// Barrel re-exports keep import sites stable.
import type { ResourceModel } from "../core/app.ts";
import type { Invariant } from "../core/verifier-contract.ts";
import type { Violation } from "../core/structural-violation.ts";
import { wholeImmutable } from "../data/schema-normalize.ts";

/** `temporal/not-immutable`: `temporal` and `immutable` are contradictory — `immutable` removes the update
 *  path, so a temporal row's open `valid_to` can never be closed on supersession. */
export const temporalNotImmutable: Invariant = {
  id: "temporal/not-immutable",
  check(ctx) {
    const m = ctx.resource;
    if (m.features.temporal && wholeImmutable(m.features)) {
      return [{
        id: "temporal/not-immutable",
        resource: m.name,
        message:
          "resource is both temporal and immutable — immutable removes the update path, so a row's open valid_to can never be closed on supersession",
      }];
    }
    return [];
  },
};

/** `singleton/not-expiry`: `singleton` and `expiry` are contradictory — the singleton read (`getOrSeedConfig`
 *  / `readSingletonRow`) omits the expiry filter, so `expires_at` would be minted but never enforced. */
export const singletonNotExpiry: Invariant = {
  id: "singleton/not-expiry",
  check(ctx) {
    const m = ctx.resource;
    if (m.features.singleton && m.features.expiry) {
      return [{
        id: "singleton/not-expiry",
        resource: m.name,
        message:
          "resource is both singleton and expiry — the lone config row is read via getOrSeedConfig, which does not apply the expiry filter, so expires_at would be minted but never enforced; drop one",
      }];
    }
    return [];
  },
};

/** `singleton/not-temporal`: `singleton` and `temporal` are contradictory — the singleton read
 *  (`readSingletonRow`) omits the valid-window filter, so `valid_from`/`valid_to` would be minted but never enforced. */
export const singletonNotTemporal: Invariant = {
  id: "singleton/not-temporal",
  check(ctx) {
    const m = ctx.resource;
    if (m.features.singleton && m.features.temporal) {
      return [{
        id: "singleton/not-temporal",
        resource: m.name,
        message:
          "resource is both singleton and temporal — the singleton read does not apply the valid-window filter, so valid_from/valid_to would be minted but never enforced; drop one",
      }];
    }
    return [];
  },
};

/** `unique/not-i18n`: a `unique` tuple may not include an `i18n` field — its real values live per-locale in
 *  the `_i18n` sidecar, so a unique constraint over the base column doesn't enforce on the field's real content. */
export const uniqueNotI18n: Invariant = {
  id: "unique/not-i18n",
  check(ctx) {
    const m = ctx.resource;
    const i18n = new Set(m.i18n);
    const out: Violation[] = [];
    for (const tuple of m.unique) {
      for (const col of tuple) {
        if (i18n.has(col)) {
          out.push({
            id: "unique/not-i18n",
            resource: m.name,
            clause: `unique.${col}`,
            message:
              `unique includes translatable column '${col}' — its real values live per-locale in the _i18n sidecar, so a unique over the base column does not mean what it says`,
          });
        }
      }
    }
    return out;
  },
};

/** `immutable/no-write-mcp`: an `immutable` resource removes update and delete by construction, so curating
 *  an mcp `update`/`delete` tool dispatches to a write path that does not exist. Surface-twin of
 *  `immutable/no-write-routes`, which guards the http face. */
export const immutableNoWriteMcp: Invariant = {
  id: "immutable/no-write-mcp",
  check(ctx) {
    const m = ctx.resource;
    if (!wholeImmutable(m.features)) return [];
    return ["update", "delete"].filter((k) => k in m.mcp).map((k) => ({
      id: "immutable/no-write-mcp",
      resource: m.name,
      clause: `mcp.${k}`,
      message:
        `resource is immutable but curates an mcp '${k}' tool — that write is removed by construction, so the agent tool dispatches to a path that cannot exist`,
    }));
  },
};

/** `softdelete/not-immutable`: `softDelete` and `immutable` are contradictory — `immutable` removes the
 *  delete path, so a row can never be soft-deleted and the softDelete machinery is dead weight. */
export const softdeleteNotImmutable: Invariant = {
  id: "softdelete/not-immutable",
  check(ctx) {
    const m = ctx.resource;
    if (m.features.softDelete && wholeImmutable(m.features)) {
      return [{
        id: "softdelete/not-immutable",
        resource: m.name,
        message:
          "resource is both softDelete and immutable — immutable removes the delete path, so a row can never be soft-deleted and the softDelete machinery is dead",
      }];
    }
    return [];
  },
};

/** `versioning/not-immutable`: `versioning` and `immutable` are contradictory — `immutable` removes the
 *  update path, so `version` never advances and the stale-write check never fires. */
export const versioningNotImmutable: Invariant = {
  id: "versioning/not-immutable",
  check(ctx) {
    const m = ctx.resource;
    if (m.features.versioning && wholeImmutable(m.features)) {
      return [{
        id: "versioning/not-immutable",
        resource: m.name,
        message:
          "resource is both versioning and immutable — immutable removes the update path, so version never advances and the stale-write check never fires",
      }];
    }
    return [];
  },
};

/** `tree/not-immutable`: `tree` and `immutable` are contradictory — `immutable` removes the update path, so
 *  `move()` can never re-parent a node and the hierarchy is frozen at creation. */
export const treeNotImmutable: Invariant = {
  id: "tree/not-immutable",
  check(ctx) {
    const m = ctx.resource;
    if (m.features.tree && wholeImmutable(m.features)) {
      return [{
        id: "tree/not-immutable",
        resource: m.name,
        message:
          "resource is both tree and immutable — immutable removes the update path, so a node can never be re-parented via move() and the hierarchy is frozen at creation",
      }];
    }
    return [];
  },
};

/** `transitions/not-immutable`: a status FSM and a whole-resource `immutable` are contradictory — whole
 *  immutability removes the update path, so status can never transition. Keyed on whole immutability
 *  specifically: a field-level `immutable:{fields}` freezing a non-status column keeps the update path
 *  transitions need, so that pairing is legal and does not fire. */
export const transitionsNotImmutable: Invariant = {
  id: "transitions/not-immutable",
  check(ctx) {
    const m = ctx.resource;
    if (Object.keys(m.transitions).length > 0 && wholeImmutable(m.features)) {
      return [{
        id: "transitions/not-immutable",
        resource: m.name,
        message:
          "resource declares transitions but is whole-resource immutable — immutable removes the update path, so status can never transition (and on a tamperEvident ledger a status write would break the hash chain); drop immutable or drop transitions",
      }];
    }
    return [];
  },
};

/** `tree/not-parent`: `tree` (a self-hierarchy via `parent_id`) and a `parent` child-relation (a different FK
 *  onto another table) are conflicting parent semantics on one resource — a row would carry two unrelated
 *  parent columns and `move()` would be ambiguous about which edge it walks. */
export const treeNotParent: Invariant = {
  id: "tree/not-parent",
  check(ctx) {
    const m = ctx.resource;
    if (m.features.tree && m.parent !== null) {
      return [{
        id: "tree/not-parent",
        resource: m.name,
        message:
          `resource is both a tree (self-hierarchy via parent_id) and a child of '${m.parent}' — two conflicting parent notions on one row; pick one`,
      }];
    }
    return [];
  },
};

/** `onrow/needs-audit`: `onRow` is an `audit` sub-option (10-invariants.md §static-conformance) — declaring
 *  it without `audit` mints the actor-stamp columns with no audit stream giving them meaning. */
export const onrowNeedsAudit: Invariant = {
  id: "onrow/needs-audit",
  check(ctx) {
    const m = ctx.resource;
    if (m.features.onRow && !m.features.audit) {
      return [{
        id: "onrow/needs-audit",
        resource: m.name,
        message:
          "resource declares onRow but not audit — onRow is the audit:{onRow:true} sub-option; without audit the actor-stamp columns are minted with no audit stream giving them meaning",
      }];
    }
    return [];
  },
};

/** True iff a custom op declaration writes — `tx:"write"` or no `tx` at all (default is write; only an
 *  explicit `tx:"read"` is read-only). Reads the opaque `m.operations[name]` value without `as`/`any`. */
function opWrites(v: unknown): boolean {
  const tx = v !== null && typeof v === "object"
    ? (v as Record<string, unknown>)["tx"]
    : undefined;
  return tx !== "read";
}

/** True iff the resource has a real change surface (update/delete reachable). Whole-resource `immutable:true`
 *  strips auto update/delete from the repo, leaving only `create`; only a custom write op (or a field-level
 *  `immutable:{fields}`, which keeps update/delete) restores one. */
function hasMutatingSurface(m: ResourceModel): boolean {
  if (!wholeImmutable(m.features)) return true; // not whole-frozen → auto-CRUD update/delete present
  return Object.values(m.operations).some(opWrites); // whole-immutable: only a custom write op restores a change surface
}

/** `audit/required` (10-invariants.md §static-conformance): a resource declaring `audit` must have a real
 *  mutating surface for the stream to record. Fires when whole-resource `immutable:true` with no custom
 *  write op leaves only `create` — a change trail wired onto something that cannot change past creation. */
export const auditRequired: Invariant = {
  id: "audit/required",
  check(ctx) {
    const m = ctx.resource;
    if (!m.features.audit) return [];
    if (hasMutatingSurface(m)) return []; // a real change surface exists → audit records its updates/deletes
    return [{
      id: "audit/required",
      resource: m.name,
      message:
        "resource declares audit but is whole-resource immutable with no custom write op — update/delete are removed from the repo, so the audit stream can only ever record the create; audit (a change trail) is wired onto a resource that cannot change past creation",
    }];
  },
};

/** `audit/mutating-unaudited` (advisory — 10-invariants.md §static-conformance): the complement of
 *  `audit/required`. A resource with a real change surface but no `audit` feature has no append-only
 *  provenance for its mutations — a discretionary nudge, never a default ship-block. The
 *  `@hazelnut/regulated` profile promotes it to ship-block. */
export const auditMutatingUnaudited: Invariant = {
  id: "audit/mutating-unaudited",
  determinism: "runtime-assert", // advisory axis position → deriveBlocks yields advisory (a profile may promote it; never a default ship-block)
  check(ctx) {
    const m = ctx.resource;
    if (m.features.audit) return []; // already audited — provenance exists
    if (!hasMutatingSurface(m)) return []; // create-only / read-only — no change to record
    return [{
      id: "audit/mutating-unaudited",
      resource: m.name,
      message:
        `resource '${m.name}' has a mutating surface (update/delete or a custom write op) but declares no \`audit\` feature — its mutations leave no append-only provenance trail; enable \`features:{ audit:true }\` if this domain needs a change record (the @hazelnut/regulated profile promotes this to a ship-block)`,
    }];
  },
};
