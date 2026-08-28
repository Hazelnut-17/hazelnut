/** `jsr:@hazelnut/core@<version>` literals — doctor, the mixed-literal fold, and the lint pin-coherence
 *  rule share this matcher so a leftover task line and a leftover import cannot disagree about what
 *  "two versions" means. */
export const FRAMEWORK_VERSION_LITERAL =
  /jsr:@hazelnut\/core@([0-9][^/\s"'`,)\]]*)/g;

export function collectFrameworkVersionLiterals(
  texts: Readonly<Record<string, string>>,
): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const [path, text] of Object.entries(texts)) {
    for (const m of text.matchAll(FRAMEWORK_VERSION_LITERAL)) {
      const v = m[1]!;
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
