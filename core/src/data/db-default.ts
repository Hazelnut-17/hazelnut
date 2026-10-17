import type { z } from "zod";
import type { DefaultSpec } from "./schema-zod.ts";

/** Explicit storage default. This brand changes resource create omission, never Zod input/output. */
declare const DB_DEFAULT_SCHEMA: unique symbol;
export type DbDefaultMark = { readonly [DB_DEFAULT_SCHEMA]: true };
export type KnownSqlDefault =
  | Readonly<{ sql: "now()" }>
  | Readonly<{ sql: "gen_random_uuid()" }>;

type BaseSchema<S> = S extends { readonly def: { readonly innerType: infer I } }
  ? BaseSchema<I>
  : S;
type DbLiteralFor<S extends z.ZodType> = Extract<
  z.output<S>,
  string | number | boolean
>;
type KnownSqlDefaultFor<S> = BaseSchema<S> extends z.ZodDate
  ? Readonly<{ sql: "now()" }>
  : BaseSchema<S> extends z.ZodUUID ? Readonly<{ sql: "gen_random_uuid()" }>
  : never;
type HasDbDefault<S> = S extends DbDefaultMark ? true
  : S extends { readonly def: { readonly innerType: infer I } }
    ? HasDbDefault<I>
  : false;
export type DbDefaultKeys<S extends z.ZodType> = S extends
  z.ZodObject<infer Shape> ? {
    [K in keyof Shape]: HasDbDefault<Shape[K]> extends true ? K : never;
  }[keyof Shape]
  : never;
export type ResourceCreateInput<S extends z.ZodType> =
  & Omit<z.input<S>, Extract<DbDefaultKeys<S>, keyof z.input<S>>>
  & Partial<Pick<z.input<S>, Extract<DbDefaultKeys<S>, keyof z.input<S>>>>;

const MARK = Symbol("hazelnut.db-default");
const defaults = new WeakMap<object, DefaultSpec>();
type AnnotationCopy = <T extends z.ZodType>(from: z.ZodType, to: T) => T;
let copyAnnotations: AnnotationCopy | undefined;
/** Internal annotation bridge avoids a schema-types → schema-zod → marker import cycle. */
export function registerDbDefaultAnnotationCopy(copy: AnnotationCopy): void {
  copyAnnotations = copy;
}

function ownData(value: unknown, key: PropertyKey): unknown {
  if (value === null || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
function definition(schema: unknown): object | undefined {
  const def = ownData(schema, "def");
  return def !== null && typeof def === "object" ? def : undefined;
}
const WRAPPERS = new Set([
  "optional",
  "exact_optional",
  "nullable",
  "default",
  "prefault",
  "readonly",
  "nonoptional",
]);
function nextSchema(def: object): unknown {
  return ownData(def, "type") === "pipe"
    ? ownData(def, "in")
    : ownData(def, "innerType");
}
function same(a: DefaultSpec, b: DefaultSpec): boolean {
  return a.kind === "literal" && b.kind === "literal"
    ? Object.is(a.value, b.value)
    : a.kind === "raw" && b.kind === "raw" && a.sql === b.sql;
}
function tokenOf(schema: unknown): object | undefined {
  const def = definition(schema);
  const token = def && ownData(def, MARK);
  return token !== null && typeof token === "object" && defaults.has(token)
    ? token
    : undefined;
}

/** Registered data tokens only; application default accessors are never read. */
export function dbDefaultOf(
  field: unknown,
  where = "column",
): DefaultSpec | undefined {
  let found: DefaultSpec | undefined;
  const seen = new Set<object>();
  let current = field;
  while (
    current !== null && typeof current === "object" && !seen.has(current)
  ) {
    seen.add(current);
    const token = tokenOf(current);
    const spec = token && defaults.get(token);
    if (spec) {
      if (found && !same(found, spec)) {
        throw new Error(
          `db-default/conflict: '${where}' carries conflicting explicit database defaults`,
        );
      }
      found = spec;
    }
    const def = definition(current);
    if (!def) break;
    current = nextSchema(def);
  }
  return found;
}

function cloneMarked<T extends z.ZodType>(schema: T, token: object): T {
  const def = definition(schema);
  if (!def) {
    throw new Error(
      "db-default/compatibility: expected a supported Zod column schema",
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(def);
  Reflect.deleteProperty(descriptors, MARK);
  // Preserve the lazy Zod default accessor rather than reading it through a definition spread.
  const markedDef = Object.create(Object.getPrototypeOf(def), descriptors);
  Object.defineProperty(markedDef, MARK, { value: token, enumerable: true });
  const cloned = schema.clone(markedDef, { parent: true });
  return copyAnnotations ? copyAnnotations(schema, cloned) : cloned;
}

/** Copy onto a new boundary node without mutating a shared original definition or schema. */
export function copyDbDefaultMark<T extends z.ZodType>(
  from: unknown,
  to: T,
): T {
  const spec = dbDefaultOf(from);
  if (!spec || from === to) return to;
  const existing = dbDefaultOf(to);
  if (existing) {
    if (!same(existing, spec)) {
      throw new Error(
        "db-default/conflict: a schema clone carries conflicting explicit database defaults",
      );
    }
    return to;
  }
  const token = Object.freeze({});
  defaults.set(token, spec);
  return cloneMarked(to, token);
}

type InputKind = "defaulted" | "optional" | undefined;
/** Mirror Zod's undefined-input routing without reading its lazy default or input metadata. */
function inputKind(field: unknown, seen = new Set<object>()): InputKind {
  if (field === null || typeof field !== "object" || seen.has(field)) {
    return undefined;
  }
  seen.add(field);
  const def = definition(field);
  if (!def) return undefined;
  const kind = ownData(def, "type");
  if (kind === "default" || kind === "prefault") return "defaulted";
  if (kind === "nonoptional") return undefined;
  if (kind === "optional" || kind === "exact_optional") {
    return inputKind(nextSchema(def), seen) === "defaulted"
      ? "defaulted"
      : "optional";
  }
  return kind === "nullable" || kind === "readonly" || kind === "pipe"
    ? inputKind(nextSchema(def), seen)
    : undefined;
}

/** Effective application-default witness; optional wrappers can short-circuit a hidden default. */
export function hasApplicationDefault(field: unknown): boolean {
  const seen = new Set<object>();
  let current = field;
  while (
    current !== null && typeof current === "object" && !seen.has(current)
  ) {
    seen.add(current);
    const def = definition(current);
    if (!def) return false;
    const kind = ownData(def, "type");
    if (kind === "default" || kind === "prefault") return true;
    if (
      (kind === "optional" || kind === "exact_optional") &&
      inputKind(nextSchema(def)) !== "defaulted"
    ) return false;
    if (
      kind !== "optional" && kind !== "exact_optional" &&
      kind !== "nullable" && kind !== "readonly" &&
      kind !== "nonoptional" && kind !== "pipe"
    ) return false;
    current = nextSchema(def);
  }
  return false;
}
/** Whether an absent key is structurally accepted, without probing isOptional()/parse(undefined). */
export function isStructurallyOptional(field: unknown): boolean {
  return inputKind(field) !== undefined || hasApplicationDefault(field);
}

function normalize(value: unknown): DefaultSpec {
  if (typeof value === "string" || typeof value === "boolean") {
    return Object.freeze({ kind: "literal", value });
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return Object.freeze({ kind: "literal", value });
  }
  if (value !== null && typeof value === "object") {
    const keys = Reflect.ownKeys(value);
    const sql = ownData(value, "sql");
    const proto = Object.getPrototypeOf(value);
    if (
      keys.length === 1 && keys[0] === "sql" &&
      (proto === Object.prototype || proto === null) &&
      (sql === "now()" || sql === "gen_random_uuid()")
    ) {
      return Object.freeze({ kind: "raw", sql });
    }
  }
  throw new Error(
    "db-default/value: use a finite string/number/boolean literal or the exact data object { sql: 'now()' | 'gen_random_uuid()' }; callbacks, accessors and arbitrary SQL are not database defaults",
  );
}

/** Static storage compatibility only; never invokes a parser, refinement, default getter or lazy getter. */
export function assertDbDefaultCompatible(
  field: unknown,
  pg?: string,
  where = "column",
): void {
  const spec = dbDefaultOf(field, where);
  if (!spec) return;
  const refuse = (reason: string): never => {
    throw new Error(
      `db-default/compatibility: '${where}' ${reason}; use a compatible explicit database default or an application .default(...)`,
    );
  };
  let current = field;
  const seen = new Set<object>();
  let base: object | undefined;
  while (
    current !== null && typeof current === "object" && !seen.has(current)
  ) {
    seen.add(current);
    const def = definition(current);
    if (!def) return refuse("is not a supported column schema");
    if (ownData(def, "coerce") === true) {
      return refuse(
        "cannot materialize a database default through coercion",
      );
    }
    for (const check of (ownData(def, "checks") ?? []) as readonly unknown[]) {
      const checkDef = ownData(ownData(check, "_zod"), "def") ??
        ownData(check, "def");
      if (ownData(checkDef, "check") === "overwrite") {
        return refuse(
          "cannot materialize a database default through overwrite",
        );
      }
    }
    const kind = ownData(def, "type");
    if (typeof kind === "string" && WRAPPERS.has(kind)) {
      current = ownData(def, "innerType");
      continue;
    }
    if (
      kind !== "string" && kind !== "enum" && kind !== "number" &&
      kind !== "boolean" && kind !== "date"
    ) {
      return refuse(
        `uses unsupported '${String(kind)}' input/output structure`,
      );
    }
    base = def;
    break;
  }
  if (!base) return refuse("has a cyclic or unsupported column wrapper");
  const kind = ownData(base, "type");
  const actualPg = pg?.trim().toLowerCase().replace(/\s+/g, " ");
  if (spec.kind === "raw") {
    if (spec.sql === "now()") {
      if (
        kind !== "date" ||
        (actualPg !== undefined && actualPg !== "timestamptz" &&
          actualPg !== "timestamp with time zone")
      ) {
        return refuse(
          "SQL now() requires z.date() stored as timestamptz, not ISO text or a native override",
        );
      }
    } else {
      const format = ownData(base, "format");
      const version = ownData(base, "version");
      if (
        kind !== "string" || format !== "uuid" ||
        (version !== undefined && version !== "v4") ||
        (actualPg !== undefined && actualPg !== "uuid")
      ) {
        return refuse(
          "SQL gen_random_uuid() requires a UUID schema accepting v4 stored as uuid",
        );
      }
    }
    return;
  }
  const value = spec.value;
  if (kind === "enum") {
    const entries = ownData(base, "entries");
    const options = ownData(base, "options") ??
      (entries && typeof entries === "object" ? Object.values(entries) : []);
    if (
      typeof value !== "string" ||
      !(options as readonly unknown[]).includes(value)
    ) return refuse("literal is not a declared enum value");
  } else if (
    (kind === "string" && typeof value !== "string") ||
    (kind === "number" && typeof value !== "number") ||
    (kind === "boolean" && typeof value !== "boolean") || kind === "date"
  ) {
    return refuse("literal does not match the column's primitive input type");
  }
  if (actualPg !== undefined) {
    const numberPg =
      /^(?:smallint|integer|int2|int4|int|double precision|real|float4|float8|numeric(?:\([^)]*\))?|decimal(?:\([^)]*\))?)$/;
    const textPg =
      /^(?:text|citext|varchar(?:\([0-9]+\))?|character varying(?:\([0-9]+\))?|char(?:\([0-9]+\))?|character(?:\([0-9]+\))?)$/;
    if (
      (typeof value === "number" && !numberPg.test(actualPg)) ||
      (typeof value === "boolean" && actualPg !== "boolean" &&
        actualPg !== "bool") ||
      (typeof value === "string" && !textPg.test(actualPg) &&
        actualPg !== "uuid" && actualPg !== "timestamptz" &&
        actualPg !== "timestamp with time zone")
    ) {
      return refuse(
        "literal is incompatible with the declared PostgreSQL storage type",
      );
    }
    if (
      typeof value === "number" &&
      /^(?:smallint|integer|int2|int4|int)$/.test(actualPg)
    ) {
      const min = /^(?:smallint|int2)$/.test(actualPg) ? -32768 : -2147483648;
      const max = /^(?:smallint|int2)$/.test(actualPg) ? 32767 : 2147483647;
      if (!Number.isInteger(value) || value < min || value > max) {
        return refuse("integer literal is outside its storage range");
      }
    }
  }
}

/** Mark a cloned column with an explicit database default; standalone Zod parsing is unchanged. */
export function dbDefault<S extends z.ZodType>(
  schema: S,
  value: DbLiteralFor<S> | KnownSqlDefaultFor<S>,
): S & DbDefaultMark {
  const spec = normalize(value);
  const previous = dbDefaultOf(schema);
  if (previous && !same(previous, spec)) {
    throw new Error(
      "db-default/conflict: a column carries conflicting explicit database defaults",
    );
  }
  const token = Object.freeze({});
  defaults.set(token, spec);
  const marked = cloneMarked(schema, token);
  assertDbDefaultCompatible(marked);
  return marked as S & DbDefaultMark;
}
