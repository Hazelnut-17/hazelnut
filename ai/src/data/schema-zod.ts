import { z } from "zod";
// The zod-node shape and the wrapper-chain peeler both halves of the schema deriver read. A leaf: it
// knows nothing about pg types or DDL, and homing it in the deriver made the pair a cycle.

/** A captured `.default(<static>)` (03-api-shape.md §4): static literals only, plus the two blessed
 *  SQL sentinels `now()`/`gen_random_uuid()` passed through raw. `kind:"literal"` carries the JS value
 *  (rendered by `defaultClause`); `kind:"raw"` carries a verbatim SQL fragment. */
export type DefaultSpec = {
  readonly kind: "literal";
  readonly value: string | number | boolean;
} | { readonly kind: "raw"; readonly sql: string };

// The two SQL-side default sentinels canon blesses (03-api-shape.md §4 — `now()`/`gen_random_uuid()`),
// recognized when the declared default is the literal string `"now()"`/`"gen_random_uuid()"`.
const RAW_DEFAULT_SENTINELS = new Set(["now()", "gen_random_uuid()"]);

/** Capture a `.default(v)` value as a `DefaultSpec`, or `undefined` when the value is not a DDL-able
 *  static (the static-literals-only pin: a non-literal default is an app-side write-auto, never DDL). */
export function defaultSpecOf(value: unknown): DefaultSpec | undefined {
  if (typeof value === "string") {
    return RAW_DEFAULT_SENTINELS.has(value)
      ? { kind: "raw", sql: value }
      : { kind: "literal", value };
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return { kind: "literal", value };
  }
  return undefined; // null/object/array/function → not a static DDL literal; left to the app-side write-auto
}

interface ZCheck {
  readonly def?: { readonly format?: string };
  readonly _zod?: {
    readonly def?: {
      readonly format?: string;
      readonly check?: string;
      readonly maximum?: number;
    };
  };
}

interface ZDef {
  readonly type: string;
  readonly format?: string; // a string subtype's format discriminator — `z.uuid()`→"uuid", `z.iso.datetime()`→"datetime" (Zod-4 `def.format`)
  readonly checks?: readonly ZCheck[];
  readonly innerType?: ZType;
  readonly options?: readonly string[];
  readonly entries?: Record<string, string>;
  readonly defaultValue?: unknown; // a `.default(v)` wrapper's captured static value (Zod-4 stores the value, not a thunk)
}

export interface ZType {
  readonly def: ZDef;
}

/**
 * A string subtype's format, from BOTH homes Zod 4 gives it: top-level `def.format` (`z.uuid()`) and a
 * `string_format` check (`z.string().uuid()`). The two spellings declare one type, so every reader of a
 * format MUST come through here — a reader that consults only one home derives a different column for the
 * same declaration, silently. Pinned by `zod-reader-symmetry.test.ts` (both readers, both spellings).
 */
export function stringFormatOf(t: ZType): string | undefined {
  let format = t.def.format;
  for (const c of t.def.checks ?? []) {
    // Zod 4 stores a check's def under `_zod.def`, older shapes under `def` — accept either.
    const d = (c as { _zod?: { def?: ZCheckDefLike }; def?: ZCheckDefLike })
      ._zod?.def ?? (c as { def?: ZCheckDefLike }).def;
    if (d?.check === "string_format" && typeof d.format === "string") {
      format = d.format;
    }
  }
  return format;
}

/**
 * The format a string subtype carries ONLY when it was spelled the chained way (`z.string().uuid()`), i.e.
 * it lives in a `string_format` check and NOT in top-level `def.format`. `stringFormatOf` deliberately
 * cannot tell the two apart — that is its job — so the declaration guard that refuses the chained spelling
 * asks here instead. Returns undefined for the canonical top-level spelling.
 */
/**
 * The nullary top-level factory that spells `format`, or undefined when the format has only the chained
 * spelling. Both namespaces are CANDIDATES, never a first-match: `z.date` exists but builds a `ZodDate`,
 * and the string-format spelling is `z.iso.date()` — resolving on the name alone silently picked the wrong
 * one and let `z.string().date()` through. The predicate is what the call PRODUCES: a nullary string schema.
 */
function nullaryStringFactory(
  format: string,
): { readonly spelling: string } | undefined {
  const root = z as unknown as Record<string, unknown>;
  const iso = root.iso as Record<string, unknown> | undefined;
  const candidates: ReadonlyArray<readonly [string, unknown]> = [
    [`z.${format}()`, root[format]],
    [`z.iso.${format}()`, iso?.[format]],
  ];
  for (const [spelling, fn] of candidates) {
    if (typeof fn !== "function") continue;
    try {
      const made = (fn as () => unknown)() as { def?: { type?: string } };
      if (made?.def?.type === "string") return { spelling };
    } catch {
      // needs an argument — not a spelling of the same thing
    }
  }
  return undefined;
}

/**
 * The canonical top-level spelling of a string format, DERIVED from zod rather than listed. A refusal that
 * names a rewrite the reader cannot type is worse than none, and a hand-kept map of which namespace each
 * format lives in goes stale the first time zod moves one.
 */
export function canonicalFormatSpelling(format: string): string {
  return nullaryStringFactory(format)?.spelling ?? `z.${format}()`;
}

/**
 * The format a string subtype carries ONLY when it was spelled the chained way (`z.string().uuid()`), i.e.
 * it lives in a `string_format` check and NOT in top-level `def.format`. `stringFormatOf` deliberately
 * cannot tell the two apart — that is its job — so the declaration guard that refuses the chained spelling
 * asks here instead. Returns undefined for the canonical top-level spelling.
 */

export function chainedStringFormat(t: ZType): string | undefined {
  if (t.def.format !== undefined) return undefined;
  // Only a format with a NULLARY top-level factory is a wrong spelling of something. `z.string().regex(/…/)`
  // and its argument-taking siblings also land in a `string_format` check, but `z.regex()` needs that
  // argument — naming it as the rewrite would send the reader to a call they cannot make. A format with one
  // spelling has no wrong one.
  for (const c of t.def.checks ?? []) {
    const d = (c as { _zod?: { def?: ZCheckDefLike }; def?: ZCheckDefLike })
      ._zod?.def ?? (c as { def?: ZCheckDefLike }).def;
    if (
      d?.check === "string_format" && typeof d.format === "string" &&
      nullaryStringFactory(d.format) !== undefined
    ) {
      return d.format;
    }
  }
  return undefined;
}

interface ZCheckDefLike {
  readonly check?: string;
  readonly format?: unknown;
}

/** Peel `nullable` / `optional` / `default` wrappers to the base type, tracking nullability and the
 *  captured static default (the outermost `default` wins — that is the value the column gets). */
export function unwrap(
  s: ZType,
): { inner: ZType; nullable: boolean; default?: DefaultSpec } {
  let nullable = false;
  let dflt: DefaultSpec | undefined;
  let cur = s;
  while (
    cur.def.type === "nullable" || cur.def.type === "optional" ||
    cur.def.type === "default"
  ) {
    if (cur.def.type === "default") {
      if (dflt === undefined) dflt = defaultSpecOf(cur.def.defaultValue); // outermost default is the effective one
    } else {
      nullable = true;
    }
    cur = cur.def.innerType!;
  }
  return { inner: cur, nullable, default: dflt };
}
