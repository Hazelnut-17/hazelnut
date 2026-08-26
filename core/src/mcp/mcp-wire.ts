import { tableOf } from "../core/app-define.ts";
import type { ResourceModel } from "../core/app.ts";
import {
  err,
  type ErrKind,
  redactWireError,
  type Result,
} from "../core/pipeline.ts";
import { validationDetail } from "../core/validation.ts";
import type { Where } from "../core/where.ts";
import type { Db } from "../data/db.ts";
import {
  buildReadWhere,
  cursorKey,
  cursorTupleValues,
  decodeCursor,
  encodeCursor,
  orderedPageTail,
  type ReadCtx,
  type RowPolicy,
} from "../data/repo.ts";

/** A syntactically-well-formed keyset cursor (decodes to a key tuple)? The parser guard so a garbled/stale
 *  `after` is a LOUD `validation` error (mcp/strict-input) that steers the agent to re-read — never a silent
 *  server `internal` (a bad cursor is bad INPUT, not a server fault) nor a silent re-serve of page 1. */
export function isValidCursor(s: string): boolean {
  try {
    decodeCursor(s);
    return true;
  } catch {
    return false;
  }
}
import { decryptRows, type Kms } from "../features/encrypt.ts";
import { z } from "zod";
// TYPE-ONLY import — `explain.ts` pulls in the contract/verify catalog, and `verify.ts` re-enters this module
// (via `surface-lock.ts`), so a VALUE import here would close a module-init cycle (`contract.ts`'s top-level
// `invariants.map` runs before `verify.ts`'s `invariants` const initializes → a TDZ error). The semantics read
// is a cold path, so `explainInvariant` is resolved lazily inside `readSemanticsResource` (a dynamic import),
// keeping this module free of an eager dependency on the verify catalog.

/** The MCP projection — a third projection of the same declaration (alongside the type faces and HTTP
 *  routes), pure. Tool names are `<module>__<resource>__<op>`, injective and `__`-reversible. */
export const SEP = "__";

// ── Structured-error STEER convention (12-mcp §8) ─────────────────────────────────────────────────────
// An external LLM consumer does not recompile — it rationalizes a workaround around a thrown error. So a
// validation/unknown-field failure NAMEs the offending field, STATEs the surface changed, and INSTRUCTs
// "call `tools/list` and retry", riding the existing `validation` message (no new `err.kind`).

/** The standing instruction every STEER error carries — re-fetch the live surface, then retry. With the
 *  pipeline's idempotency keys a steered retry of a write is safe (12-mcp §8). */
export const STEER_NEXT_ACTION =
  "call `tools/list` to re-fetch the current surface, then retry";

/** Manufactures the structured-error STEER body for a strict-input failure (12-mcp §8). The message
 *  names every offending path + issue code (received value never echoed), states the surface may have
 *  changed, and instructs the re-fetch-and-retry next-action. Pure over the ZodError. */
export function steerValidation(
  error: z.ZodError,
  what: string,
): Result<never> {
  return err(
    "validation",
    `${
      validationDetail(what, error)
    } — the tool surface may have changed; ${STEER_NEXT_ACTION}`,
  );
}

/** Steers a `validation` failure whose ZodError is not in hand, so an opaque custom-op validation still
 *  carries the steer. Idempotent — a message already steered is returned unchanged. */
export function steerOpaque(message: string): Result<never> {
  if (message.includes(STEER_NEXT_ACTION)) return err("validation", message);
  return err(
    "validation",
    `${message} — the tool surface may have changed; ${STEER_NEXT_ACTION}`,
  );
}

/** The `tools/call` result envelope (12-mcp §error-channel · §illegal-edge). An MCP tool failure is a
 *  manufactured `isError:true` tool-result — natural-language `content` plus a machine-readable `kind` —
 *  never a JSON-RPC `error` object, a channel a host may swallow. */
export interface McpToolError {
  readonly isError: true;
  readonly content: ReadonlyArray<
    { readonly type: "text"; readonly text: string }
  >;
  readonly kind: ErrKind; // the machine-readable sibling — the closed 8-union, never widened
}
export function toolCallError(
  error: { readonly kind: ErrKind; readonly message: string },
): McpToolError {
  const safe = redactWireError(error); // an `internal` message is generic on the wire (schema/CWE-209 stays server-side)
  return {
    isError: true,
    content: [{ type: "text", text: safe.message }],
    kind: safe.kind,
  };
}

const MCP_INTERNAL_ERROR = -32603;
const MCP_RESOURCE_NOT_FOUND = -32002;

/** Map a `resources/read` Result error onto the JSON-RPC error channel (12-mcp §7).
 *  notFound/forbidden → `-32002` (same body); `internal` → `-32603` with the redacted message. */
export function resourceReadRpcError(
  error: { readonly kind: ErrKind; readonly message: string },
): { readonly code: number; readonly message: string } {
  const safe = redactWireError(error);
  switch (safe.kind) {
    case "notFound":
    case "forbidden":
      return { code: MCP_RESOURCE_NOT_FOUND, message: "resource not found" };
    case "validation":
      return { code: MCP_INVALID_PARAMS, message: safe.message };
    default:
      return { code: MCP_INTERNAL_ERROR, message: safe.message };
  }
}

/** Encode an op value as MCP `content` text. Hosts that render `result.content` need this; JSON-RPC
 *  clients that already read payload keys keep doing so — object values are spread, arrays/primitives
 *  sit on `value` so the result stays a CallToolResult object. */
export function toolCallOk(value: unknown): Record<string, unknown> {
  const content: McpToolError["content"] = [{
    type: "text",
    text: JSON.stringify(value) ?? "null",
  }];
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const rec = value as Record<string, unknown>;
    if (Object.hasOwn(rec, "content")) {
      return { value: rec, content };
    }
    return { ...rec, content };
  }
  return { content, value };
}

export interface McpToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly shape?: readonly string[]; // the curated output field-pick (12-mcp §5), echoed so the agent knows the return columns
  readonly annotations?: {
    readonly readOnlyHint?: true;
    readonly destructiveHint?: true;
    readonly idempotentHint?: true;
    readonly confirmHint?: true;
  };
}

// ── Read-tool query contract (12-mcp §6) ──────────────────────────────────────────────────────
// The rich-query `list` tool: filter · sort {field,direction} · offset-first pagination with a
// framework-injected finite `limit` maximum · the mandatory {items, page, hasMore, nextOffset?} envelope.
// Strict-parsed (`mcp/strict-input`, §8): an unknown filter/sort/query key is a loud `validation` error.

/** The framework-injected finite `limit` maximum for the default `list` tool (12-mcp §6: "`limit`
 *  carries a framework-injected finite `maximum`"). Also the default page size when `limit` is omitted. */
export const LIST_LIMIT_MAX = 100;

/** The fields an agent may filter/sort on: `Row<R>` minus `encrypted` minus `sensitive` (12-mcp §6) —
 *  the MCP-local rule closing the binary-search value-oracle (core `Where<R>` keeps `sensitive` filterable). */
export function filterableFields(m: ResourceModel): string[] {
  const blocked = new Set<string>([...m.encrypted, ...m.sensitive]);
  return ["id", ...Object.keys(m.columns)].filter((f) => !blocked.has(f));
}

/** The `list` tool's JSON-Schema `inputSchema` — filter/sort/limit/offset, derived (never authored)
 *  from the resource's filterable field set. `additionalProperties:false` everywhere is the wire face
 *  of `mcp/strict-input`: an unknown key is rejected, not silently dropped. */
export function listInputSchema(m: ResourceModel): Record<string, unknown> {
  const filterable = filterableFields(m);
  const filterProps: Record<string, unknown> = {};
  for (const f of filterable) filterProps[f] = {}; // any JSON value; the value lowers through the parameterized boundary
  return {
    type: "object",
    properties: {
      filter: {
        type: "object",
        properties: filterProps,
        additionalProperties: false,
      },
      sort: {
        type: "object",
        properties: {
          field: { enum: filterable },
          direction: { enum: ["asc", "desc"] },
        },
        required: ["field"],
        additionalProperties: false,
      },
      limit: { type: "integer", minimum: 1, maximum: LIST_LIMIT_MAX },
      offset: { type: "integer", minimum: 0 },
      after: {
        type: "string",
        description:
          "opaque keyset cursor from a prior page's `nextCursor` — stable pagination (no dup/skip under concurrent writes); supersedes `offset`",
      },
    },
    additionalProperties: false,
  };
}

/** The Zod parser mirroring `listInputSchema` — strict at every object level, so an unknown query/filter/
 *  sort key is a loud `validation` error, never a silent drop. Built from the same field set. */
export function listQueryParser(m: ResourceModel): z.ZodType {
  const filterable = filterableFields(m);
  const filterShape: Record<string, z.ZodType> = {};
  for (const f of filterable) filterShape[f] = z.unknown().optional();
  return z.object({
    filter: z.object(filterShape).strict().optional(),
    sort: z.object({
      field: z.enum(filterable as [string, ...string[]]),
      direction: z.enum(["asc", "desc"]).optional(),
    }).strict().optional(),
    limit: z.number().int().min(1).max(LIST_LIMIT_MAX).optional(),
    offset: z.number().int().min(0).optional(),
    after: z.string().refine(
      isValidCursor,
      "malformed cursor — re-read the list to get a fresh `nextCursor`",
    ).optional(),
  }).strict();
}

export interface ListQuery {
  readonly filter?: Record<string, unknown>;
  readonly sort?: { field: string; direction?: "asc" | "desc" };
  readonly limit?: number;
  readonly offset?: number;
  /** Opaque keyset cursor (a prior page's `nextCursor`) — opt into stable pagination; supersedes `offset`. */
  readonly after?: string;
}

/** The MANDATORY read-tool result envelope (12-mcp §6). `hasMore` is explicit — never silent
 *  truncation. `total`/count is intentionally absent (a count-oracle; agents paginate via `hasMore`). */
export interface ListEnvelope {
  readonly items: Record<string, unknown>[];
  readonly page: {
    readonly limit: number;
    readonly offset: number;
    readonly returned: number;
  };
  readonly hasMore: boolean;
  readonly nextOffset?: number;
  /** Opaque keyset cursor for the next page (12-mcp §6) — present iff `hasMore`; feed it back as `after` for
   *  stable pagination. Emitted on EVERY page (offset or cursor mode), since every page is keyset-ordered. */
  readonly nextCursor?: string;
}

/** Runs the rich-query `list`: the canonical read WHERE-stack (`scope ∧ softDelete ∧ … ∧ rowPolicy ∧
 *  filter`) plus an always-ordered keyset-or-offset tail. `hasMore` without a count-oracle: fetch
 *  `limit+1`. Every page orders by a stable key (`sort` + `id` tiebreaker, or `id` alone) so it is
 *  deterministic and carries a `nextCursor`; `after` opts into the keyset walk and supersedes `offset`. */
export async function listQuery(
  db: Db,
  m: ResourceModel,
  ctx: ReadCtx,
  rp: RowPolicy<Record<string, unknown>>,
  q: ListQuery,
  kms?: Kms,
): Promise<ListEnvelope> {
  const limit = q.limit ?? LIST_LIMIT_MAX;
  const offset = q.offset ?? 0;
  const filter: Where<Record<string, unknown>> = (q.filter ?? {}) as Where<
    Record<string, unknown>
  >;
  const { sql, params } = buildReadWhere(m, ctx, rp, filter);
  // the keyset key: the agent's sort field (validated against `filterableFields`, a closed set) + `id` as the
  // stable tiebreaker, or `id` alone. `cursorKey` re-validates it against the sortable columns — the ORDER BY /
  // keyset positions interpolate a bare quoted name, so only a schema-derived column may reach them (no injection).
  const key = cursorKey({ orderBy: q.sort ? [q.sort.field, "id"] : ["id"] }, m);
  const dir = q.sort?.direction === "desc" ? "desc" : "asc";
  if (q.after !== undefined) {
    try {
      const tuple = decodeCursor(q.after);
      cursorTupleValues(key, tuple);
      if (tuple.some(([, v]) => v == null)) {
        throw new Error("cursor key contains NULL");
      }
    } catch (e) {
      throw Object.assign(
        new Error(
          e instanceof Error
            ? e.message
            : "malformed cursor — re-read the list to get a fresh nextCursor",
        ),
        { kind: "validation" as const },
      );
    }
  }
  // fetch limit+1 (the over-fetch sentinel for hasMore); the extra row is the proof of a next page.
  const tail = orderedPageTail({
    key,
    dir,
    after: q.after,
    offset,
    limit: limit + 1,
  }, params);
  const r = await db.query<Record<string, unknown>>(
    `SELECT * FROM ${tableOf(m)} WHERE ${sql}${tail}`,
    params,
  );
  const hasMore = r.rows.length > limit;
  const rows = hasMore ? r.rows.slice(0, limit) : r.rows;
  if (m.encrypted.length > 0 && kms) {
    await decryptRows(kms, m.encrypted, rows, {
      schema: m.pgSchema,
      table: m.name,
    });
  }
  const last = rows[rows.length - 1] as Record<string, unknown> | undefined;
  const nextCursor = hasMore && last && key.every((c) => last[c] != null)
    ? encodeCursor(key.map((c) => [c, last[c]] as const))
    : undefined;
  return {
    items: rows,
    page: { limit, offset, returned: rows.length },
    hasMore,
    // `nextOffset` only in offset mode (once you keyset, offset is meaningless); `nextCursor` on every page.
    ...(hasMore && q.after === undefined ? { nextOffset: offset + limit } : {}),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

// roster/engine extracted into cohesive submodules, re-exported so importers stay stable.

/** JSON-RPC error codes the `/mcp` envelope emits on a PROTOCOL fault (a tool execution failure rides
 *  inside `result` as an isError tool-result instead, 12-mcp §error-channel). Shared, because both
 *  transports answer in this shape and a second copy is how one of them drifts out of it. */
export const MCP_PARSE_ERROR = -32700;
export const MCP_INVALID_REQUEST = -32600;
export const MCP_METHOD_NOT_FOUND = -32601;
export const MCP_INVALID_PARAMS = -32602;
