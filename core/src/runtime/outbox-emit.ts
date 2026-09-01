// Barrel re-exports keep import sites stable.
import { uuidv7 } from "../core/id.ts";
import { classifyForRetry, errorKind } from "../core/result.ts";
import type { Db, Transactor } from "../data/db.ts";
import type { FwUpcastPin } from "../data/fw-upcast.ts";
import type { DeliveredMsg, OutboxMsg } from "./outbox.ts";
import {
  getTracer,
  popTraceparent,
  pushTraceparent,
  withSpan,
} from "../core/tracing.ts";

// ─── producer-side backpressure (05-runtime.md §5.1 §backpressure) ───────────────────────────────────
// A runaway producer (hijacked agent, bug loop) balloons `_outbox` at machine speed with nothing at the
// source to stop it — the inbound 429 cannot gate a mid-tx `ctx.emit`. The watermark is the source valve:
// past `maxReadyBacklog` ready rows, `emit`/`scheduleOnce` throw a kinded `timeout` (rolls back the emitting
// op's tx; an Idempotency-Key retry is safe) until the drain catches up. DLQ redrive and cron-tick enqueues
// are deliberately exempt (recovery/leaderless-tick paths that never route through this gate).

/** The ready-backlog predicate: a row waiting to be drained now (not processed, not sleeping on backoff).
 *  Shared by this gauge and `relayLag` (readiness/alarms) so both classify "ready" identically. */
export const OUTBOX_READY_PREDICATE =
  `processed_at IS NULL AND next_retry_at <= now()`;

/** The default watermark (05-runtime.md §5.1): generous enough that crossing it is an incident, not a burst —
 *  a healthy drain keeps the ready-backlog near zero. */
export const DEFAULT_MAX_READY_BACKLOG = 50_000;
const BACKLOG_GAUGE_TTL_MS = 2_000;

export interface BackpressureState {
  maxReadyBacklog: number | false; // false = disabled (defineConfig({ outbox: { maxReadyBacklog: false } }))
  gaugeTtlMs: number;
  cache: { pending: number; at: number };
  warned: boolean; // the 50% warn fires once per crossing (resets when the backlog drops back under)
}
const freshState = (): BackpressureState => ({
  maxReadyBacklog: DEFAULT_MAX_READY_BACKLOG,
  gaugeTtlMs: BACKLOG_GAUGE_TTL_MS,
  cache: { pending: 0, at: 0 },
  warned: false,
});

/** Build a per-app backpressure state from `defineConfig({ outbox })`. `createApp` carries this on
 *  `App.backpressure` so two apps in one process never pollute one another's watermark or gauge cache. */
export function makeBackpressure(
  cfg?: {
    readonly maxReadyBacklog?: number | false;
    readonly gaugeTtlMs?: number;
  },
): BackpressureState {
  const s = freshState();
  if (cfg?.maxReadyBacklog !== undefined) {
    s.maxReadyBacklog = cfg.maxReadyBacklog;
  }
  if (cfg?.gaugeTtlMs !== undefined) s.gaugeTtlMs = cfg.gaugeTtlMs;
  return s;
}

/** The app-less default state — the `emit`/`enqueue`/watermark fallback when no per-app state is threaded.
 *  The app path never reads this; it carries its own `App.backpressure`. */
let bp: BackpressureState = freshState();

/** Test seam / app-less default: install a backpressure config on the module default state. The app path
 *  uses `createApp({ outbox })` → `App.backpressure` (per-app, threaded), never this global. */
export function configureOutboxBackpressure(
  cfg?: {
    readonly maxReadyBacklog?: number | false;
    readonly gaugeTtlMs?: number;
  },
): void {
  bp = makeBackpressure(cfg);
}

/** The live watermark — `alarm.ts` reads the app's state so the backlog alarm classifies against the same
 *  number the wall uses. Defaults to the app-less module state on the seam path. */
export function outboxBackpressureWatermark(
  state: BackpressureState = bp,
): number | false {
  return state.maxReadyBacklog;
}

async function readyBacklogCount(db: Db): Promise<number> {
  const { rows } = await db.query<{ pending: number }>(
    `SELECT count(*)::int AS pending FROM "_outbox" WHERE ${OUTBOX_READY_PREDICATE}`,
  );
  return rows[0]?.pending ?? 0;
}

/** The emit-side gate: refresh the gauge past its TTL, warn once per 50% crossing, and refuse (kinded
 *  `timeout`, rolls back the emitting op's tx) once the ready-backlog is at/over the watermark — after one
 *  forced fresh recount, so a stale cache never refuses work the drain already cleared. */
export async function guardReadyBacklog(
  db: Db,
  state: BackpressureState = bp,
): Promise<void> {
  const max = state.maxReadyBacklog;
  if (max === false) return;
  const now = Date.now();
  if (now - state.cache.at > state.gaugeTtlMs) {
    state.cache = { pending: await readyBacklogCount(db), at: now };
  }
  if (state.cache.pending >= max) {
    state.cache = { pending: await readyBacklogCount(db), at: Date.now() }; // never refuse on stale data
  }
  const pending = state.cache.pending;
  if (pending >= max) {
    throw Object.assign(
      new Error(
        `outbox ready-backlog over watermark (${pending} >= ${max}) — drain the relay (hazelnut relay) or raise defineConfig({ outbox: { maxReadyBacklog } })`,
      ),
      { kind: "timeout" as const },
    );
  }
  if (pending >= max / 2) {
    if (!state.warned) {
      state.warned = true;
      console.warn(
        `[hazelnut] outbox ready-backlog at ${pending} — over 50% of the ${max} watermark; emits start FAILING (timeout) at the watermark. Drain the relay or raise outbox.maxReadyBacklog.`,
      );
    }
  } else {
    state.warned = false;
  }
}

/** Write an outbox row — call inside the op tx so emit commits with (or rolls back with) the mutation.
 *  `state` is the per-app backpressure state threaded from `App.backpressure`; `bp` is the seam fallback. */
export async function emit(
  db: Db,
  msg: OutboxMsg,
  state: BackpressureState = bp,
): Promise<string> {
  await guardReadyBacklog(db, state);
  const id = uuidv7();
  // The §5.1 envelope columns are additive: trace_context/scope stay NULL when the caller omits them
  // (scope NULL = crossScope). `$5`/`$7::text::jsonb`: the payload is bound as text and parsed server-side —
  // a driver serializing by inferred OID would otherwise double-encode it into a jsonb string scalar, which
  // every consumer's strict payload parse then DLQs.
  await db.query(
    `INSERT INTO "_outbox" (id, aggregate_type, aggregate_id, topic, payload, kind, trace_context, scope, schema_version)
     VALUES ($1, $2, $3, $4, $5::text::jsonb, $6, $7::text::jsonb, $8, $9)`,
    [
      id,
      msg.aggregateType,
      msg.aggregateId,
      msg.topic,
      JSON.stringify(msg.payload),
      msg.kind ?? "event",
      msg.traceContext === undefined ? null : JSON.stringify(msg.traceContext),
      msg.scope ?? null,
      msg.schemaVersion ?? 1,
    ],
  );
  return id;
}

// ─── head-of-line stall budget + per-aggregate retry circuit-breaker (05-runtime.md §relay) ──────────
// The per-aggregate ordering predicate correctly blocks a successor behind a poison head until it DLQs, but
// a slow/flaky head (not yet at maxAttempts) can otherwise hold its aggregate's stream hostage unbounded. The
// budget below bounds it on the head row's existing `created_at`/`attempts` — no new column or table — riding
// the same deadLetter + processed_at-unblock path the maxAttempts DLQ already uses.

/**
 * The per-aggregate stall budget (05-runtime.md §relay): a head is force-routed to the DLQ once it crosses
 * either bound — `maxHeadAgeMs` (wall-clock age since `created_at`) or `maxCumulativeAttempts` (a ceiling
 * distinct from `DrainOpts.maxAttempts`, the per-consumer budget). Either bound may be omitted; a budget with
 * neither disables the breaker. Applies to the ordered `kind='event'` partition only — `kind='queue'` rows
 * carry no ordering contract and are exempt.
 */
export interface StallBudget {
  readonly maxHeadAgeMs?: number; // age (now − created_at) past which a head is force-DLQ'd, even under maxAttempts
  readonly maxCumulativeAttempts?: number; // cumulative-attempt ceiling (the circuit-breaker) — trips a head whose attempts reach it
}

/** The canon default stall budget (05-runtime.md §relay). 10 min age caps the worst-case head-of-line freeze;
 *  10 cumulative attempts matches the canon RetryPolicy maxAttempts. A deployment tunes both to its own SLOs. */
export const DEFAULT_STALL_BUDGET: StallBudget = {
  maxHeadAgeMs: 600_000,
  maxCumulativeAttempts: 10,
};

/**
 * The default retry backoff (05-runtime.md §RetryPolicy): exponential (base 1s), capped at 5min, full jitter
 * (`random ∈ [0, min(cap, base·2^(attempt-1)))`) so a fleet of relays failing the same head doesn't retry in
 * lock-step. `DrainOpts.backoffMs` overrides it per deployment/test.
 */
export const RETRY_BACKOFF_BASE_MS = 1_000;
export const RETRY_BACKOFF_CAP_MS = 5 * 60 * 1_000;
export function defaultBackoffMs(attempt: number): number {
  const ceiling = Math.min(
    RETRY_BACKOFF_CAP_MS,
    RETRY_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1),
  );
  return Math.floor(Math.random() * ceiling); // full jitter — random in [0, ceiling)
}

/** The default live-relay handler deadline, coherent with `DEFAULT_STALL_BUDGET.maxHeadAgeMs` (10min): without
 *  it a hung handler holds its partition until the stall breaker forces it out. `DrainTuning.handlerTimeoutMs`
 *  overrides per-drain. */
export const DEFAULT_HANDLER_TIMEOUT_MS = 600_000;

/**
 * Decide whether a head row has stalled past its budget (05-runtime.md §relay) — pure, so the breaker decision
 * is unit-testable away from the drain. Stalled iff either bound is set and crossed: age
 * (`now − createdAtMs >= maxHeadAgeMs`) or accrued attempts (`>= maxCumulativeAttempts`). A budget with
 * neither bound is a no-op — the breaker stays strictly opt-in.
 */
export function isStalled(
  row: { readonly createdAtMs: number; readonly attempts: number },
  budget: StallBudget | undefined,
  now: number,
): boolean {
  if (budget === undefined) return false;
  if (
    budget.maxCumulativeAttempts !== undefined &&
    row.attempts >= budget.maxCumulativeAttempts
  ) return true;
  if (
    budget.maxHeadAgeMs !== undefined &&
    now - row.createdAtMs >= budget.maxHeadAgeMs
  ) return true;
  return false;
}

/**
 * The tuning knobs both drain modes share. `drainOutbox`/`runRelay` take a `DrainOpts` — a `DrainTuning` plus
 * exactly one consume source (`handler` xor `plan`, below). `runLiveRelay` takes a bare `DrainTuning`: it
 * builds the plan from its registry, so a consume source there would be ignored.
 */
export interface DrainTuning {
  readonly batch?: number;
  readonly maxAttempts?: number;
  readonly backoffMs?: (attempt: number) => number;
  readonly handlerTimeoutMs?: number; // a handler that runs past this is treated as a failure (→backoff→DLQ)
  readonly fwUpcast?: FwUpcastPin; // inject a synthetic at-rest pin (tests); the live drain omits it → FRAMEWORK_FW_PIN
  readonly maxCycles?: number; // runRelay: cap on drain cycles per call (a backstop against a livelock)
  /** The per-aggregate stall budget + circuit-breaker (05-runtime.md §relay). Absent ⇒ no breaker (a head
   *  blocks until it DLQs via `maxAttempts`). */
  readonly stallBudget?: StallBudget;
  readonly transactor?: Transactor; // the tx capability for the per-consumer claim+handler tx (defaults to `db` if it is a Transactor)
}

/**
 * Single-handler drain: one `handler(msg)` consumes every due message, fenced on the `_relay` sentinel
 * consumer (effectively-once). The simple form — a one-sink `hazelnut relay` entrypoint, or a test drive.
 */
export interface HandlerDrain extends DrainTuning {
  readonly handler: (m: DeliveredMsg) => Promise<void>;
  readonly plan?: never;
  /** By default the single-handler drain skips the framework-owned topics (`_readmodel_maintain` /
   *  `_vector_reembed` / `_file_gc`): a generic handler is not their consumer, so running it would mark the
   *  job done with zero effect. A framework-aware handler opts in with `includeFrameworkTopics: true`. */
  readonly includeFrameworkTopics?: boolean;
}

/**
 * Per-consumer fan-out drain (05-runtime.md §5.1): fans each message to the consumers `plan(msg)` returns,
 * claiming `(consumer, msg_id)` in the same tx as that consumer's handler — effectively-once per consumer. A
 * sibling failure retries only the unfinished consumer. Needs a `Transactor` (pass `transactor`, or a
 * `Db & Transactor` as `db`) for atomicity; this is the live relay's mode.
 */
export interface PlanDrain extends DrainTuning {
  readonly plan: ConsumePlan;
  readonly handler?: never;
}

/** A drain runs in exactly one mode: a single `handler`, xor a per-consumer `plan` — never both, never neither. */
export type DrainOpts = HandlerDrain | PlanDrain;

/**
 * Wrap one consumer invocation in a `consume:<topic>` span (05-runtime.md §5.1). Reads the row's
 * `trace_context.traceparent` and links it so an installed tracer makes op-span → outbox-row → consume-span
 * one distributed trace. Zero-cost with the no-op tracer or a NULL `trace_context`.
 */
export function withConsumeSpan<T>(
  topic: string,
  traceContext: Record<string, unknown> | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const parent = traceContext?.traceparent;
  const attributes: Record<string, string | number | boolean> = {};
  if (typeof parent === "string") attributes["link.traceparent"] = parent;
  const actor = traceContext?.actor;
  if (typeof actor === "string") attributes["actor"] = actor;
  const onBehalfOf = traceContext?.onBehalfOf;
  if (typeof onBehalfOf === "string") attributes["onBehalfOf"] = onBehalfOf;
  // push the producing op's traceparent so the consume span (and any re-emit inside it) links the same trace.
  const linked = typeof parent === "string";
  if (linked) {
    pushTraceparent({
      traceparent: parent as string,
      ...(typeof traceContext?.baggage === "string"
        ? { baggage: traceContext.baggage as string }
        : {}),
    });
  }
  return withSpan(getTracer(), `consume:${topic}`, () => fn(), attributes)
    .finally(() => {
      if (linked) popTraceparent();
    });
}

/** Race an already-started promise against a deadline so a hang becomes a failure (else it holds the partition
 *  forever). Abandon-only by construction (the promise cannot be cancelled once handed over) — the consumer
 *  path uses `withAbortDeadline` instead, which owns the start and threads an `AbortSignal` so the deadline can
 *  cancel the work, not just stop waiting for it. Kept for signal-less callers (the single-handler drain). */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`handler exceeded ${ms}ms`)), ms);
  });
  return Promise.race([p, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Run `start` under a deadline WITH cancellation: the
 * deadline both rejects (the loud failure that releases the partition) and aborts the signal handed to the
 * handler, so a signal-aware handler stops its in-flight work instead of running on as a zombie. A handler
 * that ignores the signal still gets the reject-side guarantee.
 */
export function withAbortDeadline<T>(
  ms: number,
  start: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const reason = new Error(`handler exceeded ${ms}ms`);
      controller.abort(reason); // cancel the work — a signal-aware handler unwinds instead of zombie-running
      reject(reason); // and fail loud regardless, so the partition is released even if the handler ignores it
    }, ms);
  });
  return Promise.race([start(controller.signal), deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
export interface DrainResult {
  readonly processed: number;
  readonly failed: number;
  readonly dead: number;
}

export interface OutboxRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  topic: string;
  payload: unknown;
  kind: "event" | "queue";
  attempts: number;
  created_at: string; // the §relay stall-budget age anchor (now − created_at = the head-of-line window held)
  schema_version: number;
  // the §5.1 provenance columns the DLQ carries forward: a redrive selects the upcaster chain by
  // `schema_version`, and the trace + crossScope tag survive a death (observable, not silent).
  trace_context: Record<string, unknown> | null;
  scope: string | null;
}

/**
 * A per-consumer consume invocation (05-runtime.md §5.1 composite fence). Each matching subscriber/worker
 * becomes one invocation keyed by its unique `consumer` name; `run` executes bound to the per-consumer tx db
 * so the handler's write and the claim commit together — effectively-once per consumer.
 */
export interface ConsumerInvocation {
  readonly consumer: string;
  /** Per-consumer retry budget (05-runtime.md §relay-mode). When set, overrides the global
   *  `DrainOpts.maxAttempts` for this consumer's DLQ decision. Absent ⇒ the global default applies. */
  readonly maxAttempts?: number;
  /** `signal` is present when the drain runs under a `handlerTimeoutMs` deadline — it aborts at the deadline so
   *  a signal-aware handler cancels its in-flight work (the reject-side failure fires either way). */
  run(msg: DeliveredMsg, txDb: Db, signal?: AbortSignal): Promise<void>;
}
export type ConsumePlan = (msg: DeliveredMsg) => ConsumerInvocation[];

/**
 * The error a stall-budget/circuit-breaker DLQ carries (05-runtime.md §relay). A force-demoted head did not
 * throw — it was demoted by policy — so this synthesizes a `kind:"timeout"` error naming the bound that
 * tripped, distinguishing the DLQ corpse from a handler's own throw.
 */
export function stallBreakerError(reason: string): Error & { kind: "timeout" } {
  return Object.assign(new Error(`relay stall budget exceeded: ${reason}`), {
    kind: "timeout" as const,
  });
}

/**
 * Dead-letter a message (05-runtime.md §5.1: same shape + `dead_at`, `final_error_kind`). Carries the
 * `_outbox` provenance forward from `r` so a redrive can select the matching upcaster chain. The DLQ `id` is
 * `(msg_id[:consumer])` so two consumers of the same message dead-letter as distinct rows.
 */
export async function deadLetter(
  db: Db,
  r: OutboxRow,
  attempts: number,
  e: unknown,
  consumer?: string,
): Promise<void> {
  // `$5::text::jsonb` / `$7::text::jsonb` — same driver-agnostic bind-as-text discipline as `emit` above.
  await db.query(
    `INSERT INTO "_outbox_dead" (id, aggregate_type, aggregate_id, topic, payload, kind, trace_context, scope, schema_version, attempts, error, final_error_kind)
     VALUES ($1, $2, $3, $4, $5::text::jsonb, $6, $7::text::jsonb, $8, $9, $10, $11, $12) ON CONFLICT (id) DO NOTHING`,
    [
      consumer ? `${r.id}:${consumer}` : r.id,
      r.aggregate_type,
      r.aggregate_id,
      r.topic,
      JSON.stringify(r.payload),
      r.kind,
      r.trace_context === null ? null : JSON.stringify(r.trace_context),
      r.scope,
      r.schema_version,
      attempts,
      String(e),
      errorKind(e),
    ],
  );
}

/**
 * The per-job failure handler for the framework-topic drains (read-model maintain / re-embed / file-gc):
 * routes a failing framework job through the same retry-with-backoff → DLQ path the app-topic drain uses,
 * instead of a throw that wedges the whole drain. A row already gone (processed/removed by a peer) is a
 * no-op ("gone").
 */
export async function retryOrDeadLetterFrameworkJob(
  db: Db,
  id: string,
  e: unknown,
  consumer: string,
  maxAttempts = 10,
): Promise<"retry" | "dead" | "gone"> {
  const row = (await db.query<OutboxRow>(
    `SELECT id, aggregate_type, aggregate_id, topic, payload, kind, attempts, created_at, schema_version, trace_context, scope FROM "_outbox" WHERE id = $1`,
    [id],
  )).rows[0];
  if (!row) return "gone";
  const attempts = row.attempts + 1;
  // kind-aware: a deterministic failure (a bad `project()`, a malformed payload) dead-letters on the first attempt —
  // a retry would only re-burn on a real bug; retryable kinds get the attempt budget, then dead-letter at the cap.
  const terminal = classifyForRetry(errorKind(e)) === "dlq" ||
    attempts >= maxAttempts;
  if (terminal) {
    await deadLetter(db, row, attempts, e, consumer);
    await db.query(
      `UPDATE "_outbox" SET processed_at = now(), attempts = $2 WHERE id = $1`,
      [id, attempts],
    ); // terminal → mark processed so the drain stops re-selecting it
    return "dead";
  }
  // the retry write carries WHY it backed off — a sleeping framework job has no DLQ corpse to read yet.
  await db.query(
    `UPDATE "_outbox" SET attempts = $2, next_retry_at = now() + ($3 || ' milliseconds')::interval, last_error = $4, last_error_kind = $5 WHERE id = $1`,
    [
      id,
      attempts,
      String(defaultBackoffMs(attempts)),
      String(e),
      errorKind(e),
    ],
  );
  return "retry";
}
