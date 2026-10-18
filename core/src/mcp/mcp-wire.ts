import type { SortSpec } from "../data/read-page.ts";
import { wireJson } from "../core/wire-json.ts";
import { servedColumnsOf } from "../features/redact.ts";
import {
  declaredFilterJsonSchema,
  parseDeclaredFilterValue,
} from "../core/filter-value.ts";
import type { ResourceModel } from "../core/app.ts";
import { deletedAtLivenessOn } from "../data/schema-normalize.ts";
import {
  err,
  type ErrKind,
  type ErrorHints,
  redactWireError,
  type Result,
  type ResultError,
} from "../core/pipeline.ts";
import type { Where } from "../core/where.ts";
import type { Db } from "../data/db.ts";
import {
  clampCount,
  continuationCursor,
  cursorKey,
  cursorTupleValues,
  decodeCursor,
  pagedLimit,
  type ReadCtx,
  refuseMixedCursorOffset,
  type RowPolicy,
  sortableKeyFields,
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
import { compileRead } from "../data/read-compiler.ts";
import { z } from "zod";

/** Shared by `listQueryParser` and `viewQueryParser` so one door cannot silently drop `offset`.
 *  Advertised JSON-Schema `after` text stays lock-stable (`mcp/additive-only`); a later MINOR
 *  bumps the list-tool version and drops "supersedes `offset`". */
export function refuseOffsetWithAfter(
  data: { after?: unknown; offset?: unknown },
  ctx: z.RefinementCtx,
): void {
  if (data.after !== undefined && data.offset !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["offset"],
      message:
        "page/offset-with-keyset: a read cannot paginate by both cursor and offset. Drop `offset`, or drop `after`.",
    });
  }
}

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
// validation/unknown-field failure uses fixed detail, STATEs the surface changed, and INSTRUCTs
// "call `tools/list` and retry", riding the existing `validation` message (no new `err.kind`).

/** The standing instruction every STEER error carries — re-fetch the live surface, then retry. With the
 *  pipeline's idempotency keys a steered retry of a write is safe (12-mcp §8). */
export const STEER_NEXT_ACTION =
  "call `tools/list` to re-fetch the current surface, then retry";

/** Manufactures the structured-error STEER body for a strict-input failure (12-mcp §8). The message
 *  does not render the ZodError: custom paths/messages can contain submitted data. It states the surface
 *  may have changed and preserves the re-fetch-and-retry next-action. */
export function steerValidation(
  _error: z.ZodError,
  what: string,
): Result<never> {
  return err(
    "validation",
    `${what} — the tool surface may have changed; ${STEER_NEXT_ACTION}`,
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
export interface McpToolError extends ErrorHints {
  readonly isError: true;
  readonly content: ReadonlyArray<
    { readonly type: "text"; readonly text: string }
  >;
  readonly kind: ErrKind; // the machine-readable sibling — the closed 8-union, never widened
  readonly _meta: {
    readonly "hazelnut/error": ResultError;
  };
}
export function toolCallError(
  error: ResultError,
): McpToolError {
  const safe = redactWireError(error); // an `internal` message is generic on the wire (schema/CWE-209 stays server-side)
  const hints: ErrorHints = {
    ...(safe.clause !== undefined ? { clause: safe.clause } : {}),
    ...(safe.code !== undefined ? { code: safe.code } : {}),
    ...(safe.retryAfter !== undefined ? { retryAfter: safe.retryAfter } : {}),
    ...(safe.throttle !== undefined ? { throttle: safe.throttle } : {}),
  };
  const detail: ResultError = {
    kind: safe.kind,
    message: safe.message,
    ...hints,
  };
  return {
    isError: true,
    // A silent kind reaches here with `message: ""`, and an agent RENDERS this text — so the empty string
    // would be the whole explanation. The kind is the honest fallback: it is already on the machine-readable
    // `kind` field beside this, it says everything the blanked message was allowed to say, and it leaks
    // nothing (that is why the kind was never the part being withheld).
    content: [
      { type: "text", text: safe.message || safe.kind },
      { type: "text", text: JSON.stringify({ error: detail }) },
    ],
    kind: safe.kind,
    ...hints,
    // Error detail is not a successful op value. In the pinned SDK, any structuredContent would be
    // checked against the success outputSchema even with isError:true; standard _meta and text are safe.
    _meta: { "hazelnut/error": detail },
  };
}

const MCP_INTERNAL_ERROR = -32603;
const MCP_RESOURCE_NOT_FOUND = -32002;

/** Map a `resources/read` Result error onto the JSON-RPC error channel (12-mcp §7).
 *  notFound/forbidden → `-32002` (same body); `internal` → `-32603` with the redacted message. */
export function resourceReadRpcError(
  error: ResultError,
): {
  readonly code: number;
  readonly message: string;
  readonly data?: {
    readonly kind: ErrKind;
    readonly code?: string;
    readonly retryAfter?: number;
  };
} {
  const safe = redactWireError(error);
  const data = {
    kind: safe.kind,
    ...(safe.code !== undefined ? { code: safe.code } : {}),
    ...(safe.retryAfter !== undefined ? { retryAfter: safe.retryAfter } : {}),
  };
  switch (safe.kind) {
    case "notFound":
    case "forbidden":
      return { code: MCP_RESOURCE_NOT_FOUND, message: "resource not found" };
    case "validation":
      return { code: MCP_INVALID_PARAMS, message: safe.message, data };
    default:
      // `|| safe.kind` for the same reason as `toolCallError`: `stale` and `timeout` are blanked at the
      // boundary, and JSON-RPC `error.message` is what a host shows a human — an empty one explains nothing.
      return {
        code: MCP_INTERNAL_ERROR,
        message: safe.message || safe.kind,
        data,
      };
  }
}

/** Encode an op value as MCP `content` text. Hosts that render `result.content` need this; JSON-RPC
 *  clients that already read payload keys keep doing so — object values are spread, arrays/primitives
 *  sit on `value` so the result stays a CallToolResult object. */
export function toolCallOk(
  raw: unknown,
  opts: { readonly includeResult?: boolean; readonly structured?: boolean } =
    {},
): Record<string, unknown> {
  const value = wireJson(raw);
  const content: McpToolError["content"] = [{
    type: "text",
    text: JSON.stringify(value) ?? "null",
  }];
  const result = opts.includeResult ? { result: value } : {};
  const structured = opts.structured
    ? { structuredContent: value === undefined ? {} : { result: value } }
    : {};
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const rec = value as Record<string, unknown>;
    if (
      Object.hasOwn(rec, "content") ||
      (opts.structured && Object.hasOwn(rec, "structuredContent"))
    ) {
      return { value: rec, content, ...result, ...structured };
    }
    // Existing business keys keep their meaning. A pre-existing `result` cannot be re-wrapped additively.
    return { ...result, ...rec, content, ...structured };
  }
  return { content, value, ...result, ...structured };
}

export interface McpToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  readonly _meta?: {
    readonly "hazelnut/shape"?: readonly string[];
    readonly "hazelnut/confirmHint"?: boolean;
  };
  readonly annotations?: {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
  };
}

// ── Read-tool query contract (12-mcp §6) ──────────────────────────────────────────────────────
// The rich-query `list` tool: filter · sort {field,direction} · offset-first pagination with a
// framework-injected finite `limit` maximum · the mandatory {items, page, hasMore, nextOffset?} envelope.
// Strict-parsed (`mcp/strict-input`, §8): an unknown filter/sort/query key is a loud `validation` error.

/** The framework-injected finite `limit` maximum for the default `list` tool (12-mcp §6: "`limit`
 *  carries a framework-injected finite `maximum`"). Also the default page size when `limit` is omitted. */
export const LIST_LIMIT_MAX = 100;

/** The fields an agent may filter/sort on: exactly the delivered `list` columns (HTTP columns narrowed
 *  by the tool's optional shape, plus MCP's version token) minus encrypted/sensitive redactions. */
export function filterableFields(
  m: ResourceModel,
  shape: readonly string[] | undefined = m.mcp.list?.shape,
): string[] {
  const blocked = new Set<string>([
    ...m.encrypted,
    ...m.sensitive,
    ...m.passwords,
    ...(m.encryptedConfig?.equality ?? []).map((field) => `${field}_bidx`),
  ]);
  const delivered = new Set(servedColumnsOf(m, "list"));
  if (m.features.versioning) delivered.add("version");
  const picked = shape
    ? shape.filter((field) => delivered.has(field))
    : [...delivered];
  return picked.filter((field) =>
    !blocked.has(field) &&
    !(field === "deleted_at" && deletedAtLivenessOn(m.features))
  );
}

/** The `list` tool's JSON-Schema `inputSchema` — filter/sort/limit/offset, derived (never authored)
 *  from the resource's filterable field set. `additionalProperties:false` everywhere is the wire face
 *  of `mcp/strict-input`: an unknown key is rejected, not silently dropped. */

const filterScalar = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

export function listInputSchema(
  m: ResourceModel,
  shape?: readonly string[],
): Record<string, unknown> {
  const filterable = filterableFields(m, shape);
  const sortable = filterable.filter((field) =>
    sortableKeyFields(m).includes(field)
  );
  const filterProps: Record<string, unknown> = {};
  for (const f of filterable) filterProps[f] = declaredFilterJsonSchema(m, f);
  return {
    type: "object",
    properties: {
      ...(m.features.temporal
        ? { asOf: { type: "string", format: "date-time" } }
        : {}),
      ...(m.searchable.length
        ? { search: { type: "string", minLength: 1, pattern: "\\S" } }
        : {}),
      filter: {
        type: "object",
        properties: filterProps,
        additionalProperties: false,
      },
      sort: {
        type: "object",
        properties: {
          field: { enum: sortable },
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
export function listQueryParser(
  m: ResourceModel,
  shape?: readonly string[],
): z.ZodType {
  const filterable = filterableFields(m, shape);
  const sortable = filterable.filter((field) =>
    sortableKeyFields(m).includes(field)
  );
  return z.object({
    ...(m.features.temporal
      ? { asOf: z.iso.datetime({ offset: true }).optional() }
      : {}),
    ...(m.searchable.length
      ? {
        search: z.string().regex(
          /\S/,
          "search must contain a non-space character",
        ).optional(),
      }
      : {}),
    filter: filterQueryParser(m, shape).optional(),
    sort: z.object({
      field: z.enum(sortable as [string, ...string[]]),
      direction: z.enum(["asc", "desc"]).optional(),
    }).strict().optional(),
    limit: z.number().int().min(1).max(LIST_LIMIT_MAX).optional(),
    offset: z.number().int().min(0).optional(),
    after: z.string().refine(
      isValidCursor,
      "malformed cursor — re-read the list to get a fresh `nextCursor`",
    ).optional(),
  }).strict().superRefine(refuseOffsetWithAfter);
}
function filterQueryParser(m: ResourceModel, shape?: readonly string[]) {
  const filterable = filterableFields(m, shape);
  const filterShape: Record<string, z.ZodType> = {};
  for (const f of filterable) {
    filterShape[f] = filterScalar.optional().transform((value, ctx) => {
      if (value === undefined) return undefined;
      const checked = parseDeclaredFilterValue(m, f, value);
      if (!checked.success) {
        ctx.addIssue({
          code: "custom",
          message: `column '${f}' value does not match its declared type`,
        });
        return z.NEVER;
      }
      return checked.data;
    });
  }
  return z.object(filterShape).strict();
}
export function countInputSchema(m: ResourceModel): Record<string, unknown> {
  const properties = listInputSchema(m).properties as Record<string, unknown>;
  return {
    type: "object",
    properties: Object.fromEntries(
      Object.entries(properties).filter(([name]) =>
        name === "filter" || name === "search" || name === "asOf"
      ),
    ),
    additionalProperties: false,
  };
}
export function countQueryParser(m: ResourceModel) {
  return z.object({
    filter: filterQueryParser(m, m.mcp.list?.shape).optional(),
    ...(m.features.temporal
      ? { asOf: z.iso.datetime({ offset: true }).optional() }
      : {}),
    ...(m.searchable.length
      ? {
        search: z.string().regex(
          /\S/,
          "search must contain a non-space character",
        ).optional(),
      }
      : {}),
  }).strict();
}

export interface ListQuery {
  readonly asOf?: string;
  readonly search?: string;
  readonly filter?: Record<string, unknown>;
  readonly sort?: SortSpec;
  readonly limit?: number;
  readonly offset?: number;
  /** Opaque keyset cursor (a prior page's `nextCursor`) — opt into stable pagination. Mixing with `offset` is validation. */
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
  /** Bounded continuation on a non-offset page, when the final projection preserves its keys.
   * Projection or token size can withhold it without changing hasMore or a non-after nextOffset. */
  readonly nextCursor?: string;
}

/** Runs the rich-query `list`: the canonical read WHERE-stack (`scope ∧ softDelete ∧ … ∧ rowPolicy ∧
 *  filter`) plus an always-ordered keyset-or-offset tail. `hasMore` without a count-oracle: fetch
 *  `limit+1`. Every page orders by a stable key (`sort` + `id` tiebreaker, or `id` alone) so it is
 *  deterministic and carries a `nextCursor`; `after` opts into the keyset walk. Mixing `offset` with
 *  `after` is validation — the compiled keyset tail would otherwise drop the offset silently. */
export async function listQuery(
  db: Db,
  m: ResourceModel,
  ctx: ReadCtx,
  rp: RowPolicy<Record<string, unknown>>,
  q: ListQuery,
  kms?: Kms,
  columns?: readonly string[],
): Promise<ListEnvelope> {
  refuseMixedCursorOffset(q);
  const limit = pagedLimit(q.limit, LIST_LIMIT_MAX, LIST_LIMIT_MAX);
  const offset = clampCount(q.offset, "offset") ?? 0;
  const filter: Where<Record<string, unknown>> = (q.filter ?? {}) as Where<
    Record<string, unknown>
  >;
  // the keyset key: the agent's sort field (validated against `filterableFields`, a closed set) + `id` as the
  // stable tiebreaker, or `id` alone. `cursorKey` re-validates it against the sortable columns — the ORDER BY /
  // keyset positions interpolate a bare quoted name, so only a schema-derived column may reach them (no injection).
  const key = cursorKey({ orderBy: q.sort ? [q.sort.field, "id"] : ["id"] }, m);
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
  const { sql, params } = compileRead(m, ctx, rp, filter, {
    at: q.asOf,
    search: q.search,
    columns: columns === undefined ? undefined : [...columns, ...key],
    page: {
      sort: q.sort ?? { field: "id" },
      after: q.after,
      ...(q.after === undefined ? { offset } : {}),
      limit: limit + 1,
    },
  });
  const r = await db.query<Record<string, unknown>>(
    sql,
    params,
  );
  const hasMore = r.rows.length > limit;
  const rows = hasMore ? r.rows.slice(0, limit) : r.rows;
  const encrypted = columns === undefined
    ? m.encrypted
    : m.encrypted.filter((field) => columns.includes(field));
  if (encrypted.length > 0) {
    if (!kms) {
      throw new Error(
        `resource '${m.name}' declares encrypted fields but no KMS is bound`,
      );
    }
    await decryptRows(kms, encrypted, rows, {
      schema: m.pgSchema,
      table: m.name,
    });
  }
  const last = rows[rows.length - 1] as Record<string, unknown> | undefined;
  const nextCursor = q.offset === undefined && hasMore && last &&
      key.every((c) => last[c] != null)
    ? continuationCursor(key.map((c) => [c, last[c]] as const))
    : undefined;
  return {
    items: rows,
    page: { limit, offset, returned: rows.length },
    hasMore,
    // `nextOffset` only in offset mode (once you keyset, offset is meaningless); the caller may withhold a
    // cursor after projection if a key was hidden or transformed.
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
/** A valid request refused by an Origin allowlist or whole-door gate (JSON-RPC server-error range). */
export const MCP_FORBIDDEN = -32001;

/** Correlated refusal shared by the served MCP endpoint and its gateway. Notifications have no envelope. */
export function mcpAuthorizationRefusal(
  id: string | number | null,
  message: "forbidden" | "origin not allowed",
) {
  return {
    jsonrpc: "2.0" as const,
    id,
    error: { code: MCP_FORBIDDEN, message },
  };
}

/** A peer response is never a request to dispatch or answer. Preserve the JSON-RPC result/error XOR
 * and validate the error shape so malformed no-method objects cannot masquerade as accepted responses. */
export function isJsonRpcResponse(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const msg = value as Record<string, unknown>;
  if (
    msg.jsonrpc !== "2.0" || !Object.hasOwn(msg, "id") ||
    !isJsonRpcId(msg.id) || Object.hasOwn(msg, "method")
  ) return false;
  const result = Object.hasOwn(msg, "result"),
    error = Object.hasOwn(msg, "error");
  if (result === error) return false;
  if (result) return true;
  if (!msg.error || typeof msg.error !== "object" || Array.isArray(msg.error)) {
    return false;
  }
  const fault = msg.error as Record<string, unknown>;
  return typeof fault.code === "number" && Number.isInteger(fault.code) &&
    typeof fault.message === "string";
}

/** Safe transport fault, distinct from a tool execution failure; no upstream exception text crosses. */
export function mcpTransportUnavailable(
  id: string | number | null,
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32603,
      message:
        "the app is temporarily unavailable; retry after the indicated delay",
      data: { status: 503, kind: "internal", retryAfter: 1 },
    },
  };
}

/** JSON-RPC 2.0 permits only a string, number, or explicit null request id.
 * A missing id is a notification; callers that need that distinction must check
 * property presence before this value guard. */
export function isJsonRpcId(value: unknown): value is string | number | null {
  return value === null || typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value));
}
