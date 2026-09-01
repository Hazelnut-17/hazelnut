import { CRUD_VERBS } from "../authz/auth.ts";
import type { ResourceModel } from "../core/app.ts";
import { idxOf, resolveNamedTarget } from "./model-index.ts";
import type { Invariant } from "../core/verifier-contract.ts";
import type { Violation } from "../core/structural-violation.ts";

/** `boundary/refs-intra-module` (cross-model): a resource's FK/parent targets must live in the SAME
 *  module — a cross-module FK would qualify to the wrong pg schema (cross-module relations are a recipe,
 *  not a raw FK). Needs the whole app to resolve each target's module. */
export const boundaryRefsIntraModule: Invariant = {
  id: "boundary/refs-intra-module",
  check(ctx) {
    const m = ctx.resource;
    // parent only — a typed cross-module `ref()` is `boundary/cross-ref-by-id` (the id that names
    // `refById`). Firing both was three contradictory ship-blocks for one edge.
    if (!m.parent) return [];
    const target = resolveNamedTarget(ctx, m, m.parent);
    if (!target || target.pgSchema === m.pgSchema) return [];
    return [{
      id: "boundary/refs-intra-module",
      resource: m.name,
      clause: `parent`,
      message:
        `parent '${m.parent}' in another module ('${target.pgSchema}') — cross-module FK is not supported (use a recipe)`,
    }];
  },
};

/** `boundary/declared-deps` (cross-model): a resource may reference another module's resource only if its
 *  owning module declares that module in `deps` — an undeclared cross-module edge is a hidden coupling the
 *  modular boundary forbids. Intra-module edges are owned by `boundary/refs-intra-module`; by-id (`refById`)
 *  targets are out of scope by construction. The module-dep-graph no-cycle clause is a separate app-wide check. */
export const boundaryDeclaredDeps: Invariant = {
  id: "boundary/declared-deps",
  check(ctx) {
    const m = ctx.resource;
    const declared = new Set(m.moduleDeps);
    const targets = [
      ...Object.values(m.references).filter((r) => !r.external).map((r) =>
        r.to
      ),
      ...(m.parent ? [m.parent] : []),
    ];
    const out: Violation[] = [];
    for (const t of targets) {
      const target = resolveNamedTarget(ctx, m, t);
      if (
        target && target.module !== m.module && !declared.has(target.module)
      ) {
        out.push({
          id: "boundary/declared-deps",
          resource: m.name,
          clause: `references.${t}`,
          message:
            `references '${t}' in module '${target.module}' but module '${m.module}' does not declare '${target.module}' in deps — an undeclared cross-module dependency`,
        });
      }
    }
    return out;
  },
};

/** `boundary/cross-ref-by-id` (universal, cross-model, 10-invariants.md §static-conformance): a reference whose target
 *  lives in another module must be by-id (`refById`, `external:true`) — a typed `ref()` across the module
 *  boundary would emit a cross-schema FK, which the modular boundary forbids. Distinct from the schema-keyed
 *  `boundary/refs-intra-module`; this is the canon roster id naming the `refById` fix. Parent relations are
 *  intra-module by construction and out of scope. */
export const boundaryCrossRefById: Invariant = {
  id: "boundary/cross-ref-by-id",
  check(ctx) {
    const m = ctx.resource;
    const out: Violation[] = [];
    for (const [field, r] of Object.entries(m.references)) {
      if (r.external) continue; // a refById by-id target is the correct cross-module pattern — exempt
      const target = resolveNamedTarget(ctx, m, r.to);
      if (target && target.module !== m.module) {
        out.push({
          id: "boundary/cross-ref-by-id",
          resource: m.name,
          clause: `references.${field}`,
          message:
            `reference '${field}' targets '${r.to}' in another module ('${target.module}') with a typed ref() — a cross-module reference must be by-id (use refById('${target.module}.${r.to}')); a cross-schema FK is not allowed`,
        });
      }
    }
    return out;
  },
};

/** The op-name surface a module legitimately exposes on a resource: the five CRUD verbs ∪ the resource's
 *  declared custom ops — the producer-side half of the typed `ctx.modules.<dep>.<op>` facade. */
const resolvableOps = (m: ResourceModel): ReadonlySet<string> =>
  new Set([...CRUD_VERBS, ...Object.keys(m.operations)]);

/** `boundary/cross-call-exposed` (universal, cross-model, 10-invariants.md §static-conformance): a name in a module's
 *  `exposes` surface must resolve to a real op (a CRUD verb or a declared custom op) on some resource of that
 *  module — a dangling exposed name makes a consumer's `ctx.modules.<dep>.<op>` call resolve to no
 *  producer. Fires once per unresolvable name, attributed to the module's first resource.
 *  This is the PRODUCER half of a closed loop: the CONSUMER half is the derived facade
 *  (`core/faces-ctx.ts §ModulesOf`), keyed on `exposes` ∩ the dep's custom ops. The two disagree in one
 *  direction only — a CRUD verb in `exposes` resolves here and is never dispatchable there, so the call
 *  site refuses what this check tolerates, never the reverse. */
export const boundaryCrossCallExposed: Invariant = {
  id: "boundary/cross-call-exposed",
  check(ctx) {
    const m = ctx.resource;
    if (m.moduleExposes.length === 0) return []; // a module that exposes nothing has no facade to dangle.
    // module-granular: fire only on the module's first resource so the (module-owned) exposes surface is not
    // re-charged once per resource.
    const firstOfModule = idxOf(ctx).firstOfModule.get(m.module); // memoized first-of-module
    if (firstOfModule !== m) return [];
    // the union of every op name resolvable anywhere in this module (CRUD verbs ∪ each resource's custom ops).
    const resolvable = new Set<string>();
    for (const r of ctx.model) {
      if (r.module !== m.module) continue;
      for (const op of resolvableOps(r)) resolvable.add(op);
    }
    return m.moduleExposes
      .filter((name) => !resolvable.has(name))
      .map((name) => ({
        id: "boundary/cross-call-exposed",
        resource: m.name,
        clause: `exposes.${name}`,
        message:
          `module '${m.module}' exposes '${name}' but no resource in the module wires that op (not a CRUD verb, not a declared custom op) — the typed ctx.modules.${m.module}.${name} facade derives from this exposes list, so a dangling name makes a consumer's cross-module call resolve to no producer`,
      }));
  },
};

/** `searchable/text-only`: full-text fields must be text columns (a tsvector is built over text). */
export const searchableTextOnly: Invariant = {
  id: "searchable/text-only",
  check(ctx) {
    const m = ctx.resource;
    return m.searchable
      .filter((c) => c in m.columns && m.columns[c]!.pg !== "text")
      .map((c) => ({
        id: "searchable/text-only",
        resource: m.name,
        clause: `searchable.${c}`,
        message: `searchable field '${c}' must be a text column (it is ${
          m.columns[c]!.pg
        })`,
      }));
  },
};

/** `i18n/cols-exist`: every translatable field name must be a real schema column. */
export const i18nColsExist: Invariant = {
  id: "i18n/cols-exist",
  check(ctx) {
    const m = ctx.resource;
    return m.i18n
      .filter((c) => !(c in m.columns))
      .map((c) => ({
        id: "i18n/cols-exist",
        resource: m.name,
        clause: `i18n.${c}`,
        message: `i18n references unknown column '${c}'`,
      }));
  },
};

/** `i18n/text-only`: translatable fields must be text columns (translations are stored as text). */
export const i18nTextOnly: Invariant = {
  id: "i18n/text-only",
  check(ctx) {
    const m = ctx.resource;
    return m.i18n
      .filter((c) => c in m.columns && m.columns[c]!.pg !== "text")
      .map((c) => ({
        id: "i18n/text-only",
        resource: m.name,
        clause: `i18n.${c}`,
        message: `i18n field '${c}' must be a text column (it is ${
          m.columns[c]!.pg
        })`,
      }));
  },
};

/** `sensitive/cols-exist`: every PII field name must be a real schema column. */
export const sensitiveColsExist: Invariant = {
  id: "sensitive/cols-exist",
  check(ctx) {
    const m = ctx.resource;
    return m.sensitive
      .filter((c) => !(c in m.columns))
      .map((c) => ({
        id: "sensitive/cols-exist",
        resource: m.name,
        clause: `sensitive.${c}`,
        message: `sensitive references unknown column '${c}'`,
      }));
  },
};
