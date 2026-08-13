// Barrel re-exports keep import sites stable.
import { CRUD_VERBS } from "../authz/auth.ts";
import { idxOf } from "./model-index.ts";
import type { Invariant } from "../core/verifier-contract.ts";
import type { Violation } from "../core/structural-violation.ts";
import { REPO_SEMANTIC_SEARCH_HAS_ITERATIVE_SCAN } from "./repo-flags.ts";

/** A legal permission-key segment: `[A-Za-z0-9_]+`, excluding the wire separators (`:`, `.`) and whitespace a
 *  key needs to assemble cleanly into `<resource>:<key>`. Distinct from the MCP tool-name charset `[a-z0-9_]`. */
const PERM_KEY = /^[A-Za-z0-9_]+$/;

/** `capabilities/unique`: a resource's declared capability keys must be distinct — a duplicate silently
 *  shadows the first declaration in the assembled `<resource>:<key>` vocabulary. */
export const capabilitiesUnique: Invariant = {
  id: "capabilities/unique",
  check(ctx) {
    const m = ctx.resource;
    const seen = new Set<string>();
    const out: Violation[] = [];
    for (const key of m.capabilities) {
      if (seen.has(key)) {
        out.push({
          id: "capabilities/unique",
          resource: m.name,
          message:
            `capability key '${key}' is declared more than once — a duplicate assembles the same '${m.name}:${key}' permission twice, silently shadowing the first declaration`,
        });
      }
      seen.add(key);
    }
    return out;
  },
};

/** `capabilities/legal-key`: every declared capability key must match `PERM_KEY` — a key with whitespace or a
 *  wire separator (`:`/`.`) would split wrong when assembled into the colon-string vocabulary. */
export const capabilitiesLegalKey: Invariant = {
  id: "capabilities/legal-key",
  check(ctx) {
    const m = ctx.resource;
    return m.capabilities
      .filter((key) => !PERM_KEY.test(key))
      .map((key) => ({
        id: "capabilities/legal-key",
        resource: m.name,
        message:
          `capability key '${key}' is not a legal permission segment — a key must be a non-empty [A-Za-z0-9_] identifier (no wire separator ':'/'.' or whitespace), else it splits wrong when assembled into the '${m.name}:<key>' vocabulary`,
      }));
  },
};

/** `capabilities/no-crud-shadow`: a declared capability key may not equal an auto-seeded CRUD verb —
 *  capabilities are the explicit non-CRUD extras (13-authz.md §2); a colliding key silently re-declares an
 *  existing `<resource>:<verb>` vocabulary entry. Reads the live `m.perms`, not a restated verb list. */
export const capabilitiesNoCrudShadow: Invariant = {
  id: "capabilities/no-crud-shadow",
  check(ctx) {
    const m = ctx.resource;
    // membership test against the live seeded vocabulary, not a restated verb list.
    const crudPerms = new Set(
      [...CRUD_VERBS].map((verb) => `${m.name}:${verb}`).filter((key) =>
        m.perms.includes(key)
      ),
    );
    return m.capabilities
      .filter((key) => crudPerms.has(`${m.name}:${key}`))
      .map((key) => ({
        id: "capabilities/no-crud-shadow",
        resource: m.name,
        message:
          `capability key '${key}' collides with the auto-seeded CRUD permission '${m.name}:${key}' — capabilities are the explicit NON-CRUD extras; a CRUD-verb key re-declares an existing vocabulary entry`,
      }));
  },
};

// ── FEATURE DERIVER-GUARDS over the emitted DDL ──
// These guard the framework's own deriver output (`deriveDDL` in schema.ts), not the declaration —
// a regression that silently stops emitting the index/constraint/clause is caught (10-invariants.md §by-construction).

/** `searchable/indexed`: searchable fields must mint both the `search_vector tsvector` column and its GIN
 *  index — the index is what makes full-text search fast, not a seq-scan (10-invariants.md §searchable/indexed). */
export const searchableIndexed: Invariant = {
  id: "searchable/indexed",
  check(ctx) {
    const m = ctx.resource;
    if (m.searchable.length === 0) return [];
    const out: Violation[] = [];
    if (!/search_vector\s+tsvector/.test(m.ddl)) {
      out.push({
        id: "searchable/indexed",
        resource: m.name,
        message:
          "searchable fields declared but the derived `search_vector` tsvector column was not minted",
      });
    }
    if (!m.ddl.includes("USING GIN (search_vector)")) {
      out.push({
        id: "searchable/indexed",
        resource: m.name,
        message:
          "searchable fields declared but no GIN index over `search_vector` was minted — full-text search would seq-scan every row",
      });
    }
    return out;
  },
};

/** `vector/indexed`: a `vector` field must mint both the typed embedding column (`vector(N)` at/below the
 *  2000-dim plain-index ceiling, else `halfvec(N)`) and the HNSW index over it — else a semantic read
 *  seq-scans, and an above-ceiling embedding can't reject a wrong-width insert (04-features.md §vector). */
export const vectorIndexed: Invariant = {
  id: "vector/indexed",
  check(ctx) {
    const m = ctx.resource;
    if (!m.vector) return [];
    const out: Violation[] = [];
    const v = m.vector;
    const wantType = v.dims <= 2000
      ? `vector(${v.dims})`
      : `halfvec(${v.dims})`;
    if (!m.ddl.includes(`"${v.field}" ${wantType}`)) {
      out.push({
        id: "vector/indexed",
        resource: m.name,
        clause: `vector.${v.field}`,
        message:
          `vector field declared at dims=${v.dims} but the derived column is not '${wantType}' — a >2000-dim embedding must route to halfvec (plain vector only indexes to 2000)`,
      });
    }
    const wantOpClass = v.dims <= 2000
      ? "vector_cosine_ops"
      : "halfvec_cosine_ops";
    if (
      !new RegExp(`USING hnsw \\("${v.field}" ${wantOpClass}\\)`).test(m.ddl)
    ) {
      out.push({
        id: "vector/indexed",
        resource: m.name,
        clause: `vector.${v.field}`,
        message:
          `vector field declared but no HNSW index (\`USING hnsw ("${v.field}" ${wantOpClass})\`) was minted — a similarity search would seq-scan + sort every row`,
      });
    }
    return out;
  },
};

/** `vector/filtered-scan-complete`: a vector field's semantic-read path MUST `SET LOCAL hnsw.iterative_scan` —
 *  without it, a naive HNSW search filters the raw top-K post-hoc, silently dropping authorized rows a
 *  rowPolicy/scope pre-filter should have returned (04-features.md §vector). Reads the shared repo source
 *  (`semanticSearch`, the single composition site), not a per-resource declaration. */
export const vectorFilteredScanComplete: Invariant = {
  id: "vector/filtered-scan-complete",
  check(ctx) {
    const m = ctx.resource;
    if (!m.vector) return [];
    // one shared site (repo.ts `semanticSearch`); if the SET is gone, every vector resource under-returns.
    if (!REPO_SEMANTIC_SEARCH_HAS_ITERATIVE_SCAN) {
      return [{
        id: "vector/filtered-scan-complete",
        resource: m.name,
        clause: `vector.${m.vector.field}`,
        message:
          "the semantic-read path does not SET hnsw.iterative_scan — a rowPolicy/scope pre-filter would silently under-return (drop authorized rows outside the raw top-K)",
      }];
    }
    return [];
  },
};

// `vector/source-not-{sensitive,encrypted}` are fail-closed boot compose-errors (`app-boot-derive.ts`), not
// verify invariants — createApp refuses before `hazelnut verify` ever boots, so a verify-time twin is inert.

/** `unique/enforced`: every non-empty `unique` tuple must mint a real `CREATE UNIQUE INDEX` — else a
 *  duplicate write is silently accepted (10-invariants.md §unique/enforced). Empty tuples are owned by
 *  `unique/no-empty-tuple` and skipped here. */
/** `rollups/columns-minted`: a `rollups` declaration must mint each maintained-aggregate column on the
 *  parent table — `count`/`sum` as `integer NOT NULL DEFAULT 0`, `avg`/`min`/`max` as `double precision`
 *  (03-api-shape.md §8) — else the aggregate is declared but never maintained. Runs from the counted child,
 *  which records the parent table/column/kind in `rollupTargets`. */
export const rollupsColumnsMinted: Invariant = {
  id: "rollups/columns-minted",
  check(ctx) {
    const m = ctx.resource;
    if (m.rollupTargets.length === 0) return [];
    const out: Violation[] = [];
    for (const t of m.rollupTargets) {
      const parent = idxOf(ctx).byTable.get(t.parentTable); // memoized table lookup
      if (!parent) continue; // parent existence is a compose-time guarantee; a missing one is not this guard's fault
      const wantType = t.kind === "avg" || t.kind === "min" || t.kind === "max"
        ? "double precision"
        : "integer NOT NULL DEFAULT 0";
      if (!parent.ddl.includes(`"${t.column}" ${wantType}`)) {
        out.push({
          id: "rollups/columns-minted",
          resource: parent.name,
          clause: `rollups.${t.column}`,
          message:
            `rollup '${t.column}' (${t.kind}) declared on '${parent.name}' but the derived '${t.column}' ${wantType} column was not minted — the aggregate would never be maintained`,
        });
      }
    }
    return out;
  },
};
export const uniqueEnforced: Invariant = {
  id: "unique/enforced",
  check(ctx) {
    const m = ctx.resource;
    const out: Violation[] = [];
    for (const cols of m.unique) {
      if (cols.length === 0) continue; // an empty tuple is owned by `unique/no-empty-tuple`, not this guard
      const indexName = `"${m.name}_${cols.join("_")}_uniq"`;
      if (
        !(m.ddl.includes("CREATE UNIQUE INDEX") && m.ddl.includes(indexName))
      ) {
        out.push({
          id: "unique/enforced",
          resource: m.name,
          message: `unique tuple [${
            cols.join(", ")
          }] declared but no UNIQUE INDEX ${indexName} was minted — duplicate writes would be accepted`,
        });
      }
    }
    return out;
  },
};

/** `ref/on-delete-honored`: a declared `onDelete` of `cascade`/`set-null` on an intra-module reference must be
 *  honored as a real FK clause in the emitted DDL — a declaration the DB cannot honor is never silently dropped
 *  (10-invariants.md §ref/on-delete-honored). Skips a soft-delete/audit child (the repo-op sweep owns it instead,
 *  03-api-shape.md §onDelete) and external refs (no FK is emitted for those). */
export const refOnDeleteHonored: Invariant = {
  id: "ref/on-delete-honored",
  check(ctx) {
    const m = ctx.resource;
    if (m.features.softDelete || m.features.audit) return []; // the repo-op sweep owns this instead
    const out: Violation[] = [];
    for (const [field, r] of Object.entries(m.references)) {
      if (
        r.external || (r.onDelete !== "cascade" && r.onDelete !== "set-null")
      ) continue;
      const action = r.onDelete === "cascade"
        ? "ON DELETE CASCADE"
        : "ON DELETE SET NULL";
      const clause = new RegExp(
        `FOREIGN KEY \\("${field}"\\) REFERENCES[^,\\n]*${action}`,
      );
      if (!clause.test(m.ddl)) {
        out.push({
          id: "ref/on-delete-honored",
          resource: m.name,
          clause: `references.${field}`,
          message:
            `reference '${field}' declares onDelete:'${r.onDelete}' but the emitted FK carries no '${action}' clause — a declared delete behavior the DB would silently not honor`,
        });
      }
    }
    return out;
  },
};
