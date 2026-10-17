import type { z } from "zod";

/** The type-level twin of schema-zod.unwrap: optional/nullable nodes witness SQL NULL even beneath
 * transparent wrappers. An explicit database default alone never makes a column nullable. */
type ColumnAllowsNull<S> = S extends {
  readonly def: { readonly type: "optional" | "exact_optional" | "nullable" };
} ? true
  : S extends {
    readonly def: {
      readonly type: "default" | "prefault" | "readonly" | "nonoptional";
      readonly innerType: infer Inner;
    };
  } ? ColumnAllowsNull<Inner>
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
