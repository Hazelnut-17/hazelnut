// Barrel re-exports keep import sites stable.
import type { Actor } from "../authz/auth.ts";
import type { ResourceData } from "../data/data.ts";
import type { Db } from "../data/db.ts";
import type { DatasourceHandle } from "../data/datasources.ts";
import type { I18nSurface } from "../features/i18n.ts";
import type { ConfigData } from "../data/data.ts";
import type { ViewEnvelope, ViewQuery } from "../features/view.ts";
import type { BackpressureState, OutboxMsg } from "../runtime/outbox.ts";
import type { WorkflowSurface } from "../runtime/workflow.ts";
import { type CodeSurface, codeSurface } from "./code-helpers.ts";
import { type Clock, makeOpLog, type OpLog } from "./ctx-provenance.ts";
import {
  emitStamped,
  makeQueueSurface,
  type QueueSurface,
  type SchedulingCapConfig,
} from "./ctx-core.ts";
import type { Result } from "./pipeline.ts";

/**
 * The data/transition/query/modules half of `ctx` (05-runtime.md §ctx) — the parts needing the composed
 * `App`. `buildOpCtx` cannot build these directly (would create a repo/app import cycle), so it accepts an
 * injected factory (`BuildCtxOpts.surface`, owned by `data.ts`); absent, a handler keeps the lean `RichCtx`.
 */
export interface OpSurface {
  /** `ctx.data.<resource>` — the scoped repo for this module's resources, bound to the live (tx) db. */
  readonly data: Record<string, ResourceData>;
  /** `ctx.config.<r>` — the singleton read-or-seed / full-replace surface (04-features.md §singleton-marker),
   *  present for each `singleton` resource. Empty when no resource declares the marker. */
  readonly config: Record<string, ConfigData>;
  /** `ctx.tasks.<name>` — `submit(input)` validates and writes the `_tasks` row in this op's tx (05-runtime.md
   *  §task; submitted iff commit), returns `{ taskId }`; `cancel(taskId)` requests cooperative cancellation. */
  readonly tasks: Record<
    string,
    {
      submit(input: unknown): Promise<Result<{ taskId: string }>>;
      cancel(taskId: string): Promise<Result<{ cancelling: boolean }>>;
    }
  >;
  /** `ctx.workflows.<name>.start(input)` — starts (or, given a `workflowId`, resumes) a declared durable
   *  workflow on this op's live db, journaled in `_workflow_journal` (05-runtime.md §workflow durable steps).
   *  Returns the run's `workflowId`. */
  readonly workflows: Record<string, WorkflowSurface>;
  /** `ctx.readModels.<name>.read(q?)` — the read side of a `defineReadModel` projection, reading the
   *  materialized table on the base db (eventually-consistent, never in this op's tx); scope auto-threads. */
  readonly readModels: Record<
    string,
    {
      read(
        q?: { readonly id?: string },
      ): Promise<Array<Record<string, unknown>>>;
    }
  >;
  /** `ctx.transition(to)` moves this op's subject row (the route `:id`) to a new status — the ONLY legal
   *  status-write path (05-runtime.md §ctx); `ctx.transition(resource, id, to)` is the cross-resource escape
   *  a subject-less context (relay/subscriber) must use instead. */
  transition(to: string): Promise<Result<{ id: string; status: string }>>;
  transition(
    resource: string,
    id: string,
    to: string,
  ): Promise<Result<{ id: string; status: string }>>;
  /** `ctx.query(sql, params)` — the `queries/` raw-SQL door, bound to the live (tx) db. */
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
  /** `ctx.datasource(name).query(sql, params)` — a named external datasource's raw-SQL door (05-runtime.md
   *  §datasources), distinct from `ctx.query`: no auto WHERE-stack/scope/rowPolicy, a separate connection that
   *  never joins the op tx. `access:"read"` refuses writes; an unconfigured name throws loud. */
  datasource(name: string): DatasourceHandle;
  /** `ctx.modules.<dep>.<op>` — the sole sanctioned cross-module sync channel (only the dep's exposed
   *  ops); each call runs as the dep's own independent tx, never folded into the caller's (05-runtime.md §ctx).
   *  The RUNTIME shape stays string-keyed, as `data` does under `DataOf`; the authoring face is the derived
   *  `faces-ctx.ts §ModulesOf`, which keys it on the dep module values `deps` carries. */
  readonly modules: Record<
    string,
    Record<
      string,
      (input: unknown, idempotencyKey?: string) => Promise<Result<unknown>>
    >
  >;
  /**
   * `ctx.reads.<dep>.<view>` — the sanctioned cross-module read channel (rung-3, the read-side twin of
   * `ctx.modules`). Reachable only for a view B's `exposesRead` lists and that A declared as a `dep`; runs
   * B's own narrowed view (columns/rowPolicy/WHERE-stack), so a producer rename is caught at the producer
   * (`boundary/cross-call-exposed`) AND at the call site — the authoring face is `faces-ctx.ts §ReadsOf`,
   * keyed on the dep's own `exposesRead` names. This runtime shape stays string-keyed, like `modules`.
   */
  readonly reads: Record<
    string,
    Record<string, (q: ViewQuery) => Promise<ViewEnvelope>>
  >;
  /**
   * `ctx.emit(msg)` — the served-op outbox publish (05-runtime.md §ctx), optional on the surface. When the
   * factory composes it, this redacting emit overrides `buildOpCtx`'s base emit, stripping `sensitive ∪
   * encrypted` from the payload before it reaches `_outbox` while keeping identical scope/trace stamping.
   */
  emit?(msg: OutboxMsg): Promise<string>;
  /**
   * `ctx.i18n.resolve/set` — the canon i18n surface (04-features.md §i18n); `logic/` never touches the
   * `<r>_i18n` sidecar directly. `resolve` overlays a locale on a stack-visible row; `set` writes through the
   * parent's scope/visibility gate (cross-scope/hidden → `notFound`) and audits when the parent declares it.
   */
  readonly i18n?: I18nSurface;
  /** The app's runtime config the surface carries from the composed `App` (per-app, never a process global):
   *  `ctxExtras` is the injected ctx-member seam below; `schedulingCap` threads into `makeQueueSurface`. */
  readonly ctxExtras?: readonly CtxExtras[];
  readonly schedulingCap?: SchedulingCapConfig | null;
  /** `outboxBackpressure` — the per-app producer watermark state (`app.backpressure`); `buildOpCtx` threads it
   *  into `emitStamped`/`makeQueueSurface` so emits gate on its own watermark, never a global one. */
  readonly outboxBackpressure?: BackpressureState;
}

/**
 * Boot-injected extra `ctx` members. A module whose ctx surface the core build does not ship composes the
 * factory at `createApp`, and it rides the composed `App` to here; core injects nothing, so those members
 * are simply absent. Same injection idiom as `BuildCtxOpts.surface` — this file names the seam, never an
 * implementation. The seam ADDS members a module owns (`ctx.llm`); it can NEVER restate one core composed —
 * `buildOpCtx` refuses a collision loud (identity is not injectable).
 */
export type CtxExtras = (
  op: {
    readonly actor: Actor | null;
    readonly log: OpLog;
    readonly now: Clock;
  },
) => Record<string, unknown>;

/** The richer op-handler ctx — the base principal/scope plus the runnable-now outward channels, and
 *  (when the pipeline is given the composed app) the data/transition/query/modules surface (§ctx). */
export interface CoreOpCtx extends Partial<OpSurface> {
  readonly actor: Actor | null;
  readonly scope: string;
  // the resolved multi-version API pin for this request (multi-version.md §3) — `ctx.version`, the pin made visible
  // to op logic so a handler can behave version-aware. Absent ⇒ `current`/latest (no `Hazelnut-Version` header).
  readonly version?: string;
  /** The per-request cancellation signal (client disconnect ∪ the `http.requestTimeoutMs` deadline) — thread
   *  it into external I/O (`fetch(url, { signal })`); never aborts the DB. Absent for a direct/relay/test caller. */
  readonly signal?: AbortSignal;
  readonly db: Db;
  /** The injected clock — `ctx.now()` is the one wall-clock source (deterministic under test). */
  now(): Date;
  /** The single canonical provenance record's decoration face (§6) — `ctx.log.set(k, v)`. */
  readonly log: OpLog;
  /**
   * Writes an outbox row in the current tx (05-runtime.md §5): publishes iff the op's mutation commits,
   * and rolls back with it. `ctx.scope` stamps the row by default, unless the caller already supplied one
   * (a declared crossScope opt-in).
   */
  emit(msg: OutboxMsg): Promise<string>;
  /**
   * `ctx.queue.enqueue(name, payload)` — enqueues a background-worker job in the current tx (05-runtime.md
   * §4), routed through the transactional outbox like `emit`: enqueued iff the op commits. `ctx.queue.schedule`
   * is the scheduled one-shot sibling (§4.1).
   */
  readonly queue: QueueSurface;
  /**
   * `ctx.code` (02-dsl.md §unguessable codes) — `generate(config)` mints an unguessable code (CSPRNG),
   * `hash(plaintext)` hashes a confirm-token (Argon2id), `slugify(title)` derives a url-safe slug.
   * Pure of the DB — `unique` is the framework invariant underneath, not this surface.
   */
  readonly code: CodeSurface;
  /**
   * `ctx.schedule(at, job, payload)` — schedules a one-shot job at `at` (05-runtime.md §4.1), the same
   * mechanism `ctx.queue.schedule` exposes: a `kind:"queue"` `_outbox` row with `next_retry_at = bucket` so
   * the relay never drains it early. Returns whether this call won the `(job, bucket)` slot.
   */
  schedule(at: Date, job: string, payload?: unknown): Promise<boolean>;
}

/**
 * The op-handler ctx as a HANDLER sees it: `CoreOpCtx` plus whatever a module injected through `CtxExtras`.
 *
 * The split is the seam, not decoration. `CoreOpCtx` is everything this build composes and is fully
 * type-checked as such; a module the core artifact does not ship declaration-merges its own members onto
 * `RichCtx`. A carved tree has no such module in its program, so those members do not exist there — which is
 * exactly what makes a core file reading one a `deno check` failure INSIDE the assembled artifact.
 */
// The empty extension IS the merge target — a `type` alias cannot be declaration-merged, so collapsing this
// would make the seam undeclarable.
export interface RichCtx extends CoreOpCtx {}

export interface BuildCtxOpts {
  /** Override the clock (test injection). Defaults to the real wall clock. */
  readonly now?: Clock;
  /** Reuse an existing `OpLog` so decorations accumulate across a per-tx ctx rebuild. */
  readonly log?: OpLog;
  /**
   * The data/transition/query/modules factory (05-runtime.md §ctx). The pipeline passes the live db (the
   * tx inside a write op, so `ctx.data.create` commits/rolls back with it), and the factory returns the
   * surface bound to it. `data.ts` provides this; `ctx.ts` stays free of the app/repo graph.
   */
  readonly surface?: (db: Db) => OpSurface;
  /**
   * Injects extra `ctx` members for this ctx — the app-less/lean path's twin of `App.ctxExtras` (test
   * injection, or a per-op override). Present wins over the surface's; absent leaves the members off.
   */
  readonly ctxExtras?: CtxExtras | readonly CtxExtras[];
}

/**
 * Composes the rich ctx from `{ actor, scope }` + the live db. The pipeline calls this at build-ctx, then
 * again inside the write tx with `db = tx`, passing the same `log` both times so `ctx.log.set` accumulates
 * into one record while `ctx.emit` rebinds to the tx connection.
 */
/** The `OpSurface` keys that configure the ctx rather than belonging to it. Named once, so the strip below
 *  and the ctx-member equality tooth read the same list. */
const SURFACE_PLUMBING_KEYS = [
  "ctxExtras",
  "schedulingCap",
  "outboxBackpressure",
] as const;

function omitPlumbing(surface: OpSurface): Partial<OpSurface> {
  const out: Record<string, unknown> = { ...surface };
  for (const k of SURFACE_PLUMBING_KEYS) delete out[k];
  return out as Partial<OpSurface>;
}

export function buildOpCtx(
  base: {
    readonly actor: Actor | null;
    readonly scope: string;
    readonly version?: string;
    readonly signal?: AbortSignal;
    /** The per-request correlation id (`Hazelnut-Trace-Id`) — stamped onto every row this op emits. */
    readonly traceId?: string;
  },
  db: Db,
  opts: BuildCtxOpts = {},
): RichCtx {
  const clock = opts.now ?? (() => new Date());
  const log = opts.log ?? makeOpLog();
  // The data/transition/query/modules surface is composed against this db (the tx inside a write op), so
  // `ctx.data.create`/`ctx.transition` join the op's tx; `ctx.modules` calls run as the dep's own tx.
  const surface = opts.surface?.(db);
  // ctx.queue routes through the same tx as emit (kind:"queue" outbox rows, scope-stamped), so an enqueued
  // job or scheduled one-shot commits-or-rolls-back with the op (05-runtime.md §4/§4.1/§5).
  const queue = makeQueueSurface(
    db,
    base,
    surface?.schedulingCap,
    surface?.outboxBackpressure,
  );
  const core: CoreOpCtx = {
    actor: base.actor,
    scope: base.scope,
    // Threads the API-version pin to op logic (multi-version.md §3), present only when the request carried
    // a `Hazelnut-Version` header. Conditional spread avoids an explicit `version: undefined` key.
    ...(base.version !== undefined ? { version: base.version } : {}),
    // Threads the per-request cancellation signal onto `ctx.signal`; a signal-aware handler cancels external
    // I/O on disconnect/deadline. Never wired to a DB call (aborting the pooled connection would poison it).
    ...(base.signal !== undefined ? { signal: base.signal } : {}),
    db,
    now: () => clock(),
    log,
    // Stamps the current scope (unless supplied) and the op's trace_context — actor + request id always,
    // the W3C span carrier when a tracer is live (05-runtime.md §5.1) — so the relay can link the consume
    // span to the op span and a dead letter still names who caused it.
    emit: (msg) =>
      emitStamped(
        db,
        base,
        msg,
        surface?.outboxBackpressure,
        surface?.schedulingCap,
      ), // + the per-source emit budget (the cap card's second verb)
    queue,
    // ctx.code — the demoted-to-helper code surface (02-dsl.md §unguessable codes); pure + stateless, the one
    // frozen instance threads onto every ctx (no db/scope binding needed — `unique` is the invariant underneath).
    code: codeSurface,
    // ctx.schedule(at, job, payload) — the canon top-level one-shot scheduler (05-runtime.md §4.1), the same
    // tx-bound scheduleOnce ctx.queue.schedule exposes.
    schedule: queue.schedule,
    // The surface carries three PLUMBING members `buildOpCtx` reads directly off it — they configure the ctx,
    // they are not members of it. Spread whole, they landed on the consumer's `ctx` as `ctx.ctxExtras`,
    // `ctx.schedulingCap`, `ctx.outboxBackpressure`: three internals on a public surface, one of them the
    // injection seam itself.
    ...(surface === undefined ? {} : omitPlumbing(surface)),
  };
  // The injected members (`CtxExtras`) are opaque to this build BY CONSTRUCTION — a module the core artifact
  // does not ship contributes them, so no type here can name them. `core` above carries the full core-side
  // check; this assertion widens only over the injection, and it is the one place that opacity lives.
  // N contributors, not one. A single slot forced whoever composed second to merge by hand, and the merge
  // that shipped was a spread — so two modules injecting the same name silently lost one of them. Folding
  // here makes that a loud error instead, and makes "another module" a roster entry rather than a rewrite.
  const declared = opts.ctxExtras ?? surface?.ctxExtras ?? [];
  const contributors: readonly CtxExtras[] = Array.isArray(declared)
    ? declared
    : [declared as CtxExtras];
  const extras: Record<string, unknown> = {};
  const owner = new Map<string, number>();
  for (const [i, contribute] of contributors.entries()) {
    const part = contribute({ actor: base.actor, log, now: clock });
    for (const [k, v] of Object.entries(part)) {
      const prior = owner.get(k);
      if (prior !== undefined) {
        throw new Error(
          `[hazelnut] two ctxExtras contributors both define ctx member '${k}' (contributor ${prior} and ${i}) — one would silently lose; each capability module owns its own members`,
        );
      }
      owner.set(k, i);
      extras[k] = v;
    }
  }
  // A member this build composed is NEVER replaceable through the seam — an injected `actor`/`scope` would
  // be an identity spoof, an injected `db`/`emit` a silent effect swap. The collision is a programming error
  // in the injecting module, so it is refused LOUD; dropping it silently would leave that module believing its
  // value is live.
  // Plumbing names count as collisions too. They are stripped from `core` above, so without this an injected
  // `ctxExtras`/`schedulingCap` would be ACCEPTED — the strip must not quietly widen what the seam can claim.
  const collisions = Object.keys(extras).filter((k) =>
    Object.hasOwn(core, k) ||
    (SURFACE_PLUMBING_KEYS as readonly string[]).includes(k)
  );
  if (collisions.length > 0) {
    throw new Error(
      `[hazelnut] ctxExtras may not redefine core ctx member(s): ${
        collisions.sort().join(", ")
      } — the injection seam ADDS members a module owns (ctx.llm); identity, db, log and the effect verbs are composed by core and are not overridable`,
    );
  }
  // core LAST: the composed members win the spread even before the refusal above is reached.
  return { ...extras, ...core } as RichCtx;
}
