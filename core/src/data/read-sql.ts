import { type SQL, sql } from "drizzle-orm/sql";
import type { ResourceModel } from "../core/app.ts";
import { conditionSql } from "../core/lower-sql.ts";
import { toNode, type Where } from "../core/where.ts";
import { bindGrantScopes } from "../core/grant-scope.ts";
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
  const options = { bind, columnAlias: alias };
  parts.push(
    conditionSql(
      bindGrantScopes(toNode(rowPolicy(ctx.actor)), model, ctx.scope),
      alias ?? model.name,
      model.pgSchema,
      options,
    ),
  );
  parts.push(
    conditionSql(
      bindGrantScopes(toNode(caller), model, ctx.scope),
      alias ?? model.name,
      model.pgSchema,
      options,
    ),
  );
  return sql.join(parts.map((part) => sql`(${part})`), sql` AND `);
}
