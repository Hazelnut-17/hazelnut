/**
 * `testCtx.arb`/`build` — derives a schema-valid `Insertable<R>` per `model.schema` (walks each field's
 * own zod type, re-parses; invalid never returns). `build` supplies a caller patch before deriving the rest and drops the
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
import { dbTypeOf } from "../data/schema-types.ts";

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
  readonly length?: number;
  readonly prefix?: string;
  readonly suffix?: string;
  readonly includes?: string;
}
interface ZCheck {
  readonly _zod?: { readonly def?: ZCheckDef };
  readonly def?: ZCheckDef;
}
interface ZDef {
  readonly type: string;
  readonly format?: string;
  readonly version?: string;
  readonly precision?: number | null;
  readonly enc?: string;
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
function valueForField(t: ZType, rng: () => number, counter: number): unknown {
  return valueFor(unwrap(t), rng, counter, dbTypeOf(t));
}

function valueFor(
  t: ZType,
  rng: () => number,
  counter: number,
  pg?: string,
): unknown {
  switch (t.def.type) {
    case "string":
      return stringValue(t, counter, pg);
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
        ? valueForField(arms[0], rng, counter)
        : `fixture-${counter}`;
    }
    case "tuple": {
      const items = t.def.items ?? [];
      return items.map((it, i) => valueForField(it, rng, counter + i));
    }
    case "array": {
      const el = t.def.element;
      if (!el) return [];
      return Array.from(
        { length: arrayMin(t) },
        (_, i) => valueForField(el, rng, counter + i),
      );
    }
    case "object": {
      const shape = t.def.shape ?? {};
      const out: Record<string, unknown> = {};
      let i = 0;
      for (const [k, v] of Object.entries(shape)) {
        out[k] = valueForField(v, rng, counter + ++i);
      }
      return out;
    }
    case "record":
    case "map": {
      const vt = t.def.valueType;
      return {
        key: vt ? valueForField(vt, rng, counter) : `fixture-${counter}`,
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
    if (d?.check === "max_length" && typeof d.maximum === "number") {
      min = Math.min(min, d.maximum);
    }
    if (d?.check === "length_equals" && typeof d.length === "number") {
      min = d.length;
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

/** The pinned built-in format's seed. Options remain schema-validated; custom constraints use build. */
function formatValue(t: ZType, counter: number): string | undefined {
  // Both of zod's homes for a format, through the one reader every format consumer shares — the DDL
  // deriver read only `def.format` and silently derived `text` for the chained spelling.
  const format = t.def.format ?? stringFormatOf(t as unknown as ZTypeForFormat);
  const digits = String(Math.abs(counter)).padStart(12, "0").slice(-12);
  const hex = Math.abs(counter).toString(16).padStart(12, "0").slice(-12);
  const date = new Date(Date.UTC(2024, 0, 1) + counter * 86_400_000);
  switch (format) {
    case "email":
      return `fixture${counter}@example.test`;
    case "url":
      return `https://example.test/${counter}`;
    case "uuid":
    case "guid":
      // a fixed valid uuid template with the counter folded into the tail — stable + schema-valid.
      return `00000000-0000-${
        (t.def.version ?? "v4").slice(-1)
      }000-8000-${hex}`;
    case "date":
      return date.toISOString().slice(0, 10);
    case "datetime": {
      const precision = t.def.precision;
      const stamp = date.toISOString().slice(0, 19);
      return precision === -1
        ? `${stamp.slice(0, 16)}Z`
        : precision === 0
        ? `${stamp}Z`
        : `${stamp}.${"0".repeat(precision ?? 3)}Z`;
    }
    case "time": {
      const precision = t.def.precision;
      return precision === -1
        ? "12:00"
        : precision === 0
        ? "12:00:00"
        : `12:00:00.${"0".repeat(precision ?? 3)}`;
    }
    case "duration":
      return `P${Math.abs(counter) + 1}D`;
    case "ipv4":
      return `203.0.113.${Math.abs(counter) % 254 + 1}`;
    case "ipv6":
      return `2001:db8::${(Math.abs(counter) % 65535).toString(16)}`;
    case "cidrv4":
      return "203.0.113.0/24";
    case "cidrv6":
      return "2001:db8::/32";
    case "mac":
      return `02:00:00:${hex.slice(-6).match(/../g)!.join(":")}`;
    case "hostname":
      return `fixture${digits}.example.test`;
    case "e164":
      return `+1${digits}`;
    case "emoji":
      return "😀";
    case "base64":
      return btoa(`fixture-${counter}`);
    case "base64url":
      return btoa(`fixture-${counter}`).replaceAll("=", "");
    case "hex":
      return hex;
    case "nanoid":
      return `fixture${digits}xx`;
    case "cuid":
      return `c${digits}`;
    case "cuid2":
      return `fixture${digits}`;
    case "ulid":
      return `00000000000000${digits}`;
    case "ksuid":
      return `000000000000000${digits}`;
    case "xid":
      return `00000000${digits}`;
    case "currency_code":
      return "USD";
    case "credit_card":
      return "4111111111111111";
    case "iban":
      return "GB82WEST12345698765432";
    case "jwt": {
      const encode = (s: string) =>
        btoa(s).replaceAll("=", "").replaceAll("+", "-").replaceAll("/", "_");
      return `${encode('{"alg":"HS256","typ":"JWT"}')}.${
        encode(JSON.stringify({ sub: digits }))
      }.Zml4dHVyZQ`;
    }
    case "regex": {
      // `money()` is a branded string + regex; a `fixture-N` fails it and the bounded search
      // retries the same unsatisfiable shape. Emit from the pattern or the parse loop is vacuous.
      const re = regexOf(t);
      const emitted = re ? stringFromRegex(re, counter) : undefined;
      if (emitted !== undefined) return emitted;
      return undefined;
    }
  }
  // Hash formats carry the algorithm and encoding in the discriminator (argument-taking factory).
  const hash = format?.match(
    /^(md5|sha1|sha256|sha384|sha512)_(hex|base64|base64url)$/,
  );
  if (hash) {
    const size = {
      md5: 16,
      sha1: 20,
      sha256: 32,
      sha384: 48,
      sha512: 64,
    }[hash[1]!]!;
    const bytes = String.fromCharCode(
      ...Array.from({ length: size }, (_, i) => (counter + i) & 255),
    );
    return hash[2] === "hex"
      ? Array.from(bytes, (c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
        .join("")
      : hash[2] === "base64"
      ? btoa(bytes)
      : btoa(bytes).replaceAll("=", "").replaceAll("+", "-").replaceAll(
        "/",
        "_",
      );
  }
  return undefined;
}

/** Native type annotations inform fixture seeds, not input validation or application semantics. */
function nativeString(pg: string, counter: number): string | undefined {
  const type = pg.trim().toLowerCase().match(
    /^([a-z][a-z0-9]*)(?:\((\d+)(?:\s*,\s*\d+)?\))?$/,
  );
  if (!type) return undefined;
  switch (type[1]) {
    case "numeric":
    case "decimal":
    case "money":
      return "0";
    case "inet":
      return `203.0.113.${Math.abs(counter) % 254 + 1}`;
    case "cidr":
      return "203.0.113.0/24";
    case "macaddr":
      return "02:00:00:00:00:01";
    case "macaddr8":
      return "02:00:00:00:00:00:00:01";
    case "point":
      return "(1,2)";
    case "line":
      return "{1,2,3}";
    case "lseg":
    case "box":
      return "((1,2),(3,4))";
    case "path":
      return "[(1,2),(3,4)]";
    case "polygon":
      return "((1,2),(3,4),(5,6))";
    case "circle":
      return "<(1,2),3>";
    case "interval":
      return "1 day";
    case "tsvector":
      return "'fixture':1";
    case "tsquery":
      return "fixture";
    case "bit":
      return "0".repeat(Number(type[2] ?? 1));
    case "varbit":
      return "0";
    case "uuid":
      return `00000000-0000-4000-8000-${
        String(Math.abs(counter)).padStart(12, "0").slice(-12)
      }`;
    case "char":
    case "bpchar":
      return `fixture-${counter}`.slice(0, Number(type[2] ?? 1));
    case "varchar":
      return `fixture-${counter}`.slice(0, Number(type[2] ?? 24));
    case "bytea":
      return "\\x00";
    case "xml":
      return "<fixture/>";
    case "citext":
    case "ltree":
      return `fixture_${Math.abs(counter)}`;
  }
  return undefined;
}

function stringValue(t: ZType, counter: number, pg?: string): string {
  let min = 1;
  let max = 24;
  let prefix = "";
  let suffix = "";
  let includes = "";
  let letterCase: string | undefined;
  for (const c of t.def.checks ?? []) {
    const d = checkOf(c);
    if (d?.check === "min_length" && typeof d.minimum === "number") {
      min = Math.max(min, d.minimum);
    }
    if (d?.check === "max_length" && typeof d.maximum === "number") {
      max = d.maximum;
    }
    if (d?.check === "length_equals" && typeof d.length === "number") {
      min = max = d.length;
    }
    if (d?.format === "starts_with") prefix = d.prefix ?? "";
    if (d?.format === "ends_with") suffix = d.suffix ?? "";
    if (d?.format === "includes") includes = d.includes ?? "";
    if (d?.format === "uppercase" || d?.format === "lowercase") {
      letterCase = d.format;
    }
  }
  const formatted = formatValue(t, counter);
  let base = formatted ?? (pg ? nativeString(pg, counter) : undefined) ??
    `fixture-${counter}`;
  // Never truncate a format/native seed to the generic default length. Only authored bounds constrain it.
  if (formatted !== undefined || pg !== undefined) {
    max = t.def.checks?.some((c) => {
        const d = checkOf(c);
        return d?.check === "max_length" || d?.check === "length_equals";
      })
      ? max
      : Infinity;
  }
  base = `${prefix}${base}${includes}${suffix}`;
  const chars = Array.from(base);
  if (chars.length < min) {
    base = `${prefix}${
      Array.from(base.slice(prefix.length, suffix ? -suffix.length : undefined))
        .join("")
    }${"x".repeat(min - chars.length)}${suffix}`;
  }
  if (Array.from(base).length > max) {
    base = Array.from(base).slice(0, max - Array.from(suffix).length).join("") +
      suffix;
  }
  if (letterCase === "uppercase") base = base.toUpperCase();
  if (letterCase === "lowercase") base = base.toLowerCase();
  return base;
}

/** A number honoring `.int()` and greater_than/less_than bounds. Deterministic via the seeded rng. */
function numberValue(t: ZType, rng: () => number): number {
  let lo = 0;
  let hi = 1000;
  let hasLo = false;
  let hasHi = false;
  let loInclusive = true;
  let hiInclusive = true;
  let isInt = /^(safeint|u?int32)$/.test(t.def.format ?? "");
  let multiple = 0;
  // Read integral posture before applying exclusive bounds, regardless of check order/spelling.
  isInt ||= (t.def.checks ?? []).some((c) => checkOf(c)?.format === "safeint");
  for (const c of t.def.checks ?? []) {
    const d = checkOf(c);
    if (d?.format === "safeint") isInt = true;
    if (d?.check === "greater_than" && typeof d.value === "number") {
      if (!hasLo || d.value >= lo) {
        loInclusive = d.value === lo && hasLo
          ? loInclusive && !!d.inclusive
          : !!d.inclusive;
        lo = d.value;
      }
      hasLo = true;
    }
    if (d?.check === "less_than" && typeof d.value === "number") {
      if (!hasHi || d.value <= hi) {
        hiInclusive = d.value === hi && hasHi
          ? hiInclusive && !!d.inclusive
          : !!d.inclusive;
        hi = d.value;
      }
      hasHi = true;
    }
    if (d?.check === "multiple_of" && typeof d.value === "number") {
      multiple = Math.abs(d.value);
    }
  }
  if (hasHi && !hasLo) lo = Math.min(0, hi - 1000);
  if (hasLo && !hasHi) hi = Math.max(1000, lo + 1000);
  if (isInt) {
    const lower = lo;
    const upper = hi;
    lo = Math.ceil(lower);
    hi = Math.floor(upper);
    if (!loInclusive && lo === lower) lo++;
    if (!hiInclusive && hi === upper) hi--;
    loInclusive = hiInclusive = true;
  }
  if (hi < lo) hi = lo;
  if (multiple > 0) {
    let first = Math.ceil(lo / multiple);
    let last = Math.floor(hi / multiple);
    if (!loInclusive && first * multiple === lo) first++;
    if (!hiInclusive && last * multiple === hi) last--;
    const factor = first + Math.floor(rng() * Math.max(1, last - first + 1));
    return Number((factor * multiple).toPrecision(15));
  }
  const v = lo +
    Math.max(Number.EPSILON, Math.min(1 - Number.EPSILON, rng())) * (hi - lo);
  return isInt
    ? Math.round(v)
    : t.def.format === "float32"
    ? Math.fround(v)
    : v;
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
/** Advances when the caller omits `{seed}`; formats with a finite domain are not a uniqueness allocator.
 *  An explicit seed stays the reproducibility door. */
let unseededCalls = 0;

export function arb<R = Record<string, unknown>, F extends Features = Features>(
  model: ResourceModel,
  opts?: ArbOptions,
): InsertableFixture<R, F> {
  return derive(model, {}, opts, "arb") as InsertableFixture<R, F>;
}

function derive(
  model: ResourceModel,
  overrides: Record<string, unknown>,
  opts: ArbOptions | undefined,
  face: "arb" | "build",
): Record<string, unknown> {
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
      raw[name] = Object.hasOwn(overrides, name)
        ? overrides[name]
        : valueForField(field, rng, counter);
      counter++;
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
      if (!subtract.has(k) || Object.hasOwn(overrides, k)) out[k] = v;
    }
    for (const [k, v] of Object.entries(overrides)) {
      if (!(k in shape)) out[k] = v;
    }
    return out;
  }
  throw new Error(
    `testCtx.${face}('${model.name}'): could not derive a schema-valid Insertable in ${MAX_DERIVE_ATTEMPTS} attempts (last: ${lastIssue}) — generated or supplied values do not satisfy the declared format, range or refinement; supply valid constrained fields via build('${model.name}', { … }) overrides`,
  );
}

/**
 * A caller patch applied before deriving the remaining fields, validated through `model.schema` (loud-fails
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
  return derive(model, overrides ?? {}, opts, "build") as InsertableFixture<
    R,
    F
  >;
}
