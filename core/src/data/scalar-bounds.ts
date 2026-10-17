import { z } from "zod";
import { copySchemaAnnotations } from "./schema-types.ts";

/** The JSON and internal input range of the PostgreSQL int4 column the declaration derives. */
export const INT4_MIN = -2147483648;
export const INT4_MAX = 2147483647;

/** Tighten the number leaf without evaluating wrapper getters such as a lazy Zod default. */
export function int4Input(field: z.ZodType): z.ZodType {
  const def = field.def as typeof field.def & { innerType?: z.ZodType };
  if (def.type === "number") {
    return copySchemaAnnotations(
      field,
      (field as z.ZodNumber).int().min(INT4_MIN).max(INT4_MAX),
    );
  }
  if (!def.innerType) return field;
  const descriptors = Object.getOwnPropertyDescriptors(def);
  descriptors.innerType = {
    ...descriptors.innerType,
    value: int4Input(def.innerType),
  };
  return copySchemaAnnotations(
    field,
    field.clone(Object.defineProperties({ type: def.type }, descriptors)),
  );
}
