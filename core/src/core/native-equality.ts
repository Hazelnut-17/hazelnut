// Equality usable for caller filters on the declared PostgreSQL value (including array elements).
const NO_VALUE_EQUALITY = new Set([
  "point",
  "polygon",
  "box",
  "path",
  "circle",
  "xml",
  "json",
]);

/** Native geometric arrays also lack element equality when the scalar line/lseg operator exists.
 * PostgreSQL's case-insensitive citext and interval/numeric equality remain their authored filter contract.
 * This predicate does not define stored-value identity for PATCH no-op detection. */
export function pgHasValueEquality(pg: string): boolean {
  const type = pg.trim().toLowerCase();
  const base = type.match(/^[a-z_][a-z0-9_]*/)?.[0];
  return base !== undefined && !NO_VALUE_EQUALITY.has(base) &&
    !(type.includes("[") && (base === "line" || base === "lseg"));
}
