import type { Where } from "../core/where.ts";
import type { Actor } from "../authz/auth.ts";
import type { Clock } from "../core/ctx.ts";

export interface ReadCtx {
  readonly actor: Actor | null;
  readonly scope: string; // the tenantId/scope this caller is bound to
  /** The injected clock (05-runtime.md §ctx `now`) — optional here so this stays the structural base every
   *  richer op-handler ctx (`RichCtx`) extends. Repo timestamp/audit stamps stay DB-side `now()`, never this. */
  readonly now?: Clock;
  /** The resolved API version pin (multi-version.md §3, `Hazelnut-Version` header) for this request, exposed to
   *  logic as `ctx.version`. Optional + additive; absent ⇒ `current`. Shape transforms happen at the serve boundary. */
  readonly version?: string;
  /** The per-request cancellation signal (serve.ts) — client disconnect merged with the wall-clock deadline.
   *  Optional + additive; `writeTxWithCancel` cancels a mid-flight statement via `pg_cancel_backend` on disconnect. */
  readonly signal?: AbortSignal;
  /** The DOOR this request entered through ("http" | "mcp"; additive) — serve stamps it, `auditWrite`
   *  persists it, so an agent-door write is distinguishable from a human one in `_audit`. */
  readonly origin?: string;
  /** The per-request correlation id serve mints and echoes as `Hazelnut-Trace-Id` (05-runtime.md §5.1).
   *  The §6 record and `_outbox.trace_context` both carry it, so a dead letter joins the request that made it. */
  readonly traceId?: string;
}
export type RowPolicy<Row> = (actor: Actor | null) => Where<Row>;

export { actorGateDenies } from "./actor-gate.ts";

// roster/engine extracted into cohesive submodules, re-exported so importers stay stable.
export * from "./repo-audit.ts";
export * from "./repo-read.ts";
export * from "./repo-list.ts";
export * from "./repo-rollup.ts";
export * from "./repo-create.ts";
export * from "./repo-topics.ts";
export * from "./repo-update.ts";
export * from "./repo-tree-shared.ts";
export * from "./repo-tree-a.ts";
export * from "./repo-tree-b.ts";
export * from "./repo-remove.ts";
export * from "./repo-rectify.ts";
export * from "./repo-config.ts";
