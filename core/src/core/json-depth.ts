/** True iff `v` nests deeper than `max`. Bounds its own recursion at `max` levels, so a pathological
 * value can never stack-overflow the check itself. */
export function exceedsJsonDepth(v: unknown, max: number): boolean {
  if (max < 0) return true;
  if (Array.isArray(v)) return v.some((x) => exceedsJsonDepth(x, max - 1));
  if (v !== null && typeof v === "object") {
    return Object.values(v as Record<string, unknown>).some((x) =>
      exceedsJsonDepth(x, max - 1)
    );
  }
  return false;
}

/** Nesting ceiling for every caller JSON value the framework parses: bodies, filters, and
 * continuation tokens. 64 sits far above any legitimate shape (trees are relational via
 * `parent_id`, never nested JSON). */
export const MAX_JSON_DEPTH = 64;
