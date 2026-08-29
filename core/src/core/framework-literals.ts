/** `@hazelnut/core` pin literals — doctor, the mixed-literal fold, and the lint pin-coherence rule share
 *  this matcher so a leftover task line and a leftover import cannot disagree about what "two versions"
 *  means. Every spelling Deno resolves: the `jsr:` specifier with or without a range operator
 *  (`@^1.2.3`, `@~1.2.3`, `@>=1.2.3`), and the `https://jsr.io/@hazelnut/core/<v>/` URL. Capture 1 is the
 *  raw pin (operator + version); `normalizeFrameworkPin` strips the operator so a range and a bare pin for
 *  the same version compare equal. */
export const FRAMEWORK_VERSION_LITERAL =
  /(?:jsr:@hazelnut\/core@|https:\/\/jsr\.io\/@hazelnut\/core\/)((?:[\^~]|[<>]=?|=)?\s*[0-9][^/\s"'`,)\]]*)/g;

/** Strip a leading semver range operator (and any space after it): the coherence check is about which
 *  VERSION a leftover pin resolves, not the operator on it, so `^0.6.4` and `0.6.4` are one version. */
export function normalizeFrameworkPin(raw: string): string {
  return raw.replace(/^(?:[\^~]|[<>]=?|=)?\s*/, "");
}

/** Blank `//` line comments and `/* *\/` block comments in a JSONC document. Deno reads `deno.json` as
 *  JSONC, so a `// bumped from …@0.6.3` breadcrumb is NOT an active pin — every reader that matches pin
 *  literals over `deno.json` strips first, or a comment reads as a second version and reds `ci` step 1
 *  on a correct tree. String-aware: a `//` inside a `"…"` is data. */
export function stripJsoncComments(text: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

export function collectFrameworkVersionLiterals(
  texts: Readonly<Record<string, string>>,
): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const [path, text] of Object.entries(texts)) {
    for (const m of text.matchAll(FRAMEWORK_VERSION_LITERAL)) {
      const v = normalizeFrameworkPin(m[1]!);
      if (!found.has(v)) found.set(v, new Set());
      found.get(v)!.add(path);
    }
  }
  return found;
}

/** Null when the tree names at most one published version. The sentence is the consumer-facing half of
 *  `version/projection-fresh`'s mixed-literal clause — lint and the fold print the same words. */
export function describeMixedFrameworkVersions(
  found: Map<string, Set<string>>,
): string | null {
  if (found.size <= 1) return null;
  const where = [...found.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([v, paths]) => `${v} (${[...paths].sort().join(", ")})`);
  return `this tree names ${found.size} framework versions — ${
    where.join("; ")
  }. A leftover pin still runs the older CLI against a newer tree.`;
}
