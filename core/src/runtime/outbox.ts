import type { Actor } from "../authz/auth.ts";
import { uuidv7 } from "../core/id.ts";
import { err, ok, type Result } from "../core/result.ts";
import type { Db } from "../data/db.ts";
import { type BackpressureState, emit } from "./outbox-emit.ts";

/**
 * The transactional outbox relay (06-generators.md §6c). `emit` writes a row in the same tx as the business
 * mutation, so an event publishes iff its change commits. `drainOutbox` (outbox-drain.ts) holds per-aggregate
 * ordering, failure isolation per entity until DLQ, and an at-least-once-effect/exactly-once-fence delivery
 * guarantee via `_processed`.
 */
export interface OutboxMsg {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly topic: string;
  readonly payload: unknown;
  readonly kind?: "event" | "queue";
  /**
   * The 05-runtime.md §5.1 envelope columns — all optional (additive); `ctx.emit` stamps these from the live
   * ctx, a bare `emit` may omit them. `traceContext` links the consume span to the producing op span.
   * `scope` omitted leaves it NULL = crossScope (13-authz.md §crossScope). `schemaVersion` dispatches the
   * matching upcaster chain at consume (§5.2); defaults to 1.
   */
  readonly traceContext?: Record<string, unknown>;
  readonly scope?: string;
  readonly schemaVersion?: number;
}

export interface DeliveredMsg extends OutboxMsg {
  readonly id: string;
  readonly attempts: number;
}

/**
 * Enqueue a background-worker job (05-runtime.md §4 `ctx.queue.enqueue`) — a `kind:"queue"` outbox row
 * written in the same tx as the op, so the job is enqueued iff the op commits. `defineWorker` consumes it;
 * the relay drains it exactly like an event, but `kind='queue'` is exempt from per-aggregate ordering — each
 * enqueued job gets its own fresh `aggregateId` so one poison job never blocks a sibling.
 */
export async function enqueue(
  db: Db,
  name: string,
  payload: unknown,
  opts: {
    readonly scope?: string;
    readonly traceContext?: Record<string, unknown>;
    readonly schemaVersion?: number;
  } = {},
  state?: BackpressureState, // per-app backpressure threaded from ctx.queue; absent ⇒ emit's app-less default
): Promise<string> {
  return await emit(db, {
    aggregateType: "queue",
    aggregateId: uuidv7(), // each enqueued job is its own aggregate → never blocks a sibling (queue has no ordering)
    topic: name,
    payload,
    kind: "queue",
    scope: opts.scope,
    traceContext: opts.traceContext,
    schemaVersion: opts.schemaVersion,
  }, state);
}

// ─── per-agent scheduling abuse cap (05-runtime.md §4.1) ─────────────────────────────────────────────
// The cron-once partial-unique index (scheduler.ts) bounds duplicate enqueues of the same (job, bucket) but
// does nothing against an agent enqueuing many distinct jobs at machine speed. This cap contains that: a
// fixed-window count check keyed on agent identity, riding the same atomic-window family as the inbound
// rate-limit (throttle.ts) but on a distinct budget — outbound scheduling enqueues, not inbound requests.
// Rejection is a domain `err("business")` (03-api-shape.md §err), not a transport 429: a mid-op
// `ctx.queue.enqueue` over-cap returns through the op's own Result rail and rolls the op back.

/**
 * The per-agent scheduling budget key (05-runtime.md §4.1). An agent keys on its own `id`; a credential-less
 * system-ctx cascade keys on its `onBehalfOf` origin so the originating agent's budget is charged, not a
 * laundered system hop. A plain user or anon is not capped here (`null` ⇒ no cap).
 */
export function schedulingCapKey(actor: Actor | null): string | null {
  if (actor === null) return null;
  if (actor.type === "agent") return `agent:${actor.id}`;
  // a system actor's onBehalfOf carries the origin (the agent/credential that triggered the cascade); charge that.
  if (actor.type === "system" && actor.onBehalfOf !== undefined) {
    return `origin:${actor.onBehalfOf}`;
  }
  return null; // user/anon — not the machine-speed actor this cap contains
}

/** The fixed-window quota an agent's scheduling enqueues are bounded by (05-runtime.md §4.1) — `max` enqueues
 *  per `windowSec` rolling window, per agent key; distinct from the inbound rate-limit. */
export interface SchedulingCap {
  readonly max: number; // the window budget — at most this many scheduling enqueues per window per agent
  readonly windowSec: number; // the rolling window width in seconds
}

/** The cap store's atomic verdict — `admitted:false` ⇒ this enqueue would breach the window and must be
 *  rejected without consuming budget. */
export interface SchedulingCapVerdict {
  readonly admitted: boolean;
  readonly remaining: number; // budget left in the live window after this call's committed effect
}

/**
 * The scheduling-cap store seam — `checkAndAdmit` must be atomic (no TOCTOU between the count read and the
 * increment) so two concurrent enqueues from the same agent cannot both admit past the cap.
 * `pgSchedulingCapStore` achieves this with a `SELECT … FOR UPDATE` held inside the caller's op tx.
 */
export interface SchedulingCapStore {
  checkAndAdmit(key: string, cap: SchedulingCap): Promise<SchedulingCapVerdict>;
}

/** The DDL for the shared scheduling-quota counter `pgSchedulingCapStore` reads/writes — one row per agent
 *  key, `key` PK so N replicas share one budget. Run once at boot/migrate. */
export const SCHEDULE_QUOTA_DDL =
  // `window_sec` (this row's window width) lets the TTL sweep delete a row only after its own window closes,
  // never on a fixed 24h horizon.
  `CREATE TABLE IF NOT EXISTS "_schedule_quota" (key text PRIMARY KEY, count int NOT NULL, window_start double precision NOT NULL, window_sec double precision NOT NULL DEFAULT 0)`;

/**
 * The shared multi-instance scheduling-cap store (mirrors `pgRateLimitStore`, throttle.ts). The verdict
 * derives from a lock-current count, never an MVCC snapshot: `checkAndAdmit` runs inside the enqueue's op tx,
 * so `SELECT … FOR UPDATE` holds the per-key row lock to op-commit and a concurrent enqueue from the same
 * agent blocks and re-reads the committed count — correctness rests on the caller being inside its op tx.
 */
export function pgSchedulingCapStore(
  opts: { db: Db; now?: () => number },
): SchedulingCapStore {
  const clock = opts.now ?? (() => Date.now() / 1000);
  return {
    checkAndAdmit: async (key, cap) => {
      const t = clock();
      // 1. seed so step 2 has a real row to lock — a phantom row cannot be `FOR UPDATE`-locked; a concurrent
      //    peer's seed no-ops via ON CONFLICT.
      await opts.db.query(
        `INSERT INTO "_schedule_quota" (key, count, window_start, window_sec) VALUES ($1, 0, $2, $3) ON CONFLICT (key) DO NOTHING`,
        [key, t, cap.windowSec],
      );
      // 2. lock-current read — `FOR UPDATE` serializes every concurrent enqueue for this key behind the row
      //    lock, held to op-commit; a peer blocks here and re-reads our committed count when it proceeds.
      const cur = (await opts.db.query<{ count: number; window_start: number }>(
        `SELECT count, window_start FROM "_schedule_quota" WHERE key = $1 FOR UPDATE`,
        [key],
      )).rows[0]!;
      // 3. decide against the lock-current state: a tumbling (fixed) window resets to empty at t when
      //    elapsed; a would-breach enqueue is rejected without burning budget (count stays flat).
      const elapsed = t - Number(cur.window_start) >= cap.windowSec;
      const oldCount = elapsed ? 0 : Number(cur.count);
      const windowStart = elapsed ? t : Number(cur.window_start);
      const admitted = oldCount < cap.max;
      const count = admitted ? oldCount + 1 : oldCount;
      // 4. write the decided state under the held lock — committed before the lock releases the next enqueue.
      await opts.db.query(
        `UPDATE "_schedule_quota" SET count = $2, window_start = $3, window_sec = $4 WHERE key = $1`,
        [key, count, windowStart, cap.windowSec],
      );
      return { admitted, remaining: Math.max(0, cap.max - count) };
    },
  };
}

/** The cap-enforcement bundle a capped enqueue is given: the agent whose budget is charged, the window quota,
 *  and the store that arbitrates it. Absent ⇒ the enqueue is uncapped (the existing `enqueue` posture). */
export interface SchedulingCapOpts {
  readonly actor: Actor | null;
  readonly cap: SchedulingCap;
  readonly store: SchedulingCapStore;
}

/**
 * Enqueue a background-worker job with the per-agent scheduling abuse cap enforced at the enqueue site
 * (05-runtime.md §4.1). The cap check runs before the `_outbox` insert, so an over-cap enqueue is rejected
 * with a domain `err("business")` and no row is written. A non-agent (key `null`) passes straight through.
 * Returns a `Result` rather than a bare id since the reject is a first-class domain outcome on the op's rail.
 */
export async function enqueueCapped(
  db: Db,
  name: string,
  payload: unknown,
  opts: {
    readonly scope?: string;
    readonly traceContext?: Record<string, unknown>;
    readonly schemaVersion?: number;
    readonly capOpts?: SchedulingCapOpts;
  } = {},
  state?: BackpressureState, // per-app backpressure threaded from ctx.queue; absent ⇒ emit's app-less default
): Promise<Result<string>> {
  const reject = await capRejection(opts.capOpts);
  if (reject) return reject;
  return ok(await enqueue(db, name, payload, opts, state));
}

/**
 * Run the per-agent scheduling cap and return a domain rejection iff the enqueue would breach the window
 * (05-runtime.md §4.1) — shared by `enqueueCapped` and the scheduler's capped one-shot/cron enqueues so the
 * same budget/window arbitrates every scheduling entry point. Absent `capOpts` (or a non-agent key) ⇒ `null`
 * (admit).
 */
export async function capRejection(
  capOpts: SchedulingCapOpts | undefined,
): Promise<Result<never> | null> {
  if (capOpts === undefined) return null;
  const key = schedulingCapKey(capOpts.actor);
  if (key === null) return null; // user/anon — not the machine-speed actor this cap contains
  const verdict = await capOpts.store.checkAndAdmit(key, capOpts.cap);
  if (verdict.admitted) return null;
  return err(
    "business",
    `scheduling quota exceeded: at most ${capOpts.cap.max} scheduled enqueues per ${capOpts.cap.windowSec}s for ${key}`,
  );
}

// roster/engine extracted into cohesive submodules, re-exported so importers stay stable.
export * from "./outbox-emit.ts";
export * from "./outbox-drain.ts";
export * from "./outbox-relay.ts";
