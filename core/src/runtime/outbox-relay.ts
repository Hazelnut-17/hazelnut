// Barrel re-exports keep import sites stable.
import { uuidv7 } from "../core/id.ts";
import type { Db, Transactor } from "../data/db.ts";
import type { OutboxRow } from "./outbox-emit.ts";
import { OUTBOX_READY_PREDICATE } from "./outbox-emit.ts";

/**
 * The relay restart-with-backoff policy (§5.1 RetryPolicy applied to loop restarts, distinct from the
 * per-message backoff in `DrainOpts`). Exponential with full jitter and a cap; `maxRestarts` bounds it so a
 * loop that cannot stay up eventually crashes the process rather than crash-looping forever.
 */
export interface RestartPolicy {
  readonly baseMs: number; // first backoff (canon base: 1s)
  readonly capMs: number; // ceiling (canon cap: 5 min)
  readonly maxRestarts: number; // after this many consecutive failed restarts, give up → crash (canon: 10)
}

/** The canon default: exponential (base 1s), cap 5 min, full jitter, 10 attempts (05-runtime.md §5.1 RetryPolicy). */
export const DEFAULT_RESTART_POLICY: RestartPolicy = {
  baseMs: 1_000,
  capMs: 300_000,
  maxRestarts: 10,
};

export interface RestartDecision {
  readonly action: "restart" | "crash"; // crash = restart budget exhausted, fail the process
  readonly delayMs: number; // backoff before the next restart (0 when crashing)
  readonly attempt: number; // 1-based restart number this decision is for
}

/**
 * Decide the next relay-loop restart. `failures` = consecutive failed restarts so far (0 on the first
 * failure). `rand` is injectable for deterministic tests; full jitter prevents a synchronized retry storm
 * across a fleet restarting at machine speed. Past `maxRestarts` the action is `crash` (fail fast).
 */
export function nextRestart(
  failures: number,
  policy: RestartPolicy = DEFAULT_RESTART_POLICY,
  rand: () => number = Math.random,
): RestartDecision {
  const attempt = failures + 1;
  if (attempt > policy.maxRestarts) {
    return { action: "crash", delayMs: 0, attempt };
  }
  const expBackoff = Math.min(policy.capMs, policy.baseMs * 2 ** failures);
  const delayMs = Math.floor(rand() * expBackoff); // full jitter: uniform in [0, expBackoff)
  return { action: "restart", delayMs, attempt };
}

export type RelayHealth = "healthy" | "lagging" | "stalled" | "paused";

/** A point-in-time relay liveness signal (the readiness-endpoint payload). */
export interface RelayLiveness {
  readonly health: RelayHealth;
  readonly ready: boolean; // false → the readiness probe should fail (loop dead or backlog too old)
  readonly lastDrainAt: number | null; // epoch ms of the last drain that ran, null if never
  readonly sinceDrainMs: number | null; // age of the last drain (null if never drained)
  readonly lagMs: number | null; // relay-lag: age of the OLDEST still-pending _outbox row, null if empty
  readonly pending: number; // current _outbox backlog depth
}

export interface LivenessOpts {
  readonly staleDrainMs?: number; // no drain within this window → the loop is presumed dead (default 60s)
  readonly maxLagMs?: number; // oldest pending row older than this → lagging/stalled (default 5 min)
}

/**
 * Classify relay liveness from observed signals — pure, so the readiness handler just renders it. `stalled`
 * = no drain within `staleDrainMs` or the backlog head is older than `maxLagMs` while work is pending; either
 * way the readiness probe must fail. `lagging` = building but inside budget (still ready). `healthy` =
 * drained recently with a fresh head.
 */
export function classifyLiveness(
  signal: {
    now: number;
    lastDrainAt: number | null;
    oldestPendingAt: number | null;
    pending: number;
    // An operator drain-hold (`_ops_control`): a backlog under a hold is INTENDED, so lag alone must not
    // fail readiness and churn the pod the operator just quiesced. Omitted = not held (the stricter verdict).
    drainHeld?: boolean;
  },
  opts: LivenessOpts = {},
): RelayLiveness {
  const staleDrainMs = opts.staleDrainMs ?? 60_000;
  const maxLagMs = opts.maxLagMs ?? 300_000;
  const sinceDrainMs = signal.lastDrainAt === null
    ? null
    : signal.now - signal.lastDrainAt;
  const lagMs = signal.oldestPendingAt === null
    ? null
    : signal.now - signal.oldestPendingAt;

  // loop-alive: a loop that has run but gone quiet past the window (with work waiting) is presumed dead;
  // a loop that has never drained yet is not stalled (a fresh boot with no traffic is healthy).
  const loopStalled = sinceDrainMs !== null && sinceDrainMs > staleDrainMs &&
    signal.pending > 0;
  // relay-lag: the head of the backlog is older than the budget — work is arriving faster than it drains.
  const lagStalled = lagMs !== null && lagMs > maxLagMs;

  let health: RelayHealth;
  // loop-death is settled BEFORE the hold: a hold suppresses the lag verdict only. A worker that stopped
  // stamping is dead whether or not an operator paused it, so a pause can never mask a crashed loop.
  if (loopStalled) health = "stalled";
  else if (signal.drainHeld === true) health = "paused";
  else if (lagStalled) health = "stalled";
  else if (lagMs !== null && signal.pending > 0) health = "lagging";
  else health = "healthy";

  return {
    health,
    ready: health !== "stalled",
    lastDrainAt: signal.lastDrainAt,
    sinceDrainMs,
    lagMs,
    pending: signal.pending,
  };
}

/**
 * Read the relay-lag feed from `_outbox` — the current backlog depth and the age of its oldest still-ready
 * row (`processed_at IS NULL AND next_retry_at <= now()`, the same readiness the drain poll uses, so a row
 * sleeping on backoff does not count as lag). Pure read, no concurrency infra; feeds `classifyLiveness`.
 */
export async function relayLag(
  db: Db,
): Promise<{ pending: number; oldestPendingAt: number | null }> {
  const { rows } = await db.query<{ pending: number; oldest: string | null }>(
    `SELECT count(*)::int AS pending, min(created_at) AS oldest
       FROM "_outbox"
      WHERE ${OUTBOX_READY_PREDICATE}`,
  );
  const row = rows[0];
  const pending = row?.pending ?? 0;
  const oldestPendingAt = row?.oldest == null
    ? null
    : new Date(row.oldest).getTime();
  return { pending, oldestPendingAt };
}

/**
 * Compose `relayLag` + `classifyLiveness` into the readiness payload, stamping `now`/`lastDrainAt` from the
 * caller. The single call a readiness handler makes — `serve.ts` mounts `GET /ready` over it, and
 * `relayHealthHandler` mounts `/healthz` over it for the headless worker.
 */
export async function relayLiveness(
  db: Db,
  lastDrainAt: number | null,
  opts: LivenessOpts = {},
  now: number = Date.now(),
): Promise<RelayLiveness> {
  const { pending, oldestPendingAt } = await relayLag(db);
  // the hold is read HERE rather than passed in, so every readiness door (`/ready`, `/healthz`) inherits it
  // from the shared row without a call-site change — and reads it fresh, never from a per-process cache.
  const hold = await relayDrainHold(db);
  return classifyLiveness(
    { now, lastDrainAt, oldestPendingAt, pending, drainHeld: hold.held },
    opts,
  );
}

/**
 * The headless relay worker's own liveness surface (05-runtime.md §5.1 external mode) — a handler factory
 * over the same `relayLiveness` classification `/ready` serves. 200 `{status:"ready"}` / 503 with the coarse
 * `relay-<health>` slug, never internals; a probe that cannot reach the DB is itself unready
 * (`db-unreachable`). `hazelnut relay --loop --health-port <n>` serves it.
 */
export function relayHealthHandler(
  db: Db,
  state: { readonly lastDrainAt: number | null },
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const reqPath = url.pathname; // windows-portability:allow-http (HTTP request URL, not an fs path)
    if (req.method !== "GET" || reqPath !== "/healthz") {
      return new Response("not found", { status: 404 });
    }
    try {
      const live = await relayLiveness(db, state.lastDrainAt);
      return live.ready
        ? Response.json({
          status: "ready",
          health: live.health,
          pending: live.pending,
        })
        : Response.json({
          status: "unready",
          reasons: [`relay-${live.health}`],
          pending: live.pending,
        }, { status: 503 });
    } catch {
      return Response.json({ status: "unready", reasons: ["db-unreachable"] }, {
        status: 503,
      });
    }
  };
}

// ─── DLQ observability floor (05-runtime.md §5: DLQ is observable, not a silent failure) ──────────────
// The floor is the `_outbox_dead` depth feed plus the threshold alarm a wired OTel sink raises — both pure
// reads/classifiers, mirroring `relayLag` → `classifyLiveness`; only a live dashboard is deferred.

/** The current `_outbox_dead` backlog — the total corpse count plus a per-topic breakdown so an alarm can
 *  name which stream is dead-lettering. `byTopic` is sorted by descending depth (worst offender first). */
export interface DeadLetterDepth {
  readonly total: number;
  readonly byTopic: ReadonlyArray<
    { readonly topic: string; readonly count: number }
  >;
}

/** Read the DLQ depth feed from `_outbox_dead` (05-runtime.md §5); feeds `classifyDlq`. Breakdown orders
 *  descending by count, then by topic for a stable tie-break. */
export async function deadLetterDepth(db: Db): Promise<DeadLetterDepth> {
  const { rows } = await db.query<{ topic: string | null; count: number }>(
    `SELECT topic, count(*)::int AS count FROM "_outbox_dead" GROUP BY topic ORDER BY count DESC, topic`,
  );
  const byTopic = rows.map((r) => ({ topic: r.topic ?? "", count: r.count }));
  const total = byTopic.reduce((sum, r) => sum + r.count, 0);
  return { total, byTopic };
}

export type DlqAlarmLevel = "ok" | "warn" | "alarm";

/** A point-in-time DLQ alarm signal (the OTel-renderable payload). `firing` is the load-bearing bit the
 *  alarm sink keys on; `level` grades it (warn = building, alarm = over the hard threshold); `worstTopic`
 *  names the stream most responsible so the alarm is actionable, not just a number. */
export interface DlqAlarm {
  readonly level: DlqAlarmLevel;
  readonly firing: boolean; // true → raise the OTel alarm (depth crossed the hard threshold)
  readonly total: number; // total `_outbox_dead` depth
  readonly worstTopic: string | null; // the topic with the most corpses (null when the DLQ is empty)
  readonly worstTopicCount: number;
}

export interface DlqAlarmOpts {
  readonly alarmAt?: number; // depth ≥ this → firing (the hard alarm threshold; default 1 — any corpse is a signal)
  readonly warnAt?: number; // depth ≥ this (but < alarmAt) → warn (a building backlog; default 1)
}

/**
 * Classify a DLQ depth feed into an alarm — pure, so a wired OTel sink / readiness handler just renders it.
 * The floor default `alarmAt:1` fires on any `_outbox_dead` row (05-runtime.md §5: a skip is never silent);
 * a deployment tunes the threshold up once a tolerated steady-state is known.
 */
export function classifyDlq(
  depth: DeadLetterDepth,
  opts: DlqAlarmOpts = {},
): DlqAlarm {
  const alarmAt = opts.alarmAt ?? 1;
  const warnAt = opts.warnAt ?? 1;
  const worst = depth.byTopic[0]; // already sorted descending by count
  const level: DlqAlarmLevel = depth.total >= alarmAt
    ? "alarm"
    : depth.total >= warnAt
    ? "warn"
    : "ok";
  return {
    level,
    firing: level === "alarm",
    total: depth.total,
    worstTopic: worst ? worst.topic : null,
    worstTopicCount: worst ? worst.count : 0,
  };
}

/**
 * The single call a DLQ-alarm sink makes (05-runtime.md §5): read the live depth and classify it. Compose
 * with `relayLiveness` for the full relay-health surface.
 */
export async function dlqAlarm(
  db: Db,
  opts: DlqAlarmOpts = {},
): Promise<DlqAlarm> {
  return classifyDlq(await deadLetterDepth(db), opts);
}

// ─── DLQ redrive primitive (05-runtime.md §relay-mode) ──────────────────────
// The operator action that takes corpses out of `_outbox_dead` and back into `_outbox` once the cause is
// fixed: the alarm names the dead stream, the redrive resurrects it.

export interface RedriveOpts {
  readonly topic?: string; // resurrect only this stream (a single poison topic), else every corpse
  readonly limit?: number; // cap the batch (re-drive in chunks rather than the whole DLQ at once)
}

/**
 * Bulk re-drive dead-lettered messages back onto the relay (05-runtime.md §relay-mode). In one tx: re-insert
 * each matching `_outbox_dead` row into `_outbox` under a fresh id with a clean delivery slate, carrying its
 * provenance (`schema_version`, `trace_context`, `scope`) forward, then delete the resurrected corpses. A
 * fresh id is deliberate — the corpse's old msg_id is still fenced in `_processed`, so reusing it would be
 * skipped as already-claimed. Returns the count re-driven.
 */
export async function redriveDead(
  db: Db & Transactor,
  opts: RedriveOpts = {},
): Promise<number> {
  return await db.transaction(async (tx) => {
    const where = opts.topic === undefined ? "" : " WHERE topic = $1";
    const params: unknown[] = opts.topic === undefined ? [] : [opts.topic];
    const limit = opts.limit === undefined
      ? ""
      : ` LIMIT $${params.length + 1}`;
    if (opts.limit !== undefined) params.push(opts.limit);
    const { rows } = await tx.query<OutboxRow & { id: string }>(
      `SELECT id, aggregate_type, aggregate_id, topic, payload, kind, schema_version, trace_context, scope
         FROM "_outbox_dead"${where} ORDER BY dead_at${limit} FOR UPDATE`,
      params,
    );
    for (const r of rows) {
      const newId = uuidv7(); // fresh id → a real re-delivery (the old msg_id is still fenced in `_processed`)
      // `$5::text::jsonb` / `$7::text::jsonb` — the same driver-agnostic bind-as-text discipline as `emit`
      // (outbox-emit.ts): without it a by-OID-serializing driver double-encodes the re-stringified payload.
      await tx.query(
        `INSERT INTO "_outbox" (id, aggregate_type, aggregate_id, topic, payload, kind, trace_context, scope, schema_version, attempts, next_retry_at)
         VALUES ($1, $2, $3, $4, $5::text::jsonb, $6, $7::text::jsonb, $8, $9, 0, now())`,
        [
          newId,
          r.aggregate_type,
          r.aggregate_id,
          r.topic,
          JSON.stringify(r.payload),
          r.kind,
          r.trace_context === null ? null : JSON.stringify(r.trace_context),
          r.scope,
          r.schema_version,
        ],
      );
      // Per-consumer effectively-once: re-driving under a fresh id re-fans to every plan consumer, so an
      // already-resolved sibling would be re-delivered unless pre-seeded. Copy the `_processed` fence onto the
      // new id for every consumer resolved under the old msg_id except this corpse's own failed consumer, so
      // only the failed consumer re-receives. A non-fanned corpse (plain `msg_id`) has no colon and no siblings.
      const sep = r.id.indexOf(":");
      if (sep !== -1) {
        const oldMsgId = r.id.slice(0, sep);
        const failedConsumer = r.id.slice(sep + 1);
        await tx.query(
          `INSERT INTO "_processed" (msg_id, consumer)
             SELECT $1, consumer FROM "_processed" WHERE msg_id = $2 AND consumer <> $3
             ON CONFLICT (consumer, msg_id) DO NOTHING`,
          [newId, oldMsgId, failedConsumer],
        );
      }
      // DELETE by the corpse's own DLQ id (which may be `msg_id:consumer`), not the recovered outbox id.
      await tx.query(`DELETE FROM "_outbox_dead" WHERE id = $1`, [r.id]);
    }
    // Reap `_processed` fence rows orphaned by redrive: a fresh `_outbox` id leaves the prior msg_id's fence
    // rows permanently dead, so they'd accumulate across cycles without this.
    await tx.query(reapOrphanProcessedSql("10 minutes"));
    return rows.length;
  });
}

/**
 * One predicate, two reapers: a `_processed` fence row is reapable only when older than `minAge` (the
 * crash-window grace over the processed→delete gap) and orphaned of both its `_outbox` row and any
 * `_outbox_dead` corpse, including the per-consumer corpse-id form `<msg_id>:<consumer>`. The redrive-side
 * reaper (10 minutes) and the nightly TTL sweep (7 days) share this exact shape so the two paths cannot drift.
 */
export function reapOrphanProcessedSql(
  minAge: "10 minutes" | "7 days",
): string {
  return `DELETE FROM "_processed" p
       WHERE p.processed_at < now() - interval '${minAge}'
         AND NOT EXISTS (SELECT 1 FROM "_outbox" o WHERE o.id = p.msg_id)
         AND NOT EXISTS (SELECT 1 FROM "_outbox_dead" d WHERE d.id = p.msg_id OR d.id LIKE p.msg_id || ':%')`;
}

// ─── operator levers (`_ops_control`) — 05-runtime.md §ops-levers ────────────────────────────────────
// Two things an operator can change WITHOUT a deploy, because both are a row every replica reads: hold the
// relay's drain (claim nothing new) and cap a rate-limit budget key. Durable (a row), shared (one row), and
// idempotent (a PK upsert). Every read below is a fresh statement — a per-process cache would let two
// replicas disagree about a lever, which is the failure the shared row exists to make impossible.

/** The lever vocabulary. Pinned in the table's CHECK too, so a hand-written SQL lever cannot mint a third
 *  name that every reader would then ignore. */
export type OpsLever = "relay-drain" | "rate-limit";

/**
 * The operator-lever control table. Row presence IS the lever — there is no `active` flag to disagree with
 * it, and clearing a lever deletes the row. The CHECK is the shape guard for the documented-SQL door: it
 * refuses a `rate-limit` row with no positive budget (which would otherwise read as "no cap"), a
 * `relay-drain` row under a key nothing consults, and any unknown lever name.
 *
 * `value IS NOT NULL AND value > 0` rather than `value > 0`: a CHECK whose expression evaluates to NULL
 * PASSES in PostgreSQL, so the bare comparison would admit exactly the ambiguous row it exists to refuse.
 */
export const OPS_CONTROL_DDL = `CREATE TABLE IF NOT EXISTS "_ops_control" (
       lever text NOT NULL, key text NOT NULL DEFAULT '', value double precision, reason text,
       set_at timestamptz NOT NULL DEFAULT now(),
       PRIMARY KEY (lever, key),
       CONSTRAINT "_ops_control_lever_shape" CHECK (
         (lever = 'relay-drain' AND key = '' AND value IS NULL)
         OR (lever = 'rate-limit' AND value IS NOT NULL AND value > 0)))`;

/** One control row as an operator reads it (`hazelnut ops <app>` renders these). */
export interface OpsControlRow {
  readonly lever: OpsLever;
  readonly key: string;
  readonly value: number | null;
  readonly reason: string | null;
  readonly setAt: string;
}

/** The relay drain-hold, as the drain and the readiness probes see it. */
export interface RelayDrainHold {
  readonly held: boolean;
  readonly reason: string | null;
  readonly setAt: string | null;
}

/**
 * Is the relay drain held right now? Read fresh on every call — the drain calls it as its first statement,
 * so the staleness bound is ONE poll cycle (`hazelnut relay --loop --interval`, default 1s) and it is the
 * same bound on every replica. Never memoized: a cached answer is the replica-invariance defect.
 */
export async function relayDrainHold(db: Db): Promise<RelayDrainHold> {
  const { rows } = await db.query<{ reason: string | null; set_at: string }>(
    `SELECT reason, set_at FROM "_ops_control" WHERE lever = 'relay-drain' AND key = ''`,
  );
  const r = rows[0];
  return r
    ? { held: true, reason: r.reason, setAt: String(r.set_at) }
    : { held: false, reason: null, setAt: null };
}

/**
 * The operator's rate-limit budget for one key, or null when no lever applies. Two levels, most specific
 * first: an exact row for this budget key, else the fleet-wide `''` default row. Read inside the limiter's
 * own transaction, so the bound is ZERO — a cap set between two requests applies to the second.
 */
export async function rateLimitOverride(
  db: Db,
  key: string,
): Promise<number | null> {
  const { rows } = await db.query<{ value: number }>(
    // `ORDER BY (key = '')`: false sorts before true, so an exact-key row wins over the '' default row.
    `SELECT value FROM "_ops_control" WHERE lever = 'rate-limit' AND key IN ($1, '')
      ORDER BY (key = '') LIMIT 1`,
    [key],
  );
  const v = rows[0]?.value;
  return v === undefined || v === null ? null : Number(v);
}

/** Every live lever, ordered — what `hazelnut ops <app>` prints and what its plan reads. */
export async function readOpsControl(db: Db): Promise<OpsControlRow[]> {
  const { rows } = await db.query<{
    lever: OpsLever;
    key: string;
    value: number | null;
    reason: string | null;
    set_at: string;
  }>(
    `SELECT lever, key, value, reason, set_at FROM "_ops_control" ORDER BY lever, key`,
  );
  return rows.map((r) => ({
    lever: r.lever,
    key: r.key,
    value: r.value === null ? null : Number(r.value),
    reason: r.reason,
    setAt: String(r.set_at),
  }));
}

/** Hold the relay's drain. Idempotent: the PK upsert means setting it twice is ONE hold — a second call
 *  re-stamps the reason and the time, never a second row a resume would have to clear twice. */
export async function setRelayDrain(
  db: Db,
  reason?: string,
): Promise<void> {
  await db.query(
    `INSERT INTO "_ops_control" (lever, key, value, reason) VALUES ('relay-drain', '', NULL, $1)
       ON CONFLICT (lever, key) DO UPDATE SET reason = EXCLUDED.reason, set_at = now()`,
    [reason ?? null],
  );
}

/** Release the relay drain-hold; true when a hold was actually standing (a second release is a clean no-op). */
export async function clearRelayDrain(db: Db): Promise<boolean> {
  const { rows } = await db.query<{ lever: string }>(
    `DELETE FROM "_ops_control" WHERE lever = 'relay-drain' AND key = '' RETURNING lever`,
  );
  return rows.length > 0;
}

/** Cap one rate-limit budget key (`''` = every key without its own row). Idempotent, same PK upsert. The
 *  limiter CLAMPS this against what the app declared, so a cap can only tighten — see `pgRateLimitStore`. */
export async function setRateCap(
  db: Db,
  key: string,
  limit: number,
  reason?: string,
): Promise<void> {
  await db.query(
    `INSERT INTO "_ops_control" (lever, key, value, reason) VALUES ('rate-limit', $1, $2, $3)
       ON CONFLICT (lever, key) DO UPDATE SET value = EXCLUDED.value, reason = EXCLUDED.reason, set_at = now()`,
    [key, limit, reason ?? null],
  );
}

/** Remove one rate-limit cap; true when a cap was standing. The app's declared floor takes over again. */
export async function clearRateCap(db: Db, key: string): Promise<boolean> {
  const { rows } = await db.query<{ lever: string }>(
    `DELETE FROM "_ops_control" WHERE lever = 'rate-limit' AND key = $1 RETURNING lever`,
    [key],
  );
  return rows.length > 0;
}
