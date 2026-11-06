// The text-input cast for a string written to a string-backed `dbType()` column (03-api-shape.md §db-schema).
import { type SQL, sql } from "drizzle-orm/sql";
import type { ResourceModel } from "../core/app.ts";
import { normalizePgType, parseCreateTables } from "./ddl-parse.ts";
import { collectDbTypeFields } from "./schema-types.ts";
import type { Db } from "./db.ts";
import type { Node } from "../core/where.ts";
import { NativeFilterValueError, spellPlusInstant } from "../core/lower-sql.ts";
import { pgHasValueEquality } from "../core/native-equality.ts";

/** Both bytea text formats; raw text is the historical format, not implicitly base64-decoded bytes. */
export const BYTEA_INPUT_PATTERN = String
  .raw`^(?:\\x(?:[ \t\n\r\v\f]*[0-9a-fA-F]{2})*[ \t\n\r\v\f]*|(?:[^\\\u0000]|\\(?:\\|[0-3][0-7]{2}))*)$`;
const BYTEA_INPUT = new RegExp(BYTEA_INPUT_PATTERN);
const guardedType = (type: string) => /^(?:bytea|inet\[\])$/i.test(type.trim());

const LENGTH_BOUND =
  /^(varchar|character varying|char|character|bpchar|bit|varbit|bit varying)\s*\(\s*(\d+)\s*\)$/i;

function declaredLength(
  type: string,
): { readonly bits: boolean; readonly max: number } | undefined {
  const base = type.trim().replace(/(?:\[\s*\])+$/u, "").trim();
  const match = LENGTH_BOUND.exec(base);
  if (!match) return undefined;
  const kind = match[1]!.toLowerCase();
  return {
    bits: kind === "bit" || kind === "varbit" || kind === "bit varying",
    max: Number(match[2]),
  };
}

function longerThanDeclared(
  value: string,
  bits: boolean,
  max: number,
): boolean {
  const length = bits ? value.length : [...value].length;
  return length > max;
}

function assertDeclaredLength(
  column: string,
  type: string,
  value: unknown,
  filter: boolean,
): void {
  const bound = declaredLength(type);
  if (!bound) return;
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      if (longerThanDeclared(item, bound.bits, bound.max)) {
        throw new NativeTextInputError(
          column,
          filter,
          `native/text-input: '${column}' is longer than ${type.trim()} allows`,
        );
      }
      return;
    }
    if (Array.isArray(item)) item.forEach(visit);
  };
  visit(value);
}

export class NativeTextInputError extends Error {
  readonly kind = "validation" as const;
  readonly code: string;
  constructor(column: string, filter: boolean, detail?: string) {
    super(
      detail ??
        `native/text-input: '${column}' requires valid PostgreSQL text input for its declared native type`,
    );
    this.code = filter ? "filter/native-text-input" : "input/native-text-input";
  }
}

/** A value that would store an instant before AD 0001 or outside JavaScript's Date range. */
export class NativeInstantRangeError extends Error {
  readonly kind = "validation" as const;
  constructor(column: string) {
    super(
      `native/instant-range: '${column}' must resolve to an AD instant within the JavaScript Date range`,
    );
  }
}

/** Keep framework-decoded timestamptz columns inside the range their native Date codec can read. */
export function assertSupportedInstantValues(
  model: ResourceModel,
  entries: readonly (readonly [string, unknown])[],
): void {
  const nativeText = textInputCasts(model);
  const physical = storedColumnTypes(model);
  for (const [column, value] of entries) {
    const declared = model.columns[column]?.pg ?? physical.get(column);
    // Explicit dbType() columns use their authored text contract. Framework-owned
    // z.date()/z.iso.datetime() and lifecycle instants decode through Date instead.
    if (
      declared === undefined || nativeText.has(column) ||
      normalizePgType(declared) !== "timestamp with time zone"
    ) continue;
    const check = (item: unknown): void => {
      if (item === null || item === undefined) return;
      const millis = item instanceof Date
        ? item.getTime()
        : typeof item === "string"
        ? Date.parse(item)
        : undefined;
      if (millis === undefined) return;
      const date = new Date(millis);
      if (!Number.isFinite(millis) || date.getUTCFullYear() < 1) {
        throw new NativeInstantRangeError(column);
      }
    };
    const visit = (item: unknown): void => {
      if (Array.isArray(item)) item.forEach(visit);
      else check(item);
    };
    visit(value);
  }
}

/** Rewrite a signed extended-year instant string on a `timestamptz` column before it is bound.
 * A `Date` stays a `Date`; the driver adapters spell that form. */
export function spellSupportedInstantInputs(
  model: ResourceModel,
  values: Record<string, unknown>,
): void {
  const nativeText = textInputCasts(model);
  const physical = storedColumnTypes(model);
  const spell = (item: unknown): unknown =>
    typeof item === "string" ? spellPlusInstant(item) ?? item : item;
  for (const [column, value] of Object.entries(values)) {
    const declared = model.columns[column]?.pg ?? physical.get(column);
    if (
      declared === undefined || nativeText.has(column) ||
      normalizePgType(declared) !== "timestamp with time zone"
    ) continue;
    values[column] = Array.isArray(value) ? value.map(spell) : spell(value);
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
  const lengths: {
    column: string;
    type: string;
    value: string;
    max: number;
    array: boolean;
  }[] = [];
  for (const [column, value] of entries) {
    const type = casts.get(column);
    if (type === undefined || value === null || value === undefined) continue;
    assertDeclaredLength(column, type, value, filter);
    if (typeof value !== "string") {
      if (filter) throw new NativeFilterValueError(column);
      if (guardedType(type)) throw new NativeTextInputError(column, false);
      continue;
    }
    const bound = declaredLength(type);
    // ASCII has the same character count in the supported PostgreSQL server
    // encodings. For other text, ask the database before an explicit typmod
    // cast: SQL_ASCII counts UTF-8 bytes and a cast would silently truncate.
    if (bound && !bound.bits && /[^\p{ASCII}]/u.test(value)) {
      lengths.push({
        column,
        type,
        value,
        max: bound.max,
        array: /(?:\[\s*\])+$/u.test(type.trim()),
      });
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
  if (lengths.length > 0) {
    const tooLong = await db.query<{ column: string; type: string }>(
      `SELECT value->>'column' AS "column", value->>'type' AS "type"
       FROM jsonb_array_elements($1::text::jsonb)
       WHERE CASE WHEN (value->>'array')::boolean THEN EXISTS (
         SELECT 1 FROM unnest((value->>'value')::text[]) AS elements(item)
         WHERE char_length(item) > (value->>'max')::int
       ) ELSE char_length(value->>'value') > (value->>'max')::int END LIMIT 1`,
      [JSON.stringify(lengths)],
    );
    const bad = tooLong.rows[0];
    if (bad) {
      throw new NativeTextInputError(
        bad.column,
        filter,
        `native/text-input: '${bad.column}' is longer than ${bad.type} allows`,
      );
    }
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

function timestamptzColumn(model: ResourceModel, col: string): boolean {
  if (textInputCasts(model).has(col)) return false;
  const declared = model.columns[col]?.pg ?? storedColumnTypes(model).get(col);
  return declared !== undefined &&
    normalizePgType(declared) === "timestamp with time zone";
}

/** `value` bound as the value of `col` — `castPlaceholder` for a bound string, the plain bind otherwise.
 * A keyset cursor stores a `Date` through `JSON.stringify`, which signs years after 9999. PostgreSQL
 * accepts that instant only without the leading `+`. */
export function castBound(
  model: ResourceModel,
  col: string,
  value: unknown,
  bind: (value: unknown) => SQL,
): SQL {
  const spelled = typeof value === "string" && timestamptzColumn(model, col)
    ? spellPlusInstant(value) ?? value
    : value;
  const pg = typeof spelled === "string"
    ? textInputCasts(model).get(col)
    : undefined;
  return pg === undefined
    ? bind(spelled)
    : sql`${bind(spelled)}::text::${sql.raw(pg)}`;
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
