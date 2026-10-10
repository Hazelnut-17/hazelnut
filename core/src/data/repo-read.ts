// Barrel re-exports keep import sites stable.
import { isSystem } from "../authz/auth.ts";
import type { ResourceModel } from "../core/app.ts";
import { lowerInto } from "../core/lower.ts";
import { bindGrantScopes } from "../core/grant-scope.ts";
import { textInputCasts } from "./native-cast.ts";
import { all, toNode, type Where } from "../core/where.ts";
import { sql as drizzleSql } from "drizzle-orm/sql";
import { compileInto, compileSql } from "../core/lower-sql.ts";
import { lifecycleSql, readWhereSql } from "./read-sql.ts";
import { orderedTailSql, readPageSql } from "./read-page-sql.ts";
import type { Page } from "./read-page.ts";
export * from "./read-page.ts";
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
  return lifecycleSql(f, drizzleSql.raw(at)).map((part) =>
    compileSql(part).sql
  );
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
  return {
    sql: compileInto(
      readWhereSql(
        model,
        ctx,
        rowPolicy,
        caller,
        (value) => drizzleSql.raw(p(value)),
        at,
      ),
      p,
    ),
    params,
  };
}

/** The declared rowPolicy carried on the model — the same `(actor) => Where` the read path resolves
 *  (mirrored from serve.ts/mcp.ts/data.ts). Resolved inside the repo so update/remove derive it with no
 *  call-site change. */
export function modelRowPolicy<Row>(model: ResourceModel): RowPolicy<Row> {
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
  return ` AND (${
    lowerInto(
      bindGrantScopes(toNode(rp(ctx.actor)), model, ctx.scope),
      p,
      model.name,
      model.pgSchema,
      (col) => textInputCasts(model).get(col),
    )
  })`;
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
  return compileInto(
    readPageSql(
      page,
      model,
      (value) => drizzleSql.raw(`$${params.push(value)}`),
    ),
    (value) => `$${params.push(value)}`,
  );
}

/**
 * The MCP read-tools' page tail (12-mcp §6) — an always-order-by keyset-or-offset suffix (unlike
 * `pageClause`'s offset-xor-keyset): an unordered offset page is non-deterministic across pages (a latent
 * dup/skip), so every page orders by a stable `key`. `key` MUST be `cursorKey`-validated (bare identifier,
 * never `$n`); a malformed `after` throws (fail-closed).
 *
 * Callers that default `offset` to 0 MUST refuse a mix on the raw query first — this tail cannot tell
 * omit from `offset: 0`, and with `after` it would drop a real offset silently.
 */
export function refuseMixedCursorOffset(
  page: { after?: string; offset?: number },
): void {
  if (page.after !== undefined && page.offset !== undefined) {
    throw Object.assign(
      new Error(
        "page/offset-with-keyset: a read cannot paginate by both cursor and offset. Drop `offset`, or drop `after`.",
      ),
      { kind: "validation" as const },
    );
  }
}

export function orderedPageTail(
  opts: {
    key: readonly string[];
    dir?: "asc" | "desc";
    after?: string;
    offset?: number;
    limit: number;
    model?: ResourceModel;
  },
  params: unknown[],
): string {
  return compileInto(
    orderedTailSql(opts, (value) => drizzleSql.raw(`$${params.push(value)}`)),
    (value) => `$${params.push(value)}`,
  );
}
