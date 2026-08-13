// The structural fold: run the roster over the composed model. Pure — no clock, no IO, no override
// overlay, no principle roster, no judge. The verification envelope wraps this; it never re-implements it.
import type { App, ResourceModel } from "../core/app.ts";
import { buildImportGraph, enrich, enrichApp } from "./enrich.ts";
import { buildModelIndex } from "./model-index.ts";
import {
  type AppMetaCheck,
  OPT_IN_INVARIANTS,
  STRUCTURAL_APP_META,
  structuralInvariants,
} from "./roster.ts";
import type {
  VerifyCtx,
  Violation as FullViolation,
} from "../core/verifier-contract.ts";

/** Builds a `VerifyCtx` for one resource — the canonical way to drive a single invariant `check` in isolation.
 *  `source` omitted defaults the model to `[resource]`; the importGraph is built from that model so a
 *  cross-module `check` sees the same dep structure the full fold does. */
export function verifyCtxFor(
  resource: ResourceModel,
  source?: App | ReadonlyArray<ResourceModel>,
): VerifyCtx {
  const model = source === undefined
    ? [resource]
    : Array.isArray(source)
    ? source
    : (source as App).model;
  return {
    resource,
    model,
    importGraph: buildImportGraph(model),
    harness: undefined,
    // an App source carries the DECLARED half of the vocabulary too; a bare model array has only the derived half
    modelIndex: buildModelIndex(
      model,
      source !== undefined && !Array.isArray(source)
        ? (source as App).perms
        : [],
    ),
  };
}

export interface RunStructuralOptions {
  readonly harness?: VerifyCtx["harness"];
  /** The app-singleton checks to fold in; defaults to core's `STRUCTURAL_APP_META`. The verification
   *  envelope passes its own half appended, so there is ONE fold body and the partition is a declared
   *  argument rather than a second implementation. */
  readonly appMeta?: readonly AppMetaCheck[];
}

/** Run the structural rung over the composed app: every per-resource invariant, then the app-singleton
 *  checks. Two passes, one output stream, in that order. */
export function runStructural(
  app: App,
  opts: RunStructuralOptions = {},
): FullViolation[] {
  const importGraph = buildImportGraph(app.model);
  const modelIndex = buildModelIndex(app.model, app.perms); // built ONCE here, read by every per-resource cross-model check
  const perResource = app.model.flatMap((m) =>
    structuralInvariants.flatMap((inv) =>
      inv.check({
        resource: m,
        model: app.model,
        importGraph,
        harness: opts.harness,
        modelIndex,
      }).map((raw) => enrich(raw, m, inv, importGraph))
    )
  );
  const appLevel = (opts.appMeta ?? STRUCTURAL_APP_META).flatMap((inv) =>
    inv(app).map(enrichApp)
  );
  return [...perResource, ...appLevel];
}

/** Drop the opt-in (scenario-only) findings. `promoted` activates them; a core build passes none, so it
 *  always suppresses. ONE body — the envelope's `applyOverrides` calls it too. */
export function applyOptIn(
  violations: ReadonlyArray<FullViolation>,
  promoted?: ReadonlySet<string>,
): FullViolation[] {
  return violations.filter((v) =>
    !OPT_IN_INVARIANTS.has(v.id) || (promoted?.has(v.id) ?? false)
  );
}
