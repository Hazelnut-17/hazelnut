// The text-input cast for a string written to a string-backed `dbType()` column (03-api-shape.md §db-schema).
import { type SQL, sql } from "drizzle-orm/sql";
import type { ResourceModel } from "../core/app.ts";
import { normalizePgType, parseCreateTables } from "./ddl-parse.ts";
import { collectDbTypeFields } from "./schema-types.ts";
import type { Db } from "./db.ts";
import type { Node } from "../core/where.ts";
import { NativeFilterValueError } from "../core/lower-sql.ts";
import { pgHasValueEquality } from "../core/native-equality.ts";

/** Both bytea text formats; raw text is the historical format, not implicitly base64-decoded bytes. */
export const BYTEA_INPUT_PATTERN = String
  .raw`^(?:\\x(?:[ \t\n\r\v\f]*[0-9a-fA-F]{2})*[ \t\n\r\v\f]*|(?:[^\\\u0000]|\\(?:\\|[0-3][0-7]{2}))*)$`;
const BYTEA_INPUT = new RegExp(BYTEA_INPUT_PATTERN);
const guardedType = (type: string) => /^(?:bytea|inet\[\])$/i.test(type.trim());

export class NativeTextInputError extends Error {
  readonly kind = "validation" as const;
  readonly code: string;
  constructor(column: string, filter: boolean) {
    super(
      `native/text-input: '${column}' requires valid PostgreSQL text input for its declared native type`,
    );
    this.code = filter ? "filter/native-text-input" : "input/native-text-input";
  }
}

/** Known declared fields only. The soft-input check never catches/relabels a driver exception: authored
 * SQL constants, unsupported server capabilities and unrelated casts keep their original error contract. */
export async function assertNativeTextValues(
  db: Db,
  model: ResourceModel,
  entries: readonly (readonly [string, unknown])[],
  filter = false,
): Promise<void> {
  const casts = textInputCasts(model);
  const checks: { column: string; type: string; value: string }[] = [];
  for (const [column, value] of entries) {
    const type = casts.get(column);
    if (type === undefined || value === null || value === undefined) continue;
    if (typeof value !== "string") {
      if (filter) throw new NativeFilterValueError(column);
      if (guardedType(type)) throw new NativeTextInputError(column, false);
      continue;
    }
    if (!guardedType(type)) continue;
    if (
      value.includes("\0") || !value.isWellFormed() ||
      (type.trim().toLowerCase() === "bytea" && !BYTEA_INPUT.test(value))
    ) {
      throw new NativeTextInputError(column, filter);
    }
    checks.push({ column, type, value });
  }
  if (checks.length === 0) return;
  const invalid = await db.query<{ column: string }>(
    `SELECT value->>'column' AS "column" FROM jsonb_array_elements($1::text::jsonb)
     WHERE NOT pg_input_is_valid(value->>'value', value->>'type') LIMIT 1`,
    [JSON.stringify(checks)],
  );
  if (invalid.rows[0]) {
    throw new NativeTextInputError(invalid.rows[0].column, filter);
  }
}

/** Async caller-filter prepass, before synchronous lowering. Inspect every native value's JS type
 * before issuing any check, so a mixed filter cannot query first and only then reject a binary value. */
export async function assertNativeTextWhere(
  db: Db,
  model: ResourceModel,
  node: Node,
): Promise<void> {
  const entries: [string, unknown][] = [];
  const walk = (part: Node): void => {
    if (
      (part.kind === "cmp" && (part.op === "eq" || part.op === "ne")) ||
      (part.kind === "inArray" && part.values.length > 0)
    ) {
      const pg = model.columns[part.col]?.pg;
      // Encrypted plaintext equality belongs to the blind-index rewrite, not its authored dbType.
      // Unindexed or unsupported encrypted comparisons keep the existing ciphertext refusal.
      if (
        !model.encrypted.includes(part.col) && pg !== undefined &&
        !pgHasValueEquality(pg)
      ) {
        throw Object.assign(
          new Error(
            `column '${part.col}' of native type '${pg}' does not support value-equality filtering`,
          ),
          { kind: "validation" as const },
        );
      }
    }
    if (part.kind === "cmp") entries.push([part.col, part.value]);
    else if (part.kind === "inArray") {
      for (const value of part.values) entries.push([part.col, value]);
    } else if (part.kind === "and" || part.kind === "or") {
      part.parts.forEach(walk);
    } else if (part.kind === "not") walk(part.part);
  };
  walk(node);
  await assertNativeTextValues(db, model, entries, true);
}

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

const stored = new WeakMap<ResourceModel, ReadonlyMap<string, string>>();

/** Every column of `model`'s table → the type its DDL stores it as (scalar types only). */
export function storedColumnTypes(
  model: ResourceModel,
): ReadonlyMap<string, string> {
  let hit = stored.get(model);
  if (hit === undefined) {
    const out = new Map<string, string>();
    for (const [col, type] of parseCreateTables(model.ddl)[0]?.columns ?? []) {
      const pg = normalizePgType(type);
      if (NATIVE_TYPE.test(pg) && !pg.endsWith("[]")) out.set(col, pg);
    }
    hit = out;
    stored.set(model, hit);
  }
  return hit;
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
