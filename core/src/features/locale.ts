// RFC 5646 §2.1 syntax only, not IANA registry validity or preferred-alias canonicalization.
const LANGUAGE_TAG =
  /^(?:[a-z]{2,3}(?:-[a-z]{3}){0,3}|[a-z]{4}|[a-z]{5,8})(?:-[a-z]{4})?(?:-(?:[a-z]{2}|[0-9]{3}))?(?:-(?:[a-z0-9]{5,8}|[0-9][a-z0-9]{3}))*(?:-[0-9a-wy-z](?:-[a-z0-9]{2,8})+)*(?:-x(?:-[a-z0-9]{1,8})+)?$/i;
const PRIVATE_TAG = /^x(?:-[a-z0-9]{1,8})+$/i;
const IRREGULAR_TAGS = new Set([
  "en-gb-oed",
  "i-ami",
  "i-bnn",
  "i-default",
  "i-enochian",
  "i-hak",
  "i-klingon",
  "i-lux",
  "i-mingo",
  "i-navajo",
  "i-pwn",
  "i-tao",
  "i-tay",
  "i-tsu",
  "sgn-be-fr",
  "sgn-be-nl",
  "sgn-ch-de",
]);

/** Syntax normalization only: script and region casing follow their grammar positions. Extension
 * and private-use subtags are lowercase; a two-letter extension payload is not a region. */
export function normalizeLocale(raw: string): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw Object.assign(
      new Error("i18n: empty locale tag (a BCP-47 tag is required)"),
      { kind: "validation" as const },
    );
  }
  const tag = raw.trim().replaceAll("_", "-");
  const lower = tag.toLowerCase();
  if (
    !LANGUAGE_TAG.test(tag) && !PRIVATE_TAG.test(tag) &&
    !IRREGULAR_TAGS.has(lower)
  ) {
    throw Object.assign(
      new Error("i18n: malformed locale tag (BCP-47 syntax required)"),
      { kind: "validation" as const },
    );
  }
  const parts = lower.split("-");
  // Grandfathered tags retain their established region casing without guessing preferred aliases.
  if (IRREGULAR_TAGS.has(lower)) {
    if (lower === "en-gb-oed") return "en-GB-oed";
    if (lower.startsWith("sgn-")) {
      return parts.map((p, i) => i === 0 ? p : p.toUpperCase()).join("-");
    }
    return lower;
  }
  if (parts[0] === "x") return lower;
  let cursor = 1;
  if (parts[0]!.length <= 3) {
    for (let n = 0; n < 3 && /^[a-z]{3}$/.test(parts[cursor] ?? ""); n++) {
      cursor++;
    }
  }
  if (/^[a-z]{4}$/.test(parts[cursor] ?? "")) {
    const script = parts[cursor]!;
    parts[cursor++] = script[0]!.toUpperCase() + script.slice(1);
  }
  if (/^(?:[a-z]{2}|[0-9]{3})$/.test(parts[cursor] ?? "")) {
    parts[cursor] = parts[cursor]!.toUpperCase();
    cursor++;
  }
  const variants = new Set<string>();
  while (/^(?:[a-z0-9]{5,8}|[0-9][a-z0-9]{3})$/.test(parts[cursor] ?? "")) {
    if (variants.has(parts[cursor]!)) {
      throw Object.assign(new Error("i18n: duplicate locale variant"), {
        kind: "validation" as const,
      });
    }
    variants.add(parts[cursor++]!);
  }
  const extensions = new Set<string>();
  while (cursor < parts.length && parts[cursor] !== "x") {
    const singleton = parts[cursor++]!;
    if (extensions.has(singleton)) {
      throw Object.assign(new Error("i18n: duplicate locale extension"), {
        kind: "validation" as const,
      });
    }
    extensions.add(singleton);
    while (cursor < parts.length && parts[cursor]!.length > 1) cursor++;
  }
  return parts.join("-");
}
