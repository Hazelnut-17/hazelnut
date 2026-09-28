import { z } from "zod";
import type { ResourceModel } from "./app.ts";

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
  const columnSchema = col === "id"
    ? m.idStrategy === "serial" ? z.number().int() : z.uuid()
    : col === "version" && m.features.versioning
    ? z.number().int()
    : m.schema.shape[col];
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
