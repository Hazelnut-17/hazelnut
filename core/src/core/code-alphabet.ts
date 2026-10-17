/**
 * The glyph set an `unguessableCode()` config draws from, and the keyspace that buys — one pure source the
 * helper mints from and the `hygiene/code-entropy` lint rule reads, so the two cannot disagree.
 */

const ALPHANUMERIC =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const NUMERIC = "0123456789";
const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const CROCKFORD32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32 — no I/L/O/U
const NO_CONFUSABLES =
  "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

const PRESETS: Readonly<Record<string, string>> = {
  alphanumeric: ALPHANUMERIC,
  numeric: NUMERIC,
  alpha: ALPHA,
  crockford32: CROCKFORD32,
  "no-confusables": NO_CONFUSABLES,
};

const CONFUSABLES = new Set("0Oo1IlL");
const VOWELS = new Set("aeiouAEIOU");

/** The config fields that decide the glyph set and how many glyphs are drawn. */
export interface CodeShape {
  readonly length?: number;
  readonly alphabet?: string;
  readonly case?: "upper" | "lower" | "mixed";
  readonly excludeVowels?: boolean;
  readonly pattern?: string;
}

/** A declaration/input refusal shared by pure helpers and the asynchronous ctx door. */
export class CodeConfigError extends Error {
  readonly kind = "validation" as const;
  readonly code = "code/config";
}

/** The distinct glyphs a code is drawn from, AFTER case folding — so every glyph is equally likely and the
 *  no-confusables default stays free of a confusable a fold would mint (`i` → `I`). */
export function codeAlphabet(shape: CodeShape): string {
  if (shape.alphabet !== undefined && typeof shape.alphabet !== "string") {
    throw new CodeConfigError(
      "unguessableCode: alphabet must be a preset name or a custom alphabet string",
    );
  }
  if (
    shape.case !== undefined &&
    !["upper", "lower", "mixed"].includes(shape.case)
  ) {
    throw new CodeConfigError(
      "unguessableCode: case must be upper, lower or mixed",
    );
  }
  if (
    shape.excludeVowels !== undefined &&
    typeof shape.excludeVowels !== "boolean"
  ) {
    throw new CodeConfigError(
      "unguessableCode: excludeVowels must be a boolean",
    );
  }
  const preset = shape.alphabet ?? "no-confusables";
  // Non-preset strings are intentional custom alphabets; inherited object keys are never presets.
  const base = Object.hasOwn(PRESETS, preset) ? PRESETS[preset]! : preset;
  const mode = shape.case ?? "upper";
  const folded = mode === "upper"
    ? base.toUpperCase()
    : mode === "lower"
    ? base.toLowerCase()
    : base;
  const glyphs = [...new Set(folded)].filter((c) =>
    !(preset === "no-confusables" && CONFUSABLES.has(c)) &&
    !(shape.excludeVowels && VOWELS.has(c))
  ).join("");
  if (
    [...glyphs].some((glyph) => {
      const cp = glyph.codePointAt(0)!;
      return cp >= 0xd800 && cp <= 0xdfff;
    })
  ) {
    throw new CodeConfigError(
      "unguessableCode: alphabet contains a lone surrogate",
    );
  }
  if ([...glyphs].length < 2) {
    throw new CodeConfigError(
      `unguessableCode: alphabet '${
        shape.alphabet ?? "(default)"
      }' resolves to <2 usable glyphs — no keyspace`,
    );
  }
  return glyphs;
}

/** How many glyphs a code draws: each `X` of a pattern, else `length` (default 10). */
export function codeGlyphCount(shape: CodeShape): number {
  return shape.pattern !== undefined
    ? [...shape.pattern].filter((c) => c === "X").length
    : shape.length ?? 10;
}

/** The keyspace below which a live code population is enumerable by an online guesser (02-dsl.md). */
export const CODE_KEYSPACE_FLOOR_BITS = 40;

/** log2 of the number of distinct codes the shape can mint. */
export function codeKeyspaceBits(shape: CodeShape): number {
  return codeGlyphCount(shape) * Math.log2([...codeAlphabet(shape)].length);
}
