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

const INLINE_IN_MAX = 256;
const scalarParam = (v: unknown): boolean =>
  typeof v === "string" || typeof v === "number" || typeof v === "bigint" ||
  typeof v === "boolean";
/** A `Date` is the read face of a timestamp column. It joins the one-array path as UTC text. */
const arrayMember = (value: unknown): boolean =>
  scalarParam(value) || value instanceof Date;
const arrayText = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value);

export class NativeFilterValueError extends Error {
  readonly kind = "validation" as const;
  readonly code = "filter/native-text-input";
  constructor(column: string) {
    super(
      `filter/native-text-input: '${column}' requires its declared string input representation; a native read value cannot be rebound as text`,
    );
  }
}

/** Lower the structural algebra, not rendered SQL. Aliases bind at the owning query node. */
export function conditionSql(
  node: Node,
  outerTable: string,
  pgSchema = "public",
  options: {
    readonly columnAlias?: string;
    readonly bind?: (value: unknown) => SQL;
    /** The native type a string-backed column's value is read as (`$n::text::<type>`), when it has one. */
    readonly castFor?: (col: string) => string | undefined;
    /** The column's stored type, which lets a long `inArray` bind its values as ONE array parameter. */
    readonly typeFor?: (col: string) => string | undefined;
  } = {},
): SQL {
  const plain = options.bind ?? ((value: unknown) => sql`${sql.param(value)}`);
  const valueOf = (col: string, value: unknown): SQL => {
    const cast = options.castFor?.(col);
    if (cast !== undefined && value !== null && typeof value !== "string") {
      throw new NativeFilterValueError(col);
    }
    const pg = typeof value === "string" ? cast : undefined;
    return pg === undefined
      ? plain(value)
      : sql`${plain(value)}::text::${sql.raw(pg)}`;
  };
  const bind = plain;
  const col = (name: string): SQL =>
    options.columnAlias === undefined
      ? sql`${sql.identifier(name)}`
      : sql`${sql.identifier(options.columnAlias)}.${sql.identifier(name)}`;
  const nested = (part: Node) =>
    conditionSql(part, outerTable, pgSchema, options);
  switch (node.kind) {
    case "cmp":
      return sql`${col(node.col)} ${comparison(node.op)} ${
        valueOf(node.col, node.value)
      }`;
    case "inArray": {
      if (node.values.length === 0) return sql`FALSE`;
      const present = node.values.filter((value) => value !== null);
      if (
        options.castFor?.(node.col) !== undefined &&
        present.some((value) => typeof value !== "string")
      ) throw new NativeFilterValueError(node.col);
      const arrayType = node.values.length > INLINE_IN_MAX &&
          present.every(arrayMember)
        ? options.castFor?.(node.col) ?? options.typeFor?.(node.col)
        : undefined;
      // One bind per value stops at Postgres's 65,535-parameter ceiling. Past that, one text array has no
      // ceiling. `unnest` builds the column's array once: a date/timestamp/interval cast beside the scan is
      // STABLE and would run again on every row.
      if (arrayType === undefined) {
        return sql`${col(node.col)} IN (${
          sql.join(node.values.map((v) => valueOf(node.col, v)), sql`, `)
        })`;
      }
      const hasNull = present.length !== node.values.length;
      const match = present.length === 0
        ? sql`FALSE`
        : sql`${col(node.col)} = ANY(ARRAY(SELECT unnest(${
          plain(present.map(arrayText))
        }::text[])::${sql.raw(arrayType)}))`;
      // `IN` with a null member is unknown for every non-match. Dropping the null would make `NOT IN` true.
      return hasNull ? sql`(${match} OR NULL)` : match;
    }
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
      if (r.viaScope !== undefined) {
        predicates.push(sql`${grant("scope_key")} = ${bind(r.viaScope)}`);
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
