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
  checkAsyncNameLiterals,
  checkBoundaryNoCycle,
  checkConfigSingletonResolves,
  checkDatasourceNameResolves,
  checkGateResolves,
  checkMcpGateDeclared,
  checkMcpOriginDeclared,
  checkReadModifyWrite,
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

type AppMetaSpec = {
  readonly ids: readonly string[];
  /** false: the fold fires the id but it stays outside the firing registry (lint-owned, graph-meta, or
   *  unregistered advisory — 10-invariants.md §Registry reconciliation). */
  readonly register: boolean;
  readonly check: AppMetaCheck;
};

const checkNoCycle: AppMetaCheck = (app) =>
  checkBoundaryNoCycle(app.model, app.moduleGraph);
const checkGates: AppMetaCheck = (app) => checkGateResolves(app);
const checkBypass: AppMetaCheck = (app) =>
  checkSystemBypassDeclared([
    ...(app.relay?.subscribers ?? []),
    ...(app.relay?.workers ?? []),
  ]);
const checkPolicy: AppMetaCheck = (app) => checkPolicyRequired(app.views ?? []);
const checkNarrowed: AppMetaCheck = (app) =>
  checkViewProjectionNarrowed(app.views ?? [], app.model);
const checkProtectedProducer: AppMetaCheck = (app) =>
  checkViewReadsProtectedProducer(app.views ?? [], app.model);
const checkExposesSensitive: AppMetaCheck = (app) =>
  checkViewExposesReadSensitive(app.views ?? [], app.model);
const checkBinaryMcp: AppMetaCheck = (app) =>
  checkBinaryViewNotMcp(app.views ?? []);
const checkTasks: AppMetaCheck = (app) => checkTaskNameResolves(app);
const checkMcpOrigin: AppMetaCheck = (app) => checkMcpOriginDeclared(app);
const checkMcpGate: AppMetaCheck = (app) => checkMcpGateDeclared(app);
const checkWorkflows: AppMetaCheck = (app) => checkWorkflowNameResolves(app);
const checkConfig: AppMetaCheck = (app) => checkConfigSingletonResolves(app);
const checkDatasource: AppMetaCheck = (app) => checkDatasourceNameResolves(app);
const checkAsyncNames: AppMetaCheck = (app) => checkAsyncNameLiterals(app);
const checkRmw: AppMetaCheck = (app) => checkReadModifyWrite(app);

/** The app-singleton half of the structural rung — whole-graph and whole-view properties no single
 *  `ResourceModel` carries, so they run once over the composed app rather than in the per-resource loop.
 *  Each spec names the ids its body can emit; `register` is what enters `registeredInvariantIds()`. A
 *  function added here without an `ids` list cannot compile into the array. */
const STRUCTURAL_APP_META_SPECS: readonly AppMetaSpec[] = [
  { ids: ["boundary/no-cycle"], register: true, check: checkNoCycle },
  // SHIP-BLOCKING: an unlocked row read then a write of that row, in one handler. `tx` is not a
  // hygiene/perf concern, so `deriveBlocks` makes it block — which is the point of the MINOR.
  {
    ids: ["tx/read-modify-write"],
    register: true,
    check: checkRmw,
  },
  // WARN, never ship: the job/topic vocabulary is open by design, so this reports a literal no declared
  // consumer answers and refuses nothing. Unregistered — it is an advisory, not a firing invariant.
  {
    ids: ["hygiene/async-name-literal"],
    register: false,
    check: checkAsyncNames,
  },
  { ids: ["authz/gate-resolves"], register: false, check: checkGates },
  {
    ids: ["scope/system-bypass-declared"],
    register: false,
    check: checkBypass,
  },
  { ids: ["policy/required"], register: true, check: checkPolicy },
  {
    ids: ["boundary/cross-read-narrowed"],
    register: false,
    check: checkNarrowed,
  },
  {
    ids: ["view/reads-protected-producer"],
    register: false,
    check: checkProtectedProducer,
  },
  {
    ids: ["boundary/exposes-read-not-sensitive"],
    register: false,
    check: checkExposesSensitive,
  },
  { ids: ["view/binary-not-mcp"], register: false, check: checkBinaryMcp },
  { ids: ["task/name-resolves"], register: true, check: checkTasks },
  { ids: ["workflow/name-resolves"], register: true, check: checkWorkflows },
  { ids: ["config/singleton-resolves"], register: true, check: checkConfig },
  { ids: ["datasource/name-resolves"], register: true, check: checkDatasource },
  { ids: ["mcp/origin-declared"], register: true, check: checkMcpOrigin },
  { ids: ["mcp/gate-declared"], register: true, check: checkMcpGate },
];

for (const spec of STRUCTURAL_APP_META_SPECS) {
  if (spec.ids.length === 0) {
    throw new Error(
      "every STRUCTURAL_APP_META check must declare the ids it can emit",
    );
  }
}

const appMetaSpecByCheck = new WeakMap<AppMetaCheck, AppMetaSpec>();
for (const spec of STRUCTURAL_APP_META_SPECS) {
  appMetaSpecByCheck.set(spec.check, spec);
}

/** The declared ids one core app-meta check may emit, or `undefined` for an envelope check. */
export function declaredAppMetaIds(
  check: AppMetaCheck,
): readonly string[] | undefined {
  return appMetaSpecByCheck.get(check)?.ids;
}

export const STRUCTURAL_APP_META: readonly AppMetaCheck[] =
  STRUCTURAL_APP_META_SPECS.map((s) => s.check);

/** Every id the app-meta fold can emit — registered or not. Derived from the specs, never a second list. */
const APP_META_EMITTED_LIST = STRUCTURAL_APP_META_SPECS.flatMap((
  s,
) => [...s.ids]);
export const STRUCTURAL_APP_META_EMITTED_IDS: ReadonlySet<string> = new Set(
  APP_META_EMITTED_LIST,
);
if (STRUCTURAL_APP_META_EMITTED_IDS.size !== APP_META_EMITTED_LIST.length) {
  throw new Error(
    "STRUCTURAL_APP_META specs must not share an id — the emitted set would hide a duplicate",
  );
}

/** The registered ids the app-meta half owns. Derived from the specs whose `register` is true. The
 *  envelope's two app-meta ids (`version/projection-fresh`, `wiring/declaration-registered`) are NOT here
 *  — they read a committed projection and the app's source tree, neither of which is the model. */
export const STRUCTURAL_APP_META_RUNG_IDS: ReadonlySet<string> = new Set(
  STRUCTURAL_APP_META_SPECS.filter((s) => s.register).flatMap((
    s,
  ) => [...s.ids]),
);

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
