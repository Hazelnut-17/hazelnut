import { type SQL, sql } from "drizzle-orm/sql";
import type { ResourceModel } from "../core/app.ts";
import { conditionSql } from "../core/lower-sql.ts";
import { type Node, toNode, type Where } from "../core/where.ts";
import { bindGrantScopes } from "../core/grant-scope.ts";
import { storedColumnTypes, textInputCasts } from "./native-cast.ts";
import { deletedAtLivenessOn } from "./schema.ts";
import type { ReadCtx, RowPolicy } from "./repo.ts";

/** The one lifecycle derivation for reads and maintenance. `at` is already bound. */
export function lifecycleSql(
  f: ResourceModel["features"],
  at: SQL = sql`now()`,
  alias?: string,
): SQL[] {
  const col = (name: string) =>
    alias === undefined
      ? sql`${sql.identifier(name)}`
      : sql`${sql.identifier(alias)}.${sql.identifier(name)}`;
  const parts: SQL[] = [];
  if (deletedAtLivenessOn(f)) parts.push(sql`${col("deleted_at")} IS NULL`);
  if (f.expiry) {
    parts.push(
      sql`(${col("expires_at")} IS NULL OR ${col("expires_at")} > ${at})`,
    );
  }
  if (f.temporal) {
    parts.push(
      sql`(${col("valid_from")} <= ${at} AND (${col("valid_to")} IS NULL OR ${
        col("valid_to")
      } > ${at}))`,
    );
  }
  return parts;
}

/** A request's where as the node SQL is lowered from: grant scopes bound, and no comparison on an encrypted
 *  column. That column holds ciphertext, so the comparison would silently match nothing (or, negated, every
 *  row); `isNull` stays, and a `ctx.data` equality filter arrives here already moved onto its blind index. */
export function requestWhereNode<Row>(
  where: Where<Row>,
  model: ResourceModel,
  scope: string,
): Node {
  const node = bindGrantScopes(toNode(where), model, scope);
  const encrypted = new Set(model.encryptedConfig?.fields ?? []);
  const walk = (n: Node): void => {
    if ((n.kind === "cmp" || n.kind === "inArray") && encrypted.has(n.col)) {
      throw Object.assign(
        new Error(
          `encrypted/where-ciphertext: a where on resource '${model.name}' compares '${n.col}', an encrypted field — its column holds ciphertext, so the comparison would match nothing (or, negated, every row). ${
            model.encryptedConfig.equality.includes(n.col)
              ? "Its equality index serves an eq/inArray filter passed to ctx.data list or find; a rowPolicy, a view's where or any other operator cannot compare it"
              : "Declare it in encrypted.equality to filter it by equality, or filter after the read decrypts it"
          }`,
        ),
        { kind: "validation" as const },
      );
    }
    if (n.kind === "and" || n.kind === "or") n.parts.forEach(walk);
    if (n.kind === "not") walk(n.part);
  };
  if (encrypted.size > 0) walk(node);
  return node;
}

/** A caller filter naming a column with nothing to compare (`{ status: input.status }` when the input
 *  omitted it) is an author error, refused loudly; in a rowPolicy the same shape matches nothing. */
function refuseUndefinedFilter(caller: unknown, model: ResourceModel): void {
  if (typeof caller !== "object" || caller === null || "node" in caller) return;
  const missing = Object.entries(caller).filter(([, v]) => v === undefined)
    .map(([k]) => k);
  if (missing.length === 0) return;
  throw Object.assign(
    new Error(
      `where/undefined-value: a filter on '${model.name}' names ${
        missing.map((k) => `'${k}'`).join(", ")
      } with the value undefined — drop the key to leave it unfiltered, or pass null to match a missing value`,
    ),
    { kind: "validation" as const },
  );
}

/** Resolve live request semantics once; no request-dependent state enters metadata caches. */
export function readWhereSql<Row>(
  model: ResourceModel,
  ctx: ReadCtx,
  rowPolicy: RowPolicy<Row>,
  caller: Where<Row>,
  bind: (value: unknown) => SQL,
  at?: Date | string,
  alias?: string,
): SQL {
  const parts: SQL[] = [];
  const col = (name: string) =>
    alias === undefined
      ? sql`${sql.identifier(name)}`
      : sql`${sql.identifier(alias)}.${sql.identifier(name)}`;
  if (model.features.scope) {
    parts.push(sql`${col("scope_key")} = ${bind(ctx.scope)}`);
  }
  const instant = model.features.temporal && at !== undefined
    ? bind(at)
    : sql`now()`;
  parts.push(...lifecycleSql(model.features, instant, alias));
  const options = {
    bind,
    columnAlias: alias,
    castFor: (col: string) => textInputCasts(model).get(col),
    typeFor: (col: string) => storedColumnTypes(model).get(col),
  };
  parts.push(
    conditionSql(
      requestWhereNode(rowPolicy(ctx.actor), model, ctx.scope),
      alias ?? model.name,
      model.pgSchema,
      options,
    ),
  );
  refuseUndefinedFilter(caller, model);
  parts.push(
    conditionSql(
      requestWhereNode(caller, model, ctx.scope),
      alias ?? model.name,
      model.pgSchema,
      options,
    ),
  );
  return sql.join(parts.map((part) => sql`(${part})`), sql` AND `);
}
