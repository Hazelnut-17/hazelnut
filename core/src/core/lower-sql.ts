import { type SQL, sql } from "drizzle-orm/sql";
import { PgDialect } from "drizzle-orm/pg-core";
import type { CmpOp, Node } from "./where.ts";

const dialect = new PgDialect();
const GRANT_ALIAS = "_hz_g";

/** Internal SQL composition only. No driver, connection, row codec, or actor cache. */
export function compileSql(statement: SQL): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(statement);
  return { sql: query.sql, params: query.params };
}

/** Bridge for existing write/DDL helpers that own their statement-wide allocator. */
export function compileInto(
  statement: SQL,
  p: (value: unknown) => string,
): string {
  return statement.toQuery({
    escapeName: (name) => dialect.escapeName(name),
    escapeString: (value) => dialect.escapeString(value),
    escapeParam: (_index, value) => p(value),
  }).sql;
}

function comparison(op: CmpOp): SQL {
  switch (op) {
    case "eq":
      return sql`=`;
    case "ne":
      return sql`<>`;
    case "gt":
      return sql`>`;
    case "gte":
      return sql`>=`;
    case "lt":
      return sql`<`;
    case "lte":
      return sql`<=`;
    case "like":
      return sql`LIKE`;
  }
  const unreachable: never = op;
  throw new Error(`unknown comparison operator: ${unreachable}`);
}

/** Lower the structural algebra, not rendered SQL. Aliases bind at the owning query node. */
export function conditionSql(
  node: Node,
  outerTable: string,
  pgSchema = "public",
  options: {
    readonly columnAlias?: string;
    readonly bind?: (value: unknown) => SQL;
  } = {},
): SQL {
  const bind = options.bind ?? ((value: unknown) => sql`${sql.param(value)}`);
  const col = (name: string): SQL =>
    options.columnAlias === undefined
      ? sql`${sql.identifier(name)}`
      : sql`${sql.identifier(options.columnAlias)}.${sql.identifier(name)}`;
  const nested = (part: Node) =>
    conditionSql(part, outerTable, pgSchema, options);
  switch (node.kind) {
    case "cmp":
      return sql`${col(node.col)} ${comparison(node.op)} ${bind(node.value)}`;
    case "inArray":
      return node.values.length
        ? sql`${col(node.col)} IN (${sql.join(node.values.map(bind), sql`, `)})`
        : sql`FALSE`;
    case "isNull":
      return sql`${col(node.col)} IS NULL`;
    case "and":
      return node.parts.length
        ? sql`(${sql.join(node.parts.map(nested), sql` AND `)})`
        : sql`TRUE`;
    case "or":
      return node.parts.length
        ? sql`(${sql.join(node.parts.map(nested), sql` OR `)})`
        : sql`FALSE`;
    case "not":
      return sql`NOT (${nested(node.part)})`;
    case "exists": {
      const r = node.rel;
      const grant = (name: string) =>
        sql`${sql.identifier(GRANT_ALIAS)}.${sql.identifier(name)}`;
      const outer = sql`${sql.identifier(options.columnAlias ?? outerTable)}.${
        sql.identifier(r.rowCol)
      }`;
      const predicates = [
        sql`${grant(r.viaRowCol)} = ${outer}`,
        sql`${grant(r.viaActorCol)} = ${bind(r.actorId)}`,
      ];
      if (r.roleCol !== undefined) {
        predicates.push(sql`${grant(r.roleCol)} = ${bind(r.role)}`);
      }
      if (r.viaSoftDelete) predicates.push(sql`${grant("deleted_at")} IS NULL`);
      if (r.viaExpiry) {
        predicates.push(
          sql`(${grant("expires_at")} IS NULL OR ${
            grant("expires_at")
          } > now())`,
        );
      }
      if (r.viaTemporal) {
        predicates.push(
          sql`(${grant("valid_from")} <= now() AND (${
            grant("valid_to")
          } IS NULL OR ${grant("valid_to")} > now()))`,
        );
      }
      return sql`EXISTS (SELECT 1 FROM ${sql.identifier(pgSchema)}.${
        sql.identifier(r.via)
      } AS ${sql.identifier(GRANT_ALIAS)} WHERE ${
        sql.join(predicates, sql` AND `)
      })`;
    }
    case "all":
      return sql`TRUE`;
    case "none":
      return sql`FALSE`;
  }
  const unreachable: never = node;
  throw new Error(`unknown condition node: ${unreachable}`);
}
