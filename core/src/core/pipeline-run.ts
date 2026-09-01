// Barrel re-exports keep import sites stable.
import type { Actor } from "../authz/auth.ts";
import {
  type Db,
  isExclusionViolation,
  isUniqueViolation,
  type Transactor,
} from "../data/db.ts";
// re-exported so the serve/mcp doors keep one import home for the engine-error predicates (pipeline barrel)
export { isExclusionViolation, isUniqueViolation };
import { strictify } from "../data/schema.ts";
import { getTracer, withSpan } from "./tracing.ts";
import { effectiveOpPolicy } from "./app-refs.ts";
import {
  assembleProvenance,
  buildOpCtx,
  getLogSink,
  type JsonScalar,
  makeOpLog,
} from "./ctx.ts";
import { err, errorKind, isTimeoutError, ok, type Result } from "./result.ts"; // the concrete home — never through the pipeline barrel, which re-exports it
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
import { validationDetail } from "./validation.ts";
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
): Promise<Result<O>> {
  const decl = carrier.operations[name] as OpDecl<unknown, O> | undefined;
  // a missing op still drains a notFound record (the by-construction §6 guarantee — every dispatch attempt
  // produces one record, even the no-such-op floor), with the requested name as the op descriptor.
  const provenance: OpProvenance = { op: name, ...prov };
  if (!decl) return drainNotFound<O>(provenance, ctx, `no operation '${name}'`);
  // resolve the gate policy at this dispatch chokepoint: a full-model (cross-module) carrier re-derives
  // default-deny via `effectiveOpPolicy`; a curated serve/mcp carrier already has policy injected, used as-is.
  const gatePolicy = isExposureSource(carrier)
    ? effectiveOpPolicy(carrier, name)
    : undefined;
  // the op-pipeline's instrumentation point — one span per op (no-op until a tracer is installed)
  return withSpan(
    getTracer(),
    `op:${name}`,
    () =>
      runOp(
        decl,
        composeOpHandler(decl),
        db,
        ctx,
        raw,
        idempotencyKey,
        surface,
        provenance,
        gatePolicy,
      ),
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

/** Drain one §6 ProvenanceRecord to the active `logSink` (05-runtime.md §6 "the pipeline drain"), fire-and-
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
    const record = assembleProvenance({
      actor: ctx.actor,
      scope: ctx.scope,
      attrs,
      op: {
        op: prov.op,
        ...(prov.module !== undefined ? { module: prov.module } : {}),
        ...(prov.resource !== undefined ? { resource: prov.resource } : {}),
      },
      origin: prov.origin ?? "cross-module",
      outcome: result.ok ? "ok" : "err",
      kind: result.ok ? undefined : result.error.kind,
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
): Promise<Result<O>> {
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
      e instanceof Error ? e.message : "op threw",
    ) as Result<O>;
    throw e;
  } finally {
    drainProvenance(
      prov ?? { op: op.tx === "read" ? "read" : "write" },
      ctx,
      log.attrs,
      result ?? err("internal", "op threw"),
      txOutcome,
      startedAt,
    );
  }
}

/**
 * Namespace the client idempotency key as an injective `[op, scope_key, key]` composition (04-features.md
 * §idempotency) — a client key can never forge another principal's namespace. Caveat: all anonymous callers
 * share one `""` principal, so same-key anon clients collide; per-client isolation needs its own actor.
 */
export function namespaceIdemKey(
  opName: string,
  actor: Actor | null,
  key: string,
): string {
  return JSON.stringify([opName, actor?.id ?? "", key]);
}

/** The crash-reclaim lease for an in-flight `_idempotency` claim (stale ⇒ reclaimed, so a hard-killed
 *  claimant can't wedge a retry). MUST exceed an op's worst-case wall-clock — a live reclaim double-runs it. */
const IDEMPOTENCY_LEASE_MS = 5 * 60 * 1000;

/** The default write-tx statement deadline (05-runtime.md §op-pipeline timeout, ~30s) applied when an op
 *  declares no `deadlineMs`, so a hung query can never hold a write tx's locks indefinitely; `0` opts out. */
export const OP_DEADLINE_DEFAULT_MS = 30_000;

/** The effective write-tx deadline for an op: declared `deadlineMs` wins, `0` disables, undeclared → the
 *  30s default floor. The single resolution the tx SET LOCAL reads (kept pure so it is unit-assertable). */
export function opDeadlineMs(op: { readonly deadlineMs?: number }): number {
  return op.deadlineMs ?? OP_DEADLINE_DEFAULT_MS;
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
  return (db as Db & Transactor).transaction(async (tx) => {
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
      await tx.query(`SET LOCAL statement_timeout = ${Math.floor(deadlineMs)}`);
    } else if (canCancel) {
      pid = Number(
        (await tx.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`))
          .rows[0]?.pid,
      );
    }
    let onAbort: (() => void) | undefined;
    if (canCancel && Number.isFinite(pid)) {
      const cancel = db.cancelBackend!;
      onAbort = () => {
        void cancel(pid).catch(() => {});
      }; // best-effort — the statement_timeout backstops a failed cancel
      if (signal!.aborted) onAbort();
      else signal!.addEventListener("abort", onAbort, { once: true });
    }
    try {
      return await fn(tx);
    } finally {
      // remove the listener before the tx commits (this finally runs inside the tx callback, before postgres.js
      // commits) so a late abort can never cancel the commit itself.
      if (onAbort) signal!.removeEventListener("abort", onAbort);
    }
  });
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
  return startClaimHeartbeat(db, IDEMPOTENCY_CLAIM, [key], leaseMs, fence); // composes the shared durable-claim heartbeat
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
  // validate (step 2) — strict-parse (mcp/strict-input): unknown keys are loudly rejected, never silently
  // dropped. The reject carries redaction-safe per-issue detail (path + code, never the received value).
  const parsed = strictify(op.input).safeParse(raw);
  if (!parsed.success) {
    return {
      result: err(
        "validation",
        validationDetail("input failed validation", parsed.error),
      ),
      txOutcome: "none",
    };
  }
  const input = parsed.data as I;
  // build-ctx (step 5) precedes policy (step 6) so policy sees a real ctx (row pre-loads need ctx.db/data).
  // `surface` rebinds per step against `tx` in-tx; `ctx.modules` dispatches on the base db by design.
  const buildOpts = { now: ctx.now, log, surface };
  // policy (step 6, deny-by-default) runs against the pre-tx ctx (additive — narrower-arity policies ignore it).
  // `gatePolicy` re-derives default-deny for a cross-module carrier (13-authz.md §authz-seam); a direct
  // `runOp` falls back to `op.policy`.
  const policy = (gatePolicy ?? op.policy) as OpDef<I>["policy"];
  // the verdict is awaited — an un-awaited async policy's Promise would read truthy and a DENYING policy
  // would silently allow (the fail-open this await forecloses).
  if (
    policy &&
    !(await policy(ctx.actor, input, buildOpCtx(ctx, db, buildOpts) as OpCtx))
  ) return { result: err("forbidden", "policy denied"), txOutcome: "none" };
  // write ops (step 8) run in a tx that rolls back on err; default is write (05-runtime.md §op-pipeline) —
  // mis-detecting a read only costs an empty tx, mis-detecting a write risks corruption. Only `tx:"read"` skips it.
  if (op.tx !== "read") {
    const useIdem = Boolean(op.idempotent && idempotencyKey);
    // namespace the claim by (op, actor, key) — the raw client key is cross-actor/cross-op shared, so
    // two tenants with the same key string would replay each other. The effective key isolates per principal+op.
    const idemKey = useIdem
      ? namespaceIdemKey(opName ?? "", ctx.actor, idempotencyKey!)
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
        op.idempotencyLeaseMs ?? IDEMPOTENCY_LEASE_MS,
      );
      if (verdict.kind === "replay") {
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
        op.idempotencyLeaseMs ?? IDEMPOTENCY_LEASE_MS,
        idemFence,
      )
      : undefined;
    try {
      // the write tx carries the default statement_timeout floor (~30s, 05-runtime.md §op-pipeline timeout);
      // `writeTxWithCancel` also cancels the in-flight statement on `ctx.signal` abort, releasing locks promptly.
      await writeTxWithCancel(db, opDeadlineMs(op), ctx.signal, async (tx) => {
        // each in-tx step gets a ctx bound to `tx` so ctx.emit writes into this tx (commits/rolls back with
        // the op); the shared `log` keeps before/handler/after decorations in one canonical §6 record across rebuilds.
        // before-hook (step 9): may reject (err → abort + rollback) or transform the input. `ok(undefined)`
        // leaves `input` unchanged; `ok(newInput)` swaps the value the handler receives.
        let handlerInput = input;
        if (op.before) {
          const b = await op.before(
            input,
            buildOpCtx(ctx, tx, buildOpts) as OpCtx,
          );
          if (!b.ok) {
            result = b as Result<O>;
            throw new Error("__rollback__");
          } // first before to err stops the chain
          if (b.value !== undefined) handlerInput = b.value as I; // ok(newInput) → transform the handler's input
        }
        result = await handler(
          handlerInput,
          buildOpCtx(ctx, tx, buildOpts) as OpCtx,
        );
        if (!result.ok) throw new Error("__rollback__");
        // after-hook (step 11): runs only after a successful handler; may reject (err → abort + rollback,
        // taking the handler's write with it). `ok(undefined)` keeps the handler's result.
        if (op.after) {
          const a = await op.after(
            handlerInput,
            buildOpCtx(ctx, tx, buildOpts) as OpCtx,
          );
          if (!a.ok) {
            result = a as Result<O>;
            throw new Error("__rollback__");
          }
        }
        // finalize in the same tx (atomic with the business write). `result.value === undefined` must coalesce
        // to `?? null` — `JSON.stringify(undefined)` binds SQL NULL (the in-flight sentinel), wedging a resend.
        // Fenced: a lease-lost zombie finalizing late matches zero rows — the peer that owns the generation
        // keeps its claim, and this attempt's business write rolls back with the throw.
        if (useIdem) {
          const finalized = (await tx.query(
            `UPDATE "_idempotency" SET result = $2::text::jsonb WHERE key = $1${
              fenceGuard(IDEMPOTENCY_CLAIM, 3)
            } RETURNING 1`,
            [idemKey, JSON.stringify(result.value ?? null), idemFence],
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
        await releaseClaim(db, IDEMPOTENCY_CLAIM, [idemKey], idemFence);
      }
      // every catch path is a rolled-back tx (it threw before commit) — the §6 record reports it.
      if (e instanceof Error && e.message === "__rollback__") {
        return { result, txOutcome: "rolled-back" }; // handler/hook err — `result` holds it
      }
      if (isUniqueViolation(e)) {
        return {
          result: err("conflict", "unique constraint violated"),
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
      // a kinded throw (a framework gate, or app code throwing a classified error) maps to its declared kind —
      // flattening it to `internal` would misroute a non-retryable failure as retryable; `errorKind` defaults there.
      return { result: err(errorKind(e), String(e)), txOutcome: "rolled-back" };
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
  // errors map the same way (isTimeoutError → timeout, else `errorKind`) so a read never escapes
  // uncaught and §6 always drains. before/after hooks run for reads too (before may reject/transform,
  // after may reject) — mirrors the write path's composition; a read op can never write, so these
  // hooks stay read-only by construction.
  const runReadHooks = async (rdb: Db): Promise<Result<O>> => {
    let handlerInput = input;
    if (op.before) {
      const b = await op.before(
        input,
        buildOpCtx(ctx, rdb, buildOpts) as OpCtx,
      );
      if (!b.ok) return b as Result<O>; // a before-hook rejection aborts the read (the first before to err stops the chain)
      if (b.value !== undefined) handlerInput = b.value as I; // ok(newInput) → transform the handler's input
    }
    const r = await handler(
      handlerInput,
      buildOpCtx(ctx, rdb, buildOpts) as OpCtx,
    );
    if (!r.ok) return r; // handler err → after does not run (mirrors the write path)
    if (op.after) {
      const a = await op.after(
        handlerInput,
        buildOpCtx(ctx, rdb, buildOpts) as OpCtx,
      );
      if (!a.ok) {
        return a as Result<O>; // after may reject
      }
    }
    return r;
  };
  try {
    const deadline = op.deadlineMs !== undefined && op.deadlineMs > 0;
    if (!deadline && db.concurrent !== true) {
      return { result: await runReadHooks(db), txOutcome: "none" };
    }
    return await db.transaction(async (tx) => {
      await tx.query("SET TRANSACTION READ ONLY");
      if (deadline) {
        await tx.query(
          `SET LOCAL statement_timeout = ${Math.floor(op.deadlineMs!)}`,
        );
      }
      return { result: await runReadHooks(tx), txOutcome: "none" };
    });
  } catch (e) {
    const txOutcome = "rolled-back";
    if (isTimeoutError(e)) {
      return {
        result: err("timeout", "operation exceeded its deadline"),
        txOutcome,
      };
    }
    const msg = String(e);
    if (
      /read-only transaction|cannot execute .* in a read-only|25006/i.test(msg)
    ) {
      return {
        result: err(
          "internal",
          `tx/read-op-no-write: this op is declared tx:"read" but wrote — declare tx:"write", or the READ ONLY tx refuses`,
        ),
        txOutcome,
      };
    }
    return { result: err(errorKind(e), String(e)), txOutcome };
  }
}
