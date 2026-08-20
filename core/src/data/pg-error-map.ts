/**
 * `pgErrorMap`: resolves a raw Postgres unique-violation (`23505`) back to the
 * declaration owning the constraint (resource + columns), by inverting the constraint-naming function in
 * schema.ts. Derived from the model. Row values (potential PII) are never
 * returned on either the mapped or the fallback path.
 */
import { pgIdent } from "./schema-types.ts";

/** One resource's identity for constraint attribution — its name + declared unique tuples + whether it is a
 *  scoped singleton (which additionally mints `<name>_scope_singleton_uniq`). Extracted from `App.model`. */
export interface UniqueOwner {
  readonly name: string;
  readonly unique?: readonly (readonly string[])[];
  readonly scopedSingleton?: boolean;
  readonly pgSchema?: string;
}

/** The declaration a violated constraint resolves to. */
export interface ClauseOwner {
  readonly resource: string;
  readonly cols: readonly string[];
  readonly pgSchema?: string;
}

/** The caller-safe attribution: an enriched `message` (never carrying a row value) and, for a mapped
 *  constraint only, the `clause` that feeds `responsible.ref.clause` (ctx.ts §Responsible). */
export interface PgAttribution {
  readonly message: string;
  readonly clause?: string;
}

/** Build the constraint-name → owning-declaration map — the inverse of `schema.ts`'s naming function. The
 *  name keeps the declared cols only (scope_key folds into the column list, never the name), so the
 *  inverse recovers the declared tuple exactly. */
/** Build the constraint-name → owning-declaration map — the inverse of `schema.ts`'s naming function. The
 *  name keeps the declared cols only (scope_key folds into the column list, never the name), so the
 *  inverse recovers the declared tuple exactly. Same derived name in two pg schemas is legal (schema-per-module);
 *  a same-schema collision is a boot-level `unique/duplicate-cols` miss and throws here as a belt. */
export function uniqueClauseMap(
  owners: readonly UniqueOwner[],
): Map<string, readonly ClauseOwner[]> {
  const m = new Map<string, ClauseOwner[]>();
  const put = (key: string, owner: ClauseOwner): void => {
    const cur = m.get(key) ?? [];
    const schema = owner.pgSchema ?? "";
    if (cur.some((o) => (o.pgSchema ?? "") === schema)) {
      throw new Error(
        `uniqueClauseMap: constraint name '${key}' collides in pg schema '${
          schema || "public"
        }' (${cur[0]!.resource} vs ${owner.resource})`,
      );
    }
    cur.push(owner);
    m.set(key, cur);
  };
  for (const o of owners) {
    const extra = o.pgSchema !== undefined ? { pgSchema: o.pgSchema } : {};
    for (const cols of o.unique ?? []) {
      put(pgIdent(`${o.name}_${cols.join("_")}_uniq`), {
        resource: o.name,
        cols,
        ...extra,
      });
    }
    if (o.scopedSingleton) {
      put(pgIdent(`${o.name}_scope_singleton_uniq`), {
        resource: o.name,
        cols: ["scope_key"],
        ...extra,
      });
    }
  }
  return m;
}

/** Extract the constraint name from a PG unique-violation error, driver-portably: PGlite exposes `.constraint`,
 *  postgres.js `.constraint_name`; both also embed it in the message (`… unique constraint "<name>"`) — the
 *  floor when neither field is present. */
export function constraintName(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const o = e as {
    constraint?: unknown;
    constraint_name?: unknown;
    message?: unknown;
  };
  if (typeof o.constraint === "string") return o.constraint;
  if (typeof o.constraint_name === "string") return o.constraint_name;
  const msg = typeof o.message === "string" ? o.message : "";
  return /unique constraint "([^"]+)"/.exec(msg)?.[1];
}

/** Extract the offending column names from a PG error's `detail` (`Key (a, b)=(…) already exists.`) — the
 *  column list only, never the values in the second parenthesis group (row data, potential PII). */
export function detailColumns(e: unknown): readonly string[] {
  const detail = typeof e === "object" && e !== null
    ? (e as { detail?: unknown }).detail
    : undefined;
  if (typeof detail !== "string") return [];
  const cols = /^Key \(([^)]+)\)=/.exec(detail)?.[1];
  return cols ? cols.split(",").map((c) => c.trim()) : [];
}

function errorRelation(e: unknown): { table?: string; schema?: string } {
  if (typeof e !== "object" || e === null) return {};
  const o = e as { table?: unknown; schema?: unknown };
  return {
    table: typeof o.table === "string" ? o.table : undefined,
    schema: typeof o.schema === "string" ? o.schema : undefined,
  };
}

function pickClauseOwner(
  hits: readonly ClauseOwner[] | undefined,
  e: unknown,
): ClauseOwner | undefined {
  if (!hits || hits.length === 0) return undefined;
  if (hits.length === 1) return hits[0];
  const { table, schema } = errorRelation(e);
  const matched = hits.filter((h) =>
    (table === undefined || h.resource === table) &&
    (schema === undefined || h.pgSchema === undefined || h.pgSchema === schema)
  );
  return matched.length === 1 ? matched[0] : undefined;
}

/** Map a PG unique violation to a caller-safe attribution. A known constraint (present in the model-derived
 *  map) resolves to its declared clause; an unknown one falls back to the enriched-unknown floor (name +
 *  table + columns, values redacted). Never leaks a row value on either path. */
export function pgErrorMap(
  e: unknown,
  clauseMap: Map<string, readonly ClauseOwner[]>,
): PgAttribution {
  const name = constraintName(e);
  const hit = pickClauseOwner(name ? clauseMap.get(name) : undefined, e);
  if (hit) {
    return {
      message: `unique constraint violated on ${hit.resource}.${
        hit.cols.join(", ")
      }`,
      clause: `${hit.resource}.unique(${hit.cols.join(", ")})`,
    };
  }
  // enriched-unknown floor: everything the model does not own, values stripped.
  const table = typeof e === "object" && e !== null
    ? (e as { table?: unknown }).table
    : undefined;
  const cols = detailColumns(e);
  const parts = [
    "unique constraint",
    name ? `"${name}"` : "",
    "violated",
    typeof table === "string" && table ? `on ${table}` : "",
    cols.length ? `(${cols.join(", ")})` : "",
  ].filter(Boolean);
  return { message: parts.join(" ") };
}
