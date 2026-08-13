import type { Node } from "./where.ts";

const OP: Record<string, string> = {
  eq: "=",
  ne: "<>",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  like: "LIKE",
};

/** The reserved alias the grant table binds to inside an `exists` correlated subquery — decouples its
 *  column namespace from the outer row so a self-grant (`via === outerTable`) can't shadow it (13-authz.md §8). */
const GRANT_ALIAS = "_hz_g";

/**
 * Lower a Condition `Node` to a parameterized SQL fragment over the shared placeholder allocator `p`. Algebra:
 * all/empty-and→TRUE, none/empty-or/inArray([])→FALSE. `outerTable` MUST be table-qualified — a bare outer
 * column in an `exists` lowering is captured by the inner grant table's same-named column (13-authz.md §8).
 */
export function lowerInto(
  node: Node,
  p: (v: unknown) => string,
  outerTable: string,
): string {
  switch (node.kind) {
    case "cmp":
      return `"${node.col}" ${OP[node.op]} ${p(node.value)}`;
    case "inArray":
      return node.values.length
        ? `"${node.col}" IN (${node.values.map(p).join(", ")})`
        : "FALSE";
    case "isNull":
      return `"${node.col}" IS NULL`;
    case "and":
      return node.parts.length
        ? `(${
          node.parts.map((x) => lowerInto(x, p, outerTable)).join(" AND ")
        })`
        : "TRUE";
    case "or":
      return node.parts.length
        ? `(${node.parts.map((x) => lowerInto(x, p, outerTable)).join(" OR ")})`
        : "FALSE";
    case "not":
      return `NOT (${lowerInto(node.part, p, outerTable)})`;
    case "exists": {
      // the rung-A grant recipe (13-authz.md §8): the inner grant table binds to `_hz_g` and every inner
      // column is qualified through it, so it can never capture the outer row column (qualified via `outerTable`).
      const r = node.rel;
      const outerRow = `"${outerTable}"."${r.rowCol}"`;
      const join = `"${GRANT_ALIAS}"."${r.viaRowCol}" = ${outerRow}`;
      const actor = `"${GRANT_ALIAS}"."${r.viaActorCol}" = ${p(r.actorId)}`;
      const role = r.roleCol !== undefined
        ? ` AND "${GRANT_ALIAS}"."${r.roleCol}" = ${p(r.role)}`
        : "";
      // the grant table inherits the trust stack (13-authz.md §8): its own softDelete/expiry conjuncts ride
      // inside the EXISTS, qualified through `_hz_g` (bare would be captured by a same-named outer column).
      const softDelete = r.viaSoftDelete
        ? ` AND "${GRANT_ALIAS}"."deleted_at" IS NULL`
        : "";
      const expiry = r.viaExpiry
        ? ` AND ("${GRANT_ALIAS}"."expires_at" IS NULL OR "${GRANT_ALIAS}"."expires_at" > now())`
        : "";
      return `EXISTS (SELECT 1 FROM "${r.via}" AS "${GRANT_ALIAS}" WHERE ${join} AND ${actor}${role}${softDelete}${expiry})`;
    }
    case "all":
      return "TRUE";
    case "none":
      return "FALSE";
  }
}

/** Inline a literal into a static SQL predicate (partial-index `WHERE`, no `$n` params). Strings `''`-escaped;
 *  numbers/booleans render bare, Date ISO-quoted; `null` never reaches here (`isNull` handles it structurally). */
function staticLiteral(v: unknown): string {
  if (typeof v === "string") return `'${v.replace(/'/g, "''")}'`;
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof Date) return `'${v.toISOString()}'`;
  throw new Error(
    `unique/partial predicate: cannot inline a ${
      v === null ? "null" : typeof v
    } literal into a static index WHERE`,
  );
}

/** Lower a Condition `Node` to a static SQL predicate (literals inlined, no `$n` params) for a partial-index
 *  `WHERE`; `exists` is rejected upstream (`unique/partial-predicate-local` boot guard), so `outerTable` is unused. */
export function lowerStatic(node: Node): string {
  return lowerInto(node, staticLiteral, "");
}
