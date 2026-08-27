/**
 * `testCtx.arb`/`build` — derives a schema-valid `Insertable<R>` per `model.schema` (walks each field's
 * own zod type, re-parses; invalid never returns). `build` merges a caller patch on top and drops the
 * `status`-under-`transitions` subtraction. Deterministic per `(model, seed)`. 05-runtime.md §testctx.
 */

import type { ResourceModel } from "./app.ts";
import type { Features, InsertableFixture } from "./faces.ts";
// `data/schema-zod.ts` is a leaf (no imports), so the one shared format reader costs no value cycle.
import {
  stringFormatOf,
  type ZType as ZTypeForFormat,
} from "../data/schema-zod.ts";
import { didYouMean } from "./validation.ts";

/** Options for the fixture deriver. `seed` makes the (otherwise fixed) generated values reproducibly vary. */
export interface ArbOptions {
  readonly seed?: number;
}

// ── the zod internal `def` shapes we read (mirrors schema.ts's reader; kept local) ──────────
interface ZCheckDef {
  readonly check?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly value?: number;
  readonly inclusive?: boolean;
  readonly format?: string;
  readonly pattern?: unknown;
}
interface ZCheck {
  readonly _zod?: { readonly def?: ZCheckDef };
  readonly def?: ZCheckDef;
}
interface ZDef {
  readonly type: string;
  readonly format?: string;
  readonly checks?: readonly ZCheck[];
  readonly innerType?: ZType;
  readonly element?: ZType;
  readonly valueType?: ZType;
  readonly keyType?: ZType;
  readonly items?: readonly ZType[];
  readonly options?: readonly unknown[];
  readonly entries?: Record<string, string>;
  readonly defaultValue?: unknown;
  readonly shape?: Record<string, ZType>;
}
interface ZType {
  readonly def: ZDef;
}

/** Peel `optional` / `nullable` / `default` wrappers to the base type (mirrors schema.ts `unwrap`). The
 *  fixture fills even optional fields (a maximal-but-valid record is the most useful default fixture). */
function unwrap(s: ZType): ZType {
  let cur = s;
  while (
    cur.def.type === "optional" || cur.def.type === "nullable" ||
    cur.def.type === "default"
  ) {
    cur = cur.def.innerType!;
  }
  return cur;
}

/** The check def, robust to Zod-4 storing it under either `_zod.def` or `def`. */
function checkOf(c: ZCheck): ZCheckDef | undefined {
  return c._zod?.def ?? c.def;
}

/** A tiny deterministic LCG so `(model, seed)` reproduces a fixture; never `Math.random` (non-deterministic). */
function makeRng(seed: number): () => number {
  let state = (seed | 0) ^ 0x9e3779b9;
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

/** Generate a deterministic valid value for one unwrapped zod type, honoring its format + range checks. */
function valueFor(t: ZType, rng: () => number, counter: number): unknown {
  switch (t.def.type) {
    case "string":
      return stringValue(t, counter);
    case "number":
      return numberValue(t, rng);
    case "bigint":
      return BigInt(1 + Math.floor(rng() * 1000));
    case "boolean":
      return rng() < 0.5;
    case "date":
      // a fixed-epoch + counter offset → deterministic, distinct-per-field instants.
      return new Date(Date.UTC(2024, 0, 1) + counter * 86_400_000);
    case "enum": {
      const opts = (t.def.options ??
        Object.values(t.def.entries ?? {})) as readonly string[];
      return opts.length > 0
        ? opts[Math.floor(rng() * opts.length) % opts.length]
        : undefined;
    }
    case "union": {
      // first arm — a rng pick would make the same seed land on different shapes across zod versions
      const arms = (t.def.options ?? []) as readonly ZType[];
      return arms[0]
        ? valueFor(unwrap(arms[0]), rng, counter)
        : `fixture-${counter}`;
    }
    case "tuple": {
      const items = t.def.items ?? [];
      return items.map((it, i) => valueFor(unwrap(it), rng, counter + i));
    }
    case "array": {
      const el = t.def.element;
      if (!el) return [];
      return Array.from(
        { length: arrayMin(t) },
        (_, i) => valueFor(unwrap(el), rng, counter + i),
      );
    }
    case "object": {
      const shape = t.def.shape ?? {};
      const out: Record<string, unknown> = {};
      let i = 0;
      for (const [k, v] of Object.entries(shape)) {
        out[k] = valueFor(unwrap(v), rng, counter + ++i);
      }
      return out;
    }
    case "record":
    case "map": {
      const vt = t.def.valueType;
      return {
        key: vt ? valueFor(unwrap(vt), rng, counter) : `fixture-${counter}`,
      };
    }
    case "literal":
      // a single-value literal carries its value in `def.values[0]` (Zod-4) — round-tripped via parse below.
      return (t.def as unknown as { values?: readonly unknown[] }).values?.[0];
    default:
      // the long tail (custom / dbType / json) — a plain string is the safest universal seed; `parse` is the gate.
      return `fixture-${counter}`;
  }
}

/** `z.array(…).min(n)` lives in a check, not on `def` — a one-element default fails the parse. */
function arrayMin(t: ZType): number {
  let min = 1;
  for (const c of t.def.checks ?? []) {
    const d = checkOf(c);
    if (d?.check === "min_length" && typeof d.minimum === "number") {
      min = Math.max(min, d.minimum);
    }
  }
  return min;
}

/** The regex a `z.string().regex()` / `money()` field carries — Zod 4 stores it on the check, not `def`. */
function regexOf(t: ZType): RegExp | undefined {
  for (const c of t.def.checks ?? []) {
    const d = checkOf(c);
    if (d?.format === "regex" && d.pattern instanceof RegExp) return d.pattern;
  }
}

/**
 * A string the pattern accepts. The supported subset is what the harness actually declares
 * (`money()`'s decimal, character classes, `\d`/`\w`, `{n,m}`, groups) — a general regex
 * solver is out of scope; an unsupported pattern returns undefined and the parse loop fails loud.
 */
function stringFromRegex(re: RegExp, counter: number): string | undefined {
  const src = re.source;
  const body = src.replace(/^\^/, "").replace(/\$$/, "");
  const out = emitRegex(body, counter);
  return out !== undefined && re.test(out) ? out : undefined;
}

function emitRegex(src: string, counter: number): string | undefined {
  let i = 0;
  const digit = (n: number) => String((counter + n) % 10);
  const word = (n: number) => String.fromCharCode(97 + ((counter + n) % 26));
  function atom(): string | undefined {
    if (i >= src.length) return undefined;
    const ch = src[i]!;
    if (ch === "\\") {
      i++;
      const n = src[i++];
      if (n === "d") return digit(i);
      if (n === "w") return word(i);
      if (n === "s") return " ";
      return n ?? "";
    }
    if (ch === "[") {
      const close = src.indexOf("]", i + 1);
      if (close < 0) return undefined;
      const cls = src.slice(i + 1, close);
      i = close + 1;
      return classChar(cls, counter);
    }
    if (ch === "(") {
      i++;
      const inner = seq();
      if (src[i] === ")") i++;
      return inner;
    }
    if (
      ch === ")" || ch === "|" || ch === "?" || ch === "*" || ch === "+" ||
      ch === "{"
    ) {
      return undefined;
    }
    i++;
    return ch;
  }
  function quantified(piece: string): string {
    if (src[i] === "?") {
      i++;
      return counter % 2 === 0 ? "" : piece;
    }
    if (src[i] === "+") {
      i++;
      return piece;
    }
    if (src[i] === "*") {
      i++;
      return "";
    }
    if (src[i] === "{") {
      const close = src.indexOf("}", i + 1);
      if (close < 0) return piece;
      const spec = src.slice(i + 1, close);
      i = close + 1;
      const [lo] = spec.split(",").map((x) => Number(x));
      const n = Number.isFinite(lo) ? Math.max(1, lo ?? 1) : 1;
      return piece.repeat(n);
    }
    return piece;
  }
  function seq(): string {
    let out = "";
    while (i < src.length && src[i] !== ")" && src[i] !== "|") {
      const a = atom();
      if (a === undefined) break;
      out += quantified(a);
    }
    if (src[i] === "|") {
      // first alternative only — same reason as union: one seed, one shape
      while (i < src.length && src[i] !== ")") i++;
    }
    return out;
  }
  const emitted = seq();
  return i <= src.length ? emitted : undefined;
}

function classChar(cls: string, counter: number): string {
  if (cls.startsWith("^")) return "x";
  const az = cls.match(/([A-Za-z])-([A-Za-z])/);
  if (az) {
    const lo = az[1]!.charCodeAt(0);
    const hi = az[2]!.charCodeAt(0);
    return String.fromCharCode(lo + (counter % (hi - lo + 1)));
  }
  const digits = cls.match(/(\d)-(\d)/);
  if (digits) {
    const lo = Number(digits[1]);
    const hi = Number(digits[2]);
    return String(lo + (counter % (hi - lo + 1)));
  }
  return cls[0] ?? "x";
}

/** A string honoring its format (email/url/uuid/datetime) and min/max length checks. Deterministic. */
function stringValue(t: ZType, counter: number): string {
  // Both of zod's homes for a format, through the one reader every format consumer shares — the DDL
  // deriver read only `def.format` and silently derived `text` for the chained spelling.
  const format = stringFormatOf(t as unknown as ZTypeForFormat);
  switch (format) {
    case "email":
      return `fixture${counter}@example.test`;
    case "url":
      return `https://example.test/${counter}`;
    case "uuid":
    case "guid":
      // a fixed valid uuid template with the counter folded into the tail — stable + schema-valid.
      return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
    case "datetime":
      return new Date(Date.UTC(2024, 0, 1) + counter * 86_400_000)
        .toISOString();
    case "regex": {
      // `money()` is a branded string + regex; a `fixture-N` fails it and the bounded search
      // retries the same unsatisfiable shape. Emit from the pattern or the parse loop is vacuous.
      const re = regexOf(t);
      const emitted = re ? stringFromRegex(re, counter) : undefined;
      if (emitted !== undefined) return emitted;
      break;
    }
  }
  let min = 1;
  let max = 24;
  for (const c of t.def.checks ?? []) {
    const d = checkOf(c);
    if (d?.check === "min_length" && typeof d.minimum === "number") {
      min = Math.max(min, d.minimum);
    }
    if (d?.check === "max_length" && typeof d.maximum === "number") {
      max = d.maximum;
    }
  }
  const base = `fixture-${counter}`;
  if (base.length < min) return base + "x".repeat(min - base.length);
  if (base.length > max) return base.slice(0, max);
  return base;
}

/** A number honoring `.int()` and greater_than/less_than bounds. Deterministic via the seeded rng. */
function numberValue(t: ZType, rng: () => number): number {
  let lo = 0;
  let hi = 1000;
  let isInt = false;
  for (const c of t.def.checks ?? []) {
    const d = checkOf(c);
    if (d?.format === "safeint") isInt = true;
    if (d?.check === "greater_than" && typeof d.value === "number") {
      lo = d.inclusive ? d.value : d.value + (isInt ? 1 : 0.001);
    }
    if (d?.check === "less_than" && typeof d.value === "number") {
      hi = d.inclusive ? d.value : d.value - (isInt ? 1 : 0.001);
    }
  }
  if (hi < lo) hi = lo;
  const v = lo + rng() * (hi - lo);
  return isInt ? Math.round(v) : v;
}

/** The user-schema fields the faces subtract from `Insertable` (never carried in the fixture). Framework-
 *  added columns are never in the user schema; the only schema field subtracted is `status` under `transitions`. */
function subtractedSchemaFields(model: ResourceModel): ReadonlySet<string> {
  const out = new Set<string>();
  if (Object.keys(model.transitions ?? {}).length > 0) out.add("status"); // sole writer is ctx.transition
  return out;
}

/** The bounded search width for a `z.refine`/cross-field constraint — each retry re-derives with a varied
 *  seed; exhausting it loud-fails naming the resource, never a bare ZodError (05-runtime.md §testCtx). */
const MAX_DERIVE_ATTEMPTS = 32;

/**
 * A deterministic, schema-valid `Insertable<R>` fixture for `model` — every field derives from its own zod
 * type, re-validated through `model.schema`; loud-fails (never a bare ZodError) if unsatisfiable within the
 * bounded seed search. 05-runtime.md §testCtx.
 */
/** Advances when the caller omits `{seed}` so two `arb()` calls in one test do not
 *  collide on a `unique` column — an explicit seed stays the reproducibility door. */
let unseededCalls = 0;

export function arb<R = Record<string, unknown>, F extends Features = Features>(
  model: ResourceModel,
  opts?: ArbOptions,
): InsertableFixture<R, F> {
  const shape =
    (model.schema as unknown as { shape: Record<string, ZType> }).shape;
  const baseSeed = opts?.seed ?? ++unseededCalls;
  let lastIssue = "";
  for (let attempt = 0; attempt < MAX_DERIVE_ATTEMPTS; attempt++) {
    // vary the seed per attempt (attempt 0 keeps the caller's seed exactly — determinism for the common case)
    const rng = makeRng(baseSeed + attempt * 7919);
    const raw: Record<string, unknown> = {};
    // seed is in the counter so a string format (email/uuid) that does not read the
    // rng still differs across unseeded calls — unique columns otherwise collide
    let counter = 1 + attempt + baseSeed;
    for (const [name, field] of Object.entries(shape)) {
      raw[name] = valueFor(unwrap(field), rng, counter++);
    }
    // The schema is the guarantee: a fixture that does not satisfy the declared schema is never returned.
    const parsed = model.schema.safeParse(raw);
    if (!parsed.success) {
      lastIssue = parsed.error.issues.map((i) =>
        `${i.path.join(".") || "(root)"}: ${i.code}`
      ).join("; ");
      continue;
    }
    const subtract = subtractedSchemaFields(model);
    const out: Record<string, unknown> = {};
    for (
      const [k, v] of Object.entries(parsed.data as Record<string, unknown>)
    ) {
      if (!subtract.has(k)) out[k] = v;
    }
    return out as InsertableFixture<R, F>;
  }
  throw new Error(
    `testCtx.arb('${model.name}'): could not derive a schema-valid Insertable in ${MAX_DERIVE_ATTEMPTS} attempts (last: ${lastIssue}) — a z.refine/cross-field constraint is narrower than the generator's search; supply the constrained fields via build('${model.name}', { … }) overrides`,
  );
}

/**
 * `arb(model)` with a caller patch shallow-merged on top, re-validated through `model.schema` (loud-fails
 * naming the resource + paths on break). An explicit override of a subtracted field (e.g. `status`) survives.
 */
export function build<
  R = Record<string, unknown>,
  F extends Features = Features,
>(
  model: ResourceModel,
  overrides?: Partial<InsertableFixture<R, F>>,
  opts?: ArbOptions,
): InsertableFixture<R, F> {
  const shape =
    (model.schema as unknown as { shape: Record<string, ZType> }).shape;
  const known = Object.keys(shape);
  for (const k of Object.keys(overrides ?? {})) {
    if (k in shape) continue;
    // a parent-FK / pass-through key is far from every schema field; a typo is close — that
    // split is the API surface's own did-you-mean, reused so a generator does not invent a second
    const hint = didYouMean(k, known);
    if (hint) {
      throw new Error(
        `testCtx.build('${model.name}'): unknown override '${k}' — did you mean '${hint}'?`,
      );
    }
  }
  const base = arb<R, F>(model, opts) as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...base, ...(overrides ?? {}) };
  const schemaOwned: Record<string, unknown> = {};
  const passThrough: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(merged)) {
    if (k in shape) schemaOwned[k] = v;
    else passThrough[k] = v;
  }
  const parsed = model.schema.safeParse(schemaOwned);
  if (!parsed.success) {
    const paths = parsed.error.issues.map((i) =>
      `${i.path.join(".") || "(root)"}: ${i.code}`
    ).join("; ");
    throw new Error(
      `testCtx.build('${model.name}'): overrides break the declared schema — ${paths}`,
    );
  }
  const out = { ...(parsed.data as Record<string, unknown>), ...passThrough };
  // parse fills schema defaults for absent keys, which must not resurrect a subtracted field the caller
  // did not override (a defaulted `status` would defeat the Insertable subtraction); an override stays.
  for (const k of subtractedSchemaFields(model)) {
    if (!(k in (overrides ?? {})) && k in out) delete out[k];
  }
  return out as InsertableFixture<R, F>;
}
