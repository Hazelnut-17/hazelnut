// Barrel re-exports keep import sites stable.
import type { App } from "../core/app.ts";
import { resolveBare } from "../core/slot.ts";
import { type CodeSurface, codeSurface } from "../core/code-helpers.ts";
import { type Clock, makeOpLog, type OpLog } from "../core/ctx-provenance.ts";
import {
  emitStamped,
  makeQueueSurface,
  type OpSurface,
  type QueueSurface,
} from "../core/ctx.ts";
import type { OpCtxIn } from "../core/pipeline.ts";
import { err, type Result } from "../core/result.ts";
import type { Kms } from "../features/encrypt.ts";
import { buildI18nSurface, type I18nSurface } from "../features/i18n.ts";
import { egress } from "../features/redact.ts";
import { transition } from "../features/transition.ts";
import {
  runViewQuery,
  type ViewEnvelope,
  type ViewQuery,
} from "../features/view.ts";
import { readReadModel } from "../features/readmodel.ts";
import type { OutboxMsg } from "../runtime/outbox.ts";
import { tasksSurface } from "../runtime/tasks.ts";
import {
  setWorkflowCtxBuilder,
  workflowsSurface,
  type WorkflowSurface,
} from "../runtime/workflow.ts";
import { systemActor } from "../authz/auth.ts";
import {
  type ConfigData,
  configOf,
  dataOf,
  type ModulesFacade,
  redactEmitPayload,
  type ResourceData,
  validateEmitPayload,
} from "./data-verbs.ts";
import { opIsCollection } from "../core/app-refs.ts";
import { dispatchOp } from "../core/pipeline.ts";
import type { DatasourceHandle, Datasources } from "./datasources.ts";
import type { Db, Transactor } from "./db.ts";
import type { ReadCtx } from "./repo.ts";

/** `ctx.modules` — the cross-module OP facade, the write-side twin of `readsOf` below. It lives here
 *  rather than beside the repo verbs because each dep call needs a fresh `opSurfaceFactory` surface: with
 *  the function on the other side of that import, the two files could only reach each other in a cycle. */
export function modulesOf(
  app: App,
  db: Db & Transactor,
  base: OpCtxIn,
  selfModule: string,
  datasources?: Datasources,
): ModulesFacade {
  const out: ModulesFacade = {};
  // group the app's models by module so a dep's exposed op can be resolved to its owning resource
  const byModule = new Map<string, typeof app.model[number][]>();
  for (const m of app.model) {
    const arr = byModule.get(m.module) ?? [];
    arr.push(m);
    byModule.set(m.module, arr);
  }
  // the calling module's declared deps — only these become callable keys (an undeclared dep is absent)
  const self = byModule.get(selfModule) ?? [];
  const declaredDeps = new Set(self.flatMap((m) => m.moduleDeps));
  for (const dep of declaredDeps) {
    const depModels = byModule.get(dep) ?? [];
    // the dep's public op surface — only ops the dep module lists in `exposes` (its `moduleExposes`)
    const exposed = new Set(depModels.flatMap((m) => m.moduleExposes));
    const ops: Record<
      string,
      (input: unknown, idempotencyKey?: string) => Promise<Result<unknown>>
    > = {};
    for (const opName of exposed) {
      // find the resource in the dep module that declares this op (an exposed op must resolve to a real op)
      const carrier = depModels.find((m) => opName in m.operations);
      if (!carrier) continue; // an exposed name with no backing op is inert (a decl-typo concern, not a runtime crash)
      ops[opName] = (input, idempotencyKey) => {
        // an instance dep op carries its subject `:id` in `input` → thread `{resource, id}` so the dep op's
        // single-arg `ctx.transition(to)` binds to it; the dep's own scope/rowPolicy still gate the transition.
        const sid = (input as Record<string, unknown> | undefined)?.id;
        const subject = (!opIsCollection(carrier, opName) && sid !== undefined)
          ? { resource: carrier.name, id: String(sid) }
          : undefined;
        // the dep's own tx on the base db (not the caller's tx), running its full pipeline + its own policy
        // through the same `opSurfaceFactory` surface serve/mcp use, so `ctx.emit` redacts here too.
        return dispatchOp(
          carrier,
          opName,
          db,
          base,
          input ?? {},
          idempotencyKey,
          opSurfaceFactory(app, base, dep, undefined, subject, datasources)(db),
          { module: dep, resource: carrier.name, origin: "cross-module" },
        );
      };
    }
    out[dep] = ops;
  }
  return out;
}

/** `ctx.reads.<dep>.<view>` — the cross-module read facade (05-runtime.md §ctx), the read-side twin of
 *  `modulesOf`: keyed only by a calling module's declared deps and each dep's `exposesRead` views, each
 *  running the dep's own view via `runViewQuery` on the base db (never folded into the caller's tx). */
export type ReadsFacade = Record<
  string,
  Record<string, (q: ViewQuery) => Promise<ViewEnvelope>>
>;
const READS_LIMIT_MAX = 100; // mirrors mcp.ts LIST_LIMIT_MAX (no cycle: data.ts must not import mcp.ts)

export function readsOf(
  app: App,
  db: Db,
  base: OpCtxIn,
  selfModule: string,
): ReadsFacade {
  const out: ReadsFacade = {};
  const views = app.views ?? [];
  // group models by module (mirrors modulesOf) so a view's `over` resource resolves to its owning module.
  const byModule = new Map<string, typeof app.model[number][]>();
  for (const m of app.model) {
    const arr = byModule.get(m.module) ?? [];
    arr.push(m);
    byModule.set(m.module, arr);
  }
  const self = byModule.get(selfModule) ?? [];
  const declaredDeps = new Set(self.flatMap((m) => m.moduleDeps)); // only declared deps become keys
  const readCtx: ReadCtx = { actor: base.actor, scope: base.scope }; // the caller's principal/scope rides the dep read
  for (const dep of declaredDeps) {
    const depModels = byModule.get(dep) ?? [];
    // the dep's public read surface — only view names the dep module lists in `exposesRead`.
    const exposedReads = new Set(depModels.flatMap((m) => m.moduleExposesRead));
    const fns: Record<string, (q: ViewQuery) => Promise<ViewEnvelope>> = {};
    for (const viewName of exposedReads) {
      const view = views.find((v) => v.name === viewName);
      if (!view) continue; // an exposesRead name resolving to no view is inert (boot already loud-checks it)
      // a run-form view has no single `over` (it derives nothing) → it is not wired into ctx.reads pagination here.
      if (view.over === undefined) continue;
      const overHit = resolveBare(app.model, view.over);
      if (overHit.kind !== "hit" || overHit.value.module !== dep) continue;
      const srcModel = overHit.value;
      fns[viewName] = async (q: ViewQuery): Promise<ViewEnvelope> => {
        const env = await runViewQuery(
          db,
          app,
          view,
          readCtx,
          q,
          READS_LIMIT_MAX,
        );
        return {
          ...env,
          items: egress(srcModel, env.items) as Array<Record<string, unknown>>,
        };
      };
    }
    out[dep] = fns;
  }
  return out;
}

/** The op-pipeline ctx surface factory (05-runtime.md §ctx): `data`/`transition`/`query` bind the live
 *  (tx) db; `modules`/`reads` bind the base db, so a cross-module call/read is never folded into the op's tx. */
/** `ctx.datasource(name)` wiring shared by both ctx factories — a loud throw when no datasources are
 *  configured (access must never silently no-op); the registry itself throws on an unknown name (datasources.ts). */
function datasourceAccessor(
  datasources?: Datasources,
): (name: string) => DatasourceHandle {
  return (name: string) => {
    if (!datasources) {
      throw new Error(
        `ctx.datasource('${name}'): no datasources configured — declare config.datasources { ${name}: { url, access } } and provide boot.datasources['${name}']`,
      );
    }
    return datasources.datasource(name);
  };
}

// The workflow primitive builds its run/step ctx through this seam instead of importing `makeCtx`: the
// dependency runs data-ctx → workflow (the op surface below composes `ctx.workflows`), so the reverse import
// would close a value cycle. A run is a system principal on the framework's own rail, like a relay consumer.
setWorkflowCtxBuilder((app, kms, workflowId, scope, selfModule) => (db) =>
  makeCtx(
    app,
    db,
    {
      actor: systemActor(`workflow:${workflowId}`),
      scope: scope ?? "",
    },
    kms,
    selfModule ?? "app",
  )
);

export function opSurfaceFactory(
  app: App,
  base: OpCtxIn,
  selfModule: string,
  kms?: Kms,
  subject?: { readonly resource: string; readonly id: string },
  datasources?: Datasources,
): (db: Db & Transactor) => (txDb: Db) => OpSurface {
  return (baseDb) => (txDb) => ({
    data: dataOf(app, txDb, base, kms, selfModule), // ctx.data is this module's resources only
    // ctx.config.<r> and ctx.i18n — canon surfaces (04-features.md §singleton-marker, §i18n) that this
    // composition once omitted while `makeCtx` carried them, so an op handler calling either hit `undefined`
    // at runtime while the same call through the test harness's ctx passed. The two compositions are pinned
    // equal by a tooth now; adding a member to one without the other is RED.
    config: configOf(app, txDb, base, kms, selfModule),
    i18n: buildI18nSurface(app.model, txDb, base, kms),
    tasks: tasksSurface(app, txDb, base), // ctx.tasks.<name>.submit — the async-task submit, in this op's tx (05-runtime.md §task)
    // ctx.workflows.<name>.start — runs a declared durable workflow on THIS op's db, so its journal and its
    // steps' writes commit or roll back with the op (workflow.ts §workflowsSurface has the tx rationale).
    // `recordDb` is the out-of-band failure-record connection (a real pool only — PGlite would deadlock);
    // the journal still rides `txDb`. Origin carries the op's actor + wire correlation for attribution.
    workflows: workflowsSurface(
      app,
      txDb,
      kms,
      baseDb.concurrent ? baseDb : undefined,
      { actor: base.actor, traceId: base.traceId, scope: base.scope },
    ),
    // ctx.emit redacts `sensitive ∪ encrypted` before `_outbox`, overriding buildOpCtx's bare base emit
    // (spread order) for served handlers; the queue/schedule and transition bare emits stay safe by payload shape.
    // parse-at-emit before redaction (05-runtime.md §event-surface-lock): a typed topic's payload is strict-
    // parsed against its declared `emits` schema — a mismatch throws `validation` and rolls this op's tx back.
    emit: (msg) => {
      validateEmitPayload(app, msg);
      return emitStamped(
        txDb,
        base,
        { ...msg, payload: redactEmitPayload(app, msg) },
        app.backpressure,
        app.schedulingCap,
      ); // + the per-source emit budget
    },
    transition: ((a: string, b?: string, c?: string) => {
      // single-arg `ctx.transition(to)` binds to the op's ambient subject (route/tool `:id`) — the handler
      // can only transition the addressed row, so confused-deputy is unrepresentable (04-features.md §transitions).
      let resource: string, id: string, to: string;
      if (b === undefined) {
        if (!subject) {
          return Promise.resolve(
            err(
              "internal",
              "ctx.transition(to) needs an instance-op subject (a route/tool :id); this context has none — use ctx.transition(resource, id, to)",
            ),
          );
        }
        resource = subject.resource, id = subject.id, to = a;
      } else resource = a, id = b, to = c!;
      const m = app.model.find((x) => x.name === resource);
      if (!m) throw new Error(`ctx.transition: no resource '${resource}'`);
      return transition(txDb, m, base, id, to, {
        // `emitStamped`, never the bare `emit`: the status-change fact carries the op's trace_context, and
        // an unscoped resource's row defaults to `base.scope` rather than landing NULL (= crossScope).
        emit: (msg) => emitStamped(txDb, base, msg, app.backpressure),
      });
    }) as OpSurface["transition"],
    query: (sql, params) => txDb.query(sql, params),
    datasource: datasourceAccessor(datasources), // ctx.datasource(name) → the external datasource's own connection (never txDb — best-effort, outside the op tx)
    modules: modulesOf(app, baseDb, base, selfModule, datasources),
    // ctx.reads is the dep's own read on the base db (like a dep op) — never folded into the caller's tx.
    reads: readsOf(app, baseDb, base, selfModule),
    // ctx.readModels — the projection read side, on the base db like ctx.reads (eventually-consistent, never
    // in this op's tx). A scoped read-model auto-threads ctx.scope and every read carries ctx.actor for the
    // projection's own gate — fail-closed, a handler cannot name a foreign scope or a different caller.
    readModels: Object.fromEntries(
      (app.readModels ?? []).map((rm) => [rm.name, {
        read: (q: { readonly id?: string } = {}) =>
          readReadModel(baseDb, rm, {
            ...q,
            actor: base.actor,
            ...(rm.scoped ? { scope: base.scope } : {}),
          }),
      }]),
    ),
    // carry the app's per-app runtime config on the surface (never a process global) — `buildOpCtx` reads
    // these off it for the injected ctx members + `ctx.queue`'s scheduling cap; absent on the lean/app-less ctx.
    ctxExtras: app.ctxExtras,
    schedulingCap: app.schedulingCap ?? null,
    outboxBackpressure: app.backpressure,
  });
}

/** The full op-handler `ctx` surface (05-runtime.md §ctx): the base actor/scope/db + the `data` facade,
 *  the sole status writer `transition`, the outbox `emit`, and the raw-SQL `query` escape door. */
export interface FullCtx extends ReadCtx {
  readonly db: Db;
  readonly data: Record<string, ResourceData>;
  /** `ctx.config.<r>` — the singleton config surface (read-or-seed / full-replace), present for each
   *  `singleton` resource (04-features.md §singleton-marker). Empty when no resource declares the marker. */
  readonly config: Record<string, ConfigData>;
  /** `ctx.transition(to)` binds to the op's subject (an instance op's route/tool `:id`); a subject-less
   *  relay/subscriber/job ctx has none, so its single-arg form errs loud → use the three-arg escape. */
  transition(to: string): Promise<Result<{ id: string; status: string }>>;
  transition(
    resource: string,
    id: string,
    to: string,
  ): Promise<Result<{ id: string; status: string }>>;
  emit(msg: OutboxMsg): Promise<string>;
  /** `ctx.queue.enqueue(name, payload)` — the in-tx background-work effect surface (05-runtime.md §4);
   *  `ctx.queue.schedule(at, job, payload)` is its scheduled-one-shot sibling (05-runtime.md §4.1). */
  readonly queue: QueueSurface;
  /** `ctx.tasks.<name>.submit(input)` — submits an async task (05-runtime.md §task): writes `_tasks` + the
   *  drain enqueue in this tx (submitted iff the op commits); `.cancel` requests cooperative cancellation. */
  readonly tasks: Record<
    string,
    {
      submit(input: unknown): Promise<Result<{ taskId: string }>>;
      cancel(taskId: string): Promise<Result<{ cancelling: boolean }>>;
    }
  >;
  /** `ctx.schedule(at, job, payload)` — the canon top-level one-shot scheduler (05-runtime.md §4.1). */
  schedule(at: Date, job: string, payload?: unknown): Promise<boolean>;
  /** `ctx.now()` — the one wall-clock source (05-runtime.md §ctx). */
  readonly now: Clock;
  /** `ctx.log` — the op-record decorator (05-runtime.md §6); `set(k, v)` adds an attr to this ctx's record. */
  readonly log: OpLog;
  /** `ctx.code` — the unguessable-code helper (02-dsl.md §unguessable codes); pure and stateless. */
  readonly code: CodeSurface;
  /** `ctx.workflows.<name>.start(input)` — starts (or, with a `workflowId`, resumes) a declared durable
   *  workflow on this ctx's db, so its journal and steps commit with whatever tx the db is bound to. */
  readonly workflows: Record<string, WorkflowSurface>;
  /** `ctx.reads.<module>.<resource>` — the cross-module READ channel (a module's published read surface). */
  readonly reads: ReturnType<typeof readsOf>;
  /** `ctx.readModels.<name>.read(q?)` — the read side of a `defineReadModel` projection (eventually
   *  consistent; never this ctx's tx). */
  readonly readModels: Record<
    string,
    {
      read(
        q?: { readonly id?: string },
      ): Promise<Array<Record<string, unknown>>>;
    }
  >;
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
  /** `ctx.datasource(name).query(sql, params)` — a named external datasource's raw-SQL door (05-runtime.md
   *  §datasources), a separate connection (never the op tx). Throws loud when unconfigured / an unknown name. */
  datasource(name: string): DatasourceHandle;
  /** `ctx.modules` — the cross-module channel; present only when `db` is a Transactor and a module is named. */
  readonly modules?: ModulesFacade;
  /** `ctx.i18n` — the canon translation surface (`resolve`/`set` over the `<r>_i18n` sidecar). */
  readonly i18n?: I18nSurface;
}

export function makeCtx(
  app: App,
  db: Db,
  base: ReadCtx,
  kms?: Kms,
  selfModule?: string,
  datasources?: Datasources,
): FullCtx {
  const txDb = db as Db & Transactor; // ctx.modules needs a Transactor; absent one, the facade is simply empty/unused
  const queue = makeQueueSurface(
    db,
    base,
    app.schedulingCap ?? null,
    app.backpressure,
  ); // enqueue + one-shot schedule bound to this db; app's per-app cap + backpressure threaded through
  return {
    ...base,
    db,
    data: dataOf(app, db, base, kms, selfModule),
    i18n: buildI18nSurface(app.model, db, base, kms), // ctx.i18n.resolve/set surface, wired live
    config: configOf(app, db, base, kms, selfModule), // ctx.config.<r> — the singleton read-or-seed / replace surface
    transition: ((a: string, b?: string, c?: string) => {
      // makeCtx is the relay/subscriber/job ctx (no route `:id`) → no ambient subject, so the single-arg
      // `ctx.transition(to)` form is rejected loud; emit binds to `db` so the transition rides the same tx as the CAS.
      if (b === undefined) {
        return Promise.resolve(
          err(
            "internal",
            "ctx.transition(to) needs an instance-op subject; a relay/subscriber/job context has none — use ctx.transition(resource, id, to)",
          ),
        );
      }
      const m = app.model.find((x) => x.name === a);
      if (!m) throw new Error(`ctx.transition: no resource '${a}'`);
      return transition(db, m, base, b, c!, {
        // same stamping door as the op-tx composition — a relay/subscriber/job transition is as durable.
        emit: (msg) => emitStamped(db, base, msg, app.backpressure),
      });
    }) as OpSurface["transition"],
    // redacts `sensitive ∪ encrypted` from the payload before `_outbox`, then uses `emitStamped` (not the bare
    // `emit`) so an unscoped chained-subscriber emit defaults to `base.scope` — see 13-authz §162.
    // parse-at-emit before redaction (05-runtime.md §event-surface-lock) — the same producer-side gate as the
    // op-tx binding, so a relay/subscriber/job re-emit honours the typed contract too.
    emit: (msg) => {
      validateEmitPayload(app, msg);
      return emitStamped(
        db,
        base,
        { ...msg, payload: redactEmitPayload(app, msg) },
        app.backpressure,
        app.schedulingCap,
      ); // + the per-source emit budget
    },
    queue,
    tasks: tasksSurface(app, db, base), // ctx.tasks.<name>.submit(input) — the async-task submit surface (05-runtime.md §task); {} when no task declared
    // The three members an op ctx carries that this composition once did not. A ctx the test harness hands a
    // consumer must be the SAME surface their handler runs on — a narrower one makes a shipped member
    // untestable through the door the framework itself documents for testing.
    workflows: workflowsSurface(
      app,
      db,
      kms,
      db.concurrent ? db : undefined,
      { actor: base.actor, traceId: base.traceId, scope: base.scope },
    ),
    reads: readsOf(app, txDb, base, selfModule ?? "app"),
    // `actor` is threaded here for the reason the surrounding comment gives: the projection's own gate
    // (`readmodel/rowpolicy-required`) is evaluated against it, so a ctx that dropped it answered every
    // gated read as the null caller — a different surface from the one the handler runs on.
    readModels: Object.fromEntries(
      (app.readModels ?? []).map((rm) => [rm.name, {
        read: (q: { readonly id?: string } = {}) =>
          readReadModel(db, rm, {
            ...q,
            actor: base.actor,
            ...(rm.scoped ? { scope: base.scope } : {}),
          }),
      }]),
    ),
    schedule: queue.schedule, // ctx.schedule(at, job, payload) — the canon top-level one-shot (05-runtime.md §4.1)
    // The three members `buildOpCtx` composes itself. Absent here, a handler helper reading `ctx.now()` or
    // decorating `ctx.log` was unreachable from the harness ctx and from a relay/subscriber/job ctx alike.
    // A fresh `log` per ctx, matching the op path: the record is per-invocation, never shared.
    // The clock comes off `base` — the same slot `buildOpCtx` reads — so freezing time reaches BOTH ctx
    // compositions; minting one here would leave `t.ctx.now()` live while the op path was frozen.
    now: base.now ?? (() => new Date()),
    log: makeOpLog(),
    code: codeSurface,
    query: (sql, params) => db.query(sql, params),
    datasource: datasourceAccessor(datasources), // ctx.datasource(name) → the external datasource's own connection (never db — best-effort, outside any tx)
    modules: selfModule !== undefined && typeof txDb.transaction === "function"
      ? modulesOf(app, txDb, base, selfModule, datasources)
      : undefined,
  };
}
