// Barrel re-exports keep import sites stable.
import { classifyForRetry, errorKind } from "../core/result.ts";
import type { Db, Transactor } from "../data/db.ts";
import { fwUpcastRow } from "../data/fw-upcast.ts";
import {
  deadLetter,
  defaultBackoffMs,
  type DrainOpts,
  type DrainResult,
  isStalled,
  type OutboxRow,
  stallBreakerError,
  withAbortDeadline,
  withConsumeSpan,
  withTimeout,
} from "./outbox-emit.ts";
import type { DeliveredMsg } from "./outbox.ts";
import { relayDrainHold } from "./outbox-relay.ts";

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
 * claim) — 05-runtime.md §5.1.
 */
export async function drainOutbox(
  db: Db,
  opts: DrainOpts,
): Promise<DrainResult> {
  const batch = opts.batch ?? 50;
  const maxAttempts = opts.maxAttempts ?? 10; // 05-runtime.md §RetryPolicy: the durable-async default is 10, not a sync SDK's 3–5
  const backoff = opts.backoffMs ?? defaultBackoffMs; // exponential + full jitter, capped at 5min

  // The operator drain-hold (05-runtime.md §ops-levers), read BEFORE the poll and read on EVERY cycle: a
  // held relay claims nothing new, while a cycle already past this line finishes the batch it claimed. That
  // is what "drain" means here — never a stop mid-transaction. Gating the poll rather than each caller is
  // deliberate: every drain door (the `hazelnut relay` loop, the in-process relay, a cron tick) is one door.
  if ((await relayDrainHold(db)).held) {
    return { processed: 0, failed: 0, dead: 0 };
  }

  // `seq` (bigserial) is the monotonic ordering key — a uuid tie-break would reorder same-instant rows, breaking
  // per-aggregate ordering. The fence is per-consumer: a message unblocks once every declared consumer resolves.
  const { rows } = await db.query<OutboxRow>(
    `SELECT id, aggregate_type, aggregate_id, topic, payload, kind, attempts, created_at, schema_version, trace_context, scope, _fw_schema_version
       FROM "_outbox" o
      WHERE processed_at IS NULL AND next_retry_at <= now()
        AND (kind = 'queue' OR NOT EXISTS (
              SELECT 1 FROM "_outbox" e
               WHERE e.aggregate_type = o.aggregate_type AND e.aggregate_id = o.aggregate_id
                 AND e.processed_at IS NULL AND e.seq < o.seq))
      ORDER BY seq
      FOR UPDATE SKIP LOCKED
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
      // Every retry write records the failure it backed off from — a row sleeping on `next_retry_at` is the
      // one state with no DLQ corpse to read, so a discarded error here is an undiagnosable stall.
      const c = claimed as { id: string; attempts: number };
      const attempts = c.attempts + 1;
      await db.query(
        `UPDATE "_outbox" SET attempts = $2, next_retry_at = now() + ($3 || ' milliseconds')::interval, last_error = $4, last_error_kind = $5 WHERE id = $1`,
        [c.id, attempts, String(backoff(attempts)), String(e), errorKind(e)],
      );
      failed++;
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
    // The AGE arm asks "has this head held its aggregate through repeated failures?", so it needs at least
    // one failure. A head with ZERO attempts is old because the relay was not POLLING — an operator hold, a
    // crash, a slow deploy — not because it is stuck, and demoting it would dead-letter a whole healthy
    // backlog on the first cycle back. The attempts arm is untouched.
    const budget = opts.stallBudget !== undefined && r.attempts === 0
      ? { ...opts.stallBudget, maxHeadAgeMs: undefined }
      : opts.stallBudget;
    if (
      r.kind === "event" &&
      isStalled(
        { createdAtMs: new Date(r.created_at).getTime(), attempts: r.attempts },
        budget,
        now,
      )
    ) {
      const ageMs = now - new Date(r.created_at).getTime();
      const e = stallBreakerError(
        `head held its aggregate ${ageMs}ms / ${r.attempts} attempts past budget — force-demoted to DLQ`,
      );
      // Demote every unresolved plan consumer (per-consumer fence), else the single-handler `_relay` consumer,
      // so the breaker is uniform across both consume modes. `processed_at = now()` unblocks the partition.
      if (opts.plan) {
        const maybeTx = (db as Partial<Transactor>).transaction !== undefined
          ? (db as Db & Transactor)
          : undefined;
        const transactor = opts.transactor ?? maybeTx;
        for (const inv of opts.plan(msg)) {
          // Claim-gate the force-DLQ: conditionally claim `(consumer, msg_id)` and DLQ only on winning the
          // claim, so a peer's uncommitted normal-path claim never gets double-effected by a false DLQ.
          // Claim + DLQ run in one tx so a claim never half-commits without its DLQ. No Transactor → still
          // claim-gated, just not atomic (the at-least-once ceiling).
          const demote = async (tx: Db): Promise<void> => {
            const claim = await tx.query<{ msg_id: string }>(
              `INSERT INTO "_processed" (msg_id, consumer) VALUES ($1, $2) ON CONFLICT (consumer, msg_id) DO NOTHING RETURNING msg_id`,
              [r.id, inv.consumer],
            );
            if (claim.rows.length === 0) return; // peer holds the claim (delivering it, or already resolved) → do not DLQ
            await deadLetter(tx, r, r.attempts, e, inv.consumer);
          };
          if (transactor) await transactor.transaction(demote);
          else await demote(db);
        }
      } else {
        await deadLetter(db, r, r.attempts, e);
      }
      await db.query(
        `UPDATE "_outbox" SET processed_at = now() WHERE id = $1`,
        [r.id],
      ); // break the stream open: the head is out, successors drain
      dead++;
      continue;
    }

    // ── per-consumer fan-out path ──────────────────────────────────────────────────────────
    if (opts.plan) {
      const invocations = opts.plan(msg);
      // A framework-owned topic with no registered plan consumer is left for its topic-scoped drain
      // (`drainFrameworkTopics`), never marked processed-with-zero-effect (a silent projection-skewing drop).
      if (invocations.length === 0) {
        if (FRAMEWORK_DRAIN_TOPICS.has(msg.topic)) continue; // framework topic → its topic-scoped drain owns it
        if (r.kind === "queue") {
          // A `kind='queue'` job with no worker is a lost job (typo'd topic or missing `defineWorker`), unlike
          // a subscriber-less `event` (correctly fire-and-forget). Treat as a retryable miss so a rolling-deploy
          // skew converges in the retry window; a permanent misconfig dead-letters at the cap for an operator.
          const attempts = r.attempts + 1;
          const miss = new Error(
            `no worker registered for queue topic '${r.topic}' — a typo'd ctx.queue topic or a missing defineWorker (the job would otherwise vanish silently)`,
          );
          if (attempts >= maxAttempts) {
            await deadLetter(db, r, attempts, miss);
            await db.query(
              `UPDATE "_outbox" SET processed_at = now() WHERE id = $1`,
              [r.id],
            ); // fence the dead row
            dead++;
          } else {
            await db.query(
              `UPDATE "_outbox" SET attempts = $2, next_retry_at = now() + ($3 || ' milliseconds')::interval, last_error = $4, last_error_kind = $5 WHERE id = $1`,
              [
                r.id,
                attempts,
                String(backoff(attempts)),
                String(miss),
                errorKind(miss),
              ],
            );
            failed++;
          }
          continue;
        }
        // a subscriber-less app `event` falls through → marked processed below (fire-and-forget, correct for pub/sub).
      }
      // the tx capability for the claim+handler tx: explicit `transactor`, else `db` itself when it is a Transactor.
      const maybeTx = (db as Partial<Transactor>).transaction !== undefined
        ? (db as Db & Transactor)
        : undefined;
      const transactor = opts.transactor ?? maybeTx;
      let allResolved = true; // every consumer claimed-ok or DLQ'd → the message can be marked done
      let anyProgress = false; // a consumer succeeded this cycle → count it as processed
      // The failure this cycle backs the message off from, boxed so a thrown `undefined` still counts as one.
      let lastError: { readonly e: unknown } | undefined;
      for (const inv of invocations) {
        // already claimed by a prior successful cycle → skip (no re-run; the composite fence's effectively-once).
        const already = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM "_processed" WHERE msg_id = $1 AND consumer = $2`,
          [r.id, inv.consumer],
        );
        if ((already.rows[0]?.n ?? 0) > 0) continue;
        const handle = (tx: Db, signal?: AbortSignal) =>
          inv.run(msg, tx, signal);
        let claimLost = false; // a peer instance won the `(consumer, msg_id)` claim this cycle → benign skip
        try {
          // wrap the consumer invocation in `consume:<topic>`, linking the producing op span via the row's
          // `trace_context.traceparent` (05-runtime.md §5.1) so an installed tracer stitches one trace end to
          // end. Zero-cost with the no-op tracer / a NULL trace_context.
          await withConsumeSpan(r.topic, msg.traceContext, async () => {
            if (transactor) {
              // Claim `(consumer, msg_id)` and run the handler in one tx: effectively-once per consumer, a
              // throw rolls back both. The claim is conditional (`ON CONFLICT DO NOTHING RETURNING`) so a
              // concurrent winner never triggers a false PK-violation DLQ — no row back means the peer won,
              // so we skip the handler as a benign already-handled outcome.
              await transactor.transaction(async (tx) => {
                const claim = await tx.query<{ msg_id: string }>(
                  `INSERT INTO "_processed" (msg_id, consumer) VALUES ($1, $2) ON CONFLICT (consumer, msg_id) DO NOTHING RETURNING msg_id`,
                  [r.id, inv.consumer],
                );
                if (claim.rows.length === 0) {
                  claimLost = true; // peer holds the claim → do not run the handler (no double-effect), do not DLQ
                  return;
                }
                // withAbortDeadline (not withTimeout): the deadline aborts the threaded signal so a signal-aware
                // handler cancels its in-flight work; the reject still fails the tx (rollback) either way.
                await (opts.handlerTimeoutMs
                  ? withAbortDeadline(
                    opts.handlerTimeoutMs,
                    (sig) => handle(tx, sig),
                  )
                  : handle(tx));
              });
              if (claimLost) return; // benign lost-race skip — mirrors the already-processed skip outcome exactly
            } else {
              // No Transactor: claim + handler are not atomic (a crash between them re-runs at-least-once, the
              // documented ceiling). Claim after a clean handler; the signal matters most here — with no tx to
              // roll back, aborting at the deadline is what stops a zombie's late write from committing.
              await (opts.handlerTimeoutMs
                ? withAbortDeadline(
                  opts.handlerTimeoutMs,
                  (sig) => handle(db, sig),
                )
                : handle(db));
              await db.query(
                `INSERT INTO "_processed" (msg_id, consumer) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                [r.id, inv.consumer],
              );
            }
          });
          if (claimLost) continue; // peer won the claim → benign already-handled skip: no progress, no DLQ, no failure
          anyProgress = true;
        } catch (e) {
          lastError = { e };
          // Per-consumer retry budget (05-runtime.md §relay-mode): this consumer's `maxAttempts` is gated
          // against its own accrued attempts, not the shared `_outbox.attempts` a flaky sibling would burn —
          // a generous subscriber and a fail-fast one share the message with independent budgets.
          const bump = await db.query<{ attempts: number }>(
            `INSERT INTO "_outbox_retry" (msg_id, consumer, attempts) VALUES ($1, $2, 1)
               ON CONFLICT (consumer, msg_id) DO UPDATE SET attempts = "_outbox_retry".attempts + 1 RETURNING attempts`,
            [r.id, inv.consumer],
          );
          const attempts = bump.rows[0]!.attempts;
          const limit = inv.maxAttempts ?? maxAttempts;
          const terminal = classifyForRetry(errorKind(e)) === "dlq" ||
            attempts >= limit;
          if (terminal) {
            await deadLetter(db, r, attempts, e, inv.consumer); // DLQ records the specific failing (consumer, msg_id) + its count
            await db.query(
              `INSERT INTO "_processed" (msg_id, consumer) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
              [r.id, inv.consumer],
            ); // fence the dead consumer so it never re-runs
            dead++;
          } else {
            allResolved = false; // this consumer still owes a run → keep the message drainable for it
          }
        }
      }
      if (allResolved) {
        await db.query(
          `UPDATE "_outbox" SET processed_at = now() WHERE id = $1`,
          [r.id],
        ); // every consumer resolved → unblock the partition
        await db.query(`DELETE FROM "_outbox_retry" WHERE msg_id = $1`, [r.id]); // housekeeping: the per-consumer counters are spent
        if (anyProgress) processed++;
      } else {
        // allResolved is false only from the catch above, so a failure is always in hand here.
        const attempts = r.attempts + 1;
        await db.query(
          `UPDATE "_outbox" SET attempts = $2, next_retry_at = now() + ($3 || ' milliseconds')::interval, last_error = $4, last_error_kind = $5 WHERE id = $1`,
          [
            r.id,
            attempts,
            String(backoff(attempts)),
            String(lastError?.e),
            errorKind(lastError?.e),
          ],
        );
        failed++;
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
      `INSERT INTO "_processed" (msg_id, consumer)
         SELECT $1, '_relay'
          WHERE NOT EXISTS (
            SELECT 1 FROM "_processed" p
             WHERE p.msg_id = $1
               AND (p.consumer <> '_relay' OR p.processed_at > now() - make_interval(secs => $2)))
         ON CONFLICT (consumer, msg_id) DO UPDATE SET processed_at = now()
           WHERE "_processed".processed_at <= now() - make_interval(secs => $2)
         RETURNING msg_id`,
      [r.id, fenceLeaseSecs],
    );
    if (claim.rows.length === 0) continue; // a peer holds the claim, or a prior cycle already fenced it
    try {
      await (opts.handlerTimeoutMs
        ? withTimeout(opts.handler(msg), opts.handlerTimeoutMs)
        : opts.handler(msg));
      await db.query(
        `UPDATE "_outbox" SET processed_at = now() WHERE id = $1`,
        [r.id],
      );
      processed++;
    } catch (e) {
      const attempts = r.attempts + 1;
      // kind-aware DLQ (05-runtime §relay): a deterministic failure dead-letters on the first attempt —
      // a retry would only re-burn tokens on a real bug; only retryable kinds get the attempt budget.
      const terminal = classifyForRetry(errorKind(e)) === "dlq" ||
        attempts >= maxAttempts;
      if (terminal) {
        await deadLetter(db, r, attempts, e); // carries schema_version/trace_context/scope forward
        await db.query(
          `UPDATE "_outbox" SET processed_at = now(), attempts = $2 WHERE id = $1`,
          [r.id, attempts],
        ); // terminal → unblock partition; the claim stays, fencing the dead message against a re-run
        dead++;
      } else {
        // catch-release: a retryable failure must leave the message drainable, so OUR claim is dropped before
        // the backoff is armed — a held claim would make every later cycle skip it, stalling it silently.
        await db.query(
          `DELETE FROM "_processed" WHERE msg_id = $1 AND consumer = '_relay'`,
          [r.id],
        );
        await db.query(
          `UPDATE "_outbox" SET attempts = $2, next_retry_at = now() + ($3 || ' milliseconds')::interval, last_error = $4, last_error_kind = $5 WHERE id = $1`,
          [r.id, attempts, String(backoff(attempts)), String(e), errorKind(e)],
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

// ─── relay supervision floor (05-runtime.md §5.1) ──────────────────────────────────────────────────
// Restart-with-backoff plus a liveness signal (loop-alive / relay-lag) wired to `/ready`, so a dead loop
// fails readiness instead of serving green while `_outbox` piles up. `serve.ts` composes `relayLiveness`
// over the drain loop's `lastDrainAt` stamp; a headless worker owns its own liveness surface at its boot.
