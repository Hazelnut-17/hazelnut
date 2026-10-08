import type { Node } from "./where.ts";
import { compileInto, conditionSql } from "./lower-sql.ts";

/**
 * Lower a Condition `Node` to a parameterized SQL fragment over the shared placeholder allocator `p`. Algebra:
 * all/empty-and→TRUE, none/empty-or/inArray([])→FALSE. `outerTable` MUST be table-qualified — a bare outer
 * column in an `exists` lowering is captured by the inner grant table's same-named column (13-authz.md §dynamic-per-row-sharing).
 */
export function lowerInto(
  node: Node,
  p: (v: unknown) => string,
  outerTable: string,
  /** The outer resource's pg schema — an `exists` grant is intra-module, so the via table
   *  qualifies here (a bare `"via"` resolves `public.via` and misses a module-schema grant). */
  pgSchema = "public",
  castFor?: (col: string) => string | undefined,
): string {
  return compileInto(conditionSql(node, outerTable, pgSchema, { castFor }), p);
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
