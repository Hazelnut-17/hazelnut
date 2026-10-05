import { type SQL, sql } from "drizzle-orm/sql";
import type { ResourceModel } from "../core/app.ts";
import {
  clampCount,
  cursorKey,
  cursorTupleValues,
  decodeCursor,
  type Page,
  PAGE_LIMIT_MAX,
} from "./read-page.ts";

/** Internal structural pagination; existing validators own its public error contract. */
export function readPageSql(
  page: Page | undefined,
  model: ResourceModel,
  bind: (value: unknown) => SQL,
): SQL {
  if (!page) return sql.empty();
  const keyset = page.after !== undefined || page.orderBy !== undefined;
  if (keyset && page.offset !== undefined) {
    if (page.after !== undefined) {
      throw new Error(
        "page/offset-with-keyset: a read cannot paginate by both cursor and offset — `offset` was passed alongside `after`, and a keyset read is positioned by its cursor. Drop `offset`, or drop the cursor and page by offset alone.",
      );
    }
    throw new Error(
      "page/offset-with-keyset: a read cannot paginate by both cursor and offset — `offset` was passed alongside `orderBy`, and a keyset read is positioned by its cursor. Drop `offset`, or drop the cursor and page by offset alone.",
    );
  }
  const out = sql.empty();
  if (keyset) {
    const key = cursorKey(page, model);
    if (page.after !== undefined) {
      const values = cursorTupleValues(key, decodeCursor(page.after));
      out.append(
        sql` AND (${sql.join(key.map((c) => sql.identifier(c)), sql`, `)}) > (${
          sql.join(values.map(bind), sql`, `)
        })`,
      );
    }
    out.append(
      sql` ORDER BY ${sql.join(key.map((c) => sql.identifier(c)), sql`, `)}`,
    );
    const limit = clampCount(page.limit);
    if (limit !== undefined) {
      out.append(sql` LIMIT ${bind(Math.min(limit, PAGE_LIMIT_MAX + 1))}`);
    }
    return out;
  }
  const limit = clampCount(page.limit);
  const offset = clampCount(page.offset, "offset");
  if (limit !== undefined || offset !== undefined) {
    const key = cursorKey(page, model);
    out.append(
      sql` ORDER BY ${sql.join(key.map((c) => sql.identifier(c)), sql`, `)}`,
    );
  }
  if (limit !== undefined) {
    out.append(sql` LIMIT ${bind(Math.min(limit, PAGE_LIMIT_MAX + 1))}`);
  }
  if (offset !== undefined) out.append(sql` OFFSET ${bind(offset)}`);
  return out;
}

export function orderedTailSql(
  opts: {
    readonly key: readonly string[];
    readonly dir?: "asc" | "desc";
    readonly after?: string;
    readonly offset?: number;
    readonly limit: number;
  },
  bind: (value: unknown) => SQL,
): SQL {
  const desc = opts.dir === "desc";
  const out = sql.empty();
  if (opts.after !== undefined) {
    const values = cursorTupleValues(opts.key, decodeCursor(opts.after));
    const op = desc ? sql`<` : sql`>`;
    out.append(
      sql` AND (${
        sql.join(opts.key.map((c) => sql.identifier(c)), sql`, `)
      }) ${op} (${sql.join(values.map(bind), sql`, `)})`,
    );
  }
  const direction = desc ? sql` DESC` : sql.empty();
  out.append(
    sql` ORDER BY ${
      sql.join(
        opts.key.map((c) => sql`${sql.identifier(c)}${direction}`),
        sql`, `,
      )
    } LIMIT ${bind(opts.limit)}`,
  );
  if (opts.after === undefined) {
    const offset = clampCount(opts.offset, "offset");
    if (offset !== undefined && offset > 0) {
      out.append(sql` OFFSET ${bind(offset)}`);
    }
  }
  return out;
}
