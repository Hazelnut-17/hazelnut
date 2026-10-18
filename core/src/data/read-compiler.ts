import { type SQL, sql } from "drizzle-orm/sql";
import type { ResourceModel } from "../core/app.ts";
import { physicalColumnsOf } from "../core/app-refs.ts";
import { compileSql } from "../core/lower-sql.ts";
import type { Where } from "../core/where.ts";
import { readPageSql } from "./read-page-sql.ts";
import type { Page } from "./read-page.ts";
import { readWhereSql } from "./read-sql.ts";
import type { ReadCtx, RowPolicy } from "./repo.ts";
import type { Db } from "./db.ts";

export interface ReadMetadata {
  readonly table: SQL;
  readonly columns: ReadonlyMap<string, SQL>;
}
const metadata = new WeakMap<ResourceModel, ReadMetadata>();

/** Execute composed specialist SQL on exactly the supplied handle, without row codecs. */
export function querySql<Row = Record<string, unknown>>(
  db: Db,
  statement: SQL,
  preparedParams?: readonly unknown[],
): Promise<{ rows: Row[] }> {
  const query = compileSql(statement);
  if (preparedParams !== undefined && query.params.length !== 0) {
    throw new Error(
      "read compiler: cannot mix prepared and compiler-allocated parameters",
    );
  }
  return db.query<Row>(
    query.sql,
    preparedParams === undefined ? query.params : [...preparedParams],
  );
}

/** Composed identity owns this cache. No bare-name, global-app, actor, or result cache. */
export function readMetadata(model: ResourceModel): ReadMetadata {
  const cached = metadata.get(model);
  if (cached) return cached;
  const derived = {
    table: sql`${sql.identifier(model.pgSchema)}.${sql.identifier(model.name)}`,
    columns: new Map(
      [...physicalColumnsOf(model.ddl)].map((
        name,
      ) => [name, sql`${sql.identifier(name)}`]),
    ),
  };
  metadata.set(model, derived);
  return derived;
}

/** Positive physical projection, before row codecs. An id accompanies encrypted cells for their AAD;
 * an empty delivered shape still needs a harmless column to preserve row cardinality. */
export function selectedReadColumns(
  model: ResourceModel,
  columns?: readonly string[],
): readonly string[] | undefined {
  if (columns === undefined) return undefined;
  const names = [...new Set(columns)];
  for (const name of names) {
    if (!readMetadata(model).columns.has(name)) {
      throw new Error(
        `read/unknown-column: '${name}' is not a stored column of '${model.name}'`,
      );
    }
  }
  if (
    names.length === 0 || names.some((name) => model.encrypted.includes(name))
  ) {
    if (!names.includes("id")) names.push("id");
  }
  return names;
}

/** Compile already equality-prepared inputs. Execution and decoding remain on the caller's Db. */
export function compileRead<Row>(
  model: ResourceModel,
  ctx: ReadCtx,
  rowPolicy: RowPolicy<Row>,
  caller: Where<Row>,
  opts: {
    readonly mode?: "rows" | "count" | "exists";
    readonly page?: Page;
    readonly at?: Date | string;
    readonly lock?: false | "update" | "share";
    readonly search?: string;
    readonly columns?: readonly string[];
    /** Internal listPage continuation; ordinary list still refuses orderBy beside offset. */
    readonly listPageOffset?: true;
  } = {},
): { sql: string; params: unknown[] } {
  if (
    opts.search !== undefined &&
    (typeof opts.search !== "string" || opts.search.trim().length === 0 ||
      model.searchable.length === 0)
  ) {
    throw Object.assign(
      new Error(
        model.searchable.length === 0
          ? `resource '${model.name}' is not searchable — omit 'search'`
          : "search must contain at least one non-space character",
      ),
      { kind: "validation" as const },
    );
  }
  // Allocate at preparation time: an as-of instant is reused by all lifecycle
  // comparisons, and existing write-adjacent parameter order stays unchanged.
  const params: unknown[] = [];
  const bind = (value: unknown): SQL => sql.raw(`$${params.push(value)}`);
  const predicate = readWhereSql(model, ctx, rowPolicy, caller, bind, opts.at);
  const source = readMetadata(model);
  const columns = selectedReadColumns(model, opts.columns);
  const selection = opts.mode === "count"
    ? sql`COUNT(*)::int AS n`
    : opts.mode === "exists"
    ? sql`1`
    : columns === undefined
    ? sql`*`
    : sql.join(columns.map((name) => source.columns.get(name)!), sql`, `);
  const statement =
    sql`SELECT ${selection} FROM ${source.table} WHERE ${predicate}`;
  if (opts.search !== undefined) {
    statement.append(
      sql` AND ${
        sql.identifier("search_vector")
      } @@ plainto_tsquery('english', ${bind(opts.search)})`,
    );
  }
  if (opts.mode === "exists") statement.append(sql` LIMIT 1`);
  else if (opts.mode !== "count") {
    statement.append(readPageSql(opts.page, model, bind, opts.listPageOffset));
  }
  if (opts.lock === "update") statement.append(sql` FOR UPDATE`);
  if (opts.lock === "share") statement.append(sql` FOR SHARE`);
  const compiled = compileSql(statement);
  if (compiled.params.length !== 0) {
    throw new Error(
      "read compiler: an unallocated parameter escaped preparation",
    );
  }
  return { sql: compiled.sql, params };
}
