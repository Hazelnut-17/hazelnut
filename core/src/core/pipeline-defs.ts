import type { Actor } from "../authz/auth.ts";
import type { Db } from "../data/db.ts";
import type { Result } from "./result.ts";
import type { HttpRoute, McpCuration } from "./app.ts";
import type { Clock, OpSurface, ProvenanceOrigin, RichCtx } from "./ctx.ts";
import type { z } from "zod";
// app.ts's convention default-deny resolver is reused here, never reimplemented, so the gate is by-construction
// on every dispatch surface. The app.ts↔serve.ts↔pipeline.ts import ring is runtime-only, not module-init.

/** The data/transition/query/modules surface factory the pipeline threads into the handler ctx (05-runtime.md
 *  §ctx), invoked with the live db at build-ctx time. Absent ⇒ the handler keeps bare `RichCtx`. */
export type SurfaceFactory = (db: Db) => OpSurface;

/** The §6 ProvenanceRecord op-descriptor + origin the drain stamps onto the record (05-runtime.md §6).
 *  `module`/`resource`/`origin` come only from the live caller; omitted, the drain defaults to `origin:"cross-module"`.
 */
export interface OpProvenance {
  readonly op: string;
  readonly module?: string;
  readonly resource?: string;
  readonly origin?: ProvenanceOrigin;
}

/** A focused subset of the 15-step op-pipeline (05-runtime.md §op-pipeline): validate → build-ctx → policy
 *  (deny-by-default, ctx-dependent policies see a real ctx) → tx (`tx:"write"` opens it, `tx:"read"` skips it) → handler.
 */
// the Result family lives in the leaf core/result.ts (the vocabulary every layer speaks) and is
// re-exported here verbatim so `from "./pipeline.ts"` import sites keep resolving.

/** The op-handler `ctx` — `RichCtx` (`{ actor, scope, db }` plus `now()`, `log`, `emit`) assembled by the
 *  pipeline's build-ctx step (05-runtime.md §ctx); callers keep passing a bare `{ actor, scope }` (`OpCtxIn`). */
// the handler-facing ctx requires the surface (`RichCtx & OpSurface`, not `Partial`): a handler always runs
// on the composed-app path, so this drops the `ctx.transition!`/`ctx.data!` non-null-assertion papercut everywhere.
export type OpCtx = RichCtx & OpSurface;

/**
 * The ctx fields a caller supplies to the pipeline; `db`/`log`/`emit` are built inside `runOp`. A bare
 * `{ actor, scope }` (`ReadCtx`) satisfies this — `now` is an optional clock injection tests pin.
 */
export interface OpCtxIn {
  readonly actor: Actor | null;
  readonly scope: string;
  readonly now?: Clock;
  // the resolved multi-version API pin (multi-version.md §3), threaded to `ctx.version`; absent ⇒
  // current/latest. Additive — serve/mcp pass it when `Hazelnut-Version` is present, else omitted.
  readonly version?: string;
  // the per-request wire correlation id (serve mints + echoes it on `Hazelnut-Trace-Id`) threaded here so
  // the §6 record's `traceId` is the id the client holds — joinable without guessing; absent ⇒ a fresh uuid.
  readonly traceId?: string;
  // the per-request cancellation signal (client disconnect merged with an optional wall-clock deadline,
  // serve.ts), threaded so a signal-aware handler can abort out-of-tx I/O instead of running on as a zombie.
  readonly signal?: AbortSignal;
}

/**
/**
 * Deny-by-default gate (step 6, 05-runtime.md §op-pipeline), run after build-ctx (step 5) against the
 * pre-tx ctx — `ctx` is additive (narrower-arity `requires(perm)` ignores it); in-tx members rebind later.
 * The pipeline awaits the verdict, so an async policy (a grant lookup) denies like a sync one.
 * `null` is the ungated door said out loud (a pre-auth login) — a decision, not an omission.
 */
export type OpPolicy<I> =
  | ((actor: Actor | null, input: I, ctx: OpCtx) => boolean | Promise<boolean>)
  | null;

/**
 * tx mode (step 8, 05-runtime.md §op-pipeline) paired with the two decisions it governs, because all
 * three are one decision. Default is write — mis-detecting a read only costs an empty tx, mis-detecting a
 * write corrupts data; `tx:"read"` is the verified opt-in that skips the tx and the idempotency store.
 *
 * BOTH branches state the authorization decision. A custom read is NOT gated by the WHERE-stack — its
 * handler may touch no table at all — so an absent `policy` there serves the handler to anonymous callers.
 * `policy: null` publishes the op and `idempotent: false` opts out of dedup; each is a decision the author
 * made, and an absent slot is one they never made.
 */
type TxDecisionSlot<I> =
  | {
    readonly tx: "read";
    readonly policy: OpPolicy<I>;
    readonly idempotent?: never;
  }
  | {
    // REQUIRED, not defaulted. An omitted `tx` landed `write` at the pipeline, so a read-only op took a
    // write transaction — locks it never needed, and no read replica able to serve it. The default was the
    // conservative direction, so nothing was unsafe; what failed is the rule that a decision whose wrong
    // answer costs something is WRITTEN. `op/decisions-written` is the boot floor under this slot.
    readonly tx: "write";
    readonly policy: OpPolicy<I>;
    readonly idempotent: boolean;
  };

/** The op contract minus the tx↔policy↔idempotent triple `TxDecisionSlot` carries. */
export interface OpDefFields<I> {
  readonly input: z.ZodType<
    I
  >; /** Per-op override of the `_idempotency` crash-reclaim lease (04-features.md §idempotency); an op whose
   *  wall-clock approaches the default floor declares its own ceiling so a slow-but-alive run isn't reclaimed. */

  readonly idempotencyLeaseMs?: number;
  readonly deadlineMs?: number; // write-tx statement deadline (05-runtime §timeout); undeclared → the 30s default
  // (declare to raise a slow op's ceiling, 0 to opt out); PG aborts an overrun → err("timeout"), rolls back.
  // op-level deprecation metadata (03-api-shape.md §9): ISO dates + a successor op name; the serve route
  // emits RFC 9745/8594 Deprecation/Sunset/Link headers. Additive (surface-lock ok); inert on MCP/logic paths.
  readonly deprecated?: string;
  readonly sunset?: string;
  readonly replacedBy?: string;
  /**
   * before-hook (step 9, 05-runtime.md §op-pipeline "hooks"): runs in-tx before the handler — `err` aborts
   * and rolls back the tx; `ok(newInput)` swaps the handler's input; `ok(undefined)` leaves it unchanged.
   */
  readonly before?: (
    input: I,
    ctx: OpCtx,
  ) => Promise<Result<I | void>> | Result<I | void>;
  /**
   * after-hook (step 11): runs in-tx after a successful handler, before commit — `err` aborts and rolls back
   * the tx, taking the handler's write with it; `ok(undefined)` keeps the result.
   */
  readonly after?: (
    input: I,
    ctx: OpCtx,
  ) => Promise<Result<void>> | Result<void>;
}

/** The op contract as one value: the fields plus the tx↔policy pair. */
export type OpDef<I> = OpDefFields<I> & TxDecisionSlot<I>;

export type Handler<I, O> = (input: I, ctx: OpCtx) => Promise<Result<O>>;

/** The `OpDef` fields plus the handler and its hook variants — again minus the tx↔policy pair. */
interface OpDeclFields<I, O> extends OpDefFields<I> {
  readonly handler: Handler<I, O>;
  /** replace-hook (step 10): substitutes `handler` — still wrapped by `before`/`after` and the tx, so the
   *  order stays before → replace → after. When both are declared, `replace` wins; `handler` is the fallback.
   */
  readonly replace?: Handler<I, O>;
  /**
   * around-hook (step 10): wraps the handler via `next()` (invokes replace-or-handler); may transform the
   * result or short-circuit (skip `next()`, e.g. a cache hit). Order: before → around(replace/handler) → after.
   */
  readonly around?: (
    input: I,
    ctx: OpCtx,
    next: () => Promise<Result<O>>,
  ) => Promise<Result<O>>;
}

/** A full op declared as one value — the OpDef contract plus its handler — collectable on a resource. */
export type OpDecl<I, O> = OpDeclFields<I, O> & TxDecisionSlot<I>;

/** `defineOp` is the single op-authoring helper — it derives the input type from the zod `input:` schema, so
 *  a duplicated hand-written type is unrepresentable. Re-exported so `pipeline.ts` import sites keep resolving.
 */

/**
 * Compose an op's effective handler from its hook variants (05-runtime.md §op-pipeline "hooks"): `replace`
 * substitutes the handler, `around` wraps it via `next()`. Full order: before → around(replace/handler) → after.
 */
export function composeOpHandler<I, O>(decl: OpDecl<I, O>): Handler<I, O> {
  const core = decl.replace ?? decl.handler;
  const around = decl.around;
  return around
    ? (input, ctx) => around(input, ctx, () => core(input, ctx))
    : core;
}

/** The `effectiveOpPolicy` input shape, re-stated structurally so the pipeline imports only the function +
 *  its leaf types, never app.ts's private `OpExposureSource` interface. A full resource model is assignable here. */
type CarrierModel = {
  readonly name: string;
  readonly operations: Readonly<Record<string, unknown>>;
  readonly http: Readonly<Partial<Record<string, HttpRoute>>>;
  readonly mcp: McpCuration;
};

/** True iff the dispatch carrier is a full resource model (the `name`/`http`/`mcp` fields `effectiveOpPolicy`
 *  reads), not the curated `{ operations }` slice serve.ts/mcp.ts pass — only the cross-module path carries these.
 */
export function isExposureSource(
  carrier: { readonly operations: Readonly<Record<string, unknown>> },
): carrier is CarrierModel {
  return "name" in carrier && "http" in carrier && "mcp" in carrier;
}

// roster/engine extracted into cohesive submodules, re-exported so importers stay stable.
