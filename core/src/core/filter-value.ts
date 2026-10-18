import { z } from "zod";
import type { ResourceModel } from "./app.ts";
import { normalizePgType, parseCreateTables } from "../data/ddl-parse.ts";
import { strictify, wireJsonSchema } from "../data/schema-types.ts";
import { int4Input } from "../data/scalar-bounds.ts";
import { pgHasValueEquality } from "./native-equality.ts";

/** An int8 filter value as JSON carries it: an integer, or the decimal string the read doors emit. */
const INT8_FILTER = z.union([z.number().int(), z.string().regex(/^-?[0-9]+$/)]);

/** Resource lookup IDs must not reach a native uuid/int8 cast with malformed or overflowing text.
 * The uuidv7 text storage keeps its existing opaque-string lookup contract. */
export function validLookupId(model: ResourceModel, value: string): boolean {
  if (model.idStrategy === "uuidv4") return z.uuid().safeParse(value).success;
  if (model.idStrategy !== "serial") return true;
  if (value.length > 21 || !/^-?[0-9]+$/.test(value)) return false;
  const integer = BigInt(value);
  return integer >= -9223372036854775808n && integer <= 9223372036854775807n;
}

/** The parsed value of a JSON equality filter, or a refusal when the scalar does not match the column's
 *  declared Zod type. HTTP GET/QUERY and MCP list share this boundary before a value reaches SQL. */
export type DeclaredFilterValue =
  | { readonly success: true; readonly data: unknown }
  | { readonly success: false };

/** Validate and normalize one JSON filter scalar using its resource declaration. JSON has no Date scalar, so
 *  a valid string is also accepted when the field's declared schema accepts a `Date` (`z.date()`'s JSON face).
 *  The caller owns projection/allowlist validation; this function owns value typing only. */
export function parseDeclaredFilterValue(
  m: ResourceModel,
  col: string,
  value: unknown,
): DeclaredFilterValue {
  if (value !== null && typeof value === "object") return { success: false };
  const declaredSchema = filterValueSchema(m, col);
  const columnSchema = declaredSchema === undefined
    ? undefined
    : strictify(declaredSchema);
  if (columnSchema === undefined) return { success: false };

  let checked = z.safeParse(columnSchema, value);
  if (!checked.success && typeof value === "string") {
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) {
      checked = z.safeParse(columnSchema, date);
    }
  }
  return checked.success
    ? { success: true, data: checked.data }
    : { success: false };
}

/** Whether this stored type has equality over its values, rather than no operator or a size-only comparison.
 * Internal metadata/caller boundary; NULL predicates on typed ctx reads remain independent of equality. */
export function declaredFilterSupportsEquality(
  m: ResourceModel,
  col: string,
): boolean {
  const pg = m.columns[col]?.pg;
  return pg === undefined || pgHasValueEquality(pg);
}

/** Shared source of truth for equality typing and its published JSON scalar shape. */
function filterValueSchema(
  m: ResourceModel,
  col: string,
): z.ZodType | undefined {
  if (!declaredFilterSupportsEquality(m, col)) return undefined;
  const declared = m.schema.shape[col];
  return col === "id"
    ? m.idStrategy === "serial" ? INT8_FILTER : z.uuid()
    : col === "version" && m.features.versioning
    ? z.number().int()
    : declared
    ? m.columns[col]?.pg === "integer"
      ? int4Input(declared as z.ZodType)
      : declared as z.ZodType
    : physicalFilterSchema(m, col);
}

/** JSON carries authored bigint equality as decimal text. Structured columns cannot admit a scalar
 * except a declared nullable branch; intersect those shapes with the actual scalar-only transport. */
export function declaredFilterJsonSchema(
  m: ResourceModel,
  col: string,
): Record<string, unknown> {
  const schema = filterValueSchema(m, col);
  if (!schema) return { not: {} };
  const json = wireJsonSchema(schema, "input") as Record<string, unknown>;
  const scalar = (node: unknown): boolean => {
    if (!node || typeof node !== "object") return false;
    const value = node as Record<string, unknown>;
    if (
      ["string", "number", "integer", "boolean", "null"].includes(
        String(value.type),
      )
    ) return true;
    if (Array.isArray(value.type)) {
      return value.type.every((t) =>
        ["string", "number", "integer", "boolean", "null"].includes(String(t))
      );
    }
    return Array.isArray(value.anyOf) && value.anyOf.every(scalar);
  };
  return scalar(json) ? json : {
    allOf: [json, {
      anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, {
        type: "null",
      }],
    }],
  };
}

const physicalTables = new WeakMap<
  ResourceModel,
  ReturnType<typeof parseCreateTables>[number] | null
>();

/** A framework-minted column (timestamps, scope key, sequence, rollup, parent key) has no Zod declaration; its
 *  filter value is typed by the column the resource's own DDL creates. Other physical types stay refused. */
function physicalFilterSchema(
  m: ResourceModel,
  col: string,
): z.ZodType | undefined {
  let table = physicalTables.get(m);
  if (table === undefined) {
    table = parseCreateTables(m.ddl)[0] ?? null;
    physicalTables.set(m, table);
  }
  const raw = table?.columns.get(col);
  if (raw === undefined) return undefined;
  const type = normalizePgType(raw);
  if (type.endsWith("[]")) return undefined;
  const base = type.replace(/\(.*$/, "");
  const scalar = base === "uuid"
    ? z.uuid()
    : /^(?:text|varchar|char|character|bpchar|citext)$/.test(base)
    ? z.string()
    : base === "bigint"
    ? INT8_FILTER
    : base === "integer"
    ? int4Input(z.number().int())
    : base === "smallint"
    ? z.number().int().min(-32768).max(32767)
    : /^(?:numeric|real|double precision)$/.test(base)
    ? z.number()
    : base === "boolean"
    ? z.boolean()
    : /^(?:timestamp|date)/.test(base)
    ? z.date()
    : undefined;
  if (scalar === undefined) return undefined;
  return table?.notNull.get(col) ? scalar : scalar.nullable();
}
