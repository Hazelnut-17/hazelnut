import {
  declaredUniqueClause,
  DeclaredUniqueError,
} from "../data/pg-error-map.ts";
// Barrel re-exports keep import sites stable.
import { wireJson } from "./wire-json.ts";
import { thrownMessage, thrownText } from "./throw-value.ts";
import {
  inTransactionScope,
  transactionScopeDb,
} from "../data/transaction-scope.ts";
import { statementReadPorts } from "./statement-read.ts";
import { markReadOnlyBuildOptions } from "./surface-caller.ts";
import {
  beforeInputGuard,
  IDEMPOTENCY_LEASE_DEFAULT_MS,
  OP_DEADLINE_DEFAULT_MS,
  opDeadlineMs,
  operationContractErrors,
} from "./op-contract.ts";
export { OP_DEADLINE_DEFAULT_MS, opDeadlineMs } from "./op-contract.ts";
import type { Actor } from "../authz/auth.ts";
import {
  type Db,
  integrityFault,
  isExclusionViolation,
  isForeignKeyViolation,
  isUniqueViolation,
  type Transactor,
  withDeadlockRetry,
} from "../data/db.ts";
// re-exported so the serve/mcp doors keep one import home for the engine-error predicates (pipeline barrel)
export { isExclusionViolation, isForeignKeyViolation, isUniqueViolation };
import { strictify, strictifyOutput } from "../data/schema.ts";
import type { ResourceModel } from "./app.ts";
import { getTracer, withSpan } from "./tracing.ts";
import {
  observeTransactionRetries,
  ownTransactionRetrySpan,
  transactionRetryAttrs,
} from "./transaction-retry-observation.ts";
import { effectiveOpPolicy } from "./app-refs.ts";
import { maskValue, redactionSet } from "../features/redact.ts";
import {
  assembleProvenance,
  buildOpCtx,
  getLogSink,
  type JsonScalar,
  makeOpLog,
  type PolicyCtx,
} from "./ctx.ts";
import {
  err,
  isResourceExhausted,
  isTimeoutError,
  ok,
  RESOURCE_EXHAUSTED_MESSAGE,
  type Result,
  resultError,
} from "./result.ts"; // the concrete home — never through the pipeline barrel, which re-exports it
import {
  composeOpHandler,
  type Handler,
  isExposureSource,
  type OpCtx,
  type OpCtxIn,
  type OpDecl,
  type OpDef,
  type OpProvenance,
  type SurfaceFactory,
} from "./pipeline-defs.ts";
import {
  acquireClaim,
  type ClaimFence,
  type DurableClaimSpec,
  fenceGuard,
  releaseClaim,
  startClaimHeartbeat,
} from "./durable-claim.ts";

/** The `_idempotency` durable-claim spec, composing the shared `durableClaim` primitive (core/durable-claim.ts)
 *  that `workflow` also composes. In-flight = `result IS NULL`; done = `result IS NOT NULL` (replays). */
const IDEMPOTENCY_CLAIM: DurableClaimSpec = {
  table: "_idempotency",
  keyCols: ["key"],
  inflight: "result IS NULL",
  done: "result IS NOT NULL",
};

/** Run a named op declared on a resource's `operations` map through the pipeline; the optional `surface`
 *  binds ctx.data/transition/query/modules (05-runtime.md §ctx) — serve/mcp supply it, tests omit it. */
export function dispatchOp<O = unknown>(
  carrier: { readonly operations: Readonly<Record<string, unknown>> },
  name: string,
  db: Db & Transactor,
  ctx: OpCtxIn,
  raw: unknown,
  idempotencyKey?: string,
  surface?: SurfaceFactory,
  prov?: Omit<OpProvenance, "op">,
  // HTTP/MCP already retry thrown dispatch failures. Keep that loop inside the
  // observation/span owner so only its final attempt drains the canonical record.
  retryThrownAborts = false,
): Promise<Result<O>> {
  const decl = carrier.operations[name] as OpDecl<unknown, O> | undefined;
  // a missing op still drains a notFound record (the by-construction §6 guarantee — every dispatch attempt
  // produces one record, even the no-such-op floor), with the requested name as the op descriptor.
  const provenance: OpProvenance = {
    op: name,
    ...prov,
    ...(isExposureSource(carrier)
      ? {
        redactedAttrs: redactionSet(carrier as ResourceModel),
        redactionMaskStyle: (carrier as ResourceModel).maskStyle,
      }
      : {}),
  };
  if (!decl) {
    return observeTransactionRetries(() =>
      drainNotFound<O>(provenance, ctx, `no operation '${name}'`)
    );
  }
  // resolve the gate policy at this dispatch chokepoint: a full-model (cross-module) carrier re-derives
  // default-deny via `effectiveOpPolicy`; a curated serve/mcp carrier already has policy injected, used as-is.
  const gatePolicy = isExposureSource(carrier)
    ? effectiveOpPolicy(carrier, name)
    : undefined;
  const composed = composeOpHandler(decl);
  const handler: Handler<unknown, O> = isExposureSource(carrier)
    ? async (input, context) => {
      try {
        return await composed(input, context);
      } catch (error) {
        const clause = declaredUniqueClause(
          error,
          carrier as ResourceModel,
          true,
        );
        if (clause) throw new DeclaredUniqueError(clause);
        throw error;
      }
    }
    : composed;
  // the op-pipeline's instrumentation point — one span per op (no-op until a tracer is installed)
  return observeTransactionRetries(() =>
    withSpan(
      getTracer(),
      `op:${name}`,
      async (span) => {
        ownTransactionRetrySpan(span);
        const startedAt = performance.now();
        let finalDrain: ((startedAt?: number) => void) | undefined;
        const work = () => {
          finalDrain = undefined;
          return runOp(
            decl,
            handler,
            db,
            ctx,
            raw,
            idempotencyKey,
            surface,
            provenance,
            gatePolicy,
            (drain) => {
              finalDrain = drain;
            },
          );
        };
        try {
          return await (retryThrownAborts ? withDeadlockRetry(work) : work());
        } finally {
          if (finalDrain) finalDrain(startedAt);
          else {drainProvenance(
              provenance,
              ctx,
              {},
              err("internal", "operation failed"),
              "none",
              startedAt,
            );}
        }
      },
      {
        ...(ctx.traceId ? { trace_id: ctx.traceId } : {}),
        origin: prov?.origin ?? "cross-module",
        ...(prov?.module ? { module: prov.module } : {}),
        ...(prov?.resource ? { resource: prov.resource } : {}),
      },
    )
  );
}

/** Drain a §6 record for the no-such-op floor (a dispatch that never reaches `runOp`), then return the err. */
function drainNotFound<O>(
  prov: OpProvenance,
  ctx: OpCtxIn,
  message: string,
): Promise<Result<O>> {
  const result = err("notFound", message);
  drainProvenance(prov, ctx, makeOpLog().attrs, result, "none", 0);
  return Promise.resolve(result as Result<O>);
}

/** Drain one §6 ProvenanceRecord to the active `logSink` (05-runtime.md §runtime-provenance "the pipeline drain"), fire-and-
 *  forget: a slow/throwing sink never blocks/fails/rolls back the op (try/catch swallows any sink fault). */
function drainProvenance(
  prov: OpProvenance,
  ctx: OpCtxIn,
  attrs: Readonly<Record<string, JsonScalar | JsonScalar[]>>,
  result: Result<unknown>,
  txOutcome: "committed" | "rolled-back" | "none",
  startedAt: number,
): void {
  try {
    const safeAttrs = prov.redactedAttrs === undefined
      ? attrs
      : Object.fromEntries(
        Object.entries(attrs).map(([key, value]) => [
          key,
          prov.redactedAttrs!.has(key)
            ? maskValue(value, prov.redactionMaskStyle)
            : value,
        ]),
      );
    const record = assembleProvenance({
      actor: ctx.actor,
      scope: ctx.scope,
      attrs: transactionRetryAttrs(safeAttrs),
      op: {
        op: prov.op,
        ...(prov.module !== undefined ? { module: prov.module } : {}),
        ...(prov.resource !== undefined ? { resource: prov.resource } : {}),
      },
      origin: prov.origin ?? "cross-module",
      outcome: result.ok ? "ok" : "err",
      kind: result.ok ? undefined : result.error.kind,
      clause: result.ok ? undefined : result.error.clause,
      message: result.ok ? undefined : result.error.message,
      durationMs: startedAt === 0
        ? 0
        : Math.max(0, performance.now() - startedAt),
      txOutcome,
      // the request's wire correlation id when serve threaded one (the client-held `Hazelnut-Trace-Id`
      // joins this record); else the per-op-minted default (§6). spanId stays per-op.
      traceId: ctx.traceId ?? crypto.randomUUID(),
      spanId: crypto.randomUUID(),
    });
    getLogSink().drain(record);
  } catch {
    // fire-and-forget: a broken sink/assembly NEVER surfaces to the op (logging does not change behaviour)
  }
}

export async function runOp<I, O>(
  op: OpDef<I>,
  handler: Handler<I, O>,
  db: Db & Transactor,
  ctx: OpCtxIn,
  raw: unknown,
  idempotencyKey?: string,
  surface?: SurfaceFactory,
  prov?: OpProvenance,
  // the carrier-resolved deny-by-default gate (`dispatchOp`'s `effectiveOpPolicy` for a full-model carrier).
  // Optional — a direct `runOp` caller falls back to the OpDef's own `op.policy`.
  gatePolicy?: unknown,
  // Internal dispatch owner defers draining until its existing outer retry settles.
  deferDrain?: (drain: (startedAt?: number) => void) => void,
): Promise<Result<O>> {
  if (!deferDrain) {
    return await observeTransactionRetries(() =>
      runOp(
        op,
        handler,
        db,
        ctx,
        raw,
        idempotencyKey,
        surface,
        prov,
        gatePolicy,
        (drain) => drain(),
      )
    );
  }
  db = transactionScopeDb(db);
  // one log instance threads the whole op (validate → policy → before → handler → after) so every
  // ctx.log.set lands in the same canonical §6 record; created before any return so the drain always reads it.
  const log = makeOpLog();
  const startedAt = performance.now();
  // run the spine, then drain exactly one §6 ProvenanceRecord no matter which path returned (05-runtime.md
  // §6 "the pipeline drain"); the inner runner reports the tx outcome so `txOutcome` stays honest.
  //
  // the idempotency-namespace descriptor is resource-qualified (`<resource>.<op>`) when not already dotted
  // with it — unqualified, two resources' same-named custom ops would collide on one actor+key (a leak).
  const idemName = prov !== undefined && prov.resource !== undefined &&
      !prov.op.startsWith(`${prov.resource}.`)
    ? `${prov.resource}.${prov.op}`
    : prov?.op;
  // drain on every exit, including a throw: a handler/hook that throws used to skip the §6 record
  // (M-14). The sink itself stays fire-and-forget inside drainProvenance.
  let result: Result<O> | undefined;
  let txOutcome: "committed" | "rolled-back" | "none" = "none";
  try {
    if (op.idempotent && idempotencyKey !== undefined) {
      if (typeof idempotencyKey !== "string") {
        result = err("validation", "idempotency key must be a string", {
          code: "idempotency/key",
        });
        return result;
      }
      idempotencyKey = idempotencyKey.trim() || undefined;
    }
    const inner = await runOpInner(
      op,
      handler,
      db,
      ctx,
      raw,
      idempotencyKey,
      surface,
      log,
      gatePolicy,
      idemName,
    );
    result = inner.result;
    txOutcome = inner.txOutcome;
    return result;
  } catch (e) {
    result = err(
      "internal",
      thrownMessage(e, "op threw"),
    ) as Result<O>;
    throw e;
  } finally {
    deferDrain((observedAt) =>
      drainProvenance(
        prov ?? { op: op.tx === "read" ? "read" : "write" },
        ctx,
        log.attrs,
        result ?? err("internal", "op threw"),
        txOutcome,
        observedAt ?? startedAt,
      )
    );
  }
}

/** UTF-8 bytes of the stored claim. An incompressible text primary key longer than
 *  this raises SQLSTATE 54000 on an 8k-page btree (index row above 2704). */
const IDEMPOTENCY_CLAIM_MAX_BYTES = 2692;

function idempotencyClaimTooLong(key: string): boolean {
  return new TextEncoder().encode(key).length > IDEMPOTENCY_CLAIM_MAX_BYTES;
}
export function namespaceIdemKey(
  opName: string,
  actor: Actor | null,
  key: string,
  scope: string,
): string {
  return JSON.stringify([opName, actor?.id ?? "", scope, key]);
}

/**
 * The op-pipeline's write-tx deadline for the direct-to-repo CRUD verbs (HTTP serve + MCP): the same
 * `statement_timeout` (`OP_DEADLINE_DEFAULT_MS`) `runOpInner` sets, so a hung write (a lock convoy on a
 * rollup parent's `FOR UPDATE`, a tree-closure rebuild) can't hold its row/advisory locks indefinitely
 * (a 57014 surfaces as `err("timeout")` → 504); no per-verb `deadlineMs` opt-out.
 */
export function crudWriteTx<T>(
  db: Db,
  fn: (tx: Db) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return writeTxWithCancel(db, OP_DEADLINE_DEFAULT_MS, signal, fn);
}

/**
 * Open a write tx that sets the tx-local `statement_timeout` floor and cancels the in-flight statement
 * out-of-band (`pg_cancel_backend`) if `signal` aborts, releasing locks promptly instead of waiting on the
 * timeout backstop. No cancel capability/signal ⇒ the plain deadline-floored tx; `deadlineMs: 0` opts out.
 */
export function writeTxWithCancel<T>(
  db: Db,
  deadlineMs: number,
  signal: AbortSignal | undefined,
  fn: (tx: Db) => Promise<T>,
): Promise<T> {
  const canCancel = signal !== undefined &&
    typeof db.cancelBackend === "function";
  return (db as Db & Transactor).transaction((rawTx) =>
    inTransactionScope(rawTx, async (tx) => {
      const refuseCancelled = () => {
        if (signal?.aborted) {
          throw Object.assign(
            new Error("operation cancelled", { cause: signal.reason }),
            { kind: "timeout" as const },
          );
        }
      };
      refuseCancelled();
      let pid = Number.NaN;
      if (deadlineMs > 0 && canCancel) {
        // one round-trip does both: `set_config('statement_timeout', v, true)` ≡ `SET LOCAL ...`, plus
        // the backend PID for the cancel — a cancellable write adds no extra query over the deadline SET.
        pid = Number(
          (await tx.query<{ pid: number }>(
            `SELECT set_config('statement_timeout', $1, true) AS _t, pg_backend_pid() AS pid`,
            [String(Math.floor(deadlineMs))],
          )).rows[0]?.pid,
        );
      } else if (deadlineMs > 0) {
        await tx.query(
          `SET LOCAL statement_timeout = ${Math.floor(deadlineMs)}`,
        );
      } else if (canCancel) {
        pid = Number(
          (await tx.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`))
            .rows[0]?.pid,
        );
      }
      let onAbort: (() => void) | undefined;
      let issuedCancel: Promise<void> | undefined;
      if (canCancel && Number.isFinite(pid)) {
        const cancel = db.cancelBackend!;
        onAbort = () => {
          issuedCancel ??= Promise.resolve().then(() => cancel(pid)).catch(
            () => {},
          );
        }; // best-effort on failure; still join completion before releasing the target backend
        if (signal!.aborted) onAbort();
        else signal!.addEventListener("abort", onAbort, { once: true });
      }
      try {
        refuseCancelled();
        const value = await fn(tx);
        // Cancelling an idle backend cannot poison its transaction. A handler may finish cooperatively
        // after abort and return ok, so reject inside the owned callback before it can commit those writes.
        refuseCancelled();
        return value;
      } finally {
        // Stop new cancels, then join any already issued side effect inside the owned callback. Otherwise
        // rollback/release could lend this PID to a peer before a delayed cancel reaches the server.
        if (onAbort) signal!.removeEventListener("abort", onAbort);
        await issuedCancel;
      }
    })
  );
}

/**
 * Start the in-flight claim heartbeat: re-stamps `locked_at` every `leaseMs / 3` so a slow-but-alive op's
 * claim never goes stale-reclaimable (guarded on `result IS NULL`; a failed refresh is swallowed). The
 * caller MUST run the returned stop function in `finally` — a leaked interval would outlive the op.
 */
export function startIdemHeartbeat(
  db: Db,
  key: string,
  leaseMs: number,
  fence: ClaimFence,
): () => void {
  // The owned write transaction may occupy the entire pool (max: 1). Native adapters expose a short
  // independent autocommit connection; a heartbeat queued on that pool cannot prove live ownership.
  const heartbeatDb: Db = db.autocommitQuery
    ? { ...db, query: db.autocommitQuery.bind(db), concurrent: true }
    : db;
  return startClaimHeartbeat(
    heartbeatDb,
    IDEMPOTENCY_CLAIM,
    [key],
    leaseMs,
    fence,
  );
}

/** Apply a declared `output` to a successful handler result. A mismatch is the APP's contract, so
 *  `internal` and no received value. Transforms and defaults ride `shaped.data`; the raw return does not. */
function applyDeclaredOutput<O>(
  op: Pick<OpDef<unknown>, "output">,
  result: Result<O>,
): Result<O> {
  if (op.output === undefined || !result.ok) return result;
  const shaped = strictifyOutput(op.output).safeParse(result.value);
  if (!shaped.success) {
    return err(
      "internal",
      "operation returned a value its declared `output` rejects",
    ) as Result<O>;
  }
  return ok(shaped.data as O);
}

/** True when `sql` mutates. Used on the PGlite read path, which cannot wrap `SET TRANSACTION READ ONLY`
 *  without deadlocking nested work on the one session. Concurrent Postgres still uses the real wrap. */
function sqlMutates(sql: string): boolean {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/'(?:''|[^'])*'/g, "''");
  return stripped.split(";").some((part) => {
    const p = part.trim();
    if (p.length === 0) return false;
    if (
      /^(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP|GRANT|REVOKE|COPY|MERGE|CALL|DO|REFRESH|REINDEX|VACUUM|CLUSTER|LOCK)\b/i
        .test(p)
    ) return true;
    if (/\bFOR\s+UPDATE\b/i.test(p)) return true;
    return /^\s*WITH\b/i.test(p) && /\b(INSERT|UPDATE|DELETE)\b/i.test(p);
  });
}

function readBoundDb(db: Db): Db {
  const refuse = (sql: string) => {
    if (sqlMutates(sql)) {
      throw new Error(
        `tx/read-op-no-write: this op is declared tx:"read" but wrote — declare tx:"write", or the READ ONLY tx refuses`,
      );
    }
  };
  return {
    query: (sql, params) => {
      refuse(sql);
      return db.query(sql, params);
    },
    ...(db.queryArrays !== undefined
      ? {
        queryArrays: (sql: string, params?: unknown[]) => {
          refuse(sql);
          return db.queryArrays!(sql, params);
        },
      }
      : {}),
    exec: (sql) => {
      refuse(sql);
      return db.exec(sql);
    },
    ...(db.concurrent !== undefined ? { concurrent: db.concurrent } : {}),
    ...(db.reserve !== undefined ? { reserve: (fn) => db.reserve!(fn) } : {}),
    ...(db.cancelBackend !== undefined
      ? { cancelBackend: (pid) => db.cancelBackend!(pid) }
      : {}),
    ...(db.savepoint !== undefined
      ? { savepoint: (fn) => db.savepoint!(fn) }
      : {}),
  };
}

/** The op-pipeline spine (steps 2–14, minus the drain): validate → build-ctx → policy → tx/before/handler/
 *  after → Result, plus the tx outcome so `runOp` can stamp the §6 record's `txOutcome`. */
async function runOpInner<I, O>(
  op: OpDef<I>,
  handler: Handler<I, O>,
  db: Db & Transactor,
  ctx: OpCtxIn,
  raw: unknown,
  idempotencyKey: string | undefined,
  surface: SurfaceFactory | undefined,
  log: ReturnType<typeof makeOpLog>,
  gatePolicy: unknown,
  opName: string | undefined,
): Promise<
  { result: Result<O>; txOutcome: "committed" | "rolled-back" | "none" }
> {
  const contractErrors = operationContractErrors(op);
  if (contractErrors.length > 0) {
    return {
      result: err(
        "internal",
        "operation declaration violates its execution contract",
      ),
      txOutcome: "none",
    };
  }
  const postBeforeGuard = beforeInputGuard(op);
  // validate (step 2) — strict-parse (mcp/strict-input): unknown keys are loudly rejected, never silently
  // dropped. The Result uses a fixed message: arbitrary custom issue paths/messages may contain data
  // and must not cross the wire or the provenance sink.
  const parsed = strictify(op.input).safeParse(raw);
  if (!parsed.success) {
    return {
      result: err(
        "validation",
        "input failed validation",
      ),
      txOutcome: "none",
    };
  }
  const input = parsed.data as I;
  // build-ctx (step 5) precedes policy (step 6) so policy sees a real read-bound ctx (row pre-loads need
  // ctx.db/data). Effects are deliberately absent/refused here: this is before the operation tx and before
  // the idempotency claim, so a denied/replayed request must not leave durable work behind.
  const buildOpts = { now: ctx.now, log, surface, transactionActive: false };
  // policy (step 6, deny-by-default) runs against the pre-tx ctx (additive — narrower-arity policies ignore it).
  // `gatePolicy` re-derives default-deny for a cross-module carrier (13-authz.md §authz-seam); a direct
  // `runOp` falls back to `op.policy`.
  const policy = (gatePolicy ?? op.policy) as OpDef<I>["policy"];
  // the verdict is awaited — an un-awaited async policy's Promise would read truthy and a DENYING policy
  // would silently allow (the fail-open this await forecloses).
  if (policy) {
    // The lexical read-bound wrapper protects single-connection read handlers, but cannot prove that a
    // SELECT function has no side effect. A policy needs the substrate's actual READ ONLY guarantee even
    // on PGlite: it is its own pre-op transaction, so it does not nest the handler transaction or let a
    // denial leave a durable database effect behind.
    const allowed = await db.transaction(async (policyDb) => {
      await policyDb.query("SET TRANSACTION READ ONLY");
      return await policy(
        ctx.actor,
        input,
        buildOpCtx(ctx, policyDb, {
          ...buildOpts,
          policy: true,
          transactionActive: true,
        }) as PolicyCtx,
      );
    });
    if (!allowed) {
      return { result: err("forbidden", "policy denied"), txOutcome: "none" };
    }
  }
  // admission is the explicit pre-tx durable-accounting seam. It follows the pure policy gate, and the
  // type-level slot permits it only on non-idempotent writes: a replay can never bill twice.
  if (op.admit) {
    const admitted = await op.admit(input, {
      actor: ctx.actor,
      scope: ctx.scope,
      credentialSource: ctx.credentialSource,
      db,
      log,
    });
    if (!admitted.ok) {
      return { result: admitted as Result<O>, txOutcome: "none" };
    }
  }
  // write ops (step 8) run in a tx that rolls back on err; default is write (05-runtime.md §op-pipeline) —
  // mis-detecting a read only costs an empty tx, mis-detecting a write risks corruption. Only `tx:"read"` skips it.
  if (op.tx !== "read") {
    const useIdem = Boolean(op.idempotent && idempotencyKey);
    // namespace the claim by (op, actor, scope, key) — the raw client key is shared across principals and
    // scopes, so two scopes of the same actor would replay each other. Policy (step 6) already ran.
    const idemKey = useIdem
      ? namespaceIdemKey(opName ?? "", ctx.actor, idempotencyKey!, ctx.scope)
      : "";
    if (useIdem && !(opName && opName.length > 0)) {
      return {
        result: err(
          "internal",
          "idempotent write requires a resource-qualified op name",
        ),
        txOutcome: "none",
      };
    }
    if (useIdem && idempotencyClaimTooLong(idemKey)) {
      return {
        result: err(
          "validation",
          "the idempotency claim is too long to store",
        ),
        txOutcome: "none",
      };
    }
    // an in-flight cross-connection claim (04-features.md §idempotency) commits on the base connection before
    // the work tx, so a concurrent same-key request on another connection sees it and 409s immediately.
    // our GENERATION of the claim, carried to the beat and the release so a lapsed holder can refresh or
    // drop only its OWN claim, never the one a peer took over after the lapse.
    let idemFence: ClaimFence = "";
    if (useIdem) {
      // pre-claim/crash-reclaim via the shared durable-claim primitive: `own` ⇒ run; `replay` ⇒ a committed
      // result exists; `conflict` ⇒ 409, never a duplicate effect.
      const verdict = await acquireClaim<O>(
        db,
        IDEMPOTENCY_CLAIM,
        [idemKey],
        op.idempotencyLeaseMs ?? IDEMPOTENCY_LEASE_DEFAULT_MS,
      );
      if (verdict.kind === "replay") {
        // policy already ran; a revoked grant cannot collect a cached result.
        return { result: ok((verdict.value ?? null) as O), txOutcome: "none" };
      }
      if (verdict.kind === "conflict") {
        return {
          result: err(
            "conflict",
            "a request with this idempotency key is already in flight",
          ),
          txOutcome: "none",
        };
      }
      // verdict.kind === "own" → fall through to run the handler
      idemFence = verdict.fence;
    }
    let result: Result<O> = err("internal", "handler did not run");
    // the mid-op heartbeat: while the work tx runs, re-stamp the claim's lease so a slow-but-alive op is never
    // stale-reclaimed (the double-effect path). Stopped in `finally` on every exit — commit, rollback, or throw.
    const stopHeartbeat = useIdem
      ? startIdemHeartbeat(
        db,
        idemKey,
        op.idempotencyLeaseMs ?? IDEMPOTENCY_LEASE_DEFAULT_MS,
        idemFence,
      )
      : undefined;
    try {
      // the write tx carries the default statement_timeout floor (~30s, 05-runtime.md §op-pipeline timeout);
      // `writeTxWithCancel` also cancels the in-flight statement on `ctx.signal` abort, releasing locks promptly.
      await writeTxWithCancel(db, opDeadlineMs(op), ctx.signal, async (tx) => {
        const txBuildOpts = { ...buildOpts, transactionActive: true };
        // each in-tx step gets a ctx bound to `tx` so ctx.emit writes into this tx (commits/rolls back with
        // the op); the shared `log` keeps before/handler/after decorations in one canonical §6 record across rebuilds.
        // before-hook (step 9): may reject (err → abort + rollback) or transform the input. `ok(undefined)`
        // leaves `input` unchanged; `ok(newInput)` swaps the value the handler receives.
        let handlerInput = input;
        if (op.before) {
          const b = await op.before(
            input,
            buildOpCtx(ctx, tx, txBuildOpts) as OpCtx,
          );
          if (!b.ok) {
            result = b as Result<O>;
            throw new Error("__rollback__");
          } // first before to err stops the chain
          if (b.value !== undefined) handlerInput = b.value as I; // ok(newInput) → transform the handler's input
          if (!postBeforeGuard!.safeParse(handlerInput).success) {
            result = err(
              "internal",
              "operation before hook violated its declared input contract",
            );
            throw new Error("__rollback__");
          }
        }
        result = await handler(
          handlerInput,
          buildOpCtx(ctx, tx, txBuildOpts) as OpCtx,
        );
        if (!result.ok) throw new Error("__rollback__");
        // after-hook (step 11): runs only after a successful handler; may reject (err → abort + rollback,
        // taking the handler's write with it). `ok(undefined)` keeps the handler's result.
        if (op.after) {
          const a = await op.after(
            handlerInput,
            buildOpCtx(ctx, tx, txBuildOpts) as OpCtx,
          );
          if (!a.ok) {
            result = a as Result<O>;
            throw new Error("__rollback__");
          }
        }
        // OUTPUT (declared → enforced) inside the write tx, before the claim is finalized. A mismatch
        // used to commit the business write and then return `internal`; a retry replayed the stored
        // raw value and failed the outer parse again. `shaped.data` is what the caller and the claim hold.
        result = applyDeclaredOutput(op, result);
        if (!result.ok) throw new Error("__rollback__");
        // finalize in the same tx (atomic with the business write). `result.value === undefined` must coalesce
        // to `?? null` — `JSON.stringify(undefined)` binds SQL NULL (the in-flight sentinel), wedging a resend.
        // Fenced: a lease-lost zombie finalizing late matches zero rows — the peer that owns the generation
        // keeps its claim, and this attempt's business write rolls back with the throw.
        if (useIdem) {
          const finalized = (await tx.query(
            `UPDATE "_idempotency" SET result = $2::text::jsonb WHERE key = $1${
              fenceGuard(IDEMPOTENCY_CLAIM, 3)
            } RETURNING 1`,
            [
              idemKey,
              JSON.stringify(
                wireJson(
                  (surface?.replayShape ?? ((v: unknown) => v))(
                    result.value ?? null,
                  ),
                ),
              ),
              idemFence,
            ],
          )).rows.length;
          if (finalized === 0) {
            throw new Error(
              `idempotency finalize lost the claim on '${idemKey}' — a peer took over the generation; this attempt is discarded`,
            );
          }
        }
      });
    } catch (e) {
      // the business write rolled back — release the in-flight claim (durable-claim.ts) so the key is
      // retryable (a failed op never burns its key); guarded on `result IS NULL` so it clears only our own claim.
      if (useIdem) {
        try {
          await releaseClaim(db, IDEMPOTENCY_CLAIM, [idemKey], idemFence);
        } catch {
          // The business transaction already rolled back. Cleanup failure must not replace its Result
          // or leak a driver exception; the unfinished claim remains recoverable through its own lease.
          log.set("claimReleaseFailed", true);
        }
      }
      // every catch path is a rolled-back tx (it threw before commit) — the §6 record reports it.
      if (thrownMessage(e, "") === "__rollback__") {
        return { result, txOutcome: "rolled-back" }; // handler/hook err — `result` holds it
      }
      if (isUniqueViolation(e)) {
        return {
          result: err("conflict", "unique constraint violated"),
          txOutcome: "rolled-back",
        };
      }
      if (isForeignKeyViolation(e)) {
        return {
          result: err("conflict", "foreign key constraint violated"),
          txOutcome: "rolled-back",
        };
      }
      // temporal noOverlap (04-features.md §temporal migrate): a 23P01 EXCLUDE violation from a write that
      // overlaps a validity window maps to the same `conflict` kind as a unique clash, never a raw `internal` 500.
      if (isExclusionViolation(e)) {
        return {
          result: err(
            "conflict",
            "validity windows overlap (temporal noOverlap)",
          ),
          txOutcome: "rolled-back",
        };
      }
      if (isTimeoutError(e)) {
        return {
          result: err("timeout", "operation exceeded its deadline"),
          txOutcome: "rolled-back",
        };
      }
      if (isResourceExhausted(e)) {
        return {
          result: err("timeout", RESOURCE_EXHAUSTED_MESSAGE),
          txOutcome: "rolled-back",
        };
      }
      // a kinded throw (a framework gate, or app code throwing a classified error) maps to its declared kind —
      // flattening it to `internal` would misroute a non-retryable failure as retryable; `errorKind` defaults there.
      return {
        result: { ok: false, error: resultError(e) },
        txOutcome: "rolled-back",
      };
    } finally {
      stopHeartbeat?.(); // every exit path stops the lease refresh — a leaked interval would outlive the op
    }
    // the transaction resolved without throwing → it committed (the write landed).
    return { result, txOutcome: "committed" };
  }
  // read path: tx-free by default on a single-connection db (PGlite) — ctx.modules / ctx.reads /
  // ctx.readModels bind the base connection, and a nested `.transaction()` there deadlocks the one
  // session (db.ts). A pooled db (`concurrent`) wraps every read in SET TRANSACTION READ ONLY so a
  // write is refused at the substrate (M-15). `deadlineMs` opts into a read-tx on both, with SET LOCAL
  // statement_timeout, so a runaway read is PG-aborted (57014 → `timeout`) same as the write path —
  // errors map the same way (timeout, then an integrity fault's fixed sentence,
  // else `errorKind`) so a read never escapes
  // uncaught and §6 always drains. before/after hooks run for reads too (before may reject/transform,
  // after may reject) — mirrors the write path's composition; a read op can never write, so these
  // hooks stay read-only by construction.
  const runReadHooks = async (
    rdb: Db,
    transactionActive: boolean,
    surfaceBaseDb?: Db & Transactor,
  ): Promise<Result<O>> => {
    const readBuildOpts = markReadOnlyBuildOptions({
      ...buildOpts,
      transactionActive,
      surfaceBaseDb,
    });
    let handlerInput = input;
    if (op.before) {
      const b = await op.before(
        input,
        buildOpCtx(ctx, rdb, readBuildOpts) as OpCtx,
      );
      if (!b.ok) return b as Result<O>; // a before-hook rejection aborts the read (the first before to err stops the chain)
      if (b.value !== undefined) handlerInput = b.value as I; // ok(newInput) → transform the handler's input
      if (!postBeforeGuard!.safeParse(handlerInput).success) {
        return err(
          "internal",
          "operation before hook violated its declared input contract",
        );
      }
    }
    const r = await handler(
      handlerInput,
      buildOpCtx(ctx, rdb, readBuildOpts) as OpCtx,
    );
    if (!r.ok) return r; // handler err → after does not run (mirrors the write path)
    if (op.after) {
      const a = await op.after(
        handlerInput,
        buildOpCtx(ctx, rdb, readBuildOpts) as OpCtx,
      );
      if (!a.ok) {
        return a as Result<O>; // after may reject
      }
    }
    return r;
  };
  try {
    if (op.readConsistency === "statement") {
      const ports = statementReadPorts(db, opDeadlineMs(op), ctx.signal);
      return {
        result: applyDeclaredOutput(
          op,
          await runReadHooks(ports.db, false, ports.base),
        ),
        txOutcome: "none",
      };
    }
    const deadline = op.deadlineMs !== undefined && op.deadlineMs > 0;
    if (!deadline && db.concurrent !== true) {
      return {
        result: applyDeclaredOutput(
          op,
          await runReadHooks(readBoundDb(db), false),
        ),
        txOutcome: "none",
      };
    }
    return await db.transaction(async (tx) => {
      await tx.query("SET TRANSACTION READ ONLY");
      if (deadline) {
        await tx.query(
          `SET LOCAL statement_timeout = ${Math.floor(op.deadlineMs!)}`,
        );
      }
      return {
        result: applyDeclaredOutput(op, await runReadHooks(tx, true)),
        txOutcome: "none",
      };
    });
  } catch (e) {
    const txOutcome = "rolled-back";
    if (isTimeoutError(e)) {
      return {
        result: err("timeout", "operation exceeded its deadline"),
        txOutcome,
      };
    }
    if (isResourceExhausted(e)) {
      return { result: err("timeout", RESOURCE_EXHAUSTED_MESSAGE), txOutcome };
    }
    // A datasource write uses its own connection, so a tx:"read" op can still
    // raise a unique, foreign-key, or exclusion fault. The owned write catch
    // already substitutes a fixed sentence; this door does too.
    const fault = integrityFault(e);
    if (fault !== undefined) {
      return { result: err(fault.kind, fault.message), txOutcome };
    }
    const msg = thrownText(e);
    if (
      /read-only transaction|cannot execute .* in a read-only|25006|tx\/read-op-no-write/i
        .test(msg)
    ) {
      return {
        result: err(
          "internal",
          `tx/read-op-no-write: this op is declared tx:"read" but wrote — declare tx:"write", or the READ ONLY tx refuses`,
        ),
        txOutcome,
      };
    }
    return { result: { ok: false, error: resultError(e) }, txOutcome };
  }
}
