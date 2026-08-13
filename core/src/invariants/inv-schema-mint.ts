// Barrel re-exports keep import sites stable.
import { staticPermKeys } from "../authz/auth.ts";
import { literalPermKeys, unresolvedPermKeys } from "../authz/perm-probe.ts";
import { httpPolicyMode, WIRE_READ_VERBS } from "../core/app-refs.ts";
import { opRowReadDoor } from "../core/model-guards.ts";
import type { Features } from "../core/faces.ts";
import {
  collectDbTypeFields,
  dbTypeOnWhitelist,
  normalizeSequence,
} from "../data/schema.ts";
import { idxOf } from "./model-index.ts";
import type { Invariant } from "../core/verifier-contract.ts";
import type { Violation } from "../core/structural-violation.ts";

/** `policy/read-protected`: a resource whose rows reach a `"policy"` door without a `rowPolicy` puts an
 *  unprotected table on the wire. The door set is the CRUD reads AND the custom ops that read the rows
 *  (`model-guards.ts §opRowReadDoor`) — the op door serves the same rows through the same route. */
export const readProtected: Invariant = {
  id: "policy/read-protected",
  check(ctx) {
    const m = ctx.resource;
    if (m.hasRowPolicy) return [];
    const out: Violation[] = [];
    for (const read of WIRE_READ_VERBS) {
      // normalizer, not a raw compare — see the twin note in `core/model-guards.ts §exposedUnderPolicy`
      const route = m.http[read];
      if (route !== undefined && httpPolicyMode(route) === "policy") {
        out.push({
          id: "policy/read-protected",
          resource: m.name,
          clause: `http.${read}`,
          message:
            `'${read}' is exposed with policy but the resource declares no rowPolicy — rows are unprotected`,
        });
      }
    }
    const door = opRowReadDoor(m, ctx.model);
    if (door !== undefined) {
      out.push({
        id: "policy/read-protected",
        resource: m.name,
        clause: `operations.${door.op}`,
        message:
          `'${m.name}' is read through ${door.face} but the resource declares no rowPolicy — a custom op is a read door too, and its rows are unprotected`,
      });
    }
    return out;
  },
};

/**
 * `authz/key-resolves` (13-authz.md §2, mirrors `principle/shadow-resolves`): every permission key an op's
 * `policy` requires must resolve to a real entry in the app-wide permission vocabulary. A `requires("typo:key")`
 * naming a key no resource seeds is unreachable by construction — a silent always-deny — so this fails the
 * build.
 *
 * TWO DOORS, one predicate. The op `policy` slot is DATA, so its keys are read statically. A `rowPolicy` is a
 * CLOSURE asking the same question about the same vocabulary, and it was outside this check entirely: a
 * `can(actor, "widget:lst")` in a policy body passed `deno check`, `createApp` and the structural rung
 * alike, and its consequence is the sentence this invariant's own message ends on. The keys are OBSERVED
 * (`authz/perm-probe.ts`), because a closure has no static key list.
 *
 * An ad-hoc actor+input op policy stays out of scope — its keys are neither declared nor derivable from a
 * claim probe, and it gates at call time.
 */
export const authzKeyResolves: Invariant = {
  id: "authz/key-resolves",
  check(ctx) {
    const m = ctx.resource;
    // the live app-wide vocabulary — the union of every resource's auto-seeded `<r>:<op>` perms (app.ts §perms).
    const vocab = idxOf(ctx).permsVocab; // the per-run memo
    const out: Violation[] = [];
    for (const [opName, decl] of Object.entries(m.operations)) {
      const policy = (decl as { readonly policy?: unknown }).policy;
      // every statically-known key — a dangling key in a multi-perm policy is a silent always-deny too.
      for (const key of staticPermKeys(policy)) {
        if (!vocab.has(key)) {
          out.push({
            id: "authz/key-resolves",
            resource: m.name,
            clause: `operations.${opName}.policy`,
            message:
              `op '${opName}' requires permission '${key}' which resolves to no vocabulary key — a dangling authz reference: no resource seeds '${key}', so the op gates on a permission no grant can hold (a silent always-deny)`,
          });
        }
      }
      // The HANDLER's own `can()` literals, read (never run — a handler does the app's real work). A
      // dangling key there is the same silent always-deny as one in the policy slot beside it: the branch is
      // never taken, and the op's behaviour reads as a business rule nobody wrote.
      const handler = (decl as { readonly handler?: unknown }).handler;
      for (const key of literalPermKeys(handler)) {
        if (!vocab.has(key)) {
          out.push({
            id: "authz/key-resolves",
            resource: m.name,
            clause: `operations.${opName}.handler`,
            message:
              `op '${opName}' calls \`can(actor, '${key}')\` in its handler and '${key}' resolves to no vocabulary key — no resource seeds it, so that branch is never taken by any caller and the op behaves as if the rule were written the other way`,
          });
        }
      }
    }
    for (const key of unresolvedPermKeys(m.rowPolicy, vocab)) {
      out.push({
        id: "authz/key-resolves",
        resource: m.name,
        clause: "rowPolicy",
        message:
          `rowPolicy asks \`can(actor, '${key}')\` and '${key}' resolves to no vocabulary key — no resource seeds it, so that branch is never taken by any caller: the rule silently collapses to its other side (usually none(), an always-deny that reads as an empty table)`,
      });
    }
    return out;
  },
};

/**
 * Deriver-guard cluster (`scope/key-minted`, the `columnMinted(...)` family, `i18n/sidecar-minted`): these
 * guard the framework's own deriver output (the emitted DDL), not the by-construction feature guarantee
 * itself (10-invariants.md §by-construction) — a regression in `deriveDDL`/`deriveI18nDDL` that silently
 * stops minting a column is caught. Descriptive id scheme, not the canon roster's own ids.
 *
 * `scope/key-minted`: a resource opting into `scope` must carry the derived `scope_key` column.
 */
export const scopeKeyMinted: Invariant = {
  id: "scope/key-minted",
  check(ctx) {
    const m = ctx.resource;
    if (m.features.scope && !m.ddl.includes("scope_key")) {
      return [{
        id: "scope/key-minted",
        resource: m.name,
        message: "scope feature declared but scope_key column not minted",
      }];
    }
    return [];
  },
};

/** `transition/has-status-field`: declaring `transitions` requires a `status` enum column to govern (the FSM's
 *  state variable). The `.default` naming the initial state is a separate concern owned by `transition/initial-required`. */
export const transitionHasStatus: Invariant = {
  id: "transition/has-status-field",
  check(ctx) {
    const m = ctx.resource;
    if (Object.keys(m.transitions).length > 0) {
      const status = m.columns["status"];
      if (!status || !status.check) {
        return [{
          id: "transition/has-status-field",
          resource: m.name,
          message:
            "transitions declared but the schema has no `status` enum field",
        }];
      }
    }
    return [];
  },
};

/** `unique/cols-exist`: every column named in a `unique` tuple must exist in the schema. */
export const uniqueColsExist: Invariant = {
  id: "unique/cols-exist",
  check(ctx) {
    const m = ctx.resource;
    const out: Violation[] = [];
    for (const tuple of m.unique) {
      for (const col of tuple) {
        if (!(col in m.columns)) {
          out.push({
            id: "unique/cols-exist",
            resource: m.name,
            clause: `unique.${col}`,
            message: `unique references unknown column '${col}'`,
          });
        }
      }
    }
    return out;
  },
};

/** `transition/targets-valid`: every transition source/target must be a declared `status` value. */
export const transitionTargetsValid: Invariant = {
  id: "transition/targets-valid",
  check(ctx) {
    const m = ctx.resource;
    const states = m.columns["status"]?.check;
    if (!states || Object.keys(m.transitions).length === 0) return [];
    const valid = new Set(states);
    const out: Violation[] = [];
    for (const [from, tos] of Object.entries(m.transitions)) {
      if (!valid.has(from)) {
        out.push({
          id: "transition/targets-valid",
          resource: m.name,
          clause: `transitions.${from}`,
          message: `transition source '${from}' is not a status value`,
        });
      }
      for (const to of tos) {
        if (!valid.has(to)) {
          out.push({
            id: "transition/targets-valid",
            resource: m.name,
            clause: `transitions.${from}.${to}`,
            message: `transition target '${to}' is not a status value`,
          });
        }
      }
    }
    return out;
  },
};

/** The schema's declared `status` default — the FSM's entry state. Walks the zod wrapper chain (`default`
 *  may sit above/below optional/nullable). `undefined` ⇔ no declared default. */
function statusDefault(field: unknown): string | undefined {
  let cur = field as {
    def?: { type?: string; defaultValue?: unknown; innerType?: unknown };
  } | undefined;
  while (cur && typeof cur === "object" && cur.def) {
    if (cur.def.type === "default") {
      const dv = cur.def.defaultValue;
      const v = typeof dv === "function" ? (dv as () => unknown)() : dv;
      return typeof v === "string" ? v : undefined;
    }
    cur = cur.def.innerType as typeof cur;
  }
  return undefined;
}

/** `transition/state-reachable`: every declared status value must be reachable from the `status` default via
 *  the transition edges — a value no edge enters is dead modeling (readers/policies assume rows reach it, but
 *  nothing produces it). Skipped when `status` declares no default (not statically knowable). */
export const transitionStateReachable: Invariant = {
  id: "transition/state-reachable",
  check(ctx) {
    const m = ctx.resource;
    const states = m.columns["status"]?.check;
    if (!states || Object.keys(m.transitions).length === 0) return [];
    const entry = statusDefault(
      (m.schema.shape as Record<string, unknown>)["status"],
    );
    if (entry === undefined) return [];
    const reachable = new Set<string>([entry]);
    const queue = [entry];
    while (queue.length > 0) {
      for (const to of m.transitions[queue.pop()!] ?? []) {
        if (!reachable.has(to)) {
          reachable.add(to);
          queue.push(to);
        }
      }
    }
    return states.filter((s) => !reachable.has(s)).map((s) => ({
      id: "transition/state-reachable",
      resource: m.name,
      clause: `status.${s}`,
      message:
        `status value '${s}' is unreachable — no transition path from the default '${entry}' enters it and the framework never sets it; drop the enum value or add the edge/mechanism that produces it`,
    }));
  },
};

/** `transition/initial-required` (04-features.md §transitions): a `transitions` resource must declare its
 *  `status` enum `.default` — without it the create path silently adopts the first enum member, so reordering
 *  the enum silently changes which state a create may set. */
export const transitionInitialRequired: Invariant = {
  id: "transition/initial-required",
  check(ctx) {
    const m = ctx.resource;
    const states = m.columns["status"]?.check;
    if (
      !states || states.length === 0 || Object.keys(m.transitions).length === 0
    ) return []; // not an enum-status transitions resource
    const entry = statusDefault(
      (m.schema.shape as Record<string, unknown>)["status"],
    );
    if (entry !== undefined) return []; // the initial state is declared — complete
    return [{
      id: "transition/initial-required",
      resource: m.name,
      clause: "status.default",
      message:
        `resource '${m.name}' declares 'transitions' but its 'status' enum has no '.default(...)' naming the initial state — add '.default("${
          states[0]
        }")' (or the intended initial). The framework never infers the initial from enum order (a reorder would silently change which state a create may set).`,
    }];
  },
};

/** `expiry/column-minted`: declaring `expiry` must mint the `expires_at` column. */
export const expiryColumnMinted: Invariant = {
  id: "expiry/column-minted",
  check(ctx) {
    const m = ctx.resource;
    if (m.features.expiry && !m.ddl.includes("expires_at")) {
      return [{
        id: "expiry/column-minted",
        resource: m.name,
        message: "expiry declared but expires_at not minted",
      }];
    }
    return [];
  },
};

/** `i18n/sidecar-minted`: translatable fields must mint the `<r>_i18n` sidecar with a cascade FK to the
 *  parent (no orphans) and a composite key over (row, field, locale) (no duplicate-locale rows). */
export const i18nSidecarMinted: Invariant = {
  id: "i18n/sidecar-minted",
  check(ctx) {
    const m = ctx.resource;
    if (m.i18n.length === 0) return [];
    const ddl = m.i18nDdl;
    if (!ddl) {
      return [{
        id: "i18n/sidecar-minted",
        resource: m.name,
        clause: "i18n.sidecar",
        message:
          "translatable fields declared but the `_i18n` sidecar was not minted",
      }];
    }
    const out: Violation[] = [];
    if (!ddl.includes("ON DELETE CASCADE")) {
      out.push({
        id: "i18n/sidecar-minted",
        resource: m.name,
        clause: "i18n.sidecar.cascadeFk",
        message:
          "the `_i18n` sidecar has no CASCADE FK — translation orphans become writable",
      });
    }
    if (!ddl.includes("PRIMARY KEY") && !ddl.toLowerCase().includes("unique")) {
      out.push({
        id: "i18n/sidecar-minted",
        resource: m.name,
        clause: "i18n.sidecar.compositeKey",
        message:
          "the `_i18n` sidecar has no composite key — duplicate-locale rows become writable",
      });
    }
    return out;
  },
};

/** Factory for "feature X declared ⇒ its column(s) minted" structural invariants. */
function columnMinted(
  id: string,
  feature: keyof Features,
  cols: readonly string[],
): Invariant {
  return {
    id,
    check(ctx) {
      const m = ctx.resource;
      if (m.features[feature] && !cols.every((c) => m.ddl.includes(c))) {
        return [{
          id,
          resource: m.name,
          message: `${String(feature)} declared but ${
            cols.join("/")
          } not minted`,
        }];
      }
      return [];
    },
  };
}

export const softdeleteColumnMinted: Invariant = columnMinted(
  "softdelete/column-minted",
  "softDelete",
  ["deleted_at"],
);
export const versioningColumnMinted: Invariant = columnMinted(
  "versioning/column-minted",
  "versioning",
  ["version"],
);
export const timestampsColumnsMinted: Invariant = columnMinted(
  "timestamps/columns-minted",
  "timestamps",
  ["created_at", "updated_at"],
);
export const temporalColumnsMinted: Invariant = columnMinted(
  "temporal/columns-minted",
  "temporal",
  ["valid_from", "valid_to"],
);

/** `sequence/column-minted` (04-features.md §sequence#): declaring `sequence#` must mint the generated
 *  number column named by the card's `field` (e.g. `invoiceNo`), not a hardcoded `seq` — reads the configured
 *  column off `normalizeSequence` so a renamed sequence doesn't false-fire. */
export const sequenceColumnMinted: Invariant = {
  id: "sequence/column-minted",
  check(ctx) {
    const m = ctx.resource;
    const cfg = normalizeSequence(
      m.features.sequence as Parameters<typeof normalizeSequence>[0],
    );
    if (cfg && !m.ddl.includes(`"${cfg.field}"`)) {
      return [{
        id: "sequence/column-minted",
        resource: m.name,
        message:
          `sequence declared but the '${cfg.field}' column was not minted`,
      }];
    }
    return [];
  },
};
export const onrowColumnsMinted: Invariant = columnMinted(
  "onrow/columns-minted",
  "onRow",
  ["created_by_id", "updated_by_id"],
);

/** Framework-generated column names a `dbType()` may never override (03-api-shape.md §4) — the migrator owns
 *  their type. By-id FK columns are added per-resource in the check: they're user-declared but their type
 *  must match the referenced PK, so the seam may not retarget them either. */
const DBTYPE_FRAMEWORK_COLS: ReadonlySet<string> = new Set([
  "id",
  "created_at",
  "updated_at",
  "deleted_at",
  "version",
  "expires_at",
  "valid_from",
  "valid_to",
  "scope_key",
  "created_by_type",
  "created_by_id",
  "updated_by_type",
  "updated_by_id",
  "deleted_by_type",
  "deleted_by_id",
  "search_vector",
]);

/** `dbtype/legal-target` (10-invariants.md `dbtype/legal-target`; 03-api-shape.md §4): a `dbType("<pg type>")`
 *  annotation is legal only on a user-declared, string-backed column, naming a known-mapping whitelist value,
 *  not on a framework-generated column, and not alongside `translatable`. Any fault fails the build. */
export const dbtypeLegalTarget: Invariant = {
  id: "dbtype/legal-target",
  check(ctx) {
    const m = ctx.resource;
    const out: Violation[] = [];
    const annotated = collectDbTypeFields(m.schema);
    const i18nFields = new Set(m.i18n); // translatable fields — a sidecar value is always text, never dbType'd
    // by-id FK columns: a `references` key resolves to a by-id column whose type the migrator owns; the
    // parent FK column (`<parent>_id`) likewise. The seam may not retarget either.
    const fkCols = new Set<string>([
      ...Object.keys(m.references),
      ...(m.parentFk ? [m.parentFk] : []),
    ]);
    for (const [field, { pg, stringBacked }] of Object.entries(annotated)) {
      if (DBTYPE_FRAMEWORK_COLS.has(field) || fkCols.has(field)) {
        out.push({
          id: "dbtype/legal-target",
          resource: m.name,
          clause: `dbType.${field}`,
          message:
            `dbType('${pg}') targets the framework-generated column '${field}' — the migrator owns that column's type and it cannot be overridden through this seam`,
        });
        continue; // a framework column is illegal regardless of the value — report once, the dominant fault
      }
      if (i18nFields.has(field)) {
        out.push({
          id: "dbtype/legal-target",
          resource: m.name,
          clause: `dbType.${field}`,
          message:
            `dbType('${pg}') on '${field}' conflicts with translatable — a translated value lives in the text \`_i18n\` sidecar, so a native column type is meaningless`,
        });
      }
      if (!stringBacked) {
        out.push({
          id: "dbtype/legal-target",
          resource: m.name,
          clause: `dbType.${field}`,
          message:
            `dbType('${pg}') on '${field}' is not on a string-backed column — the seam is for the JS-faithful string representation only (a non-string Zod type already maps structurally)`,
        });
      }
      if (!dbTypeOnWhitelist(pg)) {
        out.push({
          id: "dbtype/legal-target",
          resource: m.name,
          clause: `dbType.${field}`,
          message:
            `dbType('${pg}') on '${field}' is not a known-mapping native type — free text is rejected (a god-knob that could mint any string, including unsafe DDL)`,
        });
      }
    }
    return out;
  },
};
