/**
 * THE STRUCTURAL ROSTER — every invariant that is a pure fold over the composed model.
 *
 * The partition it draws is the one the delivery rests on: a check whose only input is the model this app's
 * declarations compose to is CORE's, and a rung needing an input from outside the model (authored source, a
 * committed baseline, the principle roster, a language model) is the verification envelope's
 * (`../verify/roster.ts`). `registeredInvariantIds()` composes the two, so neither half can answer the
 * registry question alone (09-verifier.md §rung-delivery).
 */
import {
  boundaryCrossCallExposed,
  boundaryCrossRefById,
  boundaryDeclaredDeps,
  boundaryRefsIntraModule,
  i18nColsExist,
  i18nTextOnly,
  searchableTextOnly,
  sensitiveColsExist,
} from "./inv-boundary-cols.ts";
import {
  capabilitiesLegalKey,
  capabilitiesNoCrudShadow,
  capabilitiesUnique,
  refOnDeleteHonored,
  rollupsColumnsMinted,
  searchableIndexed,
  uniqueEnforced,
  vectorFilteredScanComplete,
  vectorIndexed,
} from "./inv-cap-vector.ts";
import {
  encryptedColsExist,
  encryptedKeySource,
  expiryNotImmutable,
  handrollShadowsReservedCol,
  httpExposedHasPolicy,
  mcpShapeColsExist,
  noUnusedDeclaration,
  parentNoSelf,
  readmodelPossiblyStale,
  resourceHasId,
  rollupsPossiblyStale,
  searchableNotI18n,
  sensitiveNotInResponse,
  uniqueNoEmptyTuple,
} from "./inv-features.ts";
import {
  auditMutatingUnaudited,
  auditRequired,
  immutableNoWriteMcp,
  onrowNeedsAudit,
  singletonNotExpiry,
  singletonNotTemporal,
  softdeleteNotImmutable,
  temporalNotImmutable,
  transitionsNotImmutable,
  treeNotImmutable,
  treeNotParent,
  uniqueNotI18n,
  versioningNotImmutable,
} from "./inv-immutable.ts";
import {
  affordanceNoInstructionSplice,
  customReadAppliesRowPolicy,
  erasureNoPiiInImmutable,
  timestampsAutoSet,
} from "./inv-lifecycle.ts";
import {
  mcpConfirmOnDestructive,
  mcpReadProtected,
  opHasHandler,
  policyRequiredOp,
  refsPointToExposed,
  resourceRegistered,
} from "./inv-mcp-ops.ts";
import {
  perfPolicyIndexed,
  refExternalNoOnDelete,
  refSetNullNeedsNullable,
  treeclosureNeedsTree,
} from "./inv-perf-ref.ts";
import {
  authzKeyResolves,
  dbtypeLegalTarget,
  expiryColumnMinted,
  i18nSidecarMinted,
  onrowColumnsMinted,
  readProtected,
  scopeKeyMinted,
  sequenceColumnMinted,
  softdeleteColumnMinted,
  temporalColumnsMinted,
  timestampsColumnsMinted,
  transitionHasStatus,
  transitionInitialRequired,
  transitionStateReachable,
  transitionTargetsValid,
  uniqueColsExist,
  versioningColumnMinted,
} from "./inv-schema-mint.ts";
import {
  configDefaultDeclared,
  encryptedNotI18n,
  encryptedNotSearchable,
  httpCustomRouteHasOp,
  immutableNoWriteRoutes,
  parentScopeConsistent,
  refCascadeSafe,
  searchableColsExist,
  sensitiveNotI18n,
  sensitiveNotSearchable,
  treeParentCol,
} from "./inv-schema-shape.ts";
import {
  checkBoundaryNoCycle,
  checkConfigSingletonResolves,
  checkDatasourceNameResolves,
  checkGateResolves,
  checkSystemBypassDeclared,
  checkTaskNameResolves,
  checkWorkflowNameResolves,
} from "./checks-model-graph.ts";
import {
  checkBinaryViewNotMcp,
  checkPolicyRequired,
  checkViewExposesReadSensitive,
  checkViewProjectionNarrowed,
  checkViewReadsProtectedProducer,
} from "./checks-view.ts";
import type { App } from "../core/app.ts";
import type { Invariant } from "../core/verifier-contract.ts";
import type { AppViolation } from "../core/structural-violation.ts";

/** The per-resource structural roster — each entry a pure fold over one `ResourceModel` in the context of
 *  the whole composed model. */
export const structuralInvariants: ReadonlyArray<Invariant> = [
  readProtected,
  authzKeyResolves,
  scopeKeyMinted,
  transitionHasStatus,
  uniqueColsExist,
  transitionTargetsValid,
  transitionStateReachable,
  transitionInitialRequired,
  expiryColumnMinted,
  softdeleteColumnMinted,
  versioningColumnMinted,
  timestampsColumnsMinted,
  temporalColumnsMinted,
  sequenceColumnMinted,
  dbtypeLegalTarget,
  configDefaultDeclared,
  encryptedColsExist,
  encryptedKeySource,
  readmodelPossiblyStale,
  rollupsPossiblyStale,
  treeParentCol,
  searchableColsExist,
  searchableTextOnly,
  i18nColsExist,
  i18nTextOnly,
  i18nSidecarMinted,
  sensitiveColsExist,
  onrowColumnsMinted,
  refCascadeSafe,
  boundaryRefsIntraModule,
  boundaryDeclaredDeps,
  boundaryCrossRefById,
  boundaryCrossCallExposed,
  encryptedNotSearchable,
  encryptedNotI18n,
  sensitiveNotSearchable,
  sensitiveNotI18n,
  parentScopeConsistent,
  immutableNoWriteRoutes,
  httpCustomRouteHasOp,
  resourceHasId,
  handrollShadowsReservedCol,
  noUnusedDeclaration,
  httpExposedHasPolicy,
  mcpShapeColsExist,
  sensitiveNotInResponse,
  searchableNotI18n,
  parentNoSelf,
  uniqueNoEmptyTuple,
  expiryNotImmutable,
  temporalNotImmutable,
  singletonNotExpiry,
  singletonNotTemporal,
  uniqueNotI18n,
  immutableNoWriteMcp,
  softdeleteNotImmutable,
  versioningNotImmutable,
  treeNotImmutable,
  transitionsNotImmutable,
  treeNotParent,
  onrowNeedsAudit,
  auditRequired,
  auditMutatingUnaudited,
  perfPolicyIndexed,
  treeclosureNeedsTree,
  refSetNullNeedsNullable,
  refExternalNoOnDelete,
  mcpReadProtected,
  mcpConfirmOnDestructive,
  policyRequiredOp,
  opHasHandler,
  refsPointToExposed,
  resourceRegistered,
  capabilitiesUnique,
  capabilitiesLegalKey,
  capabilitiesNoCrudShadow,
  searchableIndexed,
  // `vectorIndexed` + `vectorFilteredScanComplete` are the vector deriver-guards, registered here into the
  // per-resource roster in LOCKSTEP with their C3 mutation-suite roster entries.
  vectorIndexed,
  vectorFilteredScanComplete,
  rollupsColumnsMinted,
  uniqueEnforced,
  refOnDeleteHonored,
  timestampsAutoSet,
  erasureNoPiiInImmutable,
  affordanceNoInstructionSplice,
  customReadAppliesRowPolicy,
];

/** One app-singleton check: reads the composed app, nothing else. A core check takes no `MetaInputs` —
 *  every field of that shape names something outside the model, so a check needing one is not core's. */
export type AppMetaCheck = (app: App) => AppViolation[];

/** The app-singleton half of the structural rung — whole-graph and whole-view properties no single
 *  `ResourceModel` carries, so they run once over the composed app rather than in the per-resource loop. */
export const STRUCTURAL_APP_META: readonly AppMetaCheck[] = [
  // the DECLARED graph wins over the model-derived one: a resource-less module contributes no ResourceModel,
  // so its `deps` edges exist only on `app.moduleGraph` (10-invariants.md §boundary).
  (app) => checkBoundaryNoCycle(app.model, app.moduleGraph),
  // `authz/gate-resolves` (13-authz.md §authz-seam): the app-level gates are config cards, not resource
  // members, so no per-resource check can see them — app-singleton, folded here beside its op-face sibling.
  (app) => checkGateResolves(app),
  // `scope/system-bypass-declared` (13-authz.md §7): reads the composed async consumer set off `app.relay`
  // (subscribers + workers `createApp` registered) — app-singleton, so folded here.
  (app) =>
    checkSystemBypassDeclared([
      ...(app.relay?.subscribers ?? []),
      ...(app.relay?.workers ?? []),
    ]),
  // `policy/required` (10-invariants.md §policy/required): a view with no rowPolicy is unauthenticated read
  // access — ship-blocking error, never auto-defaulted (the op face is the advisory `policy/required-op`).
  (app) => checkPolicyRequired(app.views ?? []),
  // `boundary/cross-read-narrowed`: a json run-form view must narrow its row set; a table-form view exposed
  // cross-module via `exposesRead` must declare explicit `columns` (no implicit SELECT * widening).
  (app) => checkViewProjectionNarrowed(app.views ?? [], app.model),
  // `view/reads-protected-producer` (advisory, never ship-blocks): a cross-source view reading a rowPolicy-
  // protected producer is gated only by the view's own `policy`, not the producer's per-row rowPolicy.
  (app) => checkViewReadsProtectedProducer(app.views ?? [], app.model),
  // `boundary/exposes-read-not-sensitive` (advisory, never ship-blocks): a cross-module-exposed view whose
  // `columns` names a producer sensitive/encrypted field declares an incoherent contract.
  (app) => checkViewExposesReadSensitive(app.views ?? [], app.model),
  // `view/binary-not-mcp` (advisory, never ship-blocks): a binary() view with an inert mcp: projection.
  (app) => checkBinaryViewNotMcp(app.views ?? []),
  // The name-keyed ctx doors (`cross-module-face.type-test.ts §NAME_KEYED_OPEN`): `tasks`/`workflows`/
  // `config`/`datasource` each key on a declared name set the composed app carries, so a literal call-site
  // name that doesn't resolve is cross-checkable the same way `authz/key-resolves` cross-checks a `can()`
  // literal. `queue`/`schedule` stay OUT — their vocabulary is imperative and ad-hoc, with no declaration
  // home to check against (the same reason `event/subscribe-declared` never touches a `defineWorker`).
  (app) => checkTaskNameResolves(app),
  (app) => checkWorkflowNameResolves(app),
  (app) => checkConfigSingletonResolves(app),
  (app) => checkDatasourceNameResolves(app),
];

/** The registered ids the app-meta half owns. The envelope's two app-meta ids
 *  (`version/projection-fresh`, `wiring/declaration-registered`) are NOT here — they read a committed projection
 *  and the app's source tree, neither of which is the model. */
export const STRUCTURAL_APP_META_RUNG_IDS: ReadonlySet<string> = new Set([
  "policy/required",
  "boundary/no-cycle",
  "task/name-resolves",
  "workflow/name-resolves",
  "config/singleton-resolves",
  "datasource/name-resolves",
]);

/** Every registered id the core fold can emit — the core half of the firing registry. */
export function structuralInvariantIds(): ReadonlySet<string> {
  return new Set<string>([
    ...structuralInvariants.map((i) => i.id),
    ...STRUCTURAL_APP_META_RUNG_IDS,
  ]);
}

/** Opt-in (scenario-only) invariant ids — suppressed unless an override PROMOTES them. The roster still
 *  RUNS them (so `inv.check` is testable directly). Core has no override surface, so a core build always
 *  suppresses; the envelope's `applyOverrides` calls the same body. */
export const OPT_IN_INVARIANTS: ReadonlySet<string> = new Set<string>([
  "audit/mutating-unaudited",
]);
