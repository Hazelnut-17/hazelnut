// Barrel re-exports keep import sites stable.
import type { App } from "../core/app.ts";
import {
  type ContextHome,
  contextHome,
  declaredContextHome,
  FLAT_APP_HOME,
  inContextHome,
} from "../core/context-home.ts";
import { resolveBare } from "../core/slot.ts";
import { type CodeSurface, codeSurface } from "../core/code-helpers.ts";
import { type Clock, makeOpLog, type OpLog } from "../core/ctx-provenance.ts";
import {
  assertEmitUnstamped,
  emitStamped,
  makeQueueSurface,
  type OpSurface,
  type QueueSurface,
} from "../core/ctx.ts";
import type { SavepointScope } from "../core/ctx-surface.ts";
import type { OpCtxIn, SurfaceFactory } from "../core/pipeline.ts";
import { currentSurfaceCaller } from "../core/surface-caller.ts";
import { err, type Result } from "../core/result.ts";
import type { Kms } from "../features/encrypt.ts";
import { buildI18nSurface, type I18nSurface } from "../features/i18n.ts";
import { egress, egressOpWithLoss } from "../features/redact.ts";
import { transition } from "../features/transition.ts";
import {
  runViewQuery,
  type ViewEnvelope,
  type ViewQuery,
} from "../features/view.ts";
import { readReadModel } from "../features/readmodel.ts";
import type { EmitMsg, OutboxMsg } from "../runtime/outbox.ts";
import { buildUpcasterChain } from "../features/versioning.ts";
import { tasksSurface, type TaskSurface } from "../runtime/tasks.ts";
import {
  setWorkflowCtxBuilder,
  type WorkflowRuntime,
  workflowsSurface,
  type WorkflowSurface,
} from "../runtime/workflow.ts";
import { crudWriteDenied, systemActor } from "../authz/auth.ts";
import {
  appQueueGuard,
  type ConfigData,
  configOf,
  dataOf,
  type DataQuery,
  type ModulesFacade,
  redactAppPayload,
  type ResourceData,
  validateEmitPayload,
} from "./data-verbs.ts";
import { opIsCollection } from "../core/app-refs.ts";
import { crudWriteTx, dispatchOp } from "../core/pipeline.ts";
import type { DatasourceHandle, Datasources } from "./datasources.ts";
import {
  type Db,
  isTransactor,
  type Transactor,
  withDeadlockRetry,
} from "./db.ts";
import { guardedQuery } from "./sql-transaction-control.ts";
import { transactionScopeDb } from "./transaction-scope.ts";
import { inTxSavepoint } from "./tx-locks.ts";
import type { ReadCtx, RestoreOptions } from "./repo.ts";
import { wholeImmutable } from "./schema.ts";
import { crossModuleCrudResult } from "./cross-module-egress.ts";

/** A caught transition failure must unwind its CAS, audit and fact before the caller continues. */
async function atomicTransition<T>(
  db: Db,
  run: (tx: Db) => Promise<Result<T>>,
): Promise<Result<T>> {
  class Rejected extends Error {
    constructor(readonly result: Result<T>) {
      super("transition rejected");
    }
  }
  const work = async (tx: Db) => {
    const result = await run(tx);
    if (!result.ok) throw new Rejected(result);
    return result;
  };
  try {
    if (isTransactor(db)) return await db.transaction(work);
    return await inTxSavepoint(db, work);
  } catch (error) {
    if (error instanceof Rejected) return error.result;
    throw error;
  }
}

/** Resolve a transition's resource name inside the capability that owns this context. Resource names may repeat
 * across modules because their tables live in distinct schemas; selecting app.model's first match would let a
 * billing context mutate sales' identically named resource. A context with no module identity may use a bare
 * name only when it is app-wide unambiguous. */
function transitionResource(
  app: App,
  resource: string,
  selfModule?: string | ContextHome,
) {
  const home = selfModule === undefined
    ? undefined
    : contextHome(app, selfModule);
  const named = app.model.filter((m) => m.name === resource);
  const candidates = selfModule === undefined
    ? named
    : named.filter((m) => inContextHome(m, home!));
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length === 0) {
    const qualifier = selfModule === undefined
      ? "the application"
      : `module '${home!.module}' in schema '${home!.pgSchema}'`;
    throw new Error(
      `ctx.transition: no resource '${resource}' in ${qualifier}`,
    );
  }
  throw new Error(
    `ctx.transition: resource '${resource}' is ambiguous across modules (${
      candidates.map((m) => m.module).join(", ")
    }); call from a module-bound context`,
  );
}

type CrossModuleCaller = {
  readonly readOnly?: boolean;
  readonly transactionActive?: boolean;
};

/** Dependency work owns the base connection; neither read-only nor single-session callers may escape it. */
function crossModuleRefusal(
  db: Db,
  caller: CrossModuleCaller | undefined,
  write: boolean,
): Result<never> | undefined {
  if (caller?.readOnly && write) {
    return err(
      "forbidden",
      'tx/read-op-no-write: a tx:"read" caller cannot invoke a dependency write operation',
      { code: "tx/read-op-no-write" },
    );
  }
  if (
    caller?.transactionActive === true &&
    db.concurrent !== true
  ) {
    return err(
      "validation",
      "transaction/nested-base-unavailable: an independent dependency call needs a concurrent database while the caller transaction is open; use a real Postgres pool or call outside that transaction",
      { code: "transaction/nested-base-unavailable" },
    );
  }
  return undefined;
}

/** `ctx.modules` — the cross-module OP facade, the write-side twin of `readsOf` below. It lives here
 *  rather than beside the repo verbs because each dep call needs a fresh `opSurfaceFactory` surface: with
 *  the function on the other side of that import, the two files could only reach each other in a cycle. */
export function modulesOf(
  app: App,
  db: Db & Transactor,
  base: OpCtxIn,
  selfModule: string | ContextHome,
  datasources?: Datasources,
  runtime?: WorkflowRuntime,
  kms?: Kms,
  caller?: CrossModuleCaller,
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
  const home = contextHome(app, selfModule);
  const self = app.model.filter((m) => inContextHome(m, home));
  const declaredDeps = new Set(self.flatMap((m) => m.moduleDeps));
  for (const dep of declaredDeps) {
    const depModels = (byModule.get(dep) ?? []).filter((m) =>
      m.pgSchema === dep
    );
    // the dep's public op surface — only ops the dep module lists in `exposes` (its `moduleExposes`)
    const exposed = new Set(depModels.flatMap((m) => m.moduleExposes));
    const ops: Record<
      string,
      (input: unknown, idempotencyKey?: string) => Promise<Result<unknown>>
    > = {};
    for (const opName of exposed) {
      // find the resource in the dep module that declares this op (an exposed op must resolve to a real op)
      const carrier = depModels.find((m) => opName in m.operations);
      if (!carrier) {
        if (
          !["list", "find", "count", "create", "update", "delete", "restore"]
            .includes(opName)
        ) continue;
        ops[opName] = async (input, key) => {
          const refused = crossModuleRefusal(
            db,
            caller,
            !["list", "find", "count"].includes(opName),
          );
          if (refused) return refused;
          if (
            key !== undefined || !input || typeof input !== "object" ||
            Array.isArray(input)
          ) {
            return err(
              "validation",
              "cross-module CRUD requires a resource carrier and no idempotency key",
            );
          }
          const value = input as Record<string, unknown>;
          const target = depModels.find((m) => m.name === value.resource);
          if (
            !target || (opName === "restore" && !target.features.softDelete) ||
            ((opName === "update" || opName === "delete") &&
              wholeImmutable(target.features))
          ) {
            return err(
              "validation",
              "cross-module CRUD resource or verb is unavailable",
            );
          }
          const keys = opName === "create"
            ? ["resource", "data"]
            : opName === "update"
            ? ["resource", "id", "patch", "expectedVersion"]
            : opName === "delete"
            ? ["resource", "id", "expectedVersion"]
            : opName === "restore"
            ? ["resource", "id", "options"]
            : opName === "find"
            ? ["resource", "id", "asOf"]
            : ["resource", "query"];
          if (
            Object.keys(value).some((name) => !keys.includes(name)) ||
            (["find", "update", "delete", "restore"].includes(opName) &&
              typeof value.id !== "string")
          ) {
            return err(
              "validation",
              "cross-module CRUD input failed validation",
            );
          }
          if (value.query !== undefined) {
            if (
              value.query === null || typeof value.query !== "object" ||
              Array.isArray(value.query)
            ) {
              return err(
                "validation",
                "cross-module CRUD query must be an object",
              );
            }
            const query = value.query as Record<string, unknown>;
            if (
              (opName !== "count" && query.search !== undefined) ||
              (!target.features.temporal && query.asOf !== undefined)
            ) {
              return err(
                "validation",
                "cross-module CRUD query option is unavailable on this resource",
              );
            }
          }
          if (
            (!target.features.versioning &&
              value.expectedVersion !== undefined) ||
            (opName === "find" && !target.features.temporal &&
              value.asOf !== undefined)
          ) {
            return err(
              "validation",
              "cross-module CRUD option is unavailable on this resource",
            );
          }
          const write = opName === "restore" ? "update" : opName;
          if (crudWriteDenied(base.actor, target.name, write, true)) {
            return err("forbidden", "policy denied");
          }
          // The target module owns the binding and the transaction opener. Never borrow the caller's tx.
          const run = async (tx: Db): Promise<Result<unknown>> => {
            const repo = dataOf(app, tx, base, kms, {
              module: dep,
              pgSchema: dep,
            }, true)[target.name]!;
            switch (opName) {
              case "list":
                return repo.list(value.query as DataQuery | undefined);
              case "count":
                return repo.count(
                  value.query as (DataQuery & { search?: string }) | undefined,
                );
              case "find":
                return repo.find(
                  value.id as string,
                  value.asOf === undefined
                    ? undefined
                    : { asOf: value.asOf as Date | string },
                );
              case "create":
                return repo.create(value.data as Record<string, unknown>);
              case "update":
                return repo.update(
                  value.id as string,
                  value.patch as Record<string, unknown>,
                  value.expectedVersion as number | undefined,
                );
              case "delete":
                return repo.delete(
                  value.id as string,
                  value.expectedVersion as number | undefined,
                );
              case "restore":
                return repo.restore(
                  value.id as string,
                  value.options as RestoreOptions | undefined,
                );
            }
            return err("validation", "cross-module CRUD verb is unavailable");
          };
          class Rejected extends Error {
            constructor(readonly result: Result<unknown>) {
              super("cross-module CRUD rejected");
            }
          }
          try {
            return await withDeadlockRetry(() =>
              crudWriteTx(db, async (tx) => {
                const result = await run(tx);
                if (!result.ok) throw new Rejected(result);
                return crossModuleCrudResult(depModels, target, result);
              }, base.signal)
            );
          } catch (error) {
            if (error instanceof Rejected) return error.result;
            throw error;
          }
        };
        continue;
      }
      ops[opName] = (input, idempotencyKey) => {
        const refused = crossModuleRefusal(
          db,
          caller,
          (carrier.operations[opName] as { tx?: unknown }).tx !== "read",
        );
        if (refused) return Promise.resolve(refused);
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
          opSurfaceFactory(
            app,
            base,
            carrier,
            kms,
            subject,
            datasources,
            runtime,
          )(
            db,
          ),
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
  selfModule: string | ContextHome,
  caller?: CrossModuleCaller,
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
  const home = contextHome(app, selfModule);
  const self = app.model.filter((m) => inContextHome(m, home));
  const declaredDeps = new Set(self.flatMap((m) => m.moduleDeps)); // only declared deps become keys
  const readCtx: ReadCtx = { actor: base.actor, scope: base.scope }; // the caller's principal/scope rides the dep read
  for (const dep of declaredDeps) {
    const depModels = (byModule.get(dep) ?? []).filter((m) =>
      m.pgSchema === dep
    );
    // the dep's public read surface — only view names the dep module lists in `exposesRead`.
    const exposedReads = new Set(depModels.flatMap((m) => m.moduleExposesRead));
    const fns: Record<string, (q: ViewQuery) => Promise<ViewEnvelope>> = {};
    for (const viewName of exposedReads) {
      const view = views.find((v) => v.name === viewName);
      if (!view) continue; // an exposesRead name resolving to no view is inert (boot already loud-checks it)
      // a run-form view has no single `over` (it derives nothing) → it is not wired into ctx.reads pagination here.
      if (view.over === undefined) continue;
      const overHit = resolveBare(app.model, view.over);
      if (
        overHit.kind !== "hit" ||
        !inContextHome(overHit.value, declaredContextHome(dep))
      ) continue;
      const srcModel = overHit.value;
      fns[viewName] = async (q: ViewQuery): Promise<ViewEnvelope> => {
        const refused = crossModuleRefusal(db, caller, false);
        if (refused && !refused.ok) {
          throw Object.assign(new Error(refused.error.message), refused.error);
        }
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

/** `ctx.savepoint(fn)`: `fn` runs against a scope bound to a savepoint of `db`'s open transaction, so a throw
 *  rolls back only what `fn` did. No open transaction ⇒ a loud refusal, never a silent un-nested run. */
function savepointOf<S, T>(
  db: Db,
  scope: (sp: Db) => S,
  fn: (sp: S) => Promise<T>,
): Promise<T> {
  if (db.savepoint === undefined) {
    return Promise.reject(
      new Error(
        "ctx.savepoint: this context has no open transaction to nest in — use it inside a write operation, task, worker or subscriber",
      ),
    );
  }
  const pending = inTxSavepoint(db, (sp) => fn(scope(sp)));
  // The owned boundary can interrupt a child whose caller forgot to await it. Observe this public
  // promise too (not only the driver task), while returning the SAME rejection to an explicit await.
  pending.catch(() => {});
  return pending;
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

/** New app-authored payloads use the same topic revision the relay expects. An explicit stamp
 * remains the caller's contract; bare app-less producers retain emit's v1 fallback. */
function withEventRevision(app: App, msg: OutboxMsg): OutboxMsg {
  const registry = app.relay?.upcasters;
  const spec = registry !== undefined && Object.hasOwn(registry, msg.topic)
    ? registry[msg.topic]
    : undefined;
  return {
    ...msg,
    schemaVersion: msg.schemaVersion ??
      (spec === undefined
        ? 1
        : buildUpcasterChain(spec.links, spec.currentVersion).currentVersion),
  };
}

/** Every effect exposed on the callback is bound to the savepoint handle. External datasources and
 *  outer-context effects retain their separately documented transaction boundaries. */
function savepointScope(
  app: App,
  db: Db,
  base: ReadCtx,
  kms?: Kms,
  selfModule?: string | ContextHome,
): SavepointScope<Record<string, ResourceData>> {
  db = transactionScopeDb(db);
  return {
    data: dataOf(app, db, base, kms, selfModule, true),
    query: guardedQuery(db),
    queue: makeQueueSurface(
      db,
      base,
      app.schedulingCap ?? null,
      app.backpressure,
      appQueueGuard(app),
      true,
    ),
    emit: (msg) => {
      assertEmitUnstamped(msg);
      validateEmitPayload(app, msg, selfModule ?? FLAT_APP_HOME, base.scope);
      return emitStamped(
        db,
        base,
        withEventRevision(app, {
          ...msg,
          payload: redactAppPayload(app, msg.payload),
        }),
        app.backpressure,
        app.schedulingCap,
      );
    },
  };
}

// Install the workflow's ctx builder without introducing a reverse value import into workflow.ts.
setWorkflowCtxBuilder(
  (app, kms, workflowId, scope, selfModule, actor, runtime) => (db) => ({
    ...makeCtx(
      app,
      db,
      {
        actor: actor ?? systemActor(`workflow:${workflowId}`),
        scope: scope ?? "",
        origin: "workflow",
      },
      kms,
      declaredContextHome(selfModule),
      undefined,
      true,
      runtime?.baseDb,
      runtime,
    ),
    signal: runtime?.signal,
    storage: runtime?.storage,
    baseDb: runtime?.baseDb,
  }),
);

export function opSurfaceFactory(
  app: App,
  base: OpCtxIn,
  selfModule: string | ContextHome,
  kms?: Kms,
  subject?: { readonly resource: string; readonly id: string },
  datasources?: Datasources,
  runtime?: WorkflowRuntime,
): (db: Db & Transactor) => SurfaceFactory {
  return (baseDb) =>
    Object.assign(
      (txDb: Db, readBase: Db & Transactor = baseDb): OpSurface => {
        const caller = currentSurfaceCaller(txDb);
        txDb = transactionScopeDb(txDb);
        const dependencyCaller = {
          readOnly: caller?.readOnly === true,
          transactionActive: caller?.transactionActive === true ||
            txDb.transactionScoped === true,
        };
        return ({
          data: dataOf(app, txDb, base, kms, selfModule, true), // this surface is rebound to the op's live tx
          // ctx.config.<r> and ctx.i18n — canon surfaces (04-features.md §singleton-marker, §i18n) that this
          // composition once omitted while `makeCtx` carried them, so an op handler calling either hit `undefined`
          // at runtime while the same call through the test harness's ctx passed. The two compositions are pinned
          // equal by a tooth now; adding a member to one without the other is RED.
          config: configOf(app, txDb, base, kms, selfModule),
          i18n: buildI18nSurface(app.model, txDb, base, kms),
          tasks: tasksSurface(app, txDb, base, runtime?.storage), // ctx.tasks.<name>.submit — the async-task submit, in this op's tx (05-runtime.md §task)
          // ctx.workflows.<name>.start — runs a declared durable workflow on THIS op's db, so its journal and its
          // steps' writes commit or roll back with the op (workflow.ts §workflowsSurface has the tx rationale).
          // `recordDb` is the out-of-band failure-record connection (a real pool only — PGlite would deadlock);
          // the journal still rides `txDb`. Origin carries the op's actor + wire correlation for attribution.
          workflows: workflowsSurface(
            app,
            txDb,
            kms,
            readBase.concurrent ? readBase : undefined,
            { actor: base.actor, traceId: base.traceId, scope: base.scope },
            {
              ...runtime,
              datasource: runtime?.datasource ??
                datasourceAccessor(datasources),
              baseDb: readBase,
            },
          ),
          // ctx.emit masks every resource's `sensitive ∪ encrypted` names before `_outbox`, overriding buildOpCtx's
          // bare base emit (spread order) for served handlers; ctx.queue masks through the surface's payloadRedactor.
          // parse-at-emit before redaction (05-runtime.md §event-surface-lock): a typed topic's payload is strict-
          // parsed against its declared `emits` schema — a mismatch throws `validation` and rolls this op's tx back.
          emit: (msg) => {
            assertEmitUnstamped(msg);
            validateEmitPayload(app, msg, selfModule ?? "app", base.scope);
            return emitStamped(
              txDb,
              base,
              withEventRevision(app, {
                ...msg,
                payload: redactAppPayload(app, msg.payload),
              }),
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
            const m = transitionResource(app, resource, selfModule);
            return atomicTransition(txDb, (transitionDb) =>
              transition(transitionDb, m, base, id, to, {
                kms,
                // `emitStamped`, never the bare `emit`: the status-change fact carries the op's trace_context, and
                // an unscoped resource's row defaults to `base.scope` rather than landing NULL (= crossScope).
                // Parse-at-emit still applies: the event-surface lock publishes a declared `emits` shape as the
                // PRODUCER contract, and this is the producer — unchecked, that lock could never fire.
                emit: (msg) => {
                  validateEmitPayload(
                    app,
                    msg,
                    selfModule ?? "app",
                    base.scope,
                  );
                  return emitStamped(
                    transitionDb,
                    base,
                    withEventRevision(app, msg),
                    app.backpressure,
                  );
                },
              }));
          }) as OpSurface["transition"],
          query: guardedQuery(txDb),
          savepoint: (fn) =>
            savepointOf(txDb, (sp) =>
              savepointScope(app, sp, base, kms, selfModule), fn),
          datasource: runtime?.datasource ?? datasourceAccessor(datasources), // ctx.datasource(name) → the external datasource's own connection (never txDb — best-effort, outside the op tx)
          modules: modulesOf(
            app,
            readBase,
            base,
            selfModule,
            datasources,
            runtime,
            kms,
            dependencyCaller,
          ),
          // ctx.reads is the dep's own read on the base db (like a dep op) — never folded into the caller's tx.
          reads: readsOf(app, readBase, base, selfModule, dependencyCaller),
          // ctx.readModels — the projection read side, on the base db like ctx.reads (eventually-consistent, never
          // in this op's tx). A scoped read-model auto-threads ctx.scope and every read carries ctx.actor for the
          // projection's own gate — fail-closed, a handler cannot name a foreign scope or a different caller.
          readModels: Object.fromEntries(
            (app.readModels ?? []).map((rm) => [rm.name, {
              read: (q: { readonly id?: string } = {}) =>
                readReadModel(readBase, rm, {
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
          queueGuard: appQueueGuard(app),
        });
      },
      {
        // the masked egress: an HTTP replay re-egresses and drops the masked keys, an MCP replay keeps the mask
        replayShape: (value: unknown) =>
          egressOpWithLoss(app.model, value, { mask: true }).value,
      },
    );
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
  transition(
    to: string,
  ): Promise<Result<{ id: string; status: string; version?: number }>>;
  transition(
    resource: string,
    id: string,
    to: string,
  ): Promise<Result<{ id: string; status: string; version?: number }>>;
  emit(msg: EmitMsg): Promise<string>;
  /** `ctx.queue.enqueue(name, payload)` — the in-tx background-work effect surface (05-runtime.md §async-core);
   *  `ctx.queue.schedule(at, job, payload)` is its scheduled-one-shot sibling (05-runtime.md §multi-replica-scheduling). */
  readonly queue: QueueSurface;
  /** `ctx.tasks.<name>.submit(input)` — submits an async task (05-runtime.md §task): writes `_tasks` + the
   *  drain enqueue in this tx (submitted iff the op commits); `.cancel` requests cooperative cancellation. */
  readonly tasks: Record<string, TaskSurface>;
  /** `ctx.schedule(at, job, payload)` — the canon top-level one-shot scheduler (05-runtime.md §multi-replica-scheduling). */
  schedule(at: Date, job: string, payload?: unknown): Promise<boolean>;
  /** `ctx.now()` — the one wall-clock source (05-runtime.md §ctx). */
  readonly now: Clock;
  /** `ctx.log` — the op-record decorator (05-runtime.md §runtime-provenance); `set(k, v)` adds an attr to this ctx's record. */
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
  /** `ctx.savepoint(fn)` — `fn` in a savepoint of this ctx's open transaction (see `OpSurface`). */
  savepoint<T>(
    fn: (sp: SavepointScope<Record<string, ResourceData>>) => Promise<T>,
  ): Promise<T>;
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
  selfModule?: string | ContextHome,
  datasources?: Datasources,
  transactionBound = false,
  /** A concurrent connection beside `db` for out-of-band records — the relay's base pool when `db` is a
   *  consumer's transaction, so a background `ctx.workflows.start` keeps its failure record. */
  recordDb?: Db,
  runtime?: WorkflowRuntime,
): FullCtx {
  db = transactionScopeDb(db);
  const txDb = db as Db & Transactor; // ctx.modules needs a Transactor; absent one, the facade is simply empty/unused
  const queue = makeQueueSurface(
    db,
    base,
    app.schedulingCap ?? null,
    app.backpressure,
    appQueueGuard(app),
    transactionBound,
  ); // enqueue + one-shot schedule bound to this db; app's per-app cap + backpressure + queue guard
  return {
    ...base,
    db,
    data: dataOf(app, db, base, kms, selfModule, transactionBound),
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
      const m = transitionResource(app, a, selfModule);
      return atomicTransition(
        db,
        (transitionDb) =>
          transition(transitionDb, m, base, b, c!, {
            kms,
            // same stamping door as the op-tx composition — a relay/subscriber/job transition is as durable,
            // and carries the same parse-at-emit check against a declared payload contract.
            emit: (msg) => {
              validateEmitPayload(
                app,
                msg,
                selfModule ?? FLAT_APP_HOME,
                base.scope,
              );
              return emitStamped(
                transitionDb,
                base,
                withEventRevision(app, msg),
                app.backpressure,
              );
            },
          }),
      );
    }) as OpSurface["transition"],
    // masks every resource's `sensitive ∪ encrypted` names before `_outbox`, then uses `emitStamped` (not the bare
    // `emit`) so an unscoped chained-subscriber emit defaults to `base.scope` — see 13-authz §162.
    // parse-at-emit before redaction (05-runtime.md §event-surface-lock) — the same producer-side gate as the
    // op-tx binding, so a relay/subscriber/job re-emit honours the typed contract too.
    emit: (msg) => {
      assertEmitUnstamped(msg);
      validateEmitPayload(app, msg, selfModule ?? FLAT_APP_HOME, base.scope);
      return emitStamped(
        db,
        base,
        withEventRevision(app, {
          ...msg,
          payload: redactAppPayload(app, msg.payload),
        }),
        app.backpressure,
        app.schedulingCap,
      ); // + the per-source emit budget
    },
    queue,
    tasks: tasksSurface(app, db, base, runtime?.storage), // ctx.tasks.<name>.submit(input) — the async-task submit surface (05-runtime.md §task); {} when no task declared
    // The three members an op ctx carries that this composition once did not. A ctx the test harness hands a
    // consumer must be the SAME surface their handler runs on — a narrower one makes a shipped member
    // untestable through the door the framework itself documents for testing.
    workflows: workflowsSurface(
      app,
      db,
      kms,
      recordDb?.concurrent ? recordDb : db.concurrent ? db : undefined,
      { actor: base.actor, traceId: base.traceId, scope: base.scope },
      {
        ...runtime,
        datasource: runtime?.datasource ?? datasourceAccessor(datasources),
        baseDb: recordDb,
      },
    ),
    reads: readsOf(app, txDb, base, selfModule ?? FLAT_APP_HOME),
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
    schedule: queue.schedule, // ctx.schedule(at, job, payload) — the canon top-level one-shot (05-runtime.md §multi-replica-scheduling)
    // The three members `buildOpCtx` composes itself. Absent here, a handler helper reading `ctx.now()` or
    // decorating `ctx.log` was unreachable from the harness ctx and from a relay/subscriber/job ctx alike.
    // A fresh `log` per ctx, matching the op path: the record is per-invocation, never shared.
    // The clock comes off `base` — the same slot `buildOpCtx` reads — so freezing time reaches BOTH ctx
    // compositions; minting one here would leave `t.ctx.now()` live while the op path was frozen.
    now: base.now ?? (() => new Date()),
    log: makeOpLog(),
    code: codeSurface,
    query: guardedQuery(db),
    savepoint: (fn) =>
      savepointOf(
        db,
        (sp) => savepointScope(app, sp, base, kms, selfModule),
        fn,
      ),
    datasource: runtime?.datasource ?? datasourceAccessor(datasources), // ctx.datasource(name) → the external datasource's own connection (never db — best-effort, outside any tx)
    modules: selfModule !== undefined && typeof txDb.transaction === "function"
      ? modulesOf(app, txDb, base, selfModule, datasources, runtime, kms)
      : undefined,
  };
}
