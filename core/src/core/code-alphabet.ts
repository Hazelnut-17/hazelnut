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

/** The distinct glyphs a code is drawn from, AFTER case folding — so every glyph is equally likely and the
 *  no-confusables default stays free of a confusable a fold would mint (`i` → `I`). */
export function codeAlphabet(shape: CodeShape): string {
  const preset = shape.alphabet ?? "no-confusables";
  const base = PRESETS[preset] ?? preset;
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
  if (glyphs.length < 2) {
    throw new Error(
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
  return codeGlyphCount(shape) * Math.log2(codeAlphabet(shape).length);
}
