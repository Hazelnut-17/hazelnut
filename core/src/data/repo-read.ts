// Barrel re-exports keep import sites stable.
import { isSystem } from "../authz/auth.ts";
import type { ResourceModel } from "../core/app.ts";
import { lowerInto } from "../core/lower.ts";
import { all, toNode, type Where } from "../core/where.ts";
import { rectifiableOn } from "./schema.ts";
import type { ReadCtx, RowPolicy } from "./repo.ts";

/**
 * The LIFECYCLE half of the read WHERE-stack — "is this row live right now": softDelete (which also hides a
 * rectified/superseded row, since `deleted_at` doubles as the superseded stamp — GDPR Art. 16), expiry, and
 * temporal. One derivation, so every reader of liveness agrees: the served read and the read-model maintain
 * drain both compose it, and a feature added here reaches both. `at` is the SQL instant token (`now()` or a
 * placeholder the caller already allocated).
 */
export function lifecycleLiveFrags(
  f: ResourceModel["features"],
  at = "now()",
): string[] {
  const frags: string[] = [];
  if (f.softDelete || rectifiableOn(f)) frags.push(`"deleted_at" IS NULL`);
  if (f.expiry) frags.push(`("expires_at" IS NULL OR "expires_at" > ${at})`);
  if (f.temporal) {
    frags.push(
      `("valid_from" <= ${at} AND ("valid_to" IS NULL OR "valid_to" > ${at}))`,
    );
  }
  return frags;
}

/**
 * Compose the canonical read WHERE-stack at one site, never post-query:
 *   scope ∧ softDelete ∧ expiry ∧ temporal ∧ rowPolicy ∧ caller-where.
 * Feature conjuncts fire only when the resource declares the feature; rowPolicy + caller-where
 * always apply. Everything is parameterized through one shared placeholder allocator.
 */
export function buildReadWhere<Row>(
  model: ResourceModel,
  ctx: ReadCtx,
  rowPolicy: RowPolicy<Row>,
  caller: Where<Row>,
  at?: Date | string, // temporal as-of instant; defaults to now() (the current slice)
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const f = model.features;
  const frags: string[] = [];
  if (f.scope) frags.push(`"scope_key" = ${p(ctx.scope)}`);
  // the as-of param is allocated ONLY on a temporal resource, so the placeholder numbering of every other
  // conjunct is unchanged when `at` reaches a non-temporal read.
  const t = f.temporal && at !== undefined ? p(at) : "now()";
  frags.push(...lifecycleLiveFrags(f, t));
  // The outer correlation name is the bare resource table (`model.name`; Postgres aliases a qualified FROM
  // to its last component). It MUST be passed so an `exists`-over-relation grant (13-authz.md §8) qualifies
  // the outer row column — left bare, the grant table's same-named column shadows it, turning the join into
  // a tautology that leaks every grant-bearing row cross-scope. The caller-where is qualified identically.
  frags.push(lowerInto(toNode(rowPolicy(ctx.actor)), p, model.name)); // rowPolicy throwing here aborts the read (fail-closed)
  frags.push(lowerInto(toNode(caller), p, model.name));
  return { sql: frags.map((x) => `(${x})`).join(" AND "), params };
}

/** The declared rowPolicy carried on the model — the same `(actor) => Where` the read path resolves
 *  (mirrored from serve.ts/mcp.ts/data.ts). Resolved inside the repo so update/remove derive it with no
 *  call-site change. */
function modelRowPolicy<Row>(model: ResourceModel): RowPolicy<Row> {
  return (model.rowPolicy as RowPolicy<Row> | null) ?? (() => all<Row>());
}

/**
 * ands a rowPolicy into a write WHERE — the write-side analogue of the read `buildReadWhere` conjunct
 * (authz/where-stack-complete), RLS-USING-style: scope alone is too coarse, so an actor holding the op perm
 * in-scope could otherwise mutate a row a rowPolicy meant to hide. A hidden row matches 0 rows and falls
 * through the existing not-found path. Reuses the exact read-path lowering; default is the resource's
 * declared `m.rowPolicy` (vacuous `all()` when none). The `policy` override lets an internal cascade
 * (onDelete/tree sweeps) write with `all()` so it never silently skips a hidden child. rowPolicy throwing
 * aborts the write (fail-closed).
 *
 * A framework-minted system actor (auto-purge `remove`) makes this conjunct vacuous — an end-user
 * rowPolicy would never match `id:"system"` and would silently spare every row it should purge.
 * scope/softDelete/version conjuncts still apply.
 */
export function appendRowPolicyConjunct(
  model: ResourceModel,
  ctx: ReadCtx,
  p: (v: unknown) => string,
  policy?: RowPolicy<unknown>,
): string {
  if (isSystem(ctx.actor)) return ""; // framework-internal system write: rowPolicy is vacuous (scope/softDelete/version stay)
  const rp = policy ?? modelRowPolicy(model);
  return ` AND (${lowerInto(toNode(rp(ctx.actor)), p, model.name)})`;
}

/**
 * Pagination (03-api-shape.md §pagination; 05-runtime.md §ctx): `limit`/`offset` is the v1 baseline,
 * appended after the WHERE-stack (never bypassing scope/softDelete/rowPolicy). `after`/`orderBy` opts into
 * keyset (cursor) pagination through the same composition site; when both are present, keyset wins.
 */
export interface Page {
  readonly limit?: number;
  readonly offset?: number;
  /** Keyset cursor (opaque base64 of the prior page's last key tuple) — opt into cursor pagination. */
  readonly after?: string;
  /** The stable sort key the cursor walks. Default `["id"]` (uuidv7 is time-ordered, so id alone is stable). */
  readonly orderBy?: readonly string[];
}

/** Encode a keyset cursor — an opaque base64 of the JSON key tuple (`[col, value]` pairs of a page's last
 *  row), so a caller treats it as a token, not a hand-editable offset (`decodeCursor` is the matched pair). */
export function encodeCursor(
  key: ReadonlyArray<readonly [string, unknown]>,
): string {
  return btoa(encodeURIComponent(JSON.stringify(key)));
}

/** Decode a keyset cursor back to its `[col, value]` tuple. A malformed cursor throws (fail-closed — a
 *  garbled token never silently widens to "no cursor" and re-serves page 1). */
export function decodeCursor(cursor: string): Array<[string, unknown]> {
  const parsed = JSON.parse(decodeURIComponent(atob(cursor))) as unknown;
  if (!Array.isArray(parsed)) throw new Error("malformed cursor");
  return parsed as Array<[string, unknown]>;
}

/** Clamp to a non-negative integer, or `undefined` if absent/malformed — a negative/NaN value is rejected,
 *  a finite ≥ 0 value floored. The pagination guard: only a clean count ever reaches SQL. */
export function clampCount(n: number | undefined): number | undefined {
  if (n === undefined || !Number.isFinite(n) || n < 0) return undefined;
  return Math.floor(n);
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
  if (model.features.timestamps) {
    cols.add("created_at");
    cols.add("updated_at");
  }
  for (const e of excluded) cols.delete(e); // total: an excluded field never survives, even via id
  return cols;
}

/** The keyset ORDER BY key — the caller's stable `orderBy` (defaulting to `["id"]`), validated against the
 *  resource's real sortable columns (`keysetCols`). Un-allowlisted names are a SQL-injection sink since they
 *  interpolate as a bare identifier, never a `$n` param — a rejected name fails closed here. */
export function cursorKey(page: Page, model: ResourceModel): readonly string[] {
  const k = page.orderBy && page.orderBy.length > 0 ? page.orderBy : ["id"];
  const allowed = keysetCols(model);
  for (const c of k) {
    if (!allowed.has(c)) {
      throw new Error(
        `orderBy column '${c}' is not a sortable column of '${model.name}'`,
      );
    }
  }
  return k;
}

/**
 * Append offset or keyset (cursor) pagination after the WHERE-stack, through the same allocator, so
 * neither can bypass scope/softDelete/rowPolicy. Keyset appends a `(k1,k2,...) > ($a,$b,...)` row-comparison
 * + `ORDER BY` + `LIMIT n`; the cursor tuple MUST cover the same key columns in order or it throws (fail-closed).
 */
export function pageClause(
  page: Page | undefined,
  params: unknown[],
  model: ResourceModel,
): string {
  if (!page) return "";
  const p = (v: unknown) => `$${params.push(v)}`;
  // keyset (cursor) path — the opt-in: a row-comparison `>` over the stable key + ORDER BY, appended after
  // the WHERE-stack through the same allocator, so scope/softDelete/rowPolicy still gate every row.
  if (page.after !== undefined || page.orderBy !== undefined) {
    // An OFFSET has no meaning on a keyset read — the cursor IS the position — and this branch emitted none,
    // so a caller passing both got their offset silently dropped and a page that looked right. Refuse the
    // category error rather than pick one of the two paginations on the caller's behalf.
    if (page.offset !== undefined) {
      throw new Error(
        `page/offset-with-keyset: a read cannot paginate by both cursor and offset — \`offset\` was passed alongside ${
          page.after !== undefined ? "`after`" : "`orderBy`"
        }, and a keyset read is positioned by its cursor. Drop \`offset\`, or drop the cursor and page by offset alone.`,
      );
    }
    const key = cursorKey(page, model);
    const order = ` ORDER BY ${key.map((c) => `"${c}"`).join(", ")}`;
    let clause = "";
    if (page.after !== undefined) {
      const tuple = decodeCursor(page.after);
      // bind the cursor tuple positionally against the same key columns — a row-comparison so the lexical
      // ordering of the whole key is honoured (`(a,b) > ($1,$2)`), giving no-overlap/no-gap paging.
      const lhs = key.map((c) => `"${c}"`).join(", ");
      const rhs = key.map((_, i) => p(tuple[i]?.[1])).join(", ");
      clause += ` AND (${lhs}) > (${rhs})`;
    }
    clause += order;
    const limit = clampCount(page.limit);
    if (limit !== undefined) clause += ` LIMIT ${p(limit)}`;
    return clause;
  }
  let clause = "";
  const limit = clampCount(page.limit);
  const offset = clampCount(page.offset);
  if (limit !== undefined) clause += ` LIMIT ${p(limit)}`;
  if (offset !== undefined) clause += ` OFFSET ${p(offset)}`;
  return clause;
}

/**
 * The MCP read-tools' page tail (12-mcp §6) — an always-order-by keyset-or-offset suffix (unlike
 * `pageClause`'s offset-xor-keyset): an unordered offset page is non-deterministic across pages (a latent
 * dup/skip), so every page orders by a stable `key`. `key` MUST be `cursorKey`-validated (bare identifier,
 * never `$n`); a malformed `after` throws (fail-closed).
 */
export function orderedPageTail(
  opts: {
    key: readonly string[];
    dir?: "asc" | "desc";
    after?: string;
    offset?: number;
    limit: number;
  },
  params: unknown[],
): string {
  const p = (v: unknown) => `$${params.push(v)}`;
  const desc = opts.dir === "desc";
  const dirSql = desc ? " DESC" : "";
  // the keyset walk extends the WHERE-stack (so it must precede ORDER BY); bound POSITIONALLY against the key.
  let where = "";
  if (opts.after !== undefined) {
    const tuple = decodeCursor(opts.after);
    const lhs = opts.key.map((c) => `"${c}"`).join(", ");
    const rhs = opts.key.map((_, i) => p(tuple[i]?.[1])).join(", ");
    where = ` AND (${lhs}) ${desc ? "<" : ">"} (${rhs})`;
  }
  const order = ` ORDER BY ${
    opts.key.map((c) => `"${c}"${dirSql}`).join(", ")
  }`;
  let tail = `${where}${order} LIMIT ${p(opts.limit)}`;
  if (opts.after === undefined) {
    const offset = clampCount(opts.offset);
    if (offset !== undefined && offset > 0) tail += ` OFFSET ${p(offset)}`;
  }
  return tail;
}
