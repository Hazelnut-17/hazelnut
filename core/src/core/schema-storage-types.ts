import type { z } from "zod";

/** The type-level twin of schema-zod.unwrap: only optional/nullable/default wrappers affect SQL NULL. */
type ColumnAllowsNull<S> = S extends z.ZodOptional | z.ZodNullable ? true
  : S extends z.ZodDefault<infer Inner> ? ColumnAllowsNull<Inner>
  : false;

export type SchemaNullableKeys<S extends z.ZodType> = S extends
  z.ZodObject<infer Shape> ?
    & {
      [K in keyof Shape]: ColumnAllowsNull<Shape[K]> extends true ? K : never;
    }[keyof Shape]
    & keyof z.output<S>
  : never;

/** A raw record has erased schema wrappers; its optional keys are the remaining nullable witness. */
export type OptionalStorageKeys<R> = {
  [K in keyof R]-?: undefined extends R[K] ? K : never;
}[keyof R];
