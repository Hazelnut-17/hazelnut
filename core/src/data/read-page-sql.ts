import { type SQL, sql } from "drizzle-orm/sql";
import type { ResourceModel } from "../core/app.ts";
import { castBound, storedColumnTypes } from "./native-cast.ts";
import { normalizePgType } from "./ddl-parse.ts";
import {
  clampCount,
  cursorKey,
  cursorTupleValues,
  decodeCursor,
  type Page,
} from "./read-page.ts";

/** Internal structural pagination; existing validators own its public error contract. */
const FRAMEWORK_TIMESTAMPS: ReadonlySet<string> = new Set([
  "created_at",
  "updated_at",
  "valid_from",
  "valid_to",
  "deleted_at",
  "expires_at",
]);

/** A keyset column as a cursor can hold it. A cursor carries the JS Date a read returns, which keeps
 *  milliseconds; Postgres stores microseconds. Ordering and comparing a timestamp at the millisecond leaves
 *  the rows inside one millisecond to the id tiebreak, which the cursor does carry exactly. */
function keyColumn(model: ResourceModel | undefined, c: string): SQL {
  const type = model === undefined
    ? undefined
    : storedColumnTypes(model).get(c) ?? model.columns[c]?.pg;
  // Feature names are available to app fields when that feature is off. A declared text `created_at`
  // remains text; only its real storage type decides whether date_trunc is applicable. The declared
  // fallback also covers native timestamp precision spellings the scalar cast cache does not admit.
  const timestamp = type === undefined
    ? FRAMEWORK_TIMESTAMPS.has(c)
    : /^timestamp(?:\(|\s|$)/.test(normalizePgType(type));
  return timestamp
    ? sql`date_trunc('milliseconds', ${sql.identifier(c)})`
    : sql`${sql.identifier(c)}`;
}

export function readPageSql(
  page: Page | undefined,
  model: ResourceModel,
  bind: (value: unknown) => SQL,
): SQL {
  if (!page) return sql.empty();
  if (page.sort) {
    if (page.after !== undefined && page.offset !== undefined) {
      throw new Error("page/offset-with-keyset: drop offset or after");
    }
    const limit = clampCount(page.limit);
    if (limit === undefined) {
      throw new Error("page/sort-limit: a sorted read requires a page limit");
    }
    return orderedTailSql({
      key: cursorKey(page, model),
      dir: page.sort.direction,
      after: page.after,
      offset: page.offset,
      limit,
      model,
    }, bind);
  }
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
        sql` AND (${
          sql.join(key.map((c) => keyColumn(model, c)), sql`, `)
        }) > (${
          sql.join(
            values.map((v, i) => castBound(model, key[i]!, v, bind)),
            sql`, `,
          )
        })`,
      );
    }
    out.append(
      sql` ORDER BY ${sql.join(key.map((c) => keyColumn(model, c)), sql`, `)}`,
    );
    const limit = clampCount(page.limit);
    if (limit !== undefined) {
      out.append(sql` LIMIT ${bind(limit)}`);
    }
    return out;
  }
  const limit = clampCount(page.limit);
  const offset = clampCount(page.offset, "offset");
  if (limit !== undefined || offset !== undefined) {
    const key = cursorKey(page, model);
    out.append(
      sql` ORDER BY ${sql.join(key.map((c) => keyColumn(model, c)), sql`, `)}`,
    );
  }
  if (limit !== undefined) {
    out.append(sql` LIMIT ${bind(limit)}`);
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
    readonly model?: ResourceModel;
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
        sql.join(opts.key.map((c) => keyColumn(opts.model, c)), sql`, `)
      }) ${op} (${
        sql.join(
          values.map((v, i) =>
            opts.model === undefined
              ? bind(v)
              : castBound(opts.model, opts.key[i]!, v, bind)
          ),
          sql`, `,
        )
      })`,
    );
  }
  const direction = desc ? sql` DESC` : sql.empty();
  out.append(
    sql` ORDER BY ${
      sql.join(
        opts.key.map((c) => sql`${keyColumn(opts.model, c)}${direction}`),
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
