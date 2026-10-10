// The text-input cast for a string written to a string-backed `dbType()` column (03-api-shape.md §db-schema).
import { type SQL, sql } from "drizzle-orm/sql";
import type { ResourceModel } from "../core/app.ts";
import { normalizePgType, parseCreateTables } from "./ddl-parse.ts";
import { collectDbTypeFields } from "./schema-types.ts";

/** A native type name `dbType()` may carry into SQL: a name, an optional `(p[,s])` modifier, array suffixes. */
const NATIVE_TYPE =
  /^[a-z_][a-z0-9_]*(?: [a-z_][a-z0-9_]*)*(?:\(\s*\d+(?:\s*,\s*\d+)?\s*\))?(?:\[\])*$/i;

const casts = new WeakMap<ResourceModel, ReadonlyMap<string, string>>();

/** Every string-backed, non-encrypted `dbType()` column of `model` → its native type. */
export function textInputCasts(
  model: ResourceModel,
): ReadonlyMap<string, string> {
  let hit = casts.get(model);
  if (hit === undefined) {
    const out = new Map<string, string>();
    for (const [col, f] of Object.entries(collectDbTypeFields(model.schema))) {
      const pg = f.pg.trim();
      if (
        f.stringBacked && !model.encrypted.includes(col) && NATIVE_TYPE.test(pg)
      ) {
        out.set(col, pg);
      }
    }
    hit = out;
    casts.set(model, hit);
  }
  return hit;
}

/**
 * `ph` as the value of `col`: a string bound to a string-backed `dbType()` column is cast `::text::<type>`, so
 * Postgres reads it with that type's own text input on every engine (a driver would otherwise pick a binary
 * encoding for the bound string). Any other column keeps its placeholder.
 */
export function castPlaceholder(
  model: ResourceModel,
  col: string,
  ph: string,
): string {
  const pg = textInputCasts(model).get(col);
  return pg === undefined ? ph : `${ph}::text::${pg}`;
}

/** `value` bound as the value of `col` — `castPlaceholder` for a bound string, the plain bind otherwise. */
export function castBound(
  model: ResourceModel,
  col: string,
  value: unknown,
  bind: (value: unknown) => SQL,
): SQL {
  const pg = typeof value === "string"
    ? textInputCasts(model).get(col)
    : undefined;
  return pg === undefined
    ? bind(value)
    : sql`${bind(value)}::text::${sql.raw(pg)}`;
}

const bigintColumns = new WeakMap<ResourceModel, readonly string[]>();

/** The columns a typed read carries as `bigint`: declared `z.bigint()` fields and the rollups over them
 *  (03-api-shape.md §db-schema). Any other int8 — a serial id, an FK, a sequence — stays its decimal text. */
export function declaredBigintColumns(model: ResourceModel): readonly string[] {
  let hit = bigintColumns.get(model);
  if (hit === undefined) {
    const physical = parseCreateTables(model.ddl)[0]?.columns;
    hit = [
      ...Object.entries(model.columns).filter(([, c]) => c.pg === "bigint")
        .map(([name]) => name),
      ...model.rollupOwnCols.filter((c) =>
        normalizePgType(physical?.get(c) ?? "") === "bigint"
      ),
    ];
    bigintColumns.set(model, hit);
  }
  return hit;
}

/** `rows` with each declared bigint column's decimal text read as a `bigint`, in place. */
export function decodeDeclaredBigints<R>(model: ResourceModel, rows: R[]): R[] {
  const columns = declaredBigintColumns(model);
  if (columns.length === 0) return rows;
  for (const row of rows as Record<string, unknown>[]) {
    for (const c of columns) {
      const value = row[c];
      if (typeof value === "string") row[c] = BigInt(value);
      else if (typeof value === "number" && Number.isSafeInteger(value)) {
        row[c] = BigInt(value);
      }
    }
  }
  return rows;
}
