// Barrel re-exports keep import sites stable.
import { classifyForRetry, errorKind } from "../core/result.ts";
import type { Db, Transactor } from "../data/db.ts";
import {
  inTransactionScope,
  transactionScopeDb,
} from "../data/transaction-scope.ts";
import { inTxSavepoint } from "../data/tx-locks.ts";
import { fwUpcastRow } from "../data/fw-upcast.ts";
import {
  assertDrainTuning,
  claimAndDeadLetter,
  deadLetterAndFinish,
  DEFAULT_HANDLER_TIMEOUT_MS,
  defaultBackoffMs,
  type DrainOpts,
  type DrainResult,
  isStalled,
  type OutboxRow,
  recordLeasedConsumerFailure,
  recordSourceFailure,
  stallBreakerError,
  withAbortDeadline,
  withConsumeSpan,
  withTimeout,
} from "./outbox-emit.ts";
import type { DeliveredMsg } from "./outbox.ts";
import { relayDrainHold } from "./outbox-relay.ts";
import { lockScheduledSource, scheduledSourceKey } from "./scheduled-claim.ts";

// Topics owned by topic-scoped drains (`drainFrameworkTopics`), never plan workers. A zero-invocation plan
// leaves `processed_at` NULL so the topic-scoped drain still picks it up; literals avoid an import cycle.
const FRAMEWORK_DRAIN_TOPICS = new Set([
  "_readmodel_maintain",
  "_vector_reembed",
  "_file_gc",
]);

/**
 * One relay poll cycle over each partition's due head (plus `queue` rows): runs the consumer(s), fences +
 * marks processed on success, backs off on failure, dead-letters and unblocks on exhaustion. Runs in exactly
 * one mode per `DrainOpts` — single-handler (`opts.handler`, fences the `_relay` sentinel) or per-consumer
 * fan-out (`opts.plan`, claims `(consumer, msg_id)` per consumer so a sibling failure rolls back only its own
 * claim) — 05-runtime.md §relay.
 */
export async function drainOutbox(
  db: Db,
  opts: DrainOpts,
): Promise<DrainResult> {
  db = transactionScopeDb(db);
  assertDrainTuning(opts);
  const batch = opts.batch ?? 50;
  const maxAttempts = opts.maxAttempts ?? 10; // 05-runtime.md §relay: the durable-async default is 10, not a sync SDK's 3–5
  const backoff = opts.backoffMs ?? defaultBackoffMs; // exponential + full jitter, capped at 5min

  // The operator drain-hold (05-runtime.md §ops-levers), read BEFORE the poll and read on EVERY cycle: a
  // held relay claims nothing new, while a cycle already past this line finishes the batch it claimed. That
  // is what "drain" means here — never a stop mid-transaction. Gating the poll rather than each caller is
  // deliberate: every drain door (the `hazelnut relay` loop, the in-process relay, a cron tick) is one door.
  if ((await relayDrainHold(db)).held) {
    return { processed: 0, failed: 0, dead: 0 };
  }

  // `seq` (bigserial) is the monotonic ordering key — a uuid tie-break would reorder same-instant rows, breaking
  // per-aggregate ordering. The poll is autocommit; overlapping batches are serialized by the `_processed`
  // claims, not by `FOR UPDATE` row locks (those would release before any handler ran). The fence is
  // per-consumer: a message unblocks once every declared consumer resolves.
  const { rows } = await db.query<OutboxRow>(
    `SELECT id, aggregate_type, aggregate_id, topic, payload, kind, attempts, created_at, first_failed_at, schema_version, trace_context, scope, _fw_schema_version
       FROM "_outbox" o
      WHERE processed_at IS NULL AND next_retry_at <= now()
        AND (claim_until IS NULL OR claim_until <= now())
        AND (kind = 'queue' OR NOT EXISTS (
              SELECT 1 FROM "_outbox" e
               WHERE e.aggregate_type = o.aggregate_type AND e.aggregate_id = o.aggregate_id
                 AND e.processed_at IS NULL AND e.seq < o.seq))
      ORDER BY seq
      LIMIT $1`,
    [batch],
  );

  const now = Date.now();
  let processed = 0, failed = 0, dead = 0;
  for (const claimed of rows) {
    // Walk the row to the pin's current revision before shaping delivery (fw-upcast.ts; cli/migrate.md
    // §framework-table-evolution). An unreadable row backs off via its own retry path instead of aborting the
    // whole drain cycle — it stays observable and heals once the pin ships the missing upcaster.
    let r: OutboxRow;
    try {
      r = fwUpcastRow(
        "_outbox",
        claimed as unknown as Record<string, unknown>,
        opts.fwUpcast,
      ) as unknown as OutboxRow; // opts.fwUpcast undefined → FRAMEWORK_FW_PIN (default arg)
    } catch (e) {
      const c = claimed as OutboxRow;
      const outcome = await recordSourceFailure(
        db,
        c,
        maxAttempts,
        backoff(Number(c.attempts) + 1),
        e,
      );
      if (outcome === "dead") dead++;
      if (outcome === "retry") failed++;
      continue;
    }
    const msg: DeliveredMsg = {
      id: r.id,
      aggregateType: r.aggregate_type,
      aggregateId: r.aggregate_id,
      topic: r.topic,
      payload: r.payload,
      kind: r.kind,
      attempts: r.attempts,
      schemaVersion: r.schema_version,
      traceContext: r.trace_context ?? undefined,
      scope: r.scope ?? undefined,
    };

    // ── head-of-line stall budget + circuit-breaker (05-runtime.md §relay) ─────────────────────────────
    // A selected `kind='event'` head past its stall budget (age or cumulative attempts) is force-routed to
    // the DLQ, breaking its partition open this cycle instead of blocking successors another retry window.
    // The AGE arm runs from the head's first failure: a head is not stuck for the time nothing polled it.
    const firstFailedAtMs = r.first_failed_at === null
      ? null
      : new Date(r.first_failed_at).getTime();
    const stalled = r.kind === "event" &&
      isStalled(
        { firstFailedAtMs, attempts: r.attempts },
        opts.stallBudget,
        now,
      );
    const stalledError = stalled
      ? stallBreakerError(
        `head held its aggregate ${
          firstFailedAtMs === null ? 0 : now - firstFailedAtMs
        }ms since its first failure / ${r.attempts} attempts past budget — force-demoted to DLQ`,
      )
      : undefined;
    if (stalledError && !opts.plan) {
      await deadLetterAndFinish(db, r, r.attempts, stalledError);
      dead++;
      continue;
    }

    // ── per-consumer fan-out path ──────────────────────────────────────────────────────────
    if (opts.plan) {
      const invocations = opts.plan(msg);
      // A framework-owned topic with no registered plan consumer is left for its topic-scoped drain
      // (`drainFrameworkTopics`), never marked processed-with-zero-effect (a silent projection-skewing drop).
      if (invocations.length === 0) {
        if (stalledError) {
          await deadLetterAndFinish(db, r, r.attempts, stalledError);
          dead++;
          continue;
        }
        if (FRAMEWORK_DRAIN_TOPICS.has(msg.topic)) continue; // framework topic → its topic-scoped drain owns it
        if (r.kind === "queue") {
          // A `kind='queue'` job with no worker is a lost job (typo'd topic or missing `defineWorker`), unlike
          // a subscriber-less `event` (correctly fire-and-forget). Treat as a retryable miss so a rolling-deploy
          // skew converges in the retry window; a permanent misconfig dead-letters at the cap for an operator.
          const attempts = r.attempts + 1;
          const miss = new Error(
            `no worker registered for queue topic '${r.topic}' — a typo'd ctx.queue topic or a missing defineWorker (the job would otherwise vanish silently)`,
          );
          const outcome = await recordSourceFailure(
            db,
            r,
            maxAttempts,
            backoff(attempts),
            miss,
          );
          if (outcome === "dead") dead++;
          if (outcome === "retry") failed++;
          continue;
        }
        // a subscriber-less app `event` falls through → marked processed below (fire-and-forget, correct for pub/sub).
      }
      // the tx capability for the claim+handler tx: explicit `transactor`, else `db` itself when it is a Transactor.
      const maybeTx = (db as Partial<Transactor>).transaction !== undefined
        ? (db as Db & Transactor)
        : undefined;
      const chosen = opts.transactor ?? maybeTx;
      // The explicit port may implement ONLY Transactor, with private receiver state. Both native
      // savepoint and leased fallback callbacks must finish before that selected owner commits.
      const transactor: Transactor | undefined = chosen && {
        transaction: <T>(fn: (tx: Db) => Promise<T>) =>
          chosen.transaction((tx) => inTransactionScope(tx, fn)),
      };
      let allResolved = true; // every consumer claimed-ok or DLQ'd → the message can be marked done
      let anyProgress = false; // a consumer succeeded this cycle → count it as processed
      let anyRetry = false;
      for (const inv of invocations) {
        let outcome: "resolved" | "success" | "deferred" | "retry" | "dead" =
          "resolved";
        const fail = async (tx: Db, e: unknown, holdsClaim: boolean) => {
          // Failure evidence, the next due time and releasing the claim commit together. A peer blocked
          // on this claim sees the retry state before it can execute the handler.
          const bump = await tx.query<{ attempts: number }>(
            `INSERT INTO "_outbox_retry" (msg_id, consumer, attempts, last_error, last_error_kind)
               VALUES ($1, $2, 1, $3, $4)
               ON CONFLICT (consumer, msg_id) DO UPDATE
                 SET attempts = "_outbox_retry".attempts + 1,
                     last_error = EXCLUDED.last_error, last_error_kind = EXCLUDED.last_error_kind
               RETURNING attempts`,
            [r.id, inv.consumer, String(e), errorKind(e)],
          );
          const attempts = bump.rows[0]!.attempts;
          const terminal = classifyForRetry(errorKind(e)) === "dlq" ||
            attempts >= (inv.maxAttempts ?? maxAttempts);
          const delay = terminal ? 0 : backoff(attempts);
          await recordFailedAttempt(tx, r.id, delay, e);
          if (holdsClaim) {
            await tx.query(
              `DELETE FROM "_processed" WHERE msg_id = $1 AND consumer = $2`,
              [r.id, inv.consumer],
            );
          }
          if (terminal) {
            await claimAndDeadLetter(tx, r, attempts, e, inv.consumer);
            outcome = "dead";
          } else {
            await tx.query(
              `UPDATE "_outbox_retry" SET next_retry_at = clock_timestamp() + ($3 || ' milliseconds')::interval,
                 claim_token = NULL, claim_until = NULL WHERE msg_id = $1 AND consumer = $2`,
              [r.id, inv.consumer, String(delay)],
            );
            outcome = "retry";
          }
        };
        const budget = inv.maxAttempts ?? maxAttempts;
        const leaseMs = (opts.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS) +
          60_000;
        const handle = async (tx: Db, attempts: number, leased = false) => {
          const timeout = leased
            ? opts.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS
            : opts.handlerTimeoutMs;
          if (timeout && transactor) {
            await tx.query(`SELECT set_config('statement_timeout', $1, true)`, [
              String(Math.floor(timeout)),
            ]);
          }
          const attemptMsg = { ...msg, attempts };
          await (timeout
            ? withAbortDeadline(
              timeout,
              (sig) => inv.run(attemptMsg, tx, sig),
            )
            : inv.run(attemptMsg, tx));
        };
        let lease: { token: string; attempts: number } | undefined;
        if (transactor) {
          await withConsumeSpan(
            r.topic,
            msg.traceContext,
            () =>
              transactor.transaction(async (tx) => {
                await lockScheduledSource(tx, r.id, r.aggregate_type);
                // All adapters lock the same retry row before consulting the success fence. A BYO
                // adapter without savepoints commits a lease here, then runs its handler in a second tx.
                await tx.query(
                  `INSERT INTO "_outbox_retry" (msg_id, consumer, attempts) VALUES ($1, $2, 0)
                   ON CONFLICT (consumer, msg_id) DO UPDATE SET attempts = "_outbox_retry".attempts`,
                  [r.id, inv.consumer],
                );
                const state = (await tx.query<{
                  attempts: number;
                  resolved: boolean;
                  due: boolean;
                  leased: boolean;
                  last_error: string | null;
                  last_error_kind: string | null;
                }>(
                  `SELECT retry.attempts, retry.last_error, retry.last_error_kind,
                     (o.processed_at IS NOT NULL OR EXISTS (SELECT 1 FROM "_processed" p
                       WHERE p.msg_id = o.id AND p.consumer = $2)) AS resolved,
                     ((o.claim_until IS NOT NULL AND o.claim_until > clock_timestamp())
                       OR (retry.claim_until IS NOT NULL AND retry.claim_until > clock_timestamp())) AS leased,
                     ((o.claim_until IS NULL OR o.claim_until <= clock_timestamp())
                       AND retry.next_retry_at <= clock_timestamp()
                       AND (retry.claim_until IS NULL OR retry.claim_until <= clock_timestamp())) AS due
                   FROM "_outbox" o JOIN "_outbox_retry" retry ON retry.msg_id = o.id AND retry.consumer = $2
                   WHERE o.id = $1`,
                  [r.id, inv.consumer],
                )).rows[0];
                if (!state || state.resolved) {
                  await tx.query(
                    `DELETE FROM "_outbox_retry" WHERE msg_id = $1 AND consumer = $2`,
                    [r.id, inv.consumer],
                  );
                  return;
                }
                if (stalledError) {
                  if (state.leased) {
                    outcome = "deferred";
                  } else {
                    await claimAndDeadLetter(
                      tx,
                      r,
                      state.attempts,
                      stalledError,
                      inv.consumer,
                    );
                    await tx.query(
                      `DELETE FROM "_outbox_retry" WHERE msg_id = $1 AND consumer = $2`,
                      [r.id, inv.consumer],
                    );
                    outcome = "dead";
                  }
                  return;
                }
                if (!state.due) {
                  outcome = "deferred";
                  return;
                }
                if (state.attempts >= budget) {
                  const exhausted = Object.assign(
                    new Error(
                      state.last_error ?? "relay retry budget exhausted",
                    ),
                    {
                      kind: state.last_error_kind ?? "timeout",
                    },
                  );
                  await claimAndDeadLetter(
                    tx,
                    r,
                    state.attempts,
                    exhausted,
                    inv.consumer,
                  );
                  await tx.query(
                    `DELETE FROM "_outbox_retry" WHERE msg_id = $1 AND consumer = $2`,
                    [r.id, inv.consumer],
                  );
                  outcome = "dead";
                  return;
                }
                if (!tx.savepoint) {
                  const token = crypto.randomUUID();
                  await tx.query(
                    `UPDATE "_outbox_retry" SET claim_token = $3,
                       claim_until = clock_timestamp() + ($4 || ' milliseconds')::interval
                     WHERE msg_id = $1 AND consumer = $2`,
                    [r.id, inv.consumer, token, String(leaseMs)],
                  );
                  lease = { token, attempts: state.attempts };
                  return;
                }
                await tx.query(
                  `UPDATE "_outbox_retry" SET claim_token = NULL, claim_until = NULL WHERE msg_id = $1 AND consumer = $2`,
                  [r.id, inv.consumer],
                );
                const claim = await tx.query<{ msg_id: string }>(
                  `INSERT INTO "_processed" (msg_id, consumer) VALUES ($1, $2) ON CONFLICT (consumer, msg_id) DO NOTHING RETURNING msg_id`,
                  [r.id, inv.consumer],
                );
                if (claim.rows.length === 0) return;
                try {
                  await inTxSavepoint(tx, (sp) => handle(sp, state.attempts));
                } catch (e) {
                  await fail(tx, e, true);
                  return;
                }
                // The handler savepoint has been released. A cleanup/transport failure must escape
                // and roll back this entire tx, rather than commit its effects alongside a retry.
                await tx.query(
                  `DELETE FROM "_outbox_retry" WHERE msg_id = $1 AND consumer = $2`,
                  [r.id, inv.consumer],
                );
                outcome = "success";
              }),
          );
        } else {
          const token = crypto.randomUUID();
          const claimedLease = await db.query<{ attempts: number }>(
            `${
              r.aggregate_type === "_schedule"
                ? "WITH scheduled_source AS MATERIALIZED (SELECT pg_advisory_xact_lock(hashtextextended($6, 0))) "
                : ""
            }INSERT INTO "_outbox_retry" (msg_id, consumer, attempts, claim_token, claim_until)
             SELECT $1, $2, 0, $3, clock_timestamp() + ($4 || ' milliseconds')::interval
             FROM "_outbox" o${
              r.aggregate_type === "_schedule"
                ? " CROSS JOIN scheduled_source"
                : ""
            } WHERE o.id = $1 AND o.processed_at IS NULL
               AND (o.claim_until IS NULL OR o.claim_until <= clock_timestamp())
               AND NOT EXISTS (SELECT 1 FROM "_processed" p WHERE p.msg_id = $1 AND p.consumer = $2)
             ON CONFLICT (consumer, msg_id) DO UPDATE SET claim_token = EXCLUDED.claim_token,
               claim_until = EXCLUDED.claim_until
             WHERE ($5 OR "_outbox_retry".next_retry_at <= clock_timestamp())
               AND ("_outbox_retry".claim_until IS NULL OR "_outbox_retry".claim_until <= clock_timestamp())
             RETURNING attempts`,
            [
              r.id,
              inv.consumer,
              token,
              String(leaseMs),
              Boolean(stalledError),
              ...(r.aggregate_type === "_schedule"
                ? [scheduledSourceKey(r.id)]
                : []),
            ],
          );
          if (claimedLease.rows[0]) {
            lease = { token, attempts: claimedLease.rows[0].attempts };
          } else {
            const resolved = (await db.query<{ resolved: boolean }>(
              `SELECT o.processed_at IS NOT NULL OR EXISTS (SELECT 1 FROM "_processed" p
                 WHERE p.msg_id = o.id AND p.consumer = $2) AS resolved FROM "_outbox" o WHERE o.id = $1`,
              [r.id, inv.consumer],
            )).rows[0];
            if (resolved && !resolved.resolved) outcome = "deferred";
          }
        }
        const acquiredLease = lease as
          | { token: string; attempts: number }
          | undefined;
        if (acquiredLease) {
          const ownedLease = acquiredLease;
          const runLeased = async (tx: Db) => {
            if (transactor) {
              await lockScheduledSource(tx, r.id, r.aggregate_type);
            }
            // Holding this row in the handler tx prevents expiry takeover while SQL is still running.
            const own = (await tx.query<{ claim_token: string | null }>(
              `SELECT claim_token FROM "_outbox_retry" WHERE msg_id = $1 AND consumer = $2${
                transactor ? " FOR UPDATE" : ""
              }`,
              [r.id, inv.consumer],
            )).rows[0];
            if (own?.claim_token !== ownedLease.token) {
              outcome = "deferred";
              return;
            }
            // A statement that waited on a native peer may have acquired a lease after its success;
            // consult the durable fence again with a fresh snapshot before invoking anything.
            const resolved = (await tx.query<{ resolved: boolean }>(
              `SELECT o.processed_at IS NOT NULL OR EXISTS (SELECT 1 FROM "_processed" p
                 WHERE p.msg_id = o.id AND p.consumer = $2) AS resolved FROM "_outbox" o WHERE o.id = $1`,
              [r.id, inv.consumer],
            )).rows[0];
            if (!resolved || resolved.resolved) {
              await tx.query(
                `DELETE FROM "_outbox_retry" WHERE msg_id = $1 AND consumer = $2 AND claim_token = $3`,
                [r.id, inv.consumer, ownedLease.token],
              );
              return;
            }
            if (stalledError) {
              const result = await recordLeasedConsumerFailure(
                tx,
                r,
                inv.consumer,
                ownedLease.token,
                budget,
                0,
                stalledError,
                false,
                true,
              );
              outcome = result === "gone" ? "deferred" : result;
              return;
            }
            if (ownedLease.attempts >= budget) {
              const exhausted = new Error("relay retry budget exhausted");
              // The budget can be reduced between deployments; do not run an extra invocation.
              const result = await recordLeasedConsumerFailure(
                tx,
                r,
                inv.consumer,
                ownedLease.token,
                budget,
                0,
                exhausted,
                false,
              );
              outcome = result === "gone" ? "deferred" : result;
              return;
            }
            await handle(tx, ownedLease.attempts, true);
            const finished = await tx.query(
              `WITH owned AS (DELETE FROM "_outbox_retry" WHERE msg_id = $1 AND consumer = $2 AND claim_token = $3 RETURNING msg_id)
               INSERT INTO "_processed" (msg_id, consumer) SELECT msg_id, $2 FROM owned
               ON CONFLICT (consumer, msg_id) DO NOTHING RETURNING msg_id`,
              [r.id, inv.consumer, ownedLease.token],
            );
            outcome = finished.rows.length > 0 ? "success" : "deferred";
          };
          try {
            await withConsumeSpan(
              r.topic,
              msg.traceContext,
              () =>
                transactor ? transactor.transaction(runLeased) : runLeased(db),
            );
          } catch (e) {
            if (stalledError) {
              // No handler ran: a failed breaker write can safely release its lease for an immediate
              // repair/retry, while the failed atomic statement left both corpse and fence absent.
              await db.query(
                `UPDATE "_outbox_retry" SET claim_token = NULL, claim_until = NULL
                WHERE msg_id = $1 AND consumer = $2 AND claim_token = $3`,
                [r.id, inv.consumer, ownedLease.token],
              );
              throw e;
            }
            // A SQL error has now rolled back the handler tx. The committed lease still protects this
            // atomic failure record; a crash leaves it reclaimable and preserves at-least-once delivery.
            const result = await recordLeasedConsumerFailure(
              db,
              r,
              inv.consumer,
              ownedLease.token,
              budget,
              backoff(ownedLease.attempts + 1),
              e,
            );
            outcome = result === "gone" ? "deferred" : result;
          }
        }
        // A callback mutates this value; TypeScript cannot infer those writes across transaction().
        const result = outcome as
          | "resolved"
          | "success"
          | "deferred"
          | "retry"
          | "dead";
        if (result === "success") anyProgress = true;
        if (result === "dead") dead++;
        if (result === "retry" || result === "deferred") allResolved = false;
        if (result === "retry") anyRetry = true;
      }
      if (anyRetry) failed++;
      if (allResolved) {
        await db.query(
          `UPDATE "_outbox" SET processed_at = now() WHERE id = $1`,
          [r.id],
        );
        await db.query(`DELETE FROM "_outbox_retry" WHERE msg_id = $1`, [r.id]);
        if (anyProgress) processed++;
      } else {
        // The source wakes at its earliest unresolved consumer, so a sibling's longer backoff cannot
        // postpone another consumer, and a leased consumer does not make the poll spin while it runs.
        const generation = (await db.query<{ attempts: number }>(
          `SELECT attempts FROM "_outbox" WHERE id = $1`,
          [r.id],
        )).rows[0]?.attempts;
        await db.query(
          `UPDATE "_outbox" o SET next_retry_at = pending.due FROM (
             SELECT min(GREATEST(retry.next_retry_at, COALESCE(retry.claim_until, '-infinity'::timestamptz))) AS due
             FROM "_outbox_retry" retry WHERE retry.msg_id = $1
               AND NOT EXISTS (SELECT 1 FROM "_processed" p WHERE p.msg_id = retry.msg_id AND p.consumer = retry.consumer)
           ) pending WHERE o.id = $1 AND o.attempts = $2 AND o.processed_at IS NULL AND pending.due IS NOT NULL`,
          [r.id, generation ?? -1],
        );
      }
      continue;
    }

    // ── single-handler path (`_relay` fence) ────────────────────────────────────────────────────────────
    // A framework-owned topic is left for `drainFrameworkTopics` unless the caller opts in: a generic
    // handler is not its consumer, so running it here would mark the job done with zero effect.
    if (!opts.includeFrameworkTopics && FRAMEWORK_DRAIN_TOPICS.has(msg.topic)) {
      continue;
    }
    // The fence is CLAIMED before the handler runs, in ONE statement: the conditional INSERT both tests the
    // fence and takes it, so two concurrent drainers can never both read "unfenced" and both run the handler
    // (a read-then-write pair here is the classic double-effect). The `NOT EXISTS` keeps the pre-existing
    // any-consumer skip: a message a per-consumer drain already fenced is not re-run by the generic handler.
    // The '_relay' fence carries a LEASE (`processed_at` doubles as the claim stamp): a drainer that crashes
    // between claiming and marking the message processed wedges the fence forever — and with it the head of
    // its aggregate partition. A fence older than the lease is re-claimable (DO UPDATE refreshes the stamp),
    // so a crashed peer costs one lease-term of delay, never a permanently stuck partition.
    const fenceLeaseSecs = Math.ceil(
      ((opts.handlerTimeoutMs ?? 600_000) + 60_000) / 1000,
    );
    const claim = await db.query<{ msg_id: string }>(
      `${
        r.aggregate_type === "_schedule"
          ? "WITH scheduled_source AS MATERIALIZED (SELECT pg_advisory_xact_lock(hashtextextended($3, 0))) "
          : ""
      }INSERT INTO "_processed" (msg_id, consumer)
         SELECT $1, '_relay'${
        r.aggregate_type === "_schedule" ? " FROM scheduled_source" : ""
      }
          WHERE EXISTS (SELECT 1 FROM "_outbox" WHERE id = $1 AND processed_at IS NULL AND next_retry_at <= now()
            AND (claim_until IS NULL OR claim_until <= now())) AND NOT EXISTS (
            SELECT 1 FROM "_processed" p
             WHERE p.msg_id = $1
               AND (p.consumer <> '_relay' OR p.processed_at > now() - make_interval(secs => $2)))
         ON CONFLICT (consumer, msg_id) DO UPDATE SET processed_at = now()
           WHERE "_processed".processed_at <= now() - make_interval(secs => $2)
         RETURNING msg_id`,
      [
        r.id,
        fenceLeaseSecs,
        ...(r.aggregate_type === "_schedule" ? [scheduledSourceKey(r.id)] : []),
      ],
    );
    if (claim.rows.length === 0) continue; // a peer holds the claim, or a prior cycle already fenced it
    const due = await db.query<{ attempts: number }>(
      `SELECT attempts FROM "_outbox" WHERE id = $1 AND processed_at IS NULL AND next_retry_at <= clock_timestamp()
        AND (claim_until IS NULL OR claim_until <= clock_timestamp())`,
      [r.id],
    );
    if (due.rows.length === 0) {
      await db.query(
        `DELETE FROM "_processed" WHERE msg_id = $1 AND consumer = '_relay'`,
        [r.id],
      );
      continue;
    }
    const attemptMsg = { ...msg, attempts: due.rows[0]!.attempts };
    try {
      await (opts.handlerTimeoutMs
        ? withTimeout(opts.handler(attemptMsg), opts.handlerTimeoutMs)
        : opts.handler(attemptMsg));
      await db.query(
        `UPDATE "_outbox" SET processed_at = now() WHERE id = $1`,
        [r.id],
      );
      processed++;
    } catch (e) {
      const attempts = attemptMsg.attempts + 1;
      // kind-aware DLQ (05-runtime §relay): a deterministic failure dead-letters on the first attempt —
      // a retry would only re-burn tokens on a real bug; only retryable kinds get the attempt budget.
      const terminal = classifyForRetry(errorKind(e)) === "dlq" ||
        attempts >= maxAttempts;
      if (terminal) {
        await deadLetterAndFinish(db, r, attempts, e); // corpse + terminal source fence are statement-atomic
        dead++;
      } else {
        // catch-release: a retryable failure must leave the message drainable, so OUR claim is dropped before
        // the backoff is armed — a held claim would make every later cycle skip it, stalling it silently.
        await db.query(
          `WITH released AS (DELETE FROM "_processed" WHERE msg_id = $1 AND consumer = '_relay')
           UPDATE "_outbox" SET attempts = attempts + 1,
             next_retry_at = clock_timestamp() + ($2 || ' milliseconds')::interval,
             last_error = $3, last_error_kind = $4, first_failed_at = COALESCE(first_failed_at, clock_timestamp())
            WHERE id = $1 AND processed_at IS NULL`,
          [r.id, String(backoff(attempts)), String(e), errorKind(e)],
        );
        failed++;
      }
    }
  }
  return { processed, failed, dead };
}

/**
 * The in-process relay supervisor: drains cycle after cycle until a cycle makes no progress or `maxCycles`
 * is hit. Called by a `hazelnut relay` entrypoint or a `Deno.cron` tick; returns cumulative totals.
 */
export async function runRelay(db: Db, opts: DrainOpts): Promise<DrainResult> {
  assertDrainTuning(opts);
  const total = { processed: 0, failed: 0, dead: 0 };
  for (let i = 0; i < (opts.maxCycles ?? 1000); i++) {
    const r = await drainOutbox(db, opts);
    total.processed += r.processed;
    total.failed += r.failed;
    total.dead += r.dead;
    if (r.processed + r.failed + r.dead === 0) break; // a cycle did nothing — drained to (currently) empty
  }
  return total;
}

// ─── relay supervision floor (05-runtime.md §relay) ──────────────────────────────────────────────────
// Restart-with-backoff plus a liveness signal (loop-alive / relay-lag) wired to `/ready`, so a dead loop
// fails readiness instead of serving green while `_outbox` piles up. `serve.ts` composes `relayLiveness`
// over the drain loop's `lastDrainAt` stamp; a headless worker owns its own liveness surface at its boot.

/** One failed attempt on a source row, backed off by `delayMs`. `first_failed_at` keeps its first value: it is
 *  the stall budget's age anchor. */
async function recordFailedAttempt(
  db: Db,
  id: string,
  delayMs: number,
  e: unknown,
): Promise<void> {
  await db.query(
    `UPDATE "_outbox" SET attempts = attempts + 1, next_retry_at = clock_timestamp() + ($2 || ' milliseconds')::interval, last_error = $3, last_error_kind = $4, first_failed_at = COALESCE(first_failed_at, clock_timestamp()) WHERE id = $1`,
    [id, String(delayMs), String(e), errorKind(e)],
  );
}
