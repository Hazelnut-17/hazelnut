import { wireJson } from "../core/wire-json.ts";
import { err, errorKind, ok, type Result } from "../core/result.ts";
import { isFrameworkTransactionHandle, isTransactor } from "../data/db.ts";
import { inTxSavepoint } from "../data/tx-locks.ts";
import type { Db } from "../data/db.ts";
import type { ConsumerCtx } from "./events.ts";
import type { App } from "../core/app.ts";
import type { Actor } from "../authz/auth-core.ts";
import { asyncMcpCurationErrors, type OnlyKnownKeys } from "../core/config.ts";
import type { Kms } from "../features/encrypt.ts";
import type { DatasourceHandle } from "../data/datasources.ts";
import type { StorageDriver } from "../data/storage.ts";
import {
  firstRedactedPath,
  type RedactionNames,
  redactionNamesOf,
} from "../features/redact.ts";
import { withAsyncDeadline, withSqlDeadline } from "../core/async-deadline.ts";
import { DEFAULT_HANDLER_TIMEOUT_MS } from "./outbox.ts";
import { taskSubmitter } from "./tasks.ts";
import { uuidv7 } from "../core/id.ts";
import { loudNameDoor } from "../core/ctx-core.ts";
import {
  acquireClaim,
  type DurableClaimSpec,
  fenceGuard,
  startClaimHeartbeat,
} from "../core/durable-claim.ts";

/**
 * Durable workflows (05-runtime.md §workflow durable steps): `defineWorkflow({ name, run })` drives work
 * through `ctx.step(stepId, fn)`, journaled in `_workflow_journal` — a step's `fn` runs once and its result
 * is stored; resume replays a `done` step's stored result without re-running `fn`, so a non-idempotent step
 * (a charge, an email) is never re-burned ON A COMMITTED JOURNAL ROW. In-process floor; an external
 * orchestrator (Temporal / Restate / DBOS) stays a BYO port. The journal composes the shared `durableClaim`
 * crash-reclaim lease + heartbeat (core/durable-claim.ts, same as `_idempotency` — an atomic `INSERT … ON
 * CONFLICT DO UPDATE … WHERE lease-expired RETURNING` dedup arbiter): a live peer racing the same step gets
 * `WorkflowConflictError` instead of double-running `fn`; a clean throw releases the claim for immediate
 * resume.
 *
 * `ctx.workflows.<name>.start()` invoked from inside an op is the one case where "committed" is not implied
 * by "fn returned": every step's journal row rides the calling op's own transaction (see `workflowsSurface`
 * below), so a throw ANYWHERE LATER in that op — in a subsequent step, or in the op's own code after the
 * workflow call returns — rolls back every prior step's `done` mark along with it. A resume then finds no
 * row, not a stale one, and correctly-per-its-own-logic re-runs `fn` — re-burning an external effect
 * (a charge, an email) that already fired. The "never re-burned" guarantee is exact for a standalone
 * `runWorkflow` / `hazelnut run-workflow` run (its journal UPDATE commits on its own); inside an op it holds
 * only if nothing else in that op can throw after the workflow starts, and external-effect safety there is
 * developer-managed through `stepCtx.idempotencyKey`, never free.
 */

/**
 * The crash-reclaim lease window for an in-flight `_workflow_journal` step claim — the same fence
 * `_idempotency` uses. A `'running'` claim younger than the lease is a live peer, so a second runner backs off
 * rather than re-run `fn`; only a claim older than the lease is treated as crashed and reclaimed. Must exceed
 * a step's worst-case wall-clock runtime — the mid-step heartbeat re-stamps at a third of the lease so a
 * slow-but-alive step is never reclaimed. `wf.leaseMs` overrides this floor per workflow.
 */
export const WORKFLOW_STEP_LEASE_MS = 5 * 60 * 1000;

/** Thrown when a step's claim is held by a live peer: a concurrent runner of the same `workflowId` owns this
 *  step. The losing runner aborts with this instead of re-running `fn`; a later resume replays the peer's
 *  committed result. */
export class WorkflowConflictError extends Error {
  readonly kind = "stale" as const;
  constructor(readonly workflowId: string, readonly stepId: string) {
    super(
      `workflow step '${workflowId}:${stepId}' is already in flight on a concurrent runner (claim lease still live) — back off and resume`,
    );
    this.name = "WorkflowConflictError";
  }
}

/** The `_workflow_journal` durable-claim spec — reuses the shared `durableClaim` primitive's lease+heartbeat
 *  fence rather than hand-rolling one. In-flight = a `'running'` row; done = a finalized `'done'` row whose
 *  `result` replays. */
const WORKFLOW_CLAIM: DurableClaimSpec = {
  table: "_workflow_journal",
  keyCols: ["workflow_id", "step_id"],
  inflight: "status <> 'done'",
  done: "status = 'done'",
};

/** A `_workflow_journal` step claim's operator-facing state — read-only, for `hazelnut unstick-workflow`'s
 *  plan. `live` mirrors exactly what `acquireClaim`'s reclaim predicate tests (`ageMs < leaseMs`), so the
 *  plan never claims a stuck row is safe to force when a live peer would still refuse to take it over. */
export interface WorkflowClaimState {
  readonly status: string;
  readonly ageMs: number;
  readonly leaseMs: number;
  readonly live: boolean;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly lockedAt: string;
  readonly createdAt: string;
}

/** Read one step claim's state, or `null` if no such `(workflowId, stepId)` row exists. `leaseMs` is the
 *  caller's resolved value (the declared workflow's `leaseMs` override, or the floor) — this function only
 *  reads the row and compares against it, exactly what `acquireClaim`'s reclaim predicate does server-side. */
export async function inspectWorkflowClaim(
  db: Db,
  workflowId: string,
  stepId: string,
  leaseMs: number,
): Promise<WorkflowClaimState | null> {
  const { rows } = await db.query<
    {
      status: string;
      age_ms: number;
      attempts: number;
      last_error: string | null;
      locked_at: string;
      created_at: string;
    }
  >(
    `SELECT status, attempts, last_error, locked_at::text AS locked_at, created_at::text AS created_at,
            extract(epoch from (now() - locked_at)) * 1000 AS age_ms
       FROM "_workflow_journal" WHERE workflow_id = $1 AND step_id = $2`,
    [workflowId, stepId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    status: r.status,
    ageMs: r.age_ms,
    leaseMs,
    live: r.status !== "done" && r.age_ms < leaseMs,
    attempts: r.attempts,
    lastError: r.last_error,
    lockedAt: r.locked_at,
    createdAt: r.created_at,
  };
}

/** Force a stuck step claim reclaimable NOW rather than waiting out its lease — rewinds `locked_at` to the
 *  epoch under the exact `inflight` predicate `acquireClaim` itself reclaims on, so the next `acquireClaim`
 *  takes the identical natural-reclaim path, never a bespoke one. A `done` claim never matches `inflight` and
 *  is therefore never touched. Returns `false` when there was no matching in-flight row (a clean no-op, not
 *  an error — the claim may have already finished or been reclaimed by the time this runs). */
export async function forceExpireWorkflowClaim(
  db: Db,
  workflowId: string,
  stepId: string,
  expectedLockedAt?: string,
  expectedCreatedAt?: string,
): Promise<boolean> {
  const { rows } = await db.query<{ ok: true }>(
    `UPDATE "_workflow_journal" SET locked_at = 'epoch'
       WHERE workflow_id = $1 AND step_id = $2 AND ${WORKFLOW_CLAIM.inflight} AND ($3::text IS NULL OR locked_at = $3::timestamptz) AND ($4::text IS NULL OR created_at = $4::timestamptz)
     RETURNING true AS ok`,
    [workflowId, stepId, expectedLockedAt ?? null, expectedCreatedAt ?? null],
  );
  return rows.length > 0;
}

/**
 * The per-step ctx handed to a `step` body — the base consumer/system ctx plus the step's own stable
 * identity. `idempotencyKey` is the journal's exact `${workflowId}:${stepId}` tuple, surfaced so a step's
 * out-of-tx external effect (an LLM call, a charge) can pass it as the provider's idempotency key — a
 * crash-mid-call resume then de-dups at the provider. The framework guarantees key-parity; it does not — and
 * cannot — promise exactly-once for an effect outside the per-step tx (05-runtime.md §workflow).
 */
export type StepCtx = ConsumerCtx & {
  /** This step's workflow run id — the journal partition. */
  readonly workflowId: string;
  /** This step's id — the journal step key. */
  readonly stepId: string;
  /** `${workflowId}:${stepId}` — the stable external-idempotency key, identical to the journal tuple. */
  readonly idempotencyKey: string;
};

/**
 * The workflow-handler ctx — the base consumer/system ctx plus `step(stepId, fn)`, the only durable-checkpoint
 * primitive: the workflow body calls it for each unit of replayable work, and the journal decides
 * run-vs-replay.
 */
export type WorkflowCtx = ConsumerCtx & {
  /**
   * Run a durable step, or replay its journaled result. On the first reach of `(workflowId, stepId)` the
   * `fn` executes and its return value is stored; on resume the stored result is returned and `fn` is
   * skipped. The result must be JSON-serializable.
   *
   * `fn` receives a `stepCtx` bound to the step's own per-step tx: its `stepCtx.data`/`transition`/`emit`
   * write through the same tx as the journal finalize, so the effect and the `status='done'` mark commit or
   * roll back atomically — resume never re-runs a committed step.
   */
  step<T>(stepId: string, fn: (stepCtx: StepCtx) => Promise<T> | T): Promise<T>;
};

/** A workflow declaration — a name (the journal partition) + the `run(input, ctx)` body that drives the steps.
 *  `N` carries the declaration's OWN name literal through `defineWorkflow`, so a module's `workflows:` slot
 *  keys `ctx.workflows.<name>` at the type layer (`faces-ctx.ts §WorkflowsOf`) without widening to `string`. */
export interface WorkflowDecl<I = unknown, N extends string = string> {
  readonly name: N;
  /** Owning module for `ctx.data` (05-runtime.md §ctx). Absent → the flat `"app"` module. */
  readonly module?: string;
  run(input: I, ctx: WorkflowCtx): Promise<void> | void;
  /** Per-workflow override of the step crash-reclaim lease (ms). Raise it for a workflow whose steps
   *  legitimately run longer than the `WORKFLOW_STEP_LEASE_MS` floor. Omit for the 5-minute default. */
  readonly leaseMs?: number;
  /** Actual per-step deadline; false explicitly opts out. Default 600 seconds. */
  readonly stepTimeoutMs?: number | false;
  /** Deliberate MCP curation. Omitted methods have no generated MCP door. */
  readonly mcp?: {
    readonly inspect?: { readonly describe: string };
    readonly cancel?: { readonly describe: string };
  };
}

/** Declare a durable workflow (the verb over the workflow seam) — register it on `AppConfig.workflows`.
 *  Annotate `run`'s input parameter rather than passing the factory an explicit type argument: an explicit
 *  argument suppresses the name-literal inference, and the name literal is what keys the typed door. */
export function defineWorkflow<
  I = unknown,
  N extends string = string,
  D = unknown,
>(
  decl: WorkflowDecl<I, N> & OnlyKnownKeys<D, WorkflowDecl<I, N>>,
): WorkflowDecl<I, N> {
  const errors = asyncMcpCurationErrors(decl, ["inspect", "cancel"]);
  if (errors.length) {
    throw new Error(
      `decl/unknown-key: workflow '${decl.name}': ${errors.join("; ")}`,
    );
  }
  if (
    decl.leaseMs !== undefined &&
    (!Number.isFinite(decl.leaseMs) || decl.leaseMs <= 0)
  ) {
    throw Object.assign(
      new Error(
        "workflow leaseMs must be a finite positive number of milliseconds",
      ),
      { kind: "validation" as const },
    );
  }
  if (
    decl.stepTimeoutMs !== undefined && decl.stepTimeoutMs !== false &&
    (!Number.isFinite(decl.stepTimeoutMs) || decl.stepTimeoutMs < 1 ||
      decl.stepTimeoutMs > 2_147_483_647)
  ) {
    throw Object.assign(
      new Error(
        "workflow stepTimeoutMs must be false or finite positive milliseconds",
      ),
      { kind: "validation" as const },
    );
  }
  return decl;
}

/**
 * How a run's ctx is built from the composed `App`, bound to the db a step (or the body) runs on. The
 * factory is INSTALLED by `data/data-ctx.ts` at load rather than imported here: this module composes the
 * op ctx surface (`ctx.workflows`), so an import of the ctx factory would close the value cycle
 * data-ctx → workflow → data → data-ctx that `import-cycle-gate` refuses.
 */
/** Live ports inherited by a workflow body and each step; none of these handles is journaled. */
export interface WorkflowRuntime {
  readonly datasource?: (name: string) => DatasourceHandle;
  readonly storage?: StorageDriver;
  readonly signal?: AbortSignal;
  readonly baseDb?: Db;
}

export type WorkflowCtxBuilder = (
  app: App,
  kms: Kms | undefined,
  workflowId: string,
  scope?: string,
  selfModule?: string,
  actor?: Actor | null,
  runtime?: WorkflowRuntime,
) => (db: Db) => object;

let ctxBuilder: WorkflowCtxBuilder | undefined;
/** The one install point (`data/data-ctx.ts`, at load) — mirrors `setRouterFactory`. */
export function setWorkflowCtxBuilder(build: WorkflowCtxBuilder): void {
  ctxBuilder = build;
}
/** Loud rather than a silent floor ctx: a run given an `App` whose steps quietly lost `stepCtx.data` would
 *  look green and write nothing. */
function requireCtxBuilder(): WorkflowCtxBuilder {
  if (ctxBuilder === undefined) {
    throw new Error(
      `[hazelnut] workflow: no ctx factory installed — import the framework through \`hazelnut\` (or \`hazelnut/data/data-ctx.ts\`) so the App-bound workflow ctx registers`,
    );
  }
  return ctxBuilder;
}

/** Build a step-scoped `(stepId, tx) => StepCtx` from the composed `App` — the installed ctx builder's
 *  tx-bound surface, so a step's `stepCtx.data`/`transition`/`emit` are the identical framework surface,
 *  bound to the per-step tx threaded in below. Absent an `App`, the step gets a minimal read-only `{}` base —
 *  still stamped with the stable identity, so a no-App body can still make an external call retry-safe. */
function stepCtxFactoryOf(
  app: App | undefined,
  workflowId: string,
  kms?: Kms,
  scope?: string,
  selfModule?: string,
  actor?: Actor | null,
  runtime?: WorkflowRuntime,
): (stepId: string, tx: Db, signal?: AbortSignal) => StepCtx {
  return (stepId: string, tx: Db, signal?: AbortSignal): StepCtx => {
    const make = app === undefined
      ? undefined
      : requireCtxBuilder()(app, kms, workflowId, scope, selfModule, actor, {
        ...runtime,
        signal,
      });
    return {
      ...(make === undefined ? {} : make(tx)),
      signal,
      workflowId,
      stepId,
      idempotencyKey: `${workflowId}:${stepId}`,
    } as StepCtx;
  };
}

/**
 * Build the `ctx.step` primitive bound to a workflow run (`workflowId`) on the base `db`. The step claim
 * commits independently on `db`, not folded into one workflow-wide tx, so a later step's throw cannot roll
 * an earlier step's journal back. The step body then runs in one per-step tx: `fn` receives a `stepCtx` bound
 * to that tx, and the journal finalize update runs in the same tx, so the step's writes and its `status='done'`
 * mark commit or roll back together. On a bare `Db` (no Transactor) the body runs inline against `db`.
 *
 * `recordDb` (optional) is an OUT-OF-BAND connection for the failure record — written to `_workflow_progress`,
 * never the journal. Needed when `db` is nested inside a calling op's open transaction: the journal UPDATE
 * rides that same tx and vanishes on the op's rollback, so the failure evidence has to land on a fresh
 * connection (mirrors `tasks.ts` `writeFailure` → `_task_progress`). Absent (PGlite / no pool / CLI on the
 * same handle) the journal UPDATE alone is the record — which is correct whenever `db` itself commits.
 */
function makeStep(
  db: Db,
  workflowId: string,
  stepCtxFactory: (stepId: string, tx: Db, signal?: AbortSignal) => StepCtx,
  leaseMs: number,
  recordDb?: Db,
  origin?: WorkflowFailureOrigin,
  refuse?: RedactionNames,
  timeoutMs: number | false = DEFAULT_HANDLER_TIMEOUT_MS,
  parentSignal?: AbortSignal,
  cancelled: (readDb?: Db) => Promise<boolean> = async () => false,
): WorkflowCtx["step"] {
  const reached = new Set<string>();
  return async <T>(
    stepId: string,
    fn: (stepCtx: StepCtx) => Promise<T> | T,
  ): Promise<T> => {
    if (
      typeof stepId !== "string" || stepId.trim().length === 0 ||
      stepId.includes(":")
    ) {
      throw Object.assign(
        new Error(
          "workflow/step-id: a nonempty string without ':' is required",
        ),
        { kind: "validation" as const },
      );
    }
    if (reached.has(stepId)) {
      throw Object.assign(
        new Error(
          `workflow/duplicate-step-id: '${stepId}' was reached twice in one invocation`,
        ),
        { kind: "validation" as const },
      );
    }
    reached.add(stepId);
    if (await cancelled()) throw workflowCancelled(workflowId);
    if (parentSignal?.aborted) {
      throw Object.assign(new Error("workflow parent was cancelled"), {
        kind: "timeout" as const,
      });
    }
    if (!isTransactor(db) && db.savepoint === undefined) {
      throw Object.assign(
        new Error(
          `workflow/step-boundary: step '${stepId}' runs on a transaction handle with no savepoint, so its writes could not be unwound if it fails — start the workflow from a root handle, or give the driver adapter a 'savepoint' built from its own nesting API`,
        ),
        { kind: "internal" as const },
      );
    }
    const keyVals = [workflowId, stepId];
    // claim through the shared durable-claim primitive (core/durable-claim.ts) — the same lease-reclaim
    // fence `_idempotency` uses.
    const verdict = await acquireClaim<T>(db, WORKFLOW_CLAIM, keyVals, leaseMs);
    // a `done` step short-circuits to its stored result — fn never re-runs, so a non-idempotent step is not
    // re-burned on resume.
    if (verdict.kind === "replay") {
      return verdict.value as T;
    }
    // a live peer owns the claim: a concurrent runner of the same `workflowId` is executing this step.
    // Abort with a conflict so the caller backs off rather than double-run `fn`; thrown before the
    // run/finalize try-block, so a losing runner never touches the heartbeat or the catch-release.
    if (verdict.kind === "conflict") {
      throw new WorkflowConflictError(workflowId, stepId);
    }
    // we own the claim. Run `fn` + finalize in one per-step tx so the step's writes and its `status='done'`
    // mark commit or roll back together. A heartbeat re-stamps the lease while `fn` runs; a clean throw
    // catch-releases.
    // our GENERATION of the claim. The beat and the catch-release both carry it, so a runner whose lease
    // lapsed mid-step cannot refresh — or delete — the claim a peer has since taken over.
    const fence = verdict.fence;
    const heartbeatDb: Db = isTransactor(db) && db.autocommitQuery
      ? { ...db, query: db.autocommitQuery.bind(db), concurrent: true }
      : db;
    const stopHeartbeat = startClaimHeartbeat(
      heartbeatDb,
      WORKFLOW_CLAIM,
      keyVals,
      leaseMs,
      fence,
    );
    const finalize = async (work: Db, signal: AbortSignal): Promise<T> => {
      const value = await fn(stepCtxFactory(stepId, work, signal));
      if (signal.aborted) throw signal.reason;
      if (await cancelled(work)) throw workflowCancelled(workflowId);
      const leaked = refuse === undefined
        ? null
        : firstRedactedPath(refuse, value);
      if (leaked !== null) {
        throw Object.assign(
          new Error(
            `workflow/step-result-sensitive: step '${stepId}' returned '${leaked}', a sensitive or encrypted field — the journal replays a step's result verbatim, so it would hold that plaintext, and a mask would replay the wrong value; return the row's id and re-read it in the step that needs it`,
          ),
          { kind: "validation" as const },
        );
      }
      // bind the journaled result as text, parse server-side (outbox-emit.ts `emit` has the rationale) —
      // without it a by-OID-serializing driver stores a jsonb string and a resume replays the wrong type.
      // Fenced: a lease-lost zombie finalizing late matches zero rows and throws — the peer that owns the
      // generation keeps the step, this attempt's write rolls back with the tx.
      const done = (await work.query(
        `UPDATE "_workflow_journal" SET result = $3::text::jsonb, status = 'done' WHERE workflow_id = $1 AND step_id = $2${
          fenceGuard(WORKFLOW_CLAIM, 4)
        } RETURNING 1`,
        [workflowId, stepId, JSON.stringify(wireJson(value ?? null)), fence],
      )).rows.length;
      if (done === 0) {
        throw Object.assign(
          new Error(
            `workflow step '${stepId}' finalize lost its claim — a peer owns the generation; this attempt is discarded`,
          ),
          { kind: "stale" as const },
        );
      }
      return value;
    };
    try {
      const controller = new AbortController();
      const forwardAbort = () => controller.abort(parentSignal?.reason);
      if (parentSignal?.aborted) forwardAbort();
      else {parentSignal?.addEventListener("abort", forwardAbort, {
          once: true,
        });}
      let polling = false;
      const pollTimer = recordDb?.concurrent === true ||
          (isTransactor(db) && db.concurrent === true)
        ? setInterval(() => {
          if (polling) return;
          polling = true;
          void cancelled().then((requested) => {
            if (requested) controller.abort(workflowCancelled(workflowId));
          }).catch(() => {}).finally(() => {
            polling = false;
          });
        }, 100)
        : undefined;
      try {
        const work = (tx: Db) =>
          withAsyncDeadline(
            timeoutMs,
            controller.signal,
            (signal) =>
              withSqlDeadline(
                tx,
                timeoutMs,
                signal,
                () => finalize(tx, signal),
              ),
          );
        return await (isTransactor(db)
          ? db.transaction(work)
          : inTxSavepoint(db, work));
      } finally {
        if (pollTimer !== undefined) clearInterval(pollTimer);
        parentSignal?.removeEventListener("abort", forwardAbort);
      }
    } catch (e) {
      // The failure is RECORDED, not erased. `releaseClaim` DELETEs the row, so a clean throw — the common
      // failure, a business error out of a step body — left less evidence than a crash does: no attempt
      // count, no last error, no terminal disposition, and nothing an operator could select. The row stays
      // `inflight` (`status <> 'done'` admits `'failed'`) and its lease is rewound to the epoch, so an
      // immediate resume re-owns it exactly as the delete allowed.
      //
      // When `db` is nested inside a calling op's open transaction, this UPDATE rides that same tx and is
      // rolled back with the op — so the out-of-band `_workflow_progress` write (below) is the record that
      // actually survives. On a standalone run (CLI / bare `runWorkflow` with a committing `db`) this UPDATE
      // itself commits and IS the surviving record.
      // fenced like the finalize: a zombie's late failure record must not overwrite a peer's claim
      await db.query(
        `UPDATE "_workflow_journal"
            SET status = 'failed', attempts = attempts + 1, last_error = $3,
                last_error_kind = $4, locked_at = 'epoch'
          WHERE workflow_id = $1 AND step_id = $2 AND status <> 'done'${
          fenceGuard(WORKFLOW_CLAIM, 5)
        }`,
        [
          ...keyVals,
          e instanceof Error
            ? e.message.slice(0, 2000)
            : String(e).slice(0, 2000),
          errorKind(e),
          fence,
        ],
      );
      // out-of-band twin of the journal UPDATE — survives the caller's own rollback (tasks.ts writeFailure).
      await writeWorkflowFailure(recordDb, workflowId, stepId, e, origin);
      throw e;
    } finally {
      stopHeartbeat(); // every exit stops the lease refresh — a leaked interval would outlive the step
    }
  };
}

/** Origin stamped onto an out-of-band `_workflow_progress` failure row — the calling op's actor + wire
 *  correlation id, so an operator can attribute a failed step after the op's own tx has rolled back. */
export interface WorkflowFailureOrigin {
  /** The actor the run acts as — the op that started it; absent or null, the system principal. */
  readonly actor?: Actor | null;
  readonly traceId?: string;
  readonly scope?: string;
}

/** Bind a durable journal partition to exactly one declaration and scope before it can replay.
 *  The identity row is committed out-of-band when a nested workflow supplies `recordDb`; otherwise it uses
 *  the root handle. Legacy journal/progress rows deliberately fail closed because their original declaration
 *  and scope cannot be reconstructed from `(workflow_id, step_id)`. */
async function claimWorkflowIdentity(
  db: Db,
  workflowId: string,
  workflowName: string,
  scope: string,
  submitter: string,
): Promise<void> {
  const read = async () =>
    (await db.query<
      { workflow_name: string; scope: string; submitter: string }
    >(
      `SELECT workflow_name, scope, submitter FROM "_workflow_identity" WHERE workflow_id = $1`,
      [workflowId],
    )).rows[0];
  const assertMatch = (
    identity:
      | { workflow_name: string; scope: string; submitter: string }
      | undefined,
  ) => {
    if (
      identity &&
      (identity.workflow_name !== workflowName || identity.scope !== scope ||
        (identity.submitter !== "" && identity.submitter !== submitter))
    ) {
      throw Object.assign(
        new Error(
          `workflow/identity-collision: workflowId '${workflowId}' is already bound to '${identity.workflow_name}' in scope '${identity.scope}' and cannot be reused by '${workflowName}' in scope '${scope}'`,
        ),
        { kind: "conflict" as const },
      );
    }
    return identity !== undefined;
  };

  if (assertMatch(await read())) return;

  // Older workflow schemas may not have a progress table, so probe table presence before querying it. Names
  // are fixed framework identifiers (never caller input); user values stay parameterized.
  for (const table of ["_workflow_journal", "_workflow_progress"] as const) {
    const present = (await db.query<{ relation: string | null }>(
      `SELECT to_regclass($1) AS relation`,
      [table],
    )).rows[0]?.relation;
    if (!present) continue;
    const hasLegacyState = (await db.query(
      `SELECT 1 FROM "${table}" WHERE workflow_id = $1 LIMIT 1`,
      [workflowId],
    )).rows.length > 0;
    if (hasLegacyState) {
      throw Object.assign(
        new Error(
          `workflow/identity-unbound: workflowId '${workflowId}' has persisted state without a declaration/scope identity; bind it only after verifying its original workflow and scope, or retire the old state`,
        ),
        { kind: "validation" as const },
      );
    }
  }

  // A primary-key insert arbitrates concurrent first starts. Re-read the winner so different declarations
  // or scopes racing for one id cannot proceed to the shared journal partition.
  await db.query(
    `INSERT INTO "_workflow_identity" (workflow_id, workflow_name, scope, submitter)
     VALUES ($1, $2, $3, $4) ON CONFLICT (workflow_id) DO NOTHING`,
    [workflowId, workflowName, scope, submitter],
  );
  if (!assertMatch(await read())) {
    throw Object.assign(
      new Error(
        `workflow/identity-claim: identity row for workflowId '${workflowId}' disappeared after claim`,
      ),
      { kind: "stale" as const },
    );
  }
}

/** Write a step's failure out-of-band onto `_workflow_progress` (a fresh connection, never the caller's
 *  open tx) so attempts / last_error / actor / trace_id survive the op's rollback. No `recordDb` ⇒ no-op —
 *  PGlite would deadlock querying its own outer handle while a `.transaction()` is open, and a standalone
 *  run already keeps the journal UPDATE. */
async function writeWorkflowFailure(
  recordDb: Db | undefined,
  workflowId: string,
  stepId: string,
  e: unknown,
  origin?: WorkflowFailureOrigin,
): Promise<void> {
  if (!recordDb) return;
  const msg = e instanceof Error
    ? e.message.slice(0, 2000)
    : String(e).slice(0, 2000);
  await (recordDb.autocommitQuery?.bind(recordDb) ??
    recordDb.query.bind(recordDb))(
      `INSERT INTO "_workflow_progress"
       (workflow_id, step_id, attempts, last_error, last_error_kind, actor, trace_id, updated_at)
     VALUES ($1, $2, 1, $3, $4, $5, $6, now())
     ON CONFLICT (workflow_id, step_id) DO UPDATE SET
       attempts = "_workflow_progress".attempts + 1,
       last_error = $3, last_error_kind = $4,
       actor = COALESCE($5, "_workflow_progress".actor),
       trace_id = COALESCE($6, "_workflow_progress".trace_id),
       updated_at = now()`,
      [
        workflowId,
        stepId,
        msg,
        errorKind(e),
        origin?.actor?.id ?? null,
        origin?.traceId ?? null,
      ],
    );
}

/**
 * Run (or resume) a durable workflow once. `base` is the system/consumer surface a caller binds, extended
 * with `ctx.step` bound to this run's `workflowId` on `db`. Re-invoking with the same `workflowId` after a
 * crash/throw is a resume: completed steps short-circuit to their journaled result and execution proceeds
 * from the first unfinished step.
 *
 * `workflowId` defaults to the workflow name (one logical run per name); a caller distinguishing concurrent
 * runs passes its own stable id. `app` (optional) is the composed App the per-step `stepCtx` is built from —
 * given it, a step's writes commit atomically with the journal finalize; absent it, a step gets the
 * read-only floor ctx. `recordDb` / `origin` thread the out-of-band failure record (see `makeStep`).
 */
export async function runWorkflow<I>(
  db: Db,
  wf: WorkflowDecl<I>,
  input: I,
  base: ConsumerCtx,
  workflowId: string = wf.name,
  app?: App,
  kms?: Kms,
  recordDb?: Db,
  origin?: WorkflowFailureOrigin,
): Promise<void> {
  if (!isTransactor(db) && !isFrameworkTransactionHandle(db)) {
    throw Object.assign(
      new Error(
        "workflow/transaction-required: standalone runWorkflow needs a transaction-capable root Db; a bare Db cannot atomically commit a step effect with its journal completion",
      ),
      { kind: "validation" as const },
    );
  }
  await runWorkflowCore(
    db,
    wf,
    input,
    base,
    workflowId,
    app,
    kms,
    recordDb,
    origin,
  );
}

/** Private runner for a workflow started inside an operation. The operation owns the live transaction, so
 *  opening a new root transaction would split the workflow journal from the caller's commit/rollback. */
async function runWorkflowCore<I>(
  db: Db,
  wf: WorkflowDecl<I>,
  input: I,
  base: ConsumerCtx,
  workflowId: string,
  app?: App,
  kms?: Kms,
  recordDb?: Db,
  origin?: WorkflowFailureOrigin,
): Promise<void> {
  defineWorkflow(wf);
  if (typeof workflowId !== "string" || workflowId.trim().length === 0) {
    throw Object.assign(
      new Error("workflow/id: a nonempty workflowId is required"),
      { kind: "validation" as const },
    );
  }
  // The ConsumerCtx actually scopes workflow reads and writes. `origin` is optional provenance/failure
  // metadata, so it cannot be the identity authority for a scoped base supplied without one.
  const workflowScope = typeof base.scope === "string"
    ? base.scope
    : origin?.scope ?? "";
  const identityDb = recordDb ?? db;
  const identityAccess: Db = identityDb.autocommitQuery
    ? { ...identityDb, query: identityDb.autocommitQuery.bind(identityDb) }
    : identityDb;
  await claimWorkflowIdentity(
    identityAccess,
    workflowId,
    wf.name,
    workflowScope,
    taskSubmitter(base.actor ?? origin?.actor ?? null),
  );
  const cancelled = async (readDb?: Db) => {
    const row =
      (await (readDb ?? identityAccess).query<{ cancel_requested: boolean }>(
        `SELECT cancel_requested FROM "_workflow_identity" WHERE workflow_id = $1`,
        [workflowId],
      )).rows[0];
    return row?.cancel_requested === true;
  };
  if (await cancelled()) throw workflowCancelled(workflowId);
  const runtime: WorkflowRuntime = {
    datasource: base.datasource,
    storage: base.storage,
    signal: base.signal,
    baseDb: recordDb ?? base.baseDb,
  };
  const ctx = {
    ...(base as object),
    step: makeStep(
      db,
      workflowId,
      stepCtxFactoryOf(
        app,
        workflowId,
        kms,
        workflowScope,
        wf.module,
        base.actor ?? origin?.actor,
        runtime,
      ),
      wf.leaseMs ?? WORKFLOW_STEP_LEASE_MS,
      recordDb,
      origin,
      app === undefined ? undefined : redactionNamesOf(app.model),
      wf.stepTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS,
      base.signal,
      cancelled,
    ),
  } as WorkflowCtx;
  await wf.run(input, ctx);
  if (await cancelled()) throw workflowCancelled(workflowId);
  const completed = await db.query(
    `UPDATE "_workflow_identity" SET completed_at = now() WHERE workflow_id = $1 AND cancel_requested = false RETURNING 1`,
    [workflowId],
  );
  if (completed.rows.length === 0) throw workflowCancelled(workflowId);
}

/** The per-workflow `ctx.workflows.<name>` surface — `start(input)` runs a declared workflow from inside an
 *  op, the durable-orchestration twin of `ctx.tasks.<name>.submit(input)`. */
export interface WorkflowSurface {
  /**
   * Start a run and resolve with its `workflowId`. The id is fresh per call unless the caller pins one:
   * `runWorkflow`'s bare default (the workflow NAME) would make a second start silently replay the first
   * run's journal and do nothing. Pin `workflowId` to make a start idempotent per subject (a re-start then
   * resumes that run from its first unfinished step).
   */
  start(
    input: unknown,
    opts?: { readonly workflowId?: string },
  ): Promise<{ workflowId: string }>;
  inspect(workflowId: string): Promise<Result<WorkflowInspection>>;
  cancel(workflowId: string): Promise<Result<{ cancelling: boolean }>>;
}

/**
 * Build `ctx.workflows` from `app.workflows`, bound to the op's live db (the tx inside a write op) — so the
 * journal and every step's writes commit or roll back WITH the op, exactly like `ctx.data`.
 *
 * Binding the op's db rather than reaching around it to the base connection is the load-bearing choice:
 * (1) a start that committed independently would be the one ctx verb whose writes survive a rolled-back op;
 * (2) on a single-connection db a second transaction opened while the op's is live DEADLOCKS (`Db.concurrent`),
 * so the base-connection variant would hang under PGlite while passing on pooled PG. A step's EXTERNAL
 * effect is unchanged by this: it is retry-safe only through `stepCtx.idempotencyKey`, never rolled back.
 *
 * `recordDb` is the exception to that binding — an independent durable-record connection (a real pool's
 * base handle, or `undefined` on PGlite). Run identity and failure progress use it; the journal and
 * step database writes still ride `db` and share the caller's commit or rollback.
 */
export function workflowsSurface(
  app: App,
  db: Db,
  kms?: Kms,
  recordDb?: Db,
  origin?: WorkflowFailureOrigin,
  runtime?: WorkflowRuntime,
): Record<string, WorkflowSurface> {
  const build = (app.workflows ?? []).length > 0
    ? requireCtxBuilder()
    : undefined;
  const out: Record<string, WorkflowSurface> = {};
  for (const wf of app.workflows ?? []) {
    out[wf.name] = {
      inspect: (workflowId) =>
        inspectWorkflow(
          db,
          workflowId,
          wf.name,
          origin?.scope ?? "",
          taskSubmitter(origin?.actor ?? null),
        ),
      cancel: (workflowId) =>
        cancelWorkflow(
          db,
          workflowId,
          wf.name,
          origin?.scope ?? "",
          taskSubmitter(origin?.actor ?? null),
        ),
      start: async (input, opts = {}) => {
        // Op-nested start without a concurrent pool makes a throwing step's failure ride the op tx and
        // vanish on rollback — the "recorded, not erased" promise is false on that door. Standalone
        // `runWorkflow` / `hazelnut run-workflow` keep working on PGlite (journal commits on the same handle).
        if (recordDb === undefined) {
          throw Object.assign(
            new Error(
              `ctx.workflows.${wf.name}.start requires Db.concurrent (a real pool) — ` +
                `a throwing step's failure record is erased when nested in an op tx on a single-connection Db. ` +
                `Use postgresDb for served apps, or run via runWorkflow / hazelnut run-workflow.`,
            ),
            { kind: "validation" as const },
          );
        }
        const workflowId = opts.workflowId ?? uuidv7();
        // the body's ctx is the same App-bound surface a step gets (data/transition/emit on this db) —
        // an op-started run and a relay/CLI-started one differ only in the db they bind.
        const base = build!(
          app,
          kms,
          workflowId,
          origin?.scope,
          wf.module,
          origin?.actor,
          runtime,
        )(db) as ConsumerCtx;
        await runWorkflowCore(
          db,
          wf,
          input,
          base,
          workflowId,
          app,
          kms,
          recordDb,
          origin,
        );
        return { workflowId };
      },
    };
  }
  return loudNameDoor(out, "workflows", "defineWorkflow");
}

function workflowCancelled(workflowId: string): Error & { kind: "conflict" } {
  return Object.assign(
    new Error(
      `workflow/cancelled: run '${workflowId}' has a cooperative cancellation request`,
    ),
    { kind: "conflict" as const },
  );
}

/** Owner-visible metadata; step results and raw failure text are deliberately absent. */
export interface WorkflowInspection {
  readonly workflowId: string;
  readonly completed: boolean;
  readonly cancelRequested: boolean;
  readonly steps: readonly {
    readonly stepId: string;
    readonly status: string;
    readonly attempts: number;
    readonly errorKind: string | null;
  }[];
}

export async function inspectWorkflow(
  db: Db,
  workflowId: string,
  name: string,
  scope: string,
  submitter: string,
): Promise<Result<WorkflowInspection>> {
  const identity =
    (await db.query<{ completed: boolean; cancel_requested: boolean }>(
      `SELECT completed_at IS NOT NULL AS completed, cancel_requested FROM "_workflow_identity" WHERE workflow_id = $1 AND workflow_name = $2 AND scope = $3 AND submitter = $4 AND submitter <> ''`,
      [workflowId, name, scope, submitter],
    )).rows[0];
  if (!identity) return err("notFound", `workflow '${workflowId}' not found`);
  const steps = (await db.query<
    {
      step_id: string;
      status: string;
      attempts: number;
      last_error_kind: string | null;
    }
  >(
    `SELECT COALESCE(j.step_id,p.step_id) AS step_id, COALESCE(j.status,'failed') AS status, GREATEST(COALESCE(j.attempts,0),COALESCE(p.attempts,0)) AS attempts, CASE WHEN j.status = 'done' THEN NULL ELSE COALESCE(j.last_error_kind,p.last_error_kind) END AS last_error_kind FROM "_workflow_journal" j FULL OUTER JOIN "_workflow_progress" p ON j.workflow_id=p.workflow_id AND j.step_id=p.step_id WHERE COALESCE(j.workflow_id,p.workflow_id) = $1 ORDER BY COALESCE(j.created_at,p.updated_at), COALESCE(j.step_id,p.step_id)`,
    [workflowId],
  )).rows;
  return ok({
    workflowId,
    completed: workflowBool(identity.completed),
    cancelRequested: workflowBool(identity.cancel_requested),
    steps: steps.map((step) => ({
      stepId: step.step_id,
      status: step.status,
      attempts: Number(step.attempts),
      errorKind: step.last_error_kind,
    })),
  });
}

export async function cancelWorkflow(
  db: Db,
  workflowId: string,
  name: string,
  scope: string,
  submitter: string,
): Promise<Result<{ cancelling: boolean }>> {
  const rows = (await db.query<{ cancelling: boolean }>(
    `UPDATE "_workflow_identity" SET cancel_requested = CASE WHEN completed_at IS NULL THEN true ELSE cancel_requested END WHERE workflow_id = $1 AND workflow_name = $2 AND scope = $3 AND submitter = $4 AND submitter <> '' RETURNING completed_at IS NULL AS cancelling`,
    [workflowId, name, scope, submitter],
  )).rows;
  return rows[0]
    ? ok({ cancelling: workflowBool(rows[0].cancelling) })
    : err("notFound", `workflow '${workflowId}' not found`);
}

function workflowBool(value: unknown): boolean {
  return value === true || value === "t" || value === "true";
}
