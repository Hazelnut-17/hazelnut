// Barrel re-exports keep import sites stable.
import { CRUD_VERB_SET } from "../authz/auth.ts";
import { deriveColumns } from "../data/schema.ts";
import { idxOf } from "./model-index.ts";
import type { Invariant } from "../core/verifier-contract.ts";
import { wholeImmutable } from "../data/schema-normalize.ts";

/** `config/default-declared`: a `singleton` resource must declare a typed default — a schema field
 *  carrying `.default(<static>)` — so `getConfigOr` has a value for an unseeded row (04-features.md
 *  §singleton-marker). Reads the composed model's column derivation, never codegen. */
export const configDefaultDeclared: Invariant = {
  id: "config/default-declared",
  check(ctx) {
    const m = ctx.resource;
    if (!m.features.singleton) return []; // gated on the singleton marker — a non-singleton has no config default obligation
    const cols = deriveColumns(m.schema);
    const hasTypedDefault = Object.values(cols).some((c) =>
      c.default !== undefined
    );
    if (!hasTypedDefault) {
      return [{
        id: "config/default-declared",
        resource: m.name,
        message:
          `singleton '${m.name}' declares no typed default — a singleton config row must carry a schema \`.default(…)\` so a read of an unseeded resource resolves through getConfigOr's default, never logic remembering`,
      }];
    }
    return [];
  },
};

/** `tree/parent-col`: a `tree` resource must carry a `parent_id` column for the hierarchy edge. */
export const treeParentCol: Invariant = {
  id: "tree/parent-col",
  check(ctx) {
    const m = ctx.resource;
    if (m.features.tree && !("parent_id" in m.columns)) {
      return [{
        id: "tree/parent-col",
        resource: m.name,
        message: "tree feature declared but no parent_id column",
      }];
    }
    return [];
  },
};

/** `searchable/cols-exist`: every full-text field name must be a real schema column. */
export const searchableColsExist: Invariant = {
  id: "searchable/cols-exist",
  check(ctx) {
    const m = ctx.resource;
    return m.searchable
      .filter((c) => !(c in m.columns))
      .map((c) => ({
        id: "searchable/cols-exist",
        resource: m.name,
        clause: `searchable.${c}`,
        message: `searchable references unknown column '${c}'`,
      }));
  },
};

/** `ref/cascade-safe`: a row reached by a DB `ON DELETE CASCADE` (a `cascade` reference, or a `child` —
 *  parent FKs always cascade) must not have `softDelete`/`audit` — the cascade would hard-delete it,
 *  bypassing the soft path and writing no audit row (03-api-shape.md §onDelete). */
export const refCascadeSafe: Invariant = {
  id: "ref/cascade-safe",
  check(ctx) {
    const m = ctx.resource;
    const cascadesIn = m.parent !== null ||
      Object.values(m.references).some((r) => r.onDelete === "cascade");
    if (cascadesIn && (m.features.softDelete || m.features.audit)) {
      const f = m.features.softDelete ? "softDelete" : "audit";
      return [{
        id: "ref/cascade-safe",
        resource: m.name,
        message:
          `a DB cascade would hard-delete this row, bypassing its '${f}' — drop the cascade (a parent FK / hard-delete parent cannot honor the soft path; the repo sweep handles the declared-reference side)`,
      }];
    }
    return [];
  },
};

/** `encrypted/not-searchable`: a field cannot be both `encrypted` and `searchable` — a tsvector over
 *  ciphertext is meaningless (and would leak nothing useful). */
export const encryptedNotSearchable: Invariant = {
  id: "encrypted/not-searchable",
  check(ctx) {
    const m = ctx.resource;
    const enc = new Set(m.encrypted);
    return m.searchable.filter((c) => enc.has(c)).map((c) => ({
      id: "encrypted/not-searchable",
      resource: m.name,
      clause: `encrypted.${c}`,
      message:
        `field '${c}' is both encrypted and searchable — full-text search over ciphertext is meaningless`,
    }));
  },
};

/** `encrypted/not-i18n`: a field cannot be both `encrypted` and `i18n` — the translations sidecar
 *  stores plaintext, which would defeat the at-rest encryption. */
export const encryptedNotI18n: Invariant = {
  id: "encrypted/not-i18n",
  check(ctx) {
    const m = ctx.resource;
    const enc = new Set(m.encrypted);
    return m.i18n.filter((c) => enc.has(c)).map((c) => ({
      id: "encrypted/not-i18n",
      resource: m.name,
      clause: `encrypted.${c}`,
      message:
        `field '${c}' is both encrypted and i18n — the translations sidecar would store plaintext, defeating encryption`,
    }));
  },
};

/** `sensitive/not-searchable`: a `sensitive` field (redacted on surface) cannot be `searchable` — its
 *  plaintext tokens would live in the tsvector/GIN index, queryable, defeating the redaction. */
export const sensitiveNotSearchable: Invariant = {
  id: "sensitive/not-searchable",
  check(ctx) {
    const m = ctx.resource;
    const sens = new Set(m.sensitive);
    return m.searchable.filter((c) => sens.has(c)).map((c) => ({
      id: "sensitive/not-searchable",
      resource: m.name,
      clause: `sensitive.${c}`,
      message:
        `field '${c}' is both sensitive and searchable — its plaintext tokens would live in the tsvector index, defeating redaction`,
    }));
  },
};

/** `sensitive/not-i18n`: a `sensitive` field cannot be `i18n` — the translations sidecar would hold its
 *  plaintext where the surface redaction does not reach. */
export const sensitiveNotI18n: Invariant = {
  id: "sensitive/not-i18n",
  check(ctx) {
    const m = ctx.resource;
    const sens = new Set(m.sensitive);
    return m.i18n.filter((c) => sens.has(c)).map((c) => ({
      id: "sensitive/not-i18n",
      resource: m.name,
      clause: `sensitive.${c}`,
      message:
        `field '${c}' is both sensitive and i18n — the translations sidecar would store plaintext the redaction never reaches`,
    }));
  },
};

/** `parent/scope-consistent` (cross-model): a `child` must be scoped IFF its parent is — a scoped
 *  parent with an unscoped child (or vice versa) breaks tenant isolation along the relation. */
export const parentScopeConsistent: Invariant = {
  id: "parent/scope-consistent",
  check(ctx) {
    const m = ctx.resource;
    if (m.parent === null) return [];
    const parent = idxOf(ctx).bySlot.get(`${m.parent}::${m.pgSchema}`)?.[0]; // memoized slot lookup
    if (
      parent && Boolean(parent.features.scope) !== Boolean(m.features.scope)
    ) {
      return [{
        id: "parent/scope-consistent",
        resource: m.name,
        message: `child '${m.name}' scope=${
          Boolean(m.features.scope)
        } but parent '${m.parent}' scope=${Boolean(parent.features.scope)}`,
      }];
    }
    return [];
  },
};

/** `immutable/no-write-routes`: an `immutable` resource removes update AND delete by construction, so
 *  declaring an http `update`/`delete` route is a contradiction — that route can never succeed. */
export const immutableNoWriteRoutes: Invariant = {
  id: "immutable/no-write-routes",
  check(ctx) {
    const m = ctx.resource;
    if (!wholeImmutable(m.features)) return [];
    return ["update", "delete"].filter((k) => k in m.http).map((k) => ({
      id: "immutable/no-write-routes",
      resource: m.name,
      clause: `http.${k}`,
      message:
        `resource is immutable but declares an http '${k}' route — that write is removed by construction, so the route can never succeed`,
    }));
  },
};

/** `http/custom-route-has-op`: every non-CRUD http route key must name a declared `operation` — an http
 *  access level for a route with no backing op is a dangling wire (the route has no handler). */
export const httpCustomRouteHasOp: Invariant = {
  id: "http/custom-route-has-op",
  check(ctx) {
    const m = ctx.resource;
    return Object.keys(m.http).filter((k) =>
      !CRUD_VERB_SET.has(k) && !(k in m.operations)
    ).map((k) => ({
      id: "http/custom-route-has-op",
      resource: m.name,
      clause: `http.${k}`,
      message:
        `http route '${k}' is neither a CRUD verb nor a declared operation — a dangling route with no handler`,
    }));
  },
};
