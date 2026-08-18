import {
  buildModelEntry,
  finalizeModel,
  groupDeclErrors,
  uniqueIndexCollisions,
} from "./app-boot.ts";
import type { Db, Transactor } from "../data/db.ts";
import { resolveIdStrategy } from "../data/schema.ts";
import { drainFrameworkTopics } from "../data/repo-topics.ts";
import { buildDatasources } from "../data/datasources.ts";
import {
  schedulerJobsFor,
  startFeatureScheduler,
} from "../runtime/scheduler-jobs.ts"; // the scheduler boot choice — roster + wiring from one source (no value cycle: scheduler-jobs imports App as a type only)
import {
  appKeyKms,
  type KeySource,
  type Kms,
  normalizeEncrypted,
  resolveMasterKey,
} from "../features/encrypt.ts";
import { composeReadModelScopes } from "../features/readmodel.ts";
import { mcpToolNames } from "../features/view.ts";
import {
  defaultMemoryRateLimitStore,
  defaultRateLimitStore,
} from "../features/throttle.ts";
import type { Upcaster } from "../features/versioning.ts";
import {
  type CtxExtras,
  defaultSchedulingCap,
  type SchedulingCapConfig,
} from "./ctx.ts"; // the per-app scheduling-cap floor (carried on App, no global) + the injected-ctx-member seam
import type { PromptDef } from "../mcp/prompt.ts";
import type { AnySubscriber, AnyWorker } from "../runtime/events.ts";
import { type WebhookDecl, webhookSubscriber } from "../runtime/webhook.ts";
import { taskWorkerFor } from "../runtime/tasks.ts"; // value import — app.ts → tasks.ts only (tasks imports App as a type, so no value cycle)
import { getRouterFactory } from "./router-port.ts";
import {
  collectModelGuardViolations,
  EVERY_SEAM_ATTESTED,
  readModelGateViolations,
} from "./model-guards.ts";
import { runLiveRelay } from "../runtime/relay.ts"; // in-process async drain — same value-SCC, no new cycle member
import { makeBackpressure } from "../runtime/outbox-emit.ts"; // per-app producer backpressure (05-runtime.md §5.1) — leaf module, no cycle
import { type Actor, sealPermKeys, tenantActor } from "../authz/auth.ts";
import {
  renderAndRouteAlarms,
  type RuntimeAssertsConfig,
} from "../runtime/alarm.ts"; // the in-process relay routes alarms too (parity with the CLI relay)
import {
  type App,
  type AppConfig,
  type BootSeams,
  resolveCtxFactory,
  segmentErr,
  type ServedApp,
} from "./app-define.ts";
import type { ServeConfig } from "../runtime/serve-helpers.ts"; // type-only (erased — no runtime edge): the http-card compile-bind below
import { type Cardinality, opDoorCollisionWarnings } from "./app-refs.ts";
import {
  emitTopics,
  type ResourceDecl,
  type ResourceModel,
} from "./app-types.ts";
import type { z } from "zod";
import type { AppLevelConfig, ScopeConfig, ScopeInput } from "./config.ts";
import type { Features } from "./faces.ts";
import { checkVersions, type VersionDecl } from "./versions.ts";
export { defineVersion } from "./versions.ts"; // re-exported so existing `from core/app.ts` importers keep resolving
export type { VersionDecl } from "./versions.ts";

// `defineConfig` lives in config.ts, re-exported here so the public surface (src/mod.ts) carries it without
// touching mod.ts — additive: createApp's flat `AppConfig` path is unchanged; a defineConfig result is a superset.
export {
  type AppLevelConfig,
  dataMigration,
  type DataMigrationSpec,
  defineConfig,
  type ScopeConfig,
  type ScopeInput,
} from "./config.ts";

// roster/engine extracted into cohesive submodules, re-exported so importers stay stable.
export * from "./app-refs.ts";
export * from "./app-types.ts";
export * from "./app-define.ts";
/** The full `createApp` config surface: the flat `AppConfig` core plus every app-level knob a `defineConfig`
 *  result may carry. Named (not an inline signature intersection) so the whole config shape is discoverable
 *  from one exported type — an `AppLevelConfig` from `defineConfig` structurally satisfies it. */
export interface CreateAppConfig extends AppConfig {
  readonly scope?: ScopeConfig;
  readonly runtimeAsserts?: RuntimeAssertsConfig;
  readonly subscribers?: ReadonlyArray<AnySubscriber>;
  readonly workers?: ReadonlyArray<AnyWorker>;
  /** Declared outbound webhook sinks (05-runtime.md §externalization) — each derives a named subscriber
   *  (`webhook:<name>`) on the same relay substrate (retry → DLQ → redrive). Guards: `webhook/https-required`
   *  · `webhook/secret-required` · `webhook/topic-resolves`. */
  readonly webhooks?: ReadonlyArray<WebhookDecl>;
  readonly upcasters?: Readonly<
    Record<
      string,
      { readonly links: readonly Upcaster[]; readonly currentVersion?: number }
    >
  >;
  readonly prompts?: ReadonlyArray<PromptDef>;
  readonly encryptionKey?: string;
  readonly outbox?: {
    readonly maxReadyBacklog?: number | false;
    readonly gaugeTtlMs?: number;
  };
  /** Task large-result offload (05-runtime.md §task): a `succeeded` result whose bytes exceed `storageThreshold`
   *  is written to the boot-bound `StorageDriver` (`_tasks.result` keeps only the storage-key marker; the poll
   *  answers a presigned `resultUrl`). Absent ⇒ the 256 KiB default; no storage bound keeps results inline. */
  readonly taskResults?: { readonly storageThreshold?: number };
  /** The per-agent scheduling cap on `ctx.queue`/`ctx.schedule`. Absent ⇒ the born-on floor
   *  (`defaultSchedulingCap`); `false` ⇒ disabled; a config ⇒ a custom window/store. Agent-only by construction. */
  readonly schedulingCap?: SchedulingCapConfig | false;
  /** Extra `ctx` members a capability module injects (`core/ctx-surface.ts §CtxExtras`) — threaded through
   *  the op surface and ADDED to every op ctx. One or many: N modules each contribute their own rather than
   *  merging by hand. Core composes none, and no contributor may restate a member core composed, or one
   *  another contributor already defined — either collision throws rather than silently losing an injection. */
  readonly ctxExtras?: CtxExtras | readonly CtxExtras[];
  readonly versions?: ReadonlyArray<VersionDecl>;
  /** The HTTP card, threaded to `ServeConfig.http` (compile-bound below, so the two shapes cannot drift).
   *  `maxBodyBytes` is the hardening floor (05-runtime.md §serve-floors) on request body bytes; absent → the
   *  1 MiB default, `false` → uncapped. `requestTimeoutMs` is the opt-in wall-clock deadline — an overrunning
   *  request gets a transport-level 504 and the deadline merges into `ctx.signal` (05-runtime.md §op-pipeline). */
  readonly http?: {
    readonly maxBodyBytes?: number | false;
    readonly requestTimeoutMs?: number;
  };
  /** MCP transport policy (12-mcp §7): `allowedOrigins` is the opt-in Origin allowlist (DNS-rebinding defense)
   *  the served `/mcp` route enforces; absent ⇒ no Origin check. `instructions` is the one authored
   *  business-context sentence projected into the MCP `initialize` field (12-mcp.md §server-instructions);
   *  bridged to `ServeConfig.mcpInstructions` below, where a `boot.mcpInstructions` seam override wins. */
  readonly mcp?: {
    readonly allowedOrigins?: readonly string[];
    readonly instructions?: string;
    /** The runtime projection opt-in (12-mcp.md §runtime-projection): mounts the two `hazelnut-runtime://`
     *  read-only resources (`relay`, `dlq` — metadata only, never payloads) for callers holding `gate`.
     *  Absent ⇒ not mounted; an empty `gate` is a loud boot refuse (`mcp/runtime-gate-required`). */
    readonly runtime?: { readonly gate: string };
  };
  /** `/openapi.json` exposure: opt-in like an `http` route. Absent ⇒ not mounted; `{ public: true }`
   *  ⇒ ungated public API doc; `{ gate: PermKey }` ⇒ deny-by-default (mirrors `/version`). */
  readonly openapi?: { readonly public?: boolean; readonly gate?: string };
 /** `GET /version` exposure: opt-in, deny-by-default — the sibling of `openapi`.
   *  Absent ⇒ not mounted (a probe gets 404, no build-identity leak); set ⇒ requires `can(actor, gate)` and
   *  returns the framework pin plus the app's own `appVersion`. Threaded to `ServeConfig.version` below. */
  readonly version?: { readonly gate: string; readonly appVersion?: string };
  /** The MANUALLY declared half of the permission vocabulary (13-authz.md §2) — `definePerms`'s output,
   *  handed back so the app-wide catalogue carries it. `derivePerms` mints `<resource>:<verb>` and cannot
   *  mint a key no resource seeds (a role, an operator floor like `system:ops`), so without this every such
   *  key is a `authz/key-resolves` violation at the one door the framework offers for declaring it. Accepts
   *  `definePerms`'s nested shape and a flat key list; both flatten to the same wire strings `claims` holds. */
  readonly perms?:
    | Readonly<Record<string, Readonly<Record<string, string>>>>
    | readonly string[];
}
// The legal `createApp` config keys, compile-bound to `CreateAppConfig` (the ERR_KINDS idiom): a new config
// field missing here fails `deno check` at the assertion below, so the unknown-key check can't silently lag.
export const CONFIG_KEYS = [
  "resources",
  "datasources",
  "modules",
  "id",
  "views",
  "subscribers",
  "workers",
  "webhooks",
  "upcasters",
  "prompts",
  "readModels",
  "workflows",
  "tasks",
  "jobs",
  "versions",
  "scope",
  "runtimeAsserts",
  "encryptionKey",
  "outbox",
  "schedulingCap",
  "ctxExtras",
  "http",
  "mcp",
  "openapi",
  "version",
  "taskResults",
  "perms",
] as const satisfies readonly (keyof CreateAppConfig | keyof AppLevelConfig)[];
type _AssertTrueCfg<T extends true> = T;
type _ConfigKeysComplete = _AssertTrueCfg<
  Exclude<
    keyof CreateAppConfig | keyof AppLevelConfig,
    (typeof CONFIG_KEYS)[number]
  > extends never ? true : false
>;
// The config `http` card is compile-bound to `ServeConfig["http"]` (key-set equality both directions plus
// `Required` mutual assignability), so a router http knob can never ship config-invisible.
type _CfgHttpCard = NonNullable<CreateAppConfig["http"]>;
type _ServeHttpCard = NonNullable<ServeConfig["http"]>;
type _HttpCardBound = _AssertTrueCfg<
  Exclude<keyof _ServeHttpCard, keyof _CfgHttpCard> extends never
    ? Exclude<keyof _CfgHttpCard, keyof _ServeHttpCard> extends never
      ? [Required<_CfgHttpCard>] extends [Required<_ServeHttpCard>]
        ? [Required<_ServeHttpCard>] extends [Required<_CfgHttpCard>] ? true
        : false
      : false
    : false
    : false
>;
/** The small closed inner cards worth the same strictness. Each card's key set is compile-bound to its card
 *  type both directions, so an inner knob added to a card type but omitted here is a compile error, not a silent runtime boot-refuse. */
type _InnerCardKeys = {
  outbox: keyof NonNullable<CreateAppConfig["outbox"]>;
  taskResults: keyof NonNullable<CreateAppConfig["taskResults"]>;
  http: keyof NonNullable<CreateAppConfig["http"]>;
  mcp:
    | keyof NonNullable<CreateAppConfig["mcp"]>
    | keyof NonNullable<AppLevelConfig["mcp"]>;
  openapi: keyof NonNullable<CreateAppConfig["openapi"]>;
  version: keyof NonNullable<CreateAppConfig["version"]>;
};
export const CONFIG_INNER_KEYS = {
  outbox: ["maxReadyBacklog", "gaugeTtlMs"],
  taskResults: ["storageThreshold"],
  http: ["maxBodyBytes", "requestTimeoutMs"],
  mcp: ["allowedOrigins", "instructions", "runtime"],
  openapi: ["public", "gate"],
  version: ["gate", "appVersion"],
} as const satisfies {
  readonly [P in keyof _InnerCardKeys]: readonly _InnerCardKeys[P][];
};
// completeness (the other direction — `satisfies readonly X[]` admits a subset): every card-type key must
// be listed, so an inner knob added to a card type forces a matching entry here, not a silent boot-refuse.
type _InnerKeysComplete = _AssertTrueCfg<
  {
    [P in keyof _InnerCardKeys]: Exclude<
      _InnerCardKeys[P],
      (typeof CONFIG_INNER_KEYS)[P][number]
    >;
  }[keyof _InnerCardKeys] extends never ? true : false
>;

// Overloads: the no-boot call composes the pure model (no `fetch`); a `boot` bundle adds `fetch`, so
// `Deno.serve(app.fetch)` on a model-only app is a compile error. Boot overload comes first (return type is the last).
/** The Deno-major runtime floor — Deno has no `engines` field to enforce a version at install, so `createApp`
 *  checks on every path. Lower bound only (`< 2`); the version is passed in, not read from `Deno.version`, so the floor is unit-testable. */
export function assertDenoSupported(version: string): void {
  const major = Number(version.split(".")[0]);
  if (Number.isFinite(major) && major < 2) {
    throw new Error(
      `[hazelnut] running on Deno ${version} — Hazelnut requires Deno 2.x; older runtimes are unsupported. Upgrade the Deno runtime.`,
    );
  }
}

export function createApp(config: CreateAppConfig, boot: BootSeams): ServedApp;
export function createApp(config: CreateAppConfig): App;
export function createApp(
  config: CreateAppConfig,
  boot?: BootSeams,
): App | ServedApp {
  // normalize modules + flat resources into one unit list, each carrying its module + pg schema + the
  // module's declared `deps` (the boundary/declared-deps source — see 10-invariants.md §boundary).
  const units: Array<
    {
      module: string;
      pgSchema: string;
      moduleDeps: readonly string[];
      moduleExposes: readonly string[];
      moduleExposesRead: readonly string[];
      moduleEmits: readonly string[];
      decl: ResourceDecl;
    }
  > = [];
  for (const m of config.modules ?? []) {
    for (const decl of m.resources) {
      units.push({
        module: m.name,
        pgSchema: m.name,
        moduleDeps: m.deps ?? [],
        moduleExposes: m.exposes ?? [],
        moduleExposesRead: m.exposesRead ?? [],
        moduleEmits: emitTopics(m.emits),
        decl,
      });
    }
  }
  for (const decl of config.resources ?? []) {
    units.push({
      module: "app",
      pgSchema: "public",
      moduleDeps: [],
      moduleExposes: [],
      moduleExposesRead: [],
      moduleEmits: [],
      decl,
    });
  }

  const errs: string[] = [];

  // config unknown-key check (the `decl/unknown-key` mirror at the config level): `defineConfig` is a typed
  // identity, so a config assembled loosely (a widened variable, a spread) could carry a typo'd knob that
  // silently keeps its default. The key roster is compile-bound to `CreateAppConfig` below.
  for (const k of Object.keys(config)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(k)) {
      errs.push(
        k === "auth"
          ? `config/unknown-key: 'auth' is not a defineConfig key — pass it on the boot seam: createApp(config, { auth })`
          : `config/unknown-key: unknown config key '${k}' — a typo'd knob silently keeps its default; the legal keys are the defineConfig surface`,
      );
    }
  }
  for (const [parent, allowed] of Object.entries(CONFIG_INNER_KEYS)) {
    const inner = (config as Record<string, unknown>)[parent];
    if (
      inner === undefined || inner === null || typeof inner !== "object" ||
      Array.isArray(inner)
    ) continue;
    for (const k of Object.keys(inner)) {
      if (!(allowed as readonly string[]).includes(k)) {
        errs.push(
          `config/unknown-key: unknown key '${k}' on config.${parent} — the card is { ${
            allowed.join(", ")
          } }`,
        );
      }
    }
  }
  // webhook declaration guards (05-runtime.md §externalization): a typo'd topic must not silently deliver
  // nothing, an unkeyed sink must not deliver unverifiably, and http must not leave the machine unopted-in.
  if (config.webhooks?.length) {
    const emitted = new Set<string>();
    for (const m of config.modules ?? []) {
      const e =
        (m as { emits?: readonly string[] | Readonly<Record<string, unknown>> })
          .emits;
      if (Array.isArray(e)) { for (const t of e) emitted.add(t); }
      else if (e && typeof e === "object") {
        for (const t of Object.keys(e)) emitted.add(t);
      }
    }
    for (const w of config.webhooks) {
      let proto: string | null = null;
      try {
        proto = new URL(w.url).protocol;
      } catch { /* unparseable → refuse below */ }
      if (proto === null) {
        errs.push(
          `webhook/https-required: webhook '${w.name}' has an unparseable url '${w.url}'`,
        );
      } else if (proto !== "https:" && w.allowInsecureHttp !== true) {
        errs.push(
          `webhook/https-required: webhook '${w.name}' targets ${w.url} — an outbound webhook carries a signed payload over the open network. Point it at an https url (terminate TLS at the receiver, or in front of it). A receiver on your own dev machine is the one exception, and allowInsecureHttp: true is how this declaration says so, loudly and per webhook.`,
        );
      }
      if (w.sign !== false && !w.secret) {
        errs.push(
          `webhook/secret-required: webhook '${w.name}' has no secret — deliveries would be unverifiable by the receiver. Source one (env → config, the encryptionKey precedent), or declare sign: false explicitly.`,
        );
      }
      if (!emitted.has(w.topic)) {
        errs.push(
          `webhook/topic-resolves: webhook '${w.name}' externalizes topic '${w.topic}', but no module declares that emit — it would never deliver. Declared emits: ${
            [...emitted].sort().join(", ") || "(none)"
          }.`,
        );
      }
    }
  }
  // `mcp/runtime-gate-required` (12-mcp.md §runtime-projection): the runtime projection has no ungated form —
  // an empty gate would mount the operator read floor (relay/dlq) open to any caller, served or not.
  if (config.mcp?.runtime && config.mcp.runtime.gate.trim() === "") {
    errs.push(
      `mcp/runtime-gate-required: defineConfig({ mcp: { runtime } }) declares the runtime projection with an empty gate — the operator read floor (relay/dlq) is never ungated. Name the perm a caller must hold — and one the vocabulary carries, since authz/gate-resolves refuses a dangling one: either a derived <resource>:<verb> key, or an operator key declared with perms: definePerms({ system: [\"ops\"] }) and gated as { runtime: { gate: \"system:ops\" } }. Or remove the runtime block.`,
    );
  }

  // typed emits (05-runtime.md §event-surface-lock): fold each module's `{ topic: zod }` declarations into the
  // canonical app-level schema map the event-surface lock serializes and `ctx.emit` strict-parses against.
  // Two modules typing the same topic is an ambiguous producer contract → loud boot fail.
  const emitSchemas: Record<string, z.ZodType> = {};
  for (const m of config.modules ?? []) {
    if (!m.emits || Array.isArray(m.emits)) continue;
    for (const [topic, schema] of Object.entries(m.emits)) {
      if (topic in emitSchemas) {
        errs.push(
          `event/emit-topic-unique: topic '${topic}' carries a typed payload declaration in more than one module — one topic, one producer contract`,
        );
        continue;
      }
      emitSchemas[topic] = schema as z.ZodType;
    }
  }
  for (const m of config.modules ?? []) {
    const e = segmentErr(m.name, "module");
    if (e) errs.push(e);
  } // module names (the flat "app" module is framework-legal)
  // `deps` names must resolve to a declared module — a typo'd string (`"inventori"`) must not silently
  // land on `moduleGraph` and be skipped by `boundary/no-cycle` (which only walks known nodes).
  const moduleNames = new Set((config.modules ?? []).map((m) => m.name));
  for (const m of config.modules ?? []) {
    for (const dep of m.deps ?? []) {
      if (!moduleNames.has(dep)) {
        errs.push(
          `deps/module-exists: module '${m.name}' declares dep '${dep}', which is not a declared module — add defineModule({ name: '${dep}', … }) or fix the typo`,
        );
      }
    }
  }
  const model: ResourceModel[] = [];
  const names = new Set(units.map((u) => u.decl.name));

 // read-model pre-pass: index each `defineReadModel` by its source resource
  // (`readModelSinks`; unknown source ⇒ loud boot fail). `defineReadModel` is the ONLY source of a
  // projection — a version that wants one declares it like any other, beside the resource it projects.
  //
  // A read model belongs to the module that owns its source: that placement is what lets
  // `Ctx<typeof module>` type `ctx.readModels.<name>` without widening `ctx.data` past the module boundary.
  // The app-level slot carries the projections whose source is itself app-level.
  const moduleReadModels = (config.modules ?? []).flatMap((m) =>
    (m.readModels ?? []).map((rm) => ({ rm, module: m.name }))
  );
  const readModels = [
    ...(config.readModels ?? []),
    ...moduleReadModels.map((x) => x.rm),
  ];
  // resource name → the module that declares it; a module read model's source must be in that same module.
  const moduleOfResource = new Map(units.map((u) => [u.decl.name, u.module]));
  // Where each resource NAME lives, read off the declaration rather than the `"app"` sentinel `units`
  // stamps: a module may legally BE named "app", and the two homes must not be conflated when deciding
  // where a projection sits. A LIST, not one home — schema-per-module makes resource names non-unique
  // (two modules may each declare `invoice`; they land in different pg schemas), so `source` is a bare name
  // in a namespace that is not one-to-one, and picking a winner would be a silent wrong answer.
  const homesOf = new Map<string, string[]>();
  const addHome = (name: string, home: string) =>
    homesOf.set(name, [...(homesOf.get(name) ?? []), home]);
  for (const d of config.resources ?? []) addHome(d.name, "app level");
  for (const m of config.modules ?? []) {
    for (const d of m.resources) addHome(d.name, `module '${m.name}'`);
  }
  const appLevelSources = new Set(
    (config.resources ?? []).map((d) => d.name),
  );
  /** The ambiguity refusal, or null. A projection cannot say which same-named resource it projects, so
   *  neither placement guard below can answer — it fails closed rather than resolving to a home by luck. */
  const ambiguousSource = (rm: { name: string; source: string }) => {
    const homes = homesOf.get(rm.source) ?? [];
    return homes.length > 1
      ? `readmodel/source-ambiguous: read-model '${rm.name}' names source '${rm.source}', which is declared in ${homes.length} places (${
        homes.join(", ")
      }) — a projection must name one resource, and a bare name cannot pick between same-named resources in different schemas. Rename one of them, or drop the projection.`
      : null;
  };
  for (const { rm } of moduleReadModels) {
    const amb = ambiguousSource(rm);
    if (amb) errs.push(amb);
  }
  for (const rm of config.readModels ?? []) {
    const amb = ambiguousSource(rm);
    if (amb) errs.push(amb);
  }
  for (const { rm, module } of moduleReadModels) {
    if ((homesOf.get(rm.source) ?? []).length > 1) continue; // `readmodel/source-ambiguous` above owns it
    if (appLevelSources.has(rm.source)) {
      errs.push(
        `readmodel/source-in-module: read-model '${rm.name}' is declared on module '${module}' but its source '${rm.source}' is declared at app level — a projection lives where its source lives, so leave it in the app-level \`readModels:\` slot, or move '${rm.source}' onto module '${module}'`,
      );
      continue;
    }
    const owner = moduleOfResource.get(rm.source);
    if (owner !== undefined && owner !== module) {
      errs.push(
        `readmodel/source-in-module: read-model '${rm.name}' is declared on module '${module}' but its source '${rm.source}' belongs to module '${owner}' — a projection lives with the resource it projects, or it reads across a boundary the module graph forbids`,
      );
    }
  }
  // A projection belongs where its SOURCE lives. The app-level slot is therefore wrong exactly when the
  // source sits on a module: only the module placement lets `Ctx<typeof module>` type
  // `ctx.readModels.<name>`, where the app-level slot leaves the face `Record<string, Reader | undefined>`
  // and a hallucinated name compiles again.
  //
  // The trigger is the SOURCE's home, NEVER "this app declares modules". A source declared at app level has
  // no module to move to — app level IS its home, and `Ctx<typeof config>` types it there — so firing on the
  // app's shape closed both slots at once behind an instruction nothing could satisfy.
  for (const rm of config.readModels ?? []) {
    if ((homesOf.get(rm.source) ?? []).length > 1) continue; // `readmodel/source-ambiguous` above owns it
    if (appLevelSources.has(rm.source)) continue;
    const owner = moduleOfResource.get(rm.source);
    if (owner === undefined) continue; // unknown source — `readmodel/source-exists` below owns that
    errs.push(
      `readmodel/placement: read-model '${rm.name}' is declared at app level but its source '${rm.source}' belongs to module '${owner}' — move it onto that module (\`defineModule({ …, readModels: [${rm.name}] })\`), so \`Ctx<typeof ${owner}>\` types \`ctx.readModels.${rm.name}\` instead of leaving it an untyped Record`,
    );
  }
  /** The rowPolicy in EFFECT for a source resource — the declared one, or the `boot.rowPolicies` injection
   *  when the declaration has none (`GuardSeams.rowPolicyOf`'s rule: an injected policy faces the same test
   *  as a declared one, or the injection lane becomes the way around the guard). */
  const sourceRowPolicy = (name: string): unknown =>
    units.find((u) => u.decl.name === name)?.decl.rowPolicy ??
      boot?.rowPolicies?.[name];
  const readModelsBySource = new Map<string, string[]>();
  const seenRmNames = new Set<string>();
  for (const rm of readModels) {
    const e = segmentErr(rm.name, "read-model");
    if (e) {
      errs.push(e);
      continue;
    }
    // the projection table is unqualified (public) and, on the prod-generate path, emitted as a drizzle
    // `const` — an unsafe name silently aliases a framework/resource table in dev and breaks drizzle-kit in prod.
    if (rm.name.startsWith("_")) {
      errs.push(
        `readmodel/reserved-name: read-model '${rm.name}' is _-prefixed — that namespace is reserved for framework tables; a '_'-named projection aliases a framework _* table in dev and collides with its drizzle const in prod`,
      );
      continue;
    }
    if (/^[0-9]/.test(rm.name)) {
      errs.push(
        `readmodel/name-shape: read-model '${rm.name}' starts with a digit — the prod drizzle-generate emits the projection as a JS \`const\`, which cannot start with a digit`,
      );
      continue;
    }
    if (names.has(rm.name)) {
      errs.push(
        `readmodel/name-collision: read-model '${rm.name}' collides with a resource of the same name — the projection table would alias the resource table`,
      );
      continue;
    }
    if (seenRmNames.has(rm.name)) {
      errs.push(
        `readmodel/duplicate-name: two read-models are named '${rm.name}' — projection table names must be unique`,
      );
      continue;
    }
    seenRmNames.add(rm.name);
    if (!names.has(rm.source)) {
      errs.push(
        `readmodel/source-exists: read-model '${rm.name}' has source '${rm.source}', which is not a declared resource`,
      );
      continue;
    }
    // `readmodel/rowpolicy-required` is NOT here: it reads the composed model (an exposed op reaching
    // `ctx.readModels` is one of its two firing conditions), so it runs below, once the model exists.
    (readModelsBySource.get(rm.source) ??
      readModelsBySource.set(rm.source, []).get(rm.source)!).push(rm.name);
  }

  // the app-key floor (04-features.md §encrypted): resolve the master key once, only when some resource
  // declares `encrypted`, via `defineConfig({ encryptionKey })` — the single key path (the framework reads no
  // branded env var, 05-runtime.md §config-sourcing). NEVER auto-generated — a regenerated key orphans every
  // existing ciphertext — so a missing key is a loud boot refuse below.
  const anyEncrypted = units.some((u) =>
    normalizeEncrypted(u.decl.encrypted).fields.length > 0
  );
  const { key: masterKey, source: keySource } = anyEncrypted
    ? resolveMasterKey(config.encryptionKey)
    : { key: null, source: "none" as KeySource };
  // does any resource opt into row-scoping (04-features.md §scope)? Mirrors `anyEncrypted`: a structural
  // opt-in that imposes a boot obligation on the served path — an app-wide `config.scope` resolver to supply
  // the per-request scope value. Without it, every row silently shares the empty `""` scope.
  const anyScoped = units.some((u) => u.decl.features?.scope === true);

  // `owns` pre-pass (02-dsl.md §owns): the owning relation lives on the parent, but the FK lives on the
  // child. Resolve each owned child → parent + cardinality + unique before the model loop, so the child's
  // DDL/model fills `ResourceModel.parent` / `parentFk` (cascade, rollups, children()).
  const ownsByChild = new Map<
    string,
    {
      parent: string;
      pgSchema: string;
      cardinality: Cardinality;
      unique: readonly (readonly string[])[];
    }
  >();
  const ownsByParent = new Map<
    string,
    Record<string, { child: string; cardinality: Cardinality }>
  >();
  const schemaByOwner = new Map(units.map((u) => [u.decl.name, u.pgSchema]));
  for (const { pgSchema, decl } of units) {
    for (const [rel, spec] of Object.entries(decl.owns ?? {})) {
      const e = segmentErr(rel, "owns relation");
      if (e) {
        errs.push(e);
        continue;
      }
      if (!names.has(spec.to)) {
        errs.push(
          `owns/child-exists: '${decl.name}.${rel}' owns unknown resource '${spec.to}'`,
        );
        continue;
      }
      if (spec.to === decl.name) {
        errs.push(`owns/no-self: '${decl.name}.${rel}' cannot own itself`);
        continue;
      }
      // `owns` is intra-module: the child FK is a real same-schema FK (04-features.md §344 — owns/relates are
      // between distinct resources of the same module). A cross-module owned child has no FK to emit (by-id only).
      if (schemaByOwner.get(spec.to) !== pgSchema) {
        errs.push(
          `owns/same-module: '${decl.name}.${rel}' owns '${spec.to}' across modules — owned children are intra-module (cross-module is a by-id reference, not ownership)`,
        );
        continue;
      }
      const prior = ownsByChild.get(spec.to);
      if (prior) {
        errs.push(
          `owns/single-parent: '${spec.to}' is owned by both '${prior.parent}' and '${decl.name}' — a child has at most one owning parent`,
        );
        continue;
      }
      ownsByChild.set(spec.to, {
        parent: decl.name,
        pgSchema,
        cardinality: spec.cardinality,
        unique: spec.unique ?? [],
      });
      const byRel = ownsByParent.get(decl.name) ?? {};
      byRel[rel] = { child: spec.to, cardinality: spec.cardinality };
      ownsByParent.set(decl.name, byRel);
    }
  }
  // onDelete honesty pre-pass (03-api-shape.md §onDelete): a declared `onDelete:'cascade'`/`'set-null'` is
  // emitted as a DB clause only when exactly equivalent — the parent has no softDelete and the child has
  // neither softDelete nor audit; otherwise the clause is dropped and a repo sweep inside the delete tx
  // honors it instead (a DB cascade would hard-delete around the soft path and leave no `_audit` row).
  const featOf = (name: string): Features =>
    units.find((u) => u.decl.name === name)?.decl.features ?? {};
  // the keys (`<childName>.<field>`) whose declared DB onDelete clause must be stripped (the repo sweep owns it).
  const ddlSweptRefs = new Set<string>();
  // the keys (`<childName>.<field>`) whose declared `restrict` needs a repo pre-check (03-api-shape.md
  // §onDelete): a plain restrict/no-action clause already blocks a parent hard delete, but a soft-deleting
  // parent's delete is an UPDATE the clause cannot fire on, so it gets a repo pre-check that aborts the
  // delete while a matching child still references it. The DDL clause itself is unaffected — the sweep is added.
  const restrictSweepRefs = new Set<string>();
  for (const u of units) {
    const childF = u.decl.features ?? {};
    for (const [field, r] of Object.entries(u.decl.references ?? {})) {
      if (r.external) continue; // external (refById) targets carry no in-model FK to reconcile
      if (r.onDelete === "cascade" || r.onDelete === "set-null") {
        const parentF = featOf(r.to);
        const honest = !parentF.softDelete && !childF.softDelete &&
          !childF.audit; // emit DDL iff exactly equivalent
        if (!honest) ddlSweptRefs.add(`${u.decl.name}.${field}`); // a repo sweep replaces the dishonest DB clause
      } else if (r.onDelete === "restrict" && featOf(r.to).softDelete) {
        restrictSweepRefs.add(`${u.decl.name}.${field}`); // soft-deleting parent: the clause can't fire on its UPDATE → repo pre-check
      }
    }
  }

  for (const u of units) {
    const { entry, errs: entryErrs } = buildModelEntry(u, {
      names,
      ddlSweptRefs,
      idStrategyByName: new Map(
        units.map((x) => [
          x.decl.name,
          resolveIdStrategy(x.decl.id, config.id, `resource '${x.decl.name}'`),
        ]),
      ),
      ownsByChild,
      ownsByParent,
      readModelsBySource,
      keySource,
      configId: config.id,
    });
    model.push(entry);
    errs.push(...entryErrs);
  }
  // unique/duplicate-cols: the derived unique-index name is a per-pg-schema object, so a name collision is
  // app-global — scan every model's unique + scoped-singleton names now that model[] is fully built. A
  // cross-resource clash silently drops one unique at `CREATE UNIQUE INDEX IF NOT EXISTS`, so it never exists.
  errs.push(...uniqueIndexCollisions(model));
  // password-recipe binding check (fail-closed at boot): the login/refresh factories are stringly-configured
  // (`userResource`/field names) with no tie to the declaration they're attached to. Every field is validated
  // here against the declared model — existence-against-the-declared-set also closes the hostile-interpolation
  // surface: only a declared column name can reach the recipe's quoted SQL.
  for (const u of units) {
    for (const [opName, op] of Object.entries(u.decl.operations ?? {})) {
      // optional-chained: `operations` is erased to `unknown` values, so a null/undefined op reaches here and
      // must fall through to the `op/decisions-written` refusal rather than TypeError out of composition.
      const b = (op as
        | {
          _passwordBinding?:
            import("../features/password-auth.ts").PasswordOpBinding;
        }
        | null
        | undefined)?._passwordBinding;
      if (!b) continue;
      const site = `op '${u.decl.name}.${opName}' (password ${b.kind} recipe)`;
      const target = model.find((m) => m.name === b.userResource);
      if (!target) {
        errs.push(
          `password/user-resource-exists: ${site} binds userResource '${b.userResource}', which is not a declared resource`,
        );
        continue;
      }
      const boundSchema = b.schema ?? "public";
      if (target.pgSchema !== boundSchema) {
        errs.push(
          `password/schema-matches: ${site} binds schema '${boundSchema}' but resource '${b.userResource}' lives in pg schema '${target.pgSchema}' — the auth lookup would query the wrong table${
            b.schema === undefined ? " (set schema: to the module name)" : ""
          }`,
        );
      }
      for (const f of b.fields) {
        if (f.role === "password") {
          if (!target.passwords.includes(f.name)) {
            errs.push(
              `password/field-is-password: ${site} binds passwordField '${f.name}', which is not a password() field on '${b.userResource}' — the hash column must be a declared password() field`,
            );
          }
        } else if (!(f.name in target.columns)) {
          errs.push(
            `password/field-exists: ${site} binds ${f.role} field '${f.name}', which is not a column on '${b.userResource}'`,
          );
        }
      }
      if (b.kind === "login" && target.features.scope === true) {
        Object.assign(b, { scoped: true });
        if (b.scopeFrom !== "request") {
          errs.push(
            `password/login-scope-resolution: identity '${b.userResource}' is scope:true and login is public/pre-auth — lookups AND scope_key from the request's resolved scope (ctx.scope). An empty scope does not search every tenant. Declare scopeFrom: "request" on passwordLogin and resolve scope from the request (host / claim), never by scanning identifiers across scopes.`,
          );
        }
      }
    }
  }
  // onDelete reverse-ref sweep index (03-api-shape.md §onDelete): attaches to each parent model the children
  // whose declared onDelete clause the DB can't honestly honor (see `ResourceModel.onDeleteSweeps`). Built
  // post-loop since it spans parent ↔ child — every model's table and features must already be resolved.
  const { junctions, views, errs: finErrs } = finalizeModel(
    model,
    units,
    config,
    { ddlSweptRefs, restrictSweepRefs, names },
  );
  errs.push(...finErrs);
  // app-version boot guard (multi-version.md §8): every `defineVersion` declaration is integrity-checked —
  // pin-resolves, required-supplied, field-live, enum-mapped, lossless-round-trips — aggregated into the
  // `decl/unknown-key` throw below. See `versions.ts`.
  const versions = config.versions ?? [];
  errs.push(...checkVersions(versions, model));
  // `readmodel/rowpolicy-required` (13-authz.md §authz-seam) — needs the COMPOSED model: one of its two
  // firing conditions is an exposed op reaching `ctx.readModels`, which is read off the handlers.
  errs.push(...readModelGateViolations(readModels, model, sourceRowPolicy));
  if (errs.length > 0) {
    throw new Error(groupDeclErrors(errs)); // grouped by concern for scannability; ids preserved verbatim
  }
  // The app-wide perm catalogue: every resource's DERIVED `<resource>:<verb>` vocabulary, plus the manually
  // DECLARED half (`config.perms`). Both halves are needed, and for the same reason: `can()` is exact-string
  // membership over resolver-minted claims, so a key nothing here carries is one the framework calls dangling
  // while the app gates on it every day. A role is the standing case — no resource seeds one.
  const appPerms = [
    ...new Set([...model.flatMap((m) => m.perms), ...declaredPermKeys(config)]),
  ].sort();
  // stage-2 seal (13-authz.md §open-tails): arms every `permKey()` schema field with the assembled vocabulary,
  // resolving the credential recipe's self-circularity — the vocabulary doesn't exist until this line.
  sealPermKeys(model, appPerms);
  const app: App = {
    model,
    // the declared graph, taken from `config.modules` rather than re-derived from `model` — a module with no
    // resources still declares `deps`, and only this lane can see it (10-invariants.md §boundary).
    moduleGraph: (config.modules ?? []).map((m) => ({
      name: m.name,
      deps: m.deps ?? [],
    })),
    schemas: [...new Set(model.map((m) => m.pgSchema))],
    junctions,
    perms: appPerms,
    scope: config.scope ?? null,
    views, // the composed read-only projections, carried to the MCP serve/surface/instructions seams (12-mcp §6)
    // compose the async consumer registry at boot (05-runtime.md §5) — declared `defineSubscriber`/`defineWorker`
    // consumers plus per-topic upcaster chains, in the shape `runLiveRelay` consumes. The single registration
    // site: revert it and `app.relay.subscribers` is empty, so no topic ever drains.
    relay: {
      // declared subscribers plus the webhook-derived ones (05-runtime.md §externalization) — one substrate, one drain
      subscribers: [
        ...(config.subscribers ?? []),
        ...(config.webhooks ?? []).map((w) => webhookSubscriber(w)),
      ],
      // append each declared task's drain worker (topic `_task:<name>`) — the same registration seam as a
      // hand-written `defineWorker` (05-runtime.md §task); the large-result offload threshold rides each worker's closure.
      workers: [
        ...(config.workers ?? []),
        ...(config.tasks ?? []).map((t) =>
          taskWorkerFor(t, config.taskResults?.storageThreshold)
        ),
      ],
      upcasters: config.upcasters ?? {},
    },
    // compose the typed producer payload contracts at boot (05-runtime.md §event-surface-lock): an
    // `emits:{ topic: zod }` declaration reaches the event-surface lock and parse-at-emit through this map.
    emitSchemas,
    // compose the authored MCP prompt set at boot (12-mcp §prompts): the declared `definePrompt` records, in
    // the shape the surface gate and serve layer consume. Revert this and `app.prompts` is empty, so a
    // non-additive prompt change silently passes the surface gate.
    prompts: config.prompts ?? [],
    // the MCP DNS-rebinding Origin allowlist, carried onto the App so BOTH transports read one source: the
    // served `/mcp` route (via ServeConfig.mcpAllowedOrigins) and the hardened gateway (which composes the
    // pure App and enforces the check at its own boundary, 12-mcp §transport).
    mcpAllowedOrigins: config.mcp?.allowedOrigins,
    // the declared `/openapi.json` exposure, carried so `hazelnut launch` can refuse an ungated document
    // before it grants the served process anything (cli/launch.md §openapi-gated).
    openapi: config.openapi,
    // the other two DECLARED gates, carried for the same reason — `authz/gate-resolves` folds all three
    // off the composed app, and a gate reachable only through ServeConfig is a gate no check can see.
    version: config.version,
    mcpRuntime: config.mcp?.runtime,
 // compose the materialized read-model set at boot: the maintenance drain
    // (`runReadModelMaintain`) reads `app.readModels` to resolve a job's projection, paired with each source
    // model's `readModelSinks`. Revert it and a read-model job can never resolve its projection.
    readModels: composeReadModelScopes(readModels, model), // stamps `scoped` off each source's features so readReadModel fails closed by construction
    datasources: config.datasources, // named external datasource declarations (access map) — ctx.datasource reads it for read-only; connections ride boot
    // the declared outbound webhook sinks, carried onto the App so a reader that holds only the composed
    // model still sees every egress target the app can reach — the source `hazelnut launch` derives
    // `--allow-net` from (cli/launch.md §derivation). The relay consumes them as derived subscribers above.
    webhooks: config.webhooks ?? [],

    // compose the durable workflow set at boot (05-runtime.md §workflow durable steps): the single registration
    // site a runner (`runWorkflow`) resolves declared `defineWorkflow` names off.
    workflows: config.workflows ?? [],
    // compose the declared task set at boot (05-runtime.md §task) — `ctx.tasks.<name>.submit` reads this; its
    // drain worker is already folded into `relay.workers` above.
    tasks: config.tasks ?? [],
    // compose the declared cron-job set at boot (05-runtime.md §4.1) — `startFeatureScheduler` registers each
    // on the Scheduler seam alongside the feature-auto sweeps. Revert it and a `defineJob` in config never fires.
    jobs: config.jobs ?? [],
    // carry the runtime-assert config surface (09-verifier.md §determinism-axis) so a monitor tick's
    // `evaluateRuntimeAsserts(db, app)` reads this deployment's exclude/scan-cap tuning off the composed App.
    ...(config.runtimeAsserts ? { runtimeAsserts: config.runtimeAsserts } : {}),
    // compose the app's `defineVersion` API-version projections at boot (multi-version.md §1): `serve.ts` reads
    // `app.versions` per `Hazelnut-Version` header and applies the matching version's `expose` after the
    // read-stack and sensitive redaction. Revert it and every request serves `current`, ignoring the pin.
    versions,
    // the born-on per-agent scheduling-cap floor, carried on the App (never a global). Default on
    // (`defaultSchedulingCap`, agent-only by construction); an app opts down via `defineConfig({ schedulingCap })`
    // or `false` to disable. The op surface threads it to `ctx.queue`.
    schedulingCap: config.schedulingCap === false
      ? null
      : (config.schedulingCap ?? defaultSchedulingCap()),
    // the per-app outbox backpressure state (watermark + gauge cache), carried on the App, not a process
    // global. The op surface threads it to `ctx.emit`/`ctx.queue`; the relay-tick alarm reads the same state.
    backpressure: makeBackpressure(config.outbox),
    // the injected ctx-member seam (`CtxExtras`) — carried on the App so the op surface can thread it to
    // `buildOpCtx`. Set only when a module composed one; a core app carries none and the members stay absent.
    ...(config.ctxExtras
      ? {
        ctxExtras: Array.isArray(config.ctxExtras)
          ? config.ctxExtras
          : [config.ctxExtras as CtxExtras],
      }
      : {}),
  };
  // the runtime floor fires on every path — served and the pure-model verify/migrate path — before the
  // `!boot` early-return below, so all three CLI entries refuse an unsupported Deno 1.x with the same clear
  // signal. Refuse (not warn), consistent with the encrypted-key/scope/read-policy boot guards.
  assertDenoSupported(Deno.version.deno);
  // `mcp/tool-name-collision` (12-mcp §residual-ceilings): the full derived tool-name set (resource ops ∪
  // `defineView` tools) must be injective. The `__` join is segment-guarded, but distinct declarations can
  // still mint one FQN (a run-form view vs a same-named custom op, or two same-named views) — a shadowed
  // tool makes `tools/call` dispatch ambiguous. The scan reads the same name producers the catalog emission
  // uses (`mcpToolNames`), never a second join that could drift from `tools/list`.
  {
    const seen = new Map<string, number>();
    for (const n of mcpToolNames(app)) seen.set(n, (seen.get(n) ?? 0) + 1);
    const dups = [...seen.entries()].filter(([, c]) => c > 1).map(([n]) => n)
      .sort();
    if (dups.length > 0) {
      throw new Error(
        `mcp/tool-name-collision: MCP tool name(s) minted more than once: ${
          dups.map((d) => `'${d}'`).join(", ")
        } — the <module>__<name>__<op> FQN must be unique across resource ops AND defineView tools (a view projects <module>__<view>__view; a cross-source run-form view projects app__<view>__view). Rename the colliding declaration.`,
      );
    }
  }
  // boot guards — the model-derived fail-closed set (`core/model-guards.ts`): encrypted/key-source ·
  // file/storage-required · vector/embed-required · audit/sensitive-declared · policy/read-protected (the
  // resource AND `defineView.mcp` read doors) · policy/write-protected · op/decisions-written ·
  // versioning/decision-written; refuses on the first violation.
  // `authz/rowpolicy-single-source` (13-authz.md §authz-seam) runs first, so the guard below only ever reads a
  // VALIDATED injection: `boot.rowPolicies` seeds only resources with no declared `rowPolicy` — never an
  // override lane, so row-authz never forks across two sites. Vacuous with no bundle to validate.
  if (boot?.rowPolicies) {
    for (const name of Object.keys(boot.rowPolicies)) {
      const m = model.find((r) => r.name === name);
      if (!m) {
        throw new Error(
          `authz/rowpolicy-single-source: boot.rowPolicies names '${name}', but no resource with that name exists — a typo'd injection would silently protect nothing. Known resources: ${
            model.map((r) => r.name).join(", ")
          }.`,
        );
      }
      if (m.hasRowPolicy) {
        throw new Error(
          `authz/rowpolicy-single-source: boot.rowPolicies['${name}'] would SHADOW the rowPolicy the '${name}' declaration already carries — the declaration is the single authoritative source. Move the logic into the declared rowPolicy (it can close over module state), or drop the injection; the injection lane exists only for boot-state-dependent policies on resources that declare none.`,
        );
      }
    }
    // single resolution: the VALIDATED injection is composed into the model itself, so the read gate, the
    // write conjunct, transitions, and the guards all read one field — no later site resolves the
    // injection lane again (row-authz never forks across two sites).
    for (const [name, policy] of Object.entries(boot.rowPolicies)) {
      const i = model.findIndex((r) => r.name === name); // existence proven by the guard above
      model[i] = {
        ...model[i]!,
        rowPolicy: policy as ResourceModel["rowPolicy"],
        hasRowPolicy: true,
      };
    }
  }
  // the op-door fold's name collisions (03-api-shape.md §op-door-projection): a DECLARED field a sibling's
  // DDL mints is withheld at every op door. The fold stays; the silence does not. Above the model-only
  // return, so `verify`/`routes` print it too.
  for (const line of opDoorCollisionWarnings(model)) console.warn(line);
  // ABOVE the model-only early return, so ONE guard set decides every composition door. A bundle-less call
  // credits every seam (`EVERY_SEAM_ATTESTED`) — it has nowhere to wire one — so what it still refuses is
  // exactly the wiring-unfixable remainder: a declaration defect refuses wherever the declaration is composed.
  const modelGuards = collectModelGuardViolations(
    model,
    boot
      ? {
        hasKms: boot.kms !== undefined || masterKey !== null,
        hasStorage: boot.storage !== undefined,
        hasEmbed: boot.embed !== undefined,
        // the injection was composed into the model above the guard — the guard reads the model, one source.
        rowPolicyOf: (m) => m.rowPolicy,
      }
      : EVERY_SEAM_ATTESTED,
    views,
  );
  // EVERY violation, not the first: a declaration with three defects should cost one boot, not three. It
  // also stops one guard masking another — a declaration is never silently held to one axis alone.
  if (modelGuards.length > 0) {
    throw new Error(modelGuards.map((g) => g.refuse).join("\n\n"));
  }
  if (!boot) return app; // pure model-composition path (the existing callers) — no live db to serve against
  // compose the live external-datasource registry (05-runtime.md §datasources): pairs each declared
  // datasource's access mode (`config.datasources`) with its boot connection (`boot.datasources`) — a declared
  // datasource with no live connection is a loud boot refuse (`buildDatasources`).
  const datasources = buildDatasources(
    boot.datasources ?? {},
    config.datasources ?? {},
  );
  // `scope/resolver-required` (04-features.md §scope): a resource declaring `features:{ scope:true }` is only
  // half the contract — the app-wide `config.scope` resolver supplies the per-request value. With no resolver,
  // every row is silently stamped/filtered on the empty `""` scope, so tenancy isolates nothing. Served-path only.
  if (anyScoped && !config.scope) {
    throw new Error(
      `scope/resolver-required: a resource declares 'scope:true' (opting into row-scoping) but no app scope resolver is wired (defineConfig({ scope: { key, resolve } })) — every row would share the empty scope and tenancy would NOT isolate. Refusing to boot the silent no-op: declare a config.scope resolver to supply the per-request scope value.`,
    );
  }
  // …and the resolver must be ABLE to vary — the same obligation `scope/resolver-required` states, one step
  // in: a resolver answering every request with the same value is the empty-scope no-op wearing a literal.
  // Every caller lands on one partition and the conjunct matches every row. PROBED, never measured off
  // `Function.length` (`(i) => { void i; return "public"; }` reports 1 and reads nothing).
  if (anyScoped && config.scope && resolverIsConstant(config.scope.resolve)) {
    throw new Error(
      `scope/resolver-constant: the app scope resolver answered two DIFFERENT synthetic requests (different actor, url, host and headers) with the SAME scope value, so every request resolves to that one value and the scope conjunct partitions nothing — the same silent no-op as wiring no resolver at all. Refusing to boot: derive the scope from the request, e.g. resolve: ({ actor }) => actor?.orgId ?? "" (never a client header — a header is spoofable). If this app genuinely has one partition, drop 'scope:true'; per-row visibility is the rowPolicy's job either way, since scope partitions the tenant boundary and never two callers within it.`,
    );
  }
  // default the `kms` seam to the app-key floor when no external KMS is injected (04-features.md §encrypted):
  // the per-row DEK is wrapped locally (AES-KW, no network) under the resolved master key; an injected
  // `boot.kms` wins. Only built when a key resolved, so a non-encrypted app keeps `kms: undefined`.
  const kms: Kms | undefined = boot.kms ??
    (masterKey !== null ? appKeyKms(masterKey) : undefined);
  // compose the servable handler from the runtime seams (06-generators.md §3): the per-request ctx factory
  // derives scope from the app-wide ScopeConfig plus the seam-resolved actor; the HTTP/MCP router composes
  // onto the same `createRouter` the standalone path uses. `app.fetch` is `router.fetch`.
  // the /ready ↔ drain-loop liveness handle: the loop stamps `lastDrainAt` after each successful drain and
  // the readiness route classifies over it (05-runtime.md §5.1 — loop-alive wired to the readiness endpoint).
  const relayState = { lastDrainAt: null as number | null };
  warnTasksNeedConcurrentDb(config, boot.db); // a task app on a non-concurrent Db degrades progress — say it once, loudly
  warnWorkflowsNeedConcurrentDb(config, boot.db); // same class of out-of-band failure record for nested workflows
  void warnUnboundedReads(boot.db); // warn once if a served pool has no statement_timeout → unbounded reads (fire-and-forget; createApp is sync)
  const router = getRouterFactory()({
    app,
    db: boot.db,
    datasources, // the live external-datasource registry → ctx.datasource(name) on the served op path (05-runtime.md §datasources)
    resolveCtx: resolveCtxFactory(app.scope ?? null),
    auth: boot.auth,
    relayState,
    kms, // the injected external KMS, else the defaulted app-key floor (AppKeyKms) — 04-features.md §encrypted
    storage: boot.storage, // the off-box file bytes seam — no default floor (the boot guard already refused a driverless file() app)
    // the embedding provider seam — threaded to ServeConfig so the inline HTTP re-embed door (serve-routes.ts)
    // fires, not just the relay tick; a vector app on the createApp path re-embeds instead of leaving NULL vectors
    embed: boot.embed,

    mcpServerInfo: boot.mcpServerInfo,
    // the projected MCP `initialize` instructions business-context sentence (12-mcp.md §server-instructions).
    // The `boot.mcpInstructions` runtime seam wins; absent ⇒ the authored `defineConfig({ mcp: { instructions } })` slot.
    mcpInstructions: boot.mcpInstructions ?? config.mcp?.instructions,
    // the MCP Origin allowlist (DNS-rebinding defense, 12-mcp §7) — declared app-level, enforced by the
    // served `/mcp` route; absent ⇒ no Origin check (a headless agent sends none).
    mcpAllowedOrigins: config.mcp?.allowedOrigins,
    // the MCP runtime projection opt-in (12-mcp.md §runtime-projection) — gate validated at the boot guard above.
    mcpRuntime: config.mcp?.runtime,
    // the served prompt set comes from the same declarative source the surface gate reads (`app.prompts`), so
    // the served `prompts/*` surface and `mcp/additive-only` gate can never drift. `boot.prompts` is an
    // explicit runtime-seam override (e.g. a test injecting a prompt set) — present ⇒ it wins.
    prompts: boot.prompts ?? app.prompts,
    // default the rate-limit store to the born-on floor so an app is throttled out of the box, never silently
    // fail-open (13-authz §9). An injected `boot.rateLimitStore` wins; an app opts down to
    // `memoryRateLimitStore` for single-instance/dev. A Transactor db gets the shared PG floor
    // (multi-instance-correct); a non-Transactor db gets the per-instance memory floor — still bounded, just N×-per-replica.
    rateLimitStore: boot.rateLimitStore ??
      (boot.db !== undefined
        ? ((boot.db as { transaction?: unknown }).transaction !== undefined
          ? defaultRateLimitStore(boot.db as Db & Transactor)
          : defaultMemoryRateLimitStore())
        : undefined),
    // the HTTP hardening floor (body byte cap) — declared app-level (`defineConfig({ http })`), enforced
    // by the served router; absent ⇒ the router's own 1 MiB default applies.
    http: config.http,
    // `/openapi.json` exposure — opt-in to expose the API contract; absent ⇒ not mounted.
    openapi: config.openapi,
    // `GET /version` gate — opt-in, deny-by-default; absent ⇒ 404. Threaded the same way `openapi` is.
    version: config.version,
    // the opt-in trusted-client-IP resolver → anon throttle sub-keys per-IP; absent ⇒ shared anon floor.
    clientIp: boot.clientIp,
  });
  // ── the async-drain seam on the servable path ────────────────────────────────────
  // async features with no drain wired leave the outbox filling and never firing. `relay:"in-process"`
  // drains it here on a timer; `"external"` acknowledges a separate drain; no choice ⇒ refuse (sibling of scheduler).
  const asyncDeclared = drainReasonsOf(app);
  // ── the scheduler boot choice ────────────────────────────────────────────────────
  // The feature scheduler (`startFeatureScheduler`, Deno.cron) is separate from the relay drain — it reaps
  // `expiry:{purge}` rows and sweeps framework TTL tables. Its dependency set derives from `schedulerJobsFor`,
  // the same roster `registerFeatureJobs` registers, so the refuse can't drift from what actually runs; the
  // unconditional sweeps make virtually every served app scheduler-dependent, so an undeclared choice REFUSES
  // every served/relay boot shape (same floor as `hazelnut launch` — WARN+serve was the sibling-door hole).
  const schedulerJobs = schedulerJobsFor(app);
  if (boot.scheduler === "in-process") {
    // createApp wires the scheduler itself. Deno.cron absent (no --unstable-cron) → the jobs warn once and
    // no-op-bind (scheduler-jobs.ts warnCronUnavailable), never a crash.
    startFeatureScheduler(app, boot.db);
  } else if (boot.scheduler === undefined && schedulerJobs.length > 0) {
    throw new Error(
      `scheduler/decision-written: this app depends on the feature scheduler (${
        schedulerJobs.map((j) => j.name).join(", ")
      }) but the boot declares no scheduler choice — these sweeps/purges NEVER run on this process and their tables grow without bound (the default throttle/idempotency floors alone make every served app scheduler-dependent). Declare it: scheduler: "in-process" (createApp wires startFeatureScheduler(app, db) onto Deno.cron — the serve command needs --unstable-cron), or scheduler: "external" (you run startFeatureScheduler(app, db) in a separate scheduler process).`,
    );
  }
  if (boot.relay !== undefined && boot.relay !== "external") {
    const intervalMs = typeof boot.relay === "object"
      ? boot.relay.intervalMs ?? 1000
      : 1000;
    let draining = false; // overlap guard — a slow drain skips ticks instead of stacking concurrent drains
    const tick = async (): Promise<void> => {
      if (draining) return;
      draining = true;
      try {
        // the framework-topic sweep runs first (the same order the CLI relay uses) — read-model maintain,
        // re-embed, and file-gc are not plan consumers, so `runLiveRelay`'s plan leaves them for this
        // topic-scoped drain. Without it a read-model maintain job is consume-dropped and the projection silently skews.
        await drainFrameworkTopics(boot.db, {
          models: app.model,
          app,
          storage: boot.storage,
          embed: boot.embed,
        });
        if (app.relay) {
          await runLiveRelay(
            boot.db,
            app.relay,
            {},
            app,
            kms,
            datasources,
            boot.storage,
          ); // storage → ctx.storage (task large-result offload)
        }
        relayState.lastDrainAt = Date.now(); // loop-alive stamp — /ready's `relayLiveness` reads it
        // route the post-drain relay-health alarms (DLQ depth, backlog watermark, fired asserts) into the
        // installed AlarmSink on the in-process relay too, so a single-process deploy never leaves a DLQ
        // corpse or backlog crossing silent. Noop sink = zero cost.
        await renderAndRouteAlarms(boot.db, {
          lastDrainAt: relayState.lastDrainAt,
          backpressure: app.backpressure,
        });
      } catch (e) {
        console.error(
          "[hazelnut] in-process relay drain failed (rows persist for the next tick):",
          e,
        );
      } finally {
        draining = false;
      }
    };
    const timer = setInterval(() => void tick(), intervalMs);
    return {
      ...app,
      fetch: (req: Request) => router.fetch(req),
      stopInProcessRelay: () => clearInterval(timer),
    };
  }
  if (asyncDeclared.length > 0 && boot.relay === undefined) {
    throw new Error(
      `relay/decision-written: async features declared (${
        asyncDeclared.join(", ")
      }) but NO drain is wired on this boot — the outbox will fill and these will NEVER fire on a serve-only deploy. Declare it: relay: "in-process" (single-process — this boot drains its own outbox), or relay: "external" (you run a separate \`hazelnut relay --loop\` process / cron drain).`,
    );
  }
  return { ...app, fetch: (req: Request) => router.fetch(req) };
}

/** One synthetic request whose EVERY readable axis carries the tag — url, host and any header name a
 *  resolver asks for — so a resolver reading any of them answers differently per tag. */
function scopeProbeInput(tag: string, actor: Actor | null): ScopeInput {
  return {
    req: {
      url: `https://${tag}.hazelnut-probe.invalid/${tag}?scope=${tag}`,
      method: "GET",
      headers: {
        get: (name: string) => `${tag}-${name}`,
        has: () => true,
        forEach: () => {},
      },
    } as unknown as Request,
    actor,
  };
}

/**
 * Does this scope resolver answer every caller the same? CALLED, never measured off `Function.length` —
 * `length` stops counting at the first default parameter and ignores rest, and an arity-1 body that reads
 * nothing reports 1, so all four of those defeats read as "takes an argument" while resolving one constant.
 * A resolver that THROWS on a synthetic input looked at something this cannot synthesize: unknowable, so
 * never a refusal — only two SUCCEEDING answers that agree are evidence of a constant.
 */
function resolverIsConstant(resolve: (input: ScopeInput) => string): boolean {
  const answers: string[] = [];
  for (
    const [tag, actor] of [
      // Bound to DIFFERENT tenants: an app whose scope comes from the tenancy recipe reads
      // `tenantOf(actor)`, a WeakMap binding no bare `userActor` carries — two unbound principals both
      // answer the app's `?? "public"` fallback and a caller-derived resolver reads as constant.
      [
        "probe-a",
        tenantActor("probe-actor-a", "probe-tenant-a", [
          "probe_a:read" as never,
        ]),
      ],
      [
        "probe-b",
        tenantActor("probe-actor-b", "probe-tenant-b", [
          "probe_b:write" as never,
        ]),
      ],
      ["probe-nobody", null],
    ] as const
  ) {
    try {
      answers.push(resolve(scopeProbeInput(tag, actor)));
    } catch {
      /* looked and disliked the synthetic input — not evidence either way */
    }
  }
  return answers.length >= 2 && answers.every((a) => a === answers[0]);
}

/**
 * Every reason this app needs an outbox drain, derived from the COMPOSED app and the two consumers a boot
 * without `relay` never runs: `runLiveRelay` (reads `app.relay`, which already folds `webhooks` into
 * subscribers and `tasks` into workers) and `drainFrameworkTopics` (`_readmodel_maintain`,
 * `_vector_reembed`, `_file_gc`). Reading the raw `config.*` keys instead left a `defineTask`-only or
 * `defineWebhook`-only boot with the outbox filling and no signal at all.
 */
/**
 * The permission keys `config.perms` declares, flattened to the wire strings `claims` holds. Accepts both
 * shapes `definePerms` and a hand-written list produce; a non-string leaf is dropped rather than stringified,
 * so a mis-shaped vocabulary widens nothing (it stays a dangling-key violation, which is the honest answer).
 */
export function declaredPermKeys(
  config: Pick<CreateAppConfig, "perms">,
): string[] {
  const p = config.perms;
  if (p === undefined) return [];
  if (Array.isArray(p)) return p.filter((k) => typeof k === "string");
  return Object.values(p as Record<string, Record<string, string>>)
    .filter((g): g is Record<string, string> =>
      g !== null && typeof g === "object"
    )
    .flatMap((g) => Object.values(g))
    .filter((k) => typeof k === "string");
}

export function drainReasonsOf(app: App): string[] {
  const subs = app.relay?.subscribers?.length ?? 0;
  const workers = app.relay?.workers?.length ?? 0;
  const readModels = app.readModels?.length ?? 0;
  return [
    ...(subs > 0 ? [`${subs} subscriber(s)`] : []),
    ...(workers > 0 ? [`${workers} worker(s)`] : []),
    ...(readModels > 0 ? [`${readModels} read-model(s)`] : []),
    ...(app.model.some((m) => m.vector !== null) ? ["vector re-embed(s)"] : []),
    ...(app.model.some((m) => m.files.length > 0)
      ? ["file() byte reclaim (_file_gc)"]
      : []),
  ];
}

/** The silent-degrade notice for a task app on a non-concurrent Db: live task progress and the
 *  out-of-band terminal-failure write need a second connection (`Db.concurrent`, a real pool); a BYO Db
 *  without the flag makes them honest no-ops (data/db.ts), so this says it out loud once at boot. */
function warnTasksNeedConcurrentDb(config: CreateAppConfig, db: Db): void {
  if ((config.tasks?.length ?? 0) > 0 && db.concurrent !== true) {
    console.warn(
      `[hazelnut] defineTask declared but boot.db carries no \`concurrent: true\` — live task progress and the out-of-band terminal-failure write are silent NO-OPS on a single-connection Db. Use postgresDb (a real pool) for live progress, or mark your BYO pool \`concurrent: true\`; single-connection PGlite is the test floor.`,
    );
  }
}

/** Nested `ctx.workflows.*.start` needs an out-of-band `_workflow_progress` write on a second connection
 *  (`Db.concurrent`); without it the start door REFUSES at call time. Say it once at boot too, so a served
 *  PGlite app that declares workflows hears before the first op. Standalone `run-workflow` stays valid. */
function warnWorkflowsNeedConcurrentDb(
  config: CreateAppConfig,
  db: Db,
): void {
  if ((config.workflows?.length ?? 0) > 0 && db.concurrent !== true) {
    console.warn(
      `[hazelnut] defineWorkflow declared but boot.db carries no \`concurrent: true\` — \`ctx.workflows.*.start\` REFUSES on a single-connection Db (a throwing step's failure would ride the op tx and vanish on rollback). Use postgresDb (a real pool) for served nested starts, or run via \`hazelnut run-workflow\`; single-connection PGlite is the test floor.`,
    );
  }
}

/** A served app whose DB connection has no `statement_timeout` (SHOW = "0") leaves the read path unbounded.
 *  Writes get the ~30s op-deadline floor (a hung write holds row/advisory locks); a read holds only a pooled
 *  connection, so a pathological read can pin one indefinitely and exhaust the pool. The framework leaves the
 *  read floor to the deployment, but warns once at boot rather than impose a ceiling that would kill a
 *  legitimately-slow read. Gated on a real pool — single-connection PGlite is the test floor. */
export async function warnUnboundedReads(db: Db): Promise<void> {
  if (db.concurrent !== true) return; // only a real pool risks connection-pool exhaustion
  try {
    const r = await db.query<{ statement_timeout: string }>(
      "SHOW statement_timeout",
    );
    if ((r.rows[0]?.statement_timeout ?? "0") === "0") {
      console.warn(
        `[hazelnut] the DB connection has no statement_timeout (SHOW statement_timeout = 0) — a pathological read (a missing index, a huge scan) can hold a pooled connection UNBOUNDEDLY and exhaust the pool. Writes get a ~30s op-deadline floor, but the read floor is your deployment's: set it on the DB role (e.g. \`ALTER ROLE app SET statement_timeout = '30s'\`), or a per-op \`deadlineMs\` for a known-slow read. (REL-F5)`,
      );
    }
  } catch {
    /* SHOW unsupported / transient connection issue → advisory, stay silent */
  }
}
