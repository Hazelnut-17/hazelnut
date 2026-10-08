// The read type of a `dbType()` column: the value the driver returns for its native type (03-api-shape.md §db-schema).
import type { z } from "zod";

declare const nativeType: unique symbol;

/** The phantom a `dbType()` field carries: its native type, readable by the read faces and nothing else. */
export interface NativeMark<P extends string> {
  readonly [nativeType]?: P;
}

type MarkOf<F> = F extends NativeMark<infer P> ? (string extends P ? never : P)
  : never;

/** The native type a field declares, through its nullable / optional / default wrappers. */
export type FieldNative<F> = [MarkOf<F>] extends [never] ? F extends
    | z.ZodNullable<infer I>
    | z.ZodOptional<infer I>
    | z.ZodDefault<infer I> ? FieldNative<I>
  : never
  : MarkOf<F>;

/** What the driver returns for a native type: `bytea` is bytes, `<type>[]` an array of its element. */
type NativeValue<P extends string> = P extends `${infer E}[]` ? NativeValue<E>[]
  : P extends `bytea${string}` ? Uint8Array
  : string;

/** Only the types whose driver value is not the declared string change: `bytea` and arrays. */
type ReadOf<V, P> = [P] extends [never] ? V
  : P extends `${string}[]` | `bytea${string}`
    ? NativeValue<P> | Extract<V, null | undefined>
  : V;

/** The read row of a schema: every `bytea` / array `dbType()` field typed as the value reads return. */
export type NativeRead<R, S> = S extends z.ZodObject<infer Shape> ? {
    [K in keyof R]: K extends keyof Shape ? ReadOf<R[K], FieldNative<Shape[K]>>
      : R[K];
  }
  : R;
