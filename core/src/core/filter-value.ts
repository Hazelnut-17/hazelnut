import { z } from "zod";
import type { ResourceModel } from "./app.ts";
import { normalizePgType, parseCreateTables } from "../data/ddl-parse.ts";
import { strictify } from "../data/schema-types.ts";

/** An int8 filter value as JSON carries it: an integer, or the decimal string the read doors emit. */
const INT8_FILTER = z.union([z.number().int(), z.string().regex(/^-?[0-9]+$/)]);

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
  const declared = m.schema.shape[col];
  const columnSchema = col === "id"
    ? m.idStrategy === "serial" ? INT8_FILTER : z.uuid()
    : col === "version" && m.features.versioning
    ? z.number().int()
    : declared
    ? strictify(declared as z.ZodType)
    : physicalFilterSchema(m, col);
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
    : /^(?:smallint|integer)$/.test(base)
    ? z.number().int()
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
