import type { Actor } from "../authz/auth.ts";
import type { Db, Transactor } from "../data/db.ts";
import type { Result } from "./result.ts";
import type { HttpRoute, McpCuration } from "./app.ts";
import type {
  Clock,
  OpLog,
  OpSurface,
  PolicyCtx,
  ProvenanceOrigin,
  RichCtx,
} from "./ctx.ts";
import type { z } from "zod";
// app.ts's convention default-deny resolver is reused here, never reimplemented, so the gate is by-construction
// on every dispatch surface. The app.ts↔serve.ts↔pipeline.ts import ring is runtime-only, not module-init.

/** The data/transition/query/modules surface factory the pipeline threads into the handler ctx (05-runtime.md
 *  §ctx), invoked with the live db at build-ctx time. Absent ⇒ the handler keeps bare `RichCtx`. */
export type SurfaceFactory =
  & ((db: Db, readBase?: Db & Transactor) => OpSurface)
  & {
    /** The value an idempotency claim stores for replay: what the doors serve, never the handler's raw value. */
    readonly replayShape?: (value: unknown) => unknown;
  };

/** The §6 ProvenanceRecord op-descriptor + origin the drain stamps onto the record (05-runtime.md §runtime-provenance).
 *  `module`/`resource`/`origin` come only from the live caller; omitted, the drain defaults to `origin:"cross-module"`.
 */
export interface OpProvenance {
  readonly op: string;
  readonly module?: string;
  readonly resource?: string;
  readonly origin?: ProvenanceOrigin;
  /** Declared fields that must never cross the provenance-sink boundary in plaintext. */
  readonly redactedAttrs?: ReadonlySet<string>;
  /** The resource's declared log-mask style for `redactedAttrs`; absent keeps the fail-safe full mask. */
  readonly redactionMaskStyle?: "full" | "partial";
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
  /** Source asserted by the deployment's trusted clientIp hook; never read from raw forwarded headers. */
  readonly credentialSource?: string;
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
  | ((
    actor: Actor | null,
    input: I,
    ctx: PolicyCtx,
  ) => boolean | Promise<boolean>)
  | null;

/** The deliberately narrow context for explicit pre-transaction admission accounting. Unlike `policy`, an
 * admission may write through `db` and that write commits independently of the operation transaction. It is
 * therefore available only to non-idempotent writes: a replay must never bill a durable admission twice. */
export interface AdmissionCtx {
  readonly actor: Actor | null;
  readonly scope: string;
  readonly credentialSource?: string;
  readonly db: Db;
  readonly log: OpLog;
}

export type OpAdmission<I> = (
  input: I,
  ctx: AdmissionCtx,
) => Promise<Result<void>> | Result<void>;

/**
 * tx mode (step 8, 05-runtime.md §op-pipeline) paired with the two decisions it governs, because all
 * three are one decision. Every declaration writes tx explicitly; tx:"read" is the verified opt-in
 * that skips the tx and the idempotency store. The lower-level write fallback is not an authoring default.
 *
 * BOTH branches state the authorization decision. A custom read is NOT gated by the WHERE-stack — its
 * handler may touch no table at all. Without the type face and createApp's op/decisions-written boot floor,
 * an omitted policy could therefore leave a lower-level carrier ungated. Guarded apps refuse omission;
 * policy:null is the written ungated decision, and idempotent:false opts out of dedup on a write.
 */
type TxDecisionSlot<I> =
  | {
    readonly tx: "read";
    /** Each DB call owns a short READ ONLY tx; the operation can wait on external I/O without holding one. */
    readonly readConsistency?: "statement";
    readonly policy: OpPolicy<I>;
    readonly idempotent?: never;
    readonly admit?: never;
  }
  | {
    // REQUIRED, not defaulted. An omitted `tx` landed `write` at the pipeline, so a read-only op took a
    // write transaction — locks it never needed, and no read replica able to serve it. The default was the
    // conservative direction, so nothing was unsafe; what failed is the rule that a decision whose wrong
    // answer costs something is WRITTEN. `op/decisions-written` is the boot floor under this slot.
    readonly tx: "write";
    readonly readConsistency?: never;
    readonly policy: OpPolicy<I>;
    readonly idempotent: true;
    readonly admit?: never;
  }
  | {
    readonly tx: "write";
    readonly readConsistency?: never;
    readonly policy: OpPolicy<I>;
    readonly idempotent: false;
    /** Explicit durable admission accounting after a policy permits the request, before its transaction.
     * An admission's database work is intentionally independent: its `err` stops the operation with no op
     * transaction, while an admitted operation that later errors does not roll the admission back. */
    readonly admit?: OpAdmission<I>;
  };

/** The op contract minus the tx↔policy↔idempotent triple `TxDecisionSlot` carries. */
export interface OpDefFields<I> {
  readonly input: z.ZodType<I>;

  /** The shape the handler's `ok` value must satisfy. Declared, it is ENFORCED: a handler returning
   *  something else is a contract violation and never reaches the caller. Absent, the return is unchecked. */
  readonly output?: z.ZodType;
  /** Crash-reclaim lease, default five minutes; an idempotent write requires it strictly longer than
   * its finite SQL statement deadline. Heartbeats extend live ownership; external effects remain retryable. */
  readonly idempotencyLeaseMs?: number;
  /** SQL statement deadline, default 30s on writes. Zero opts out only for non-idempotent operations. */
  readonly deadlineMs?: number;
  // op-level deprecation metadata (03-api-shape.md §http-evolution): ISO dates + a successor op name; the serve route
  // emits RFC 9745/8594 Deprecation/Sunset/Link headers. Additive (surface-lock ok); inert on MCP/logic paths.
  readonly deprecated?: string;
  readonly sunset?: string;
  readonly replacedBy?: string;
  /** Validation-only schema for the parsed handler input after `before`; required when input decoding
   * has opaque output (transforms/coercion/defaults). Never reruns the external input decoder. */
  readonly beforeOutput?: z.ZodType<I>;
  /** Runs in-tx before the handler. Errors roll back; every success validates the replacement or
   * mutated original before the body, including observers returning `ok(undefined)`. */
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
