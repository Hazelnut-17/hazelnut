import { errorKind } from "../core/result.ts";
import { isTransactor } from "../data/db.ts";
import type { Db } from "../data/db.ts";
import type { ConsumerCtx } from "./events.ts";
import type { App } from "../core/app.ts";
import type { OnlyKnownKeys } from "../core/config.ts";
import type { Kms } from "../features/encrypt.ts";
import { uuidv7 } from "../core/id.ts";
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
 * (a charge, an email) is never re-burned. In-process floor; an external orchestrator (Temporal / Restate /
 * DBOS) stays a BYO port. The journal composes the shared `durableClaim` crash-reclaim lease + heartbeat
 * (core/durable-claim.ts, same as `_idempotency` — an atomic `INSERT … ON CONFLICT DO UPDATE … WHERE
 * lease-expired RETURNING` dedup arbiter): a live peer racing the same step gets `WorkflowConflictError`
 * instead of double-running `fn`; a clean throw releases the claim for immediate resume.
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
    }
  >(
    `SELECT status, attempts, last_error,
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
): Promise<boolean> {
  const { rows } = await db.query<{ ok: true }>(
    `UPDATE "_workflow_journal" SET locked_at = 'epoch'
       WHERE workflow_id = $1 AND step_id = $2 AND ${WORKFLOW_CLAIM.inflight}
     RETURNING true AS ok`,
    [workflowId, stepId],
  );
  return rows.length > 0;
}

/**
 * The per-step ctx handed to a `step` body — the base consumer/system ctx plus the step's own stable
 * identity. `idempotencyKey` is the journal's exact `${workflowId}:${stepId}` tuple, surfaced so a step's
 * out-of-tx external effect (an LLM call, a charge) can pass it as the provider's idempotency key — a
 * crash-mid-call resume then de-dups at the provider. The framework guarantees key-parity; it does not — and
 * cannot — promise exactly-once for an effect outside the per-step tx (05-runtime.md §4.2).
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

/** A workflow declaration — a name (the journal partition) + the `run(input, ctx)` body that drives the steps. */
export interface WorkflowDecl<I = unknown> {
  readonly name: string;
  run(input: I, ctx: WorkflowCtx): Promise<void> | void;
  /** Per-workflow override of the step crash-reclaim lease (ms). Raise it for a workflow whose steps
   *  legitimately run longer than the `WORKFLOW_STEP_LEASE_MS` floor. Omit for the 5-minute default. */
  readonly leaseMs?: number;
}

/** Declare a durable workflow (the verb over the workflow seam) — register it on `AppConfig.workflows`. */
export function defineWorkflow<I = unknown, D = unknown>(
  decl: WorkflowDecl<I> & OnlyKnownKeys<D, WorkflowDecl<I>>,
): WorkflowDecl<I> {
  return decl;
}

/**
 * How a run's ctx is built from the composed `App`, bound to the db a step (or the body) runs on. The
 * factory is INSTALLED by `data/data-ctx.ts` at load rather than imported here: this module composes the
 * op ctx surface (`ctx.workflows`), so an import of the ctx factory would close the value cycle
 * data-ctx → workflow → data → data-ctx that `import-cycle-gate` refuses.
 */
export type WorkflowCtxBuilder = (
  app: App,
  kms: Kms | undefined,
  workflowId: string,
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
): (stepId: string, tx: Db) => StepCtx {
  const make = app === undefined
    ? undefined
    : requireCtxBuilder()(app, kms, workflowId);
  return (stepId: string, tx: Db): StepCtx => {
    return {
      ...(make === undefined ? {} : make(tx)),
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
  stepCtxFactory: (stepId: string, tx: Db) => StepCtx,
  leaseMs: number,
  recordDb?: Db,
  origin?: WorkflowFailureOrigin,
): WorkflowCtx["step"] {
  return async <T>(
    stepId: string,
    fn: (stepCtx: StepCtx) => Promise<T> | T,
  ): Promise<T> => {
    const keyVals = [workflowId, stepId];
    // claim through the shared durable-claim primitive (core/durable-claim.ts) — the same lease-reclaim
    // fence `_idempotency` uses.
    const verdict = await acquireClaim<T>(db, WORKFLOW_CLAIM, keyVals, leaseMs);
    // a `done` step short-circuits to its stored result — fn never re-runs, so a non-idempotent step is not
    // re-burned on resume.
    if (verdict.kind === "replay") return (verdict.value ?? null) as T;
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
    const stopHeartbeat = startClaimHeartbeat(
      db,
      WORKFLOW_CLAIM,
      keyVals,
      leaseMs,
      fence,
    );
    const finalize = async (work: Db): Promise<T> => {
      const value = await fn(stepCtxFactory(stepId, work));
      // bind the journaled result as text, parse server-side (outbox-emit.ts `emit` has the rationale) —
      // without it a by-OID-serializing driver stores a jsonb string and a resume replays the wrong type.
      // Fenced: a lease-lost zombie finalizing late matches zero rows and throws — the peer that owns the
      // generation keeps the step, this attempt's write rolls back with the tx.
      const done = (await work.query(
        `UPDATE "_workflow_journal" SET result = $3::text::jsonb, status = 'done' WHERE workflow_id = $1 AND step_id = $2${
          fenceGuard(WORKFLOW_CLAIM, 4)
        } RETURNING 1`,
        [workflowId, stepId, JSON.stringify(value ?? null), fence],
      )).rows.length;
      if (done === 0) {
        throw new Error(
          `workflow step '${stepId}' finalize lost its claim — a peer owns the generation; this attempt is discarded`,
        );
      }
      return value;
    };
    try {
      return isTransactor(db)
        ? await db.transaction((tx) => finalize(tx))
        : await finalize(db);
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
  readonly actor?: { readonly id: string } | null;
  readonly traceId?: string;
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
  await recordDb.query(
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
  const ctx = {
    ...(base as object),
    step: makeStep(
      db,
      workflowId,
      stepCtxFactoryOf(app, workflowId, kms),
      wf.leaseMs ?? WORKFLOW_STEP_LEASE_MS,
      recordDb,
      origin,
    ),
  } as WorkflowCtx;
  await wf.run(input, ctx);
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
 * `recordDb` is the ONE exception to that binding — the out-of-band failure-record connection (a real pool's
 * base handle, or `undefined` on PGlite). The journal still rides `db`; only `_workflow_progress` uses it.
 */
export function workflowsSurface(
  app: App,
  db: Db,
  kms?: Kms,
  recordDb?: Db,
  origin?: WorkflowFailureOrigin,
): Record<string, WorkflowSurface> {
  const build = (app.workflows ?? []).length > 0
    ? requireCtxBuilder()
    : undefined;
  const out: Record<string, WorkflowSurface> = {};
  for (const wf of app.workflows ?? []) {
    out[wf.name] = {
      start: async (input, opts = {}) => {
        // Op-nested start without a concurrent pool makes a throwing step's failure ride the op tx and
        // vanish on rollback — the "recorded, not erased" promise is false on that door. Standalone
        // `runWorkflow` / `hazelnut run-workflow` keep working on PGlite (journal commits on the same handle).
        if (recordDb === undefined) {
          throw new Error(
            `ctx.workflows.${wf.name}.start requires Db.concurrent (a real pool) — ` +
              `a throwing step's failure record is erased when nested in an op tx on a single-connection Db. ` +
              `Use postgresDb for served apps, or run via runWorkflow / hazelnut run-workflow.`,
          );
        }
        const workflowId = opts.workflowId ?? uuidv7();
        // the body's ctx is the same App-bound surface a step gets (data/transition/emit on this db) —
        // an op-started run and a relay/CLI-started one differ only in the db they bind.
        const base = build!(app, kms, workflowId)(db) as ConsumerCtx;
        await runWorkflow(
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
  return out;
}
