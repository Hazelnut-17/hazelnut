// Barrel re-exports keep import sites stable.
import type { ResourceModel } from "../core/app.ts";
import { type Node as WhereNode, toNode } from "../core/where.ts";
import type { Invariant } from "../core/verifier-contract.ts";
import type { Violation } from "../core/structural-violation.ts";

/** Walk a `Where` Node tree, collecting every column name a comparison/null/inArray leaf references — used
 *  to recover the columns a rowPolicy filters on (perf/policy-indexed). */
function whereCols(node: WhereNode, into: Set<string>): void {
  switch (node.kind) {
    case "cmp":
    case "inArray":
    case "isNull":
      into.add(node.col);
      return;
    case "and":
    case "or":
      for (const p of node.parts) whereCols(p, into);
      return;
    case "not":
      whereCols(node.part, into);
      return;
      // "all" / "none" reference no column.
  }
}

/** The columns this framework actually puts an index on — derived from the same declarations
 *  `migrate-drizzle.ts` reads when it emits them, so the two cannot disagree about what exists.
 *
 *  A `references` column is NOT here, and that is the correction: Postgres indexes the REFERENCED key,
 *  never the referencing one, and nothing in the DDL derivation emits an index for a child FK column.
 *  Counting it as indexed made this check silent on exactly the filter it exists to catch. */
function indexedCols(m: ResourceModel): Set<string> {
  const idx = new Set<string>(["id"]); // the PK is always indexed
  if (m.parentFk) idx.add(m.parentFk); // the closure table's parent edge
  for (const c of m.searchable) idx.add(c); // the GIN over each searchable column
  for (const tuple of m.unique) {
    for (const c of tuple as readonly string[]) idx.add(c); // every unique-tuple column
  }
  if (m.features.scope) idx.add("scope_key"); // scope key participates in the read WHERE-stack on every query
  // the ownership btree the deriver mints for a bare-string `rowPolicy` (`data/schema-ddl.ts §policyIdx`).
  // Before it, the shorthand this vocabulary teaches FIRST produced a warning no declaration could answer:
  // there is no plain-index key in the language, so the advisory fired on every scaffolded resource forever.
  if (m.rowPolicyColumn !== null) idx.add(m.rowPolicyColumn);
  // No entry for the feature-minted btrees (`expires_at`, `valid_*`, `<f>_bidx`): the report filters to
  // `c in m.columns`, which holds DECLARED columns only, so those can never be reported in the first place.
  return idx;
}

/** `perf/policy-indexed` (warn — 10-invariants.md §hygiene): a rowPolicy filtering on a column with no index
 *  makes every policy-gated read a sequential scan under load. Recovers the filtered columns by invoking the
 *  rowPolicy with a probe actor (and `null`) and walking the returned `Where` tree; a policy that throws on
 *  the probe is skipped (actor-dependent, not statically recoverable — never confident-wrong). Never ship-block. */
export const perfPolicyIndexed: Invariant = {
  id: "perf/policy-indexed",
  check(ctx) {
    const m = ctx.resource;
    if (!m.hasRowPolicy || typeof m.rowPolicy !== "function") return [];
    const policy = m.rowPolicy as (actor: unknown) => unknown;
    const cols = new Set<string>();
    // probe with a synthetic actor and null — a policy may branch on the actor, so collect the union.
    // A throw means the columns aren't statically recoverable → skip (fail toward no-finding).
    for (const probe of [{ type: "user", id: "_probe" }, null]) {
      let where: unknown;
      try {
        where = policy(probe);
      } catch {
        return []; // actor-dependent / non-total policy — not statically recoverable.
      }
      if (where === null || typeof where !== "object") continue;
      try {
        whereCols(toNode(where as Parameters<typeof toNode>[0]), cols);
      } catch {
        return []; // a non-Where return — leave it to other invariants, never WARN on a shape we cannot read.
      }
    }
    const indexed = indexedCols(m);
    return [...cols]
      .filter((c) => c in m.columns && !indexed.has(c)) // only real, unindexed columns (an unknown col is another invariant's fault)
      .map((c) => ({
        id: "perf/policy-indexed",
        resource: m.name,
        clause: `rowPolicy.${c}`,
        message:
          `rowPolicy filters on column '${c}' which has no index — every policy-gated read scans the table on '${c}'. The bare-column shorthand (\`rowPolicy: "${c}"\`) mints the btree for you; a function-form policy is the author's own shape, so declaring \`unique\`/\`searchable\`, or adding the index in a migration, is yours (a perf hint, not a correctness break)`,
      }));
  },
};

/** `treeclosure/needs-tree`: `treeClosure` is a `tree` sub-option (it maintains the `<r>_tree` closure table
 *  over the `parent_id` edge) — without `tree` there is no hierarchy edge to close over. */
export const treeclosureNeedsTree: Invariant = {
  id: "treeclosure/needs-tree",
  check(ctx) {
    const m = ctx.resource;
    if (m.features.treeClosure && !m.features.tree) {
      return [{
        id: "treeclosure/needs-tree",
        resource: m.name,
        message:
          "resource declares treeClosure but not tree — treeClosure is a tree sub-option; with no parent_id hierarchy edge there is nothing for the closure table to index",
      }];
    }
    return [];
  },
};

/** `ref/set-null-needs-nullable`: an FK declaring `onDelete:"set-null"` over a NOT NULL column is unsatisfiable
 *  at the DB — a parent delete tries to null the FK column and the NOT NULL constraint rejects it, erroring
 *  instead of nulling the edge. */
export const refSetNullNeedsNullable: Invariant = {
  id: "ref/set-null-needs-nullable",
  check(ctx) {
    const m = ctx.resource;
    const out: Violation[] = [];
    for (const [field, r] of Object.entries(m.references)) {
      if (r.external || r.onDelete !== "set-null") continue;
      const col = m.columns[field];
      if (col && !col.nullable) {
        out.push({
          id: "ref/set-null-needs-nullable",
          resource: m.name,
          message:
            `reference '${field}' declares onDelete:'set-null' but the column is NOT NULL — a parent delete would try to null a NOT NULL column and error; make '${field}' nullable or drop set-null`,
        });
      }
    }
    return out;
  },
};

/** `ref/external-no-ondelete`: an external by-id reference (`refById`, `external:true`) that also carries an
 *  `onDelete` is a no-op declaration — `deriveDDL` emits no FK for an external target, so the `onDelete`
 *  behavior is silently dropped. */
export const refExternalNoOnDelete: Invariant = {
  id: "ref/external-no-ondelete",
  check(ctx) {
    const m = ctx.resource;
    return Object.entries(m.references)
      .filter(([, r]) => r.external && r.onDelete !== undefined)
      .map(([field, r]) => ({
        id: "ref/external-no-ondelete",
        resource: m.name,
        message:
          `external by-id reference '${field}' declares onDelete:'${r.onDelete}' but no FK is emitted for an external target, so the onDelete is silently dropped — a no-op declaration`,
      }));
  },
};
