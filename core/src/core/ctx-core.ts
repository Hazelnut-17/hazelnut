import type { Actor } from "../authz/auth.ts";
import type { Db } from "../data/db.ts";
import {
  type BackpressureState,
  emit,
  enqueue,
  enqueueCapped,
  type OutboxMsg,
  pgSchedulingCapStore,
  type SchedulingCap,
  schedulingCapKey,
  type SchedulingCapStore,
} from "../runtime/outbox.ts";
import { scheduleOnce, scheduleOnceCapped } from "../runtime/schedule-once.ts"; // the leaf import, not scheduler.ts — avoids a ctx → scheduler cycle
import { getCurrentTraceparent } from "./tracing.ts"; // ambient trace-carrier holder homes with the tracer port (05-runtime.md §5.1)
// ctx.data/reads/llm/judge/i18n bindings are type-only here (no runtime edge) — the owning modules hold
// the concrete factories, keeping ctx.ts free of the app/repo graph and avoiding import cycles.

/**
 * The op-pipeline's "build ctx" step (05-runtime.md §ctx): assembles the runnable-now half of the
 * handler-facing surface — clock, log, and the outbox-bound emit/queue effects — derivable from
 * `{ actor, scope, db }` alone. `data`/`reads`/`transition`/`query` compose elsewhere onto this base.
 */

/** JSON-scalar leaves a provenance record may carry (05-runtime.md §6 `ProvenanceRecord.attrs`). */
export type JsonScalar = string | number | boolean | null;

// ── end-to-end trace propagation: the ambient current-span carrier (05-runtime.md §5.1) ──────────
// `TraceCarrier` lives in core/tracing.ts, not here — hosting it in ctx would cycle ctx → runtime/outbox →
// outbox-emit → ctx. No live span ⇒ null floor (un-instrumented deployments never touch it).

/** Who caused an outbox write and which request it came from — the identity stamped onto the row. Every
 *  door takes the WHOLE origin, never `(scope, actor)` picked off it — picking is how a door composes the
 *  actor and silently forgets the request id. */
export interface EmitOrigin {
  readonly actor: Actor | null;
  readonly scope: string;
  /** The per-request correlation id (`Hazelnut-Trace-Id`) the §6 record also carries; absent off a request. */
  readonly traceId?: string;
}

/** Build the `_outbox.trace_context` envelope `ctx.emit` stamps (05-runtime.md §5.1): the active span's
 *  W3C traceparent/baggage when a tracer is installed, plus the actor and request id, which need none.
 *  `undefined` only when there is nothing to say — an un-instrumented anonymous non-request emit. */
export function buildTraceContext(
  origin: EmitOrigin,
): Record<string, unknown> | undefined {
  const carrier = getCurrentTraceparent(); // no live span → the traceparent half is simply absent
  const { actor, traceId } = origin;
  const ctx = {
    ...(carrier !== undefined
      ? {
        traceparent: carrier.traceparent,
        ...(carrier.baggage !== undefined ? { baggage: carrier.baggage } : {}),
      }
      : {}),
    ...(traceId !== undefined ? { traceId } : {}),
    ...(actor !== null ? { actor: actor.id } : {}),
    ...(actor?.onBehalfOf !== undefined
      ? { onBehalfOf: actor.onBehalfOf }
      : {}),
  };
  return Object.keys(ctx).length === 0 ? undefined : ctx;
}

/** Stamp an outbox msg with the op's `scope` (if absent) and its trace_context — actor + request id always,
 *  the W3C carrier when a tracer is live (05-runtime.md §5.1) — then emit it. The one stamping impl:
 *  `buildOpCtx`'s base emit and the redacting served-op emit both ride it, so the two paths cannot drift. */
export async function emitStamped(
  db: Db,
  origin: EmitOrigin,
  msg: OutboxMsg,
  state?: BackpressureState,
  cap?: SchedulingCapConfig | null,
): Promise<string> {
  const { actor, scope } = origin;
  // Per-source emit budget (05-runtime.md §5.1 §backpressure), keyed by schedulingCapKey and counted
  // separately from the scheduling budget (`emit:`-prefixed). Over-cap throws `business` and writes no row.
  const emitCap = cap == null || cap.emitCap === false
    ? null
    : cap.emitCap ?? EMIT_FLOOR;
  if (emitCap !== null) {
    const key = schedulingCapKey(actor);
    if (key !== null) {
      const verdict = await cap!.store(db).checkAndAdmit(
        `emit:${key}`,
        emitCap,
      );
      if (!verdict.admitted) {
        throw Object.assign(
          new Error(
            `emit budget exceeded: at most ${emitCap.max} ctx.emit per ${emitCap.windowSec}s for ${key} — a runaway source is refused on its own budget before the global watermark; raise defineConfig({ schedulingCap: { emitCap } })`,
          ),
          { kind: "business" as const },
        );
      }
    }
  }
  const scoped = msg.scope === undefined ? { ...msg, scope } : msg;
  if (scoped.traceContext !== undefined) return emit(db, scoped, state);
  const traceContext = buildTraceContext(origin);
  return emit(
    db,
    traceContext === undefined ? scoped : { ...scoped, traceContext },
    state,
  );
}

/**
 * `ctx.queue` — the background-work effect surface (05-runtime.md §4 / §ctx). Both verbs write to
 * `_outbox` in the current tx, so a job/one-shot is enqueued iff the op commits; `schedule`'s bool
 * return is whether this call won the `(job, bucket)` slot — a double-schedule is a silent no-op.
 */
export interface QueueSurface {
  enqueue(name: string, payload: unknown): Promise<string>;
  schedule(at: Date, job: string, payload?: unknown): Promise<boolean>;
}

/**
 * The boot-configured per-agent scheduling cap (05-runtime.md §4.1) — the window quota + the store
 * that arbitrates it. `store` is a factory `(db) => SchedulingCapStore` so the check runs on the
 * same tx connection as the `_outbox` enqueue.
 */
export interface SchedulingCapConfig {
  readonly cap: SchedulingCap;
  readonly store: (db: Db) => SchedulingCapStore;
  /** The emit-verb budget of the same containment family (05-runtime.md §5.1 §backpressure) — a distinct
   *  counter from the scheduling budget (`emit:`-prefixed). Absent ⇒ `EMIT_FLOOR` default; `false` ⇒ off. */
  readonly emitCap?: SchedulingCap | false;
}

// The active scheduling cap, the single install point (mirrors setLLMClient/getLLMClient). `createApp`
// carries it on by default; `null` here means only "no cap on this raw path yet", never "off by default".
let activeSchedulingCap: SchedulingCapConfig | null = null;
/** Test seam only: installs a global cap for unit tests that build a ctx without a composed App. The app
 *  path never touches this — `makeQueueSurface` reads a passed cap first, falling back here only app-less. */
export function setSchedulingCap(config: SchedulingCapConfig | null): void {
  activeSchedulingCap = config;
}
export function getSchedulingCap(): SchedulingCapConfig | null {
  return activeSchedulingCap;
}

/** The born-on per-agent scheduling floor (13-authz.md §9): not opt-in — agents get at most `max` scheduled
 *  enqueues per `windowSec` (user/anon exempt). `defineConfig({ schedulingCap })` or `false` opts down. */
export const SCHEDULING_FLOOR: SchedulingCap = { max: 120, windowSec: 60 };
/** The born-on per-source emit budget floor (05-runtime.md §5.1 §backpressure): ~50 emits/s sustained per
 *  source, well inside the global watermark — one runaway source is refused on its own budget first. */
export const EMIT_FLOOR: SchedulingCap = { max: 3000, windowSec: 60 };
/** The default cap config `createApp` installs: both the scheduling and emit floors over the shared
 *  `_schedule_quota` counter, bound per-op to the live tx db. */
export function defaultSchedulingCap(): SchedulingCapConfig {
  return {
    cap: SCHEDULING_FLOOR,
    store: (db) => pgSchedulingCapStore({ db }),
    emitCap: EMIT_FLOOR,
  };
}

// Throws the cap rejection as a `.kind: "business"` failure (05-runtime.md §4.1) so an over-cap
// enqueue/schedule rolls back through the op's own rail, not a transport 429, and writes no row.
function throwCapReject(
  r: { ok: false; error: { kind: string; message: string } },
): never {
  throw Object.assign(new Error(r.error.message), { kind: r.error.kind });
}

/**
 * A name-keyed `ctx` door that THROWS on a name the app does not declare.
 *
 * `Ctx<T>` narrows five doors from the declaration and hands these through as `Record<string, …>`, so
 * `noUncheckedIndexedAccess` forces `?.` at every call site whether the name resolves or not. A typo then
 * compiles clean and is a SILENT no-op at runtime: `?.` short-circuits, the caller's `await` resolves to
 * `undefined`, and the op returns `ok` while the work never happens. That is the async surface, where there
 * is no exception, no `_outbox` row, and nothing to reconstruct from afterwards.
 *
 * SYMBOLS and inherited members pass through untouched: `Symbol.toStringTag`, `toString`, an inspector's
 * probe and an accidental `await` on the door itself all ask about the OBJECT, never about a name.
 */
export function loudNameDoor<T>(
  entries: Record<string, T>,
  door: string,
  what: string,
): Record<string, T> {
  return new Proxy(entries, {
    get(target, prop, recv) {
      // The widening escape the typed doors carry (`ctx.tasks.$(name)` — faces-ctx.ts §DoorWidener): the
      // deliberate dynamic-address call shape, meeting the SAME floor — an unknown name throws loud
      // rather than resolving to undefined and short-circuiting.
      if (prop === "$") {
        return (name: string): T => {
          if (!Object.hasOwn(target, name)) {
            const declared = Object.keys(target).sort();
            throw new Error(
              `ctx.${door}.$('${name}'): no ${what} named '${name}' is declared — ${
                declared.length === 0
                  ? `this app declares none, so every ctx.${door} call is a no-op`
                  : `declared: ${declared.join(", ")}`
              }. The widening escape reaches the same names; it cannot invent one.`,
            );
          }
          return Reflect.get(target, name, recv) as T;
        };
      }
      if (typeof prop !== "string" || Reflect.has(target, prop)) {
        return Reflect.get(target, prop, recv);
      }
      // `then` decides whether a value is thenable; throwing here would make `await ctx.tasks` explode on a
      // question that is about the door, not about any name on it.
      if (prop === "then" || prop === "toJSON") return undefined;
      const declared = Object.keys(target).sort();
      throw new Error(
        `ctx.${door}.${prop}: no ${what} named '${prop}' is declared — ${
          declared.length === 0
            ? `this app declares none, so every ctx.${door} call is a no-op`
            : `declared: ${declared.join(", ")}`
        }. An undeclared name used to resolve to undefined and short-circuit, so the call returned and the work never ran.`,
      );
    },
  });
}

/**
 * Build the `ctx.queue` effect surface bound to `db` + the op's {@link EmitOrigin}, shared by `buildOpCtx`
 * and `makeCtx` (05-runtime.md §4/§4.1) so both paths get an identical surface. It takes the WHOLE origin,
 * never `(scope, actor)` picked off it: a queue row is as durable as an emitted one, so it stamps the same
 * `trace_context` — a dead-lettered worker job that cannot name its request is the case this exists for.
 */
export function makeQueueSurface(
  db: Db,
  origin: EmitOrigin,
  cap?: SchedulingCapConfig | null,
  bp?: BackpressureState,
): QueueSurface {
  const { actor, scope } = origin;
  // one envelope for every row this surface writes — built once per ctx, not per enqueue.
  const traceContext = buildTraceContext(origin);
  // `cap === undefined` is the app-less path (falls back to the test-seam `getSchedulingCap()`); `cap === null`
  // is an app that opted out — stays uncapped, never falling through to the global test-set cap.
  const capConfig = cap === undefined ? getSchedulingCap() : cap;
  // default-off: no cap installed ⇒ the existing uncapped posture (zero behaviour change for non-opt-in apps).
  if (capConfig === null) {
    return {
      enqueue: (name, payload) =>
        enqueue(db, name, payload, { scope, traceContext }, bp),
      // the one-shot scheduled job (05-runtime.md §4.1), bound to this tx db and backpressure-gated like
      // enqueue — `bp` threaded so schedule cannot bypass the watermark choke point.
      schedule: (at, job, payload = {}) =>
        scheduleOnce(db, job, at, payload, { scope, traceContext }, bp),
    };
  }
  // bind the cap store to this db (the live tx) so the quota check runs on the same connection as the enqueue.
  const capOpts = { actor, cap: capConfig.cap, store: capConfig.store(db) };
  return {
    // the cap is enforced at this live in-handler enqueue site: over-cap ⇒ a `business` reject (throws → rolls
    // the op back, no row); under cap (or a non-agent actor) ⇒ the row lands and the bare id is returned.
    enqueue: async (name, payload) => {
      const r = await enqueueCapped(db, name, payload, {
        scope,
        traceContext,
        capOpts,
      }, bp);
      return r.ok ? r.value : throwCapReject(r);
    },
    schedule: async (at, job, payload = {}) => {
      const r = await scheduleOnceCapped(db, job, at, payload, {
        scope,
        traceContext,
        capOpts,
      }, bp);
      return r.ok ? r.value : throwCapReject(r);
    },
  };
}

// roster/engine extracted into cohesive submodules, re-exported so importers stay stable.
