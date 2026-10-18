import { wireJson } from "../core/wire-json.ts";
import type { ResourceModel } from "../core/app.ts";
import { normalizePgType } from "./ddl-parse.ts";
import { storedColumnTypes } from "./native-cast.ts";
import { timestampsGate } from "./repo-audit.ts";

/**
 * Pagination (03-api-shape.md §pagination; 05-runtime.md §ctx): `limit`/`offset` is the v1 baseline,
 * appended after the WHERE-stack (never bypassing scope/softDelete/rowPolicy) and ordered by `id` by
 * default so an HTTP cursor minted from a full page continues from that same ordered read. `after`/`orderBy`
 * opts into keyset (cursor) pagination through the same composition site; a mixed offset is refused.
 */
export interface SortSpec {
  readonly field: string;
  readonly direction?: "asc" | "desc";
}

export interface Page {
  readonly sort?: SortSpec;
  readonly limit?: number;
  readonly offset?: number;
  /** Keyset cursor (opaque base64 of the prior page's last key tuple) — opt into cursor pagination. */
  readonly after?: string;
  /** The stable sort key the cursor walks. Default `["id"]` (uuidv7 is time-ordered, so id alone is stable). */
  readonly orderBy?: readonly string[];
}

/** Encode a keyset cursor — an opaque base64 of the JSON key tuple (`[col, value]` pairs of a page's last
 *  row). Unsigned, without TTL or query-value binding: untrusted continuation input, never an authorization
 *  grant. Consumers should reuse the returned token unchanged (`decodeCursor` is the matched pair). */
export function encodeCursor(
  key: ReadonlyArray<readonly [string, unknown]>,
): string {
  const encoded = continuationCursor(key);
  if (encoded === undefined) {
    throw new CursorValidationError(
      "encoded continuation exceeds 8192 characters",
    );
  }
  return encoded;
}

/** A server-generated continuation is optional: a valid page with a large sort value must not fail
 * because its token cannot fit the wire bound. Only size is withheld; codec/serialization faults propagate. */
export function continuationCursor(
  key: ReadonlyArray<readonly [string, unknown]>,
): string | undefined {
  const json = JSON.stringify(wireJson(key));
  if (json.length > 8192) return undefined;
  const encoded = btoa(encodeURIComponent(json));
  if (encoded.length > 8192) return undefined;
  return encoded;
}

/** Decode a keyset cursor back to its `[col, value]` tuple. A malformed cursor throws (fail-closed — a
 *  garbled token never silently widens to "no cursor" and re-serves page 1). */
export class CursorValidationError extends Error {
  readonly kind = "validation" as const;

  constructor(reason: string) {
    super(`cursor/malformed: ${reason}`);
    this.name = "CursorValidationError";
  }
}

export function decodeCursor(cursor: string): Array<[string, unknown]> {
  if (cursor.length > 8192) {
    throw new CursorValidationError(
      "encoded continuation exceeds 8192 characters",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(atob(cursor))) as unknown;
  } catch {
    throw new CursorValidationError("token is not base64 JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new CursorValidationError("token is not a key tuple array");
  }
  return parsed.map((entry, i): [string, unknown] => {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new CursorValidationError(`key ${i} is not a [column, value] pair`);
    }
    const [column, value] = entry;
    if (typeof column !== "string" || column.length === 0) {
      throw new CursorValidationError(`key ${i} has no column name`);
    }
    // A row comparison against NULL is unknown for every row. Refuse it at the
    // shared decoder before any caller can turn a bad continuation into 200 [].
    if (value == null) {
      throw new CursorValidationError(`key '${column}' has a NULL value`);
    }
    return [column, value];
  });
}

/** Bind a decoded cursor against the ORDER BY key: column names and arity must match, in order.
 *  Positional binding that discards `tuple[i][0]` silently pages against the wrong columns (M-20). */
export function cursorTupleValues(
  key: readonly string[],
  tuple: ReadonlyArray<readonly [string, unknown]>,
): unknown[] {
  if (tuple.length !== key.length) {
    throw new CursorValidationError(
      `page/cursor-key-mismatch: cursor has ${tuple.length} column(s); orderBy has ${key.length} — restart paging from the first page without \`after\``,
    );
  }
  for (let i = 0; i < key.length; i++) {
    if (tuple[i]![0] !== key[i]) {
      throw new CursorValidationError(
        `page/cursor-key-mismatch: cursor column '${
          tuple[i]![0]
        }' does not match orderBy '${key[i]}'`,
      );
    }
  }
  return tuple.map(([, v]) => v);
}

export const PAGE_LIMIT_MAX = 100;

export class LimitValidError extends Error {
  readonly kind = "validation" as const;

  constructor(n: number, field: "limit" | "offset" = "limit") {
    super(
      field === "offset"
        ? `read/offset-valid: ${n} is not an integer from 0 to 9007199254740991 — a malformed page is a validation error, never an unbounded query`
        : `read/limit-valid: ${n} is not an integer from 0 to 9007199254740991 — a malformed page is a validation error, never an unbounded query`,
    );
    this.name = "LimitValidError";
  }
}

/** Clamp to a non-negative safe integer, or `undefined` if absent. Past `MAX_SAFE_INTEGER` the value is no
 *  longer the one the caller wrote, and past 2^63 Postgres refuses the bind as an internal error. */
export function clampCount(
  n: number | undefined,
  field: "limit" | "offset" = "limit",
): number | undefined {
  if (n === undefined) return undefined;
  if (!Number.isFinite(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) {
    throw new LimitValidError(n, field);
  }
  return Math.floor(n);
}

export class PageLimitError extends Error {
  readonly kind = "validation" as const;

  constructor() {
    super(
      "read/page-limit: a paged read needs a positive limit — a zero-row page cannot carry the continuation its hasMore promises",
    );
    this.name = "PageLimitError";
  }
}

/** The limit a `hasMore` pager serves: absent → `fallback`, above `max` → `max`, zero or malformed → refused. */
export function pagedLimit(
  n: number | undefined,
  fallback: number,
  max: number,
): number {
  const requested = clampCount(n);
  if (requested === 0) throw new PageLimitError();
  return Math.min(requested ?? fallback, max);
}

/** Caller-supplied page input a Result facade answers as `validation` rather than throwing. */
export function isPageInputError(e: unknown): e is Error {
  return e instanceof PageSortError || e instanceof CursorValidationError ||
    e instanceof LimitValidError ||
    e instanceof PageLimitError;
}

/** The columns a keyset `orderBy` may name — declared fields (minus encrypted/sensitive) plus `id` and
 *  per-feature framework columns. Interpolated as a bare identifier (never `$n`), so ONLY a schema-derived name may reach SQL (mirrors `filterableCols`). */
function keysetCols(model: ResourceModel): ReadonlySet<string> {
  const excluded = new Set<string>([...model.encrypted, ...model.sensitive]);
  const cols = new Set<string>(["id"]);
  for (const k of Object.keys(model.schema.shape)) {
    if (!excluded.has(k)) cols.add(k);
  }
  if (model.features.scope) cols.add("scope_key");
  if (model.features.softDelete) cols.add("deleted_at");
  if (model.features.versioning) cols.add("version");
  if (model.features.expiry) cols.add("expires_at");
  if (model.features.temporal) {
    cols.add("valid_from");
    cols.add("valid_to");
  }
  const ts = timestampsGate(model); // each half is gated on its own — `{created:true}` mints no updated_at
  if (ts?.created) cols.add("created_at");
  if (ts?.updated) cols.add("updated_at");
  for (const e of excluded) cols.delete(e); // total: an excluded field never survives, even via id
  return cols;
}

/** The keyset ORDER BY key — the caller's `orderBy` (defaulting to `["id"]`) validated against the resource's
 *  real sortable columns (`keysetCols`), then `id` as the tiebreak so rows tied on a non-unique key are neither
 *  skipped nor repeated. Un-allowlisted names are a SQL-injection sink (bare identifiers) and fail closed here. */
export class PageSortError extends Error {
  readonly kind = "validation" as const;
  constructor(
    readonly code:
      | "page/orderBy-unknown"
      | "page/orderBy-nullable"
      | "page/orderBy-unsupported",
    field: string,
  ) {
    super(`${code}: '${field}' is not a supported non-null scalar keyset key`);
    this.name = "PageSortError";
  }
}

const SCALAR_KEY_TYPES = new Set([
  "smallint",
  "integer",
  "bigint",
  "real",
  "double precision",
  "numeric",
  "decimal",
  "money",
  "boolean",
  "text",
  "varchar",
  "character varying",
  "char",
  "character",
  "bpchar",
  "citext",
  "uuid",
  "date",
  "time",
  "time without time zone",
  "time with time zone",
  "timetz",
  "timestamp",
  "timestamp without time zone",
  "timestamp with time zone",
  "timestamptz",
  "inet",
  "cidr",
  "macaddr",
  "macaddr8",
]);
function keyIssue(
  model: ResourceModel,
  field: string,
): PageSortError["code"] | undefined {
  if (!keysetCols(model).has(field)) return "page/orderBy-unknown";
  const type = normalizePgType(
    String(
      model.columns[field]?.pg ?? storedColumnTypes(model).get(field) ?? "text",
    ),
  ).replace(/\([^)]*\)/g, "").trim();
  if (!SCALAR_KEY_TYPES.has(type) && !/^interval(?: |$)/.test(type)) {
    return "page/orderBy-unsupported";
  }
  if (
    model.columns[field]?.nullable === true ||
    (field === "deleted_at" && model.features.softDelete) ||
    (field === "expires_at" && model.features.expiry) ||
    (field === "valid_to" && model.features.temporal)
  ) return "page/orderBy-nullable";
}

/** The source vocabulary for sort ads, separate from equality-filterable fields. */
export function sortableKeyFields(model: ResourceModel): readonly string[] {
  return [...keysetCols(model)].filter((field) =>
    keyIssue(model, field) === undefined
  );
}

export function cursorKey(page: Page, model: ResourceModel): readonly string[] {
  if (
    page.sort !== undefined &&
    (typeof page.sort !== "object" || page.sort === null ||
      typeof page.sort.field !== "string" ||
      (page.sort.direction !== undefined && page.sort.direction !== "asc" &&
        page.sort.direction !== "desc") ||
      page.orderBy !== undefined)
  ) throw new PageSortError("page/orderBy-unknown", "sort");
  if (
    page.orderBy !== undefined &&
    (!Array.isArray(page.orderBy) ||
      page.orderBy.some((value) => typeof value !== "string"))
  ) throw new PageSortError("page/orderBy-unknown", "orderBy");
  const k = page.sort
    ? [page.sort.field, "id"].filter((value, index, all) =>
      all.indexOf(value) === index
    )
    : page.orderBy && page.orderBy.length > 0
    ? page.orderBy
    : ["id"];
  for (const field of k) {
    const issue = keyIssue(model, field);
    if (issue) throw new PageSortError(issue, field);
  }
  return k.includes("id") ? k : [...k, "id"];
}
