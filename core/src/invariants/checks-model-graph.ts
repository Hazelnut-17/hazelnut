// The app-singleton checks that read the composed MODEL and nothing else — the declared module-dep graph
// and the composed async-consumer set. Siblings of the per-resource roster, not of the rungs that read
// authored source, a committed baseline or the principle roster.
import type { App, ResourceModel } from "../core/app.ts";
import type { AnySubscriber, AnyWorker } from "../runtime/events.ts";
import type { AppViolation } from "../core/structural-violation.ts";
import {
  ctxHandlerSites,
  literalDatasourceNames,
  literalDoorPropertyNames,
} from "./name-keyed-probe.ts";

/** `boundary/no-cycle` (universal, static — 10-invariants.md §boundary; 06-generators.md §Phase-1). Gates
 *  the declared module-dep GRAPH (acyclic) — the sibling `boundary/declared-deps` gates each edge. A cycle
 *  means two modules each name the other in `deps`, breaking independent changeability (the monolithic-
 *  modular boundary forbids it). App-singleton whole-graph DFS, run once per verify; self-loops count
 *  as a degenerate cycle; a single-module app is trivially acyclic. */
export function checkBoundaryNoCycle(
  model: ReadonlyArray<ResourceModel>,
  declaredGraph?: ReadonlyArray<
    { readonly name: string; readonly deps: readonly string[] }
  >,
): AppViolation[] {
  // Build the declared module-dep graph: module → the modules it names in `deps`. `app.moduleGraph` is the
  // authoritative source when present — it carries every DECLARED module, including one with no resources,
  // whose edges the model-derived fallback cannot see (a resource-less module owns no `ResourceModel`, so a
  // cycle routed through it would be silently unreported). The fallback keeps the bare model callable:
  // `moduleDeps` is identical across a module's resources (module-owned), so first sighting is authoritative.
  const depsOf = new Map<string, readonly string[]>();
  if (declaredGraph !== undefined) {
    for (const m of declaredGraph) {
      if (!depsOf.has(m.name)) depsOf.set(m.name, m.deps);
    }
  } else {
    for (const m of model) {
      if (!depsOf.has(m.module)) depsOf.set(m.module, m.moduleDeps);
    }
  }
  const out: AppViolation[] = [];
  const seenCycles = new Set<string>(); // dedupe: one finding per normalized cycle, not one per traversal order
  const WHITE = 0, GREY = 1, BLACK = 2; // tri-color DFS — GREY = on the current recursion stack (a back-edge = cycle)
  const color = new Map<string, number>();
  const stack: string[] = [];
  const visit = (mod: string): void => {
    color.set(mod, GREY);
    stack.push(mod);
    for (const dep of depsOf.get(mod) ?? []) {
      if (!depsOf.has(dep)) continue; // a dep on a module with no resources in the model — not a graph node here
      const c = color.get(dep) ?? WHITE;
      if (c === GREY) {
        // back-edge → a cycle. The cycle is `dep …→ mod → dep` — slice the stack from `dep` to here.
        const at = stack.indexOf(dep);
        const cyclePath = [...stack.slice(at), dep];
        // Dedupe a DUPLICATED `deps` entry (`deps: ["a", "a"]`), which walks the same back-edge twice and
        // would otherwise report one break as two. Distinct back-edges cannot collide on this key: every
        // cyclePath is a contiguous slice of the GREY stack, whose entries are unique, so two different
        // back-edges yield different segments — and BLACK stops a later root from re-finding a cycle.
        const key = [...cyclePath].sort().join("|");
        if (!seenCycles.has(key)) {
          seenCycles.add(key);
          out.push({
            id: "boundary/no-cycle",
            message: `the declared module-dep graph has a cycle: ${
              cyclePath.join(" → ")
            } — a circular cross-module dependency makes neither module independently changeable or compose-orderable (the monolithic-modular boundary forbids it; break the cycle by removing one direction's \`deps\` and depending by-id / via an event instead)`,
            responsible: {
              kind: "unknown",
              why: `module-dep cycle [${cyclePath.join(" → ")}]`,
            },
          });
        }
      } else if (c === WHITE) {
        visit(dep);
      }
    }
    stack.pop();
    color.set(mod, BLACK);
  };
  for (const mod of depsOf.keys()) {
    if ((color.get(mod) ?? WHITE) === WHITE) visit(mod);
  }
  return out;
}

/** The stable consumer label for a `scope/system-bypass-declared` finding — the declared `name`, else the
 *  topic (the relay derives `sub:<topic>:<index>` when no name is given, so the topic is the honest fallback). */
function consumerLabel(c: AnySubscriber | AnyWorker): string {
  return c.name ?? c.topic;
}

/** `scope/system-bypass-declared` (authz cluster, static, advisory — 13-authz.md §7 "System-actor scope"): a
 *  consumer whose scope resolves `"cross"` (all partitions) MUST also carry `crossScope:true`, so the bypass
 *  is declared and surfaces in the audit row — the confused-deputy the canon forecloses ("there is no god
 *  'system' principal"). The default (`scope` absent/`"inherit"`) is the safe partition-preserving path, so
 *  a normal consumer owes nothing. Advisory (`runtime-assert` → warn): a discipline nudge, not a shipped break. */
export function checkSystemBypassDeclared(
  consumers: ReadonlyArray<AnySubscriber | AnyWorker>,
): AppViolation[] {
  const out: AppViolation[] = [];
  for (const c of consumers) {
    // read the identity before the mismatch test: `ConsumerScopeDecl` makes the cross-without-flag arm
    // unrepresentable, so TS narrows `c` to `never` inside the guard — must not read members off it there.
    const label = consumerLabel(c);
    const topic = c.topic;
    if (c.scope === "cross" && c.crossScope !== true) {
      out.push({
        id: "scope/system-bypass-declared",
        message:
          `consumer '${label}' (topic '${topic}') declares scope:"cross" (resolves scope→null, all partitions) but does not set crossScope:true — an undeclared scope bypass: the cross-tenant access has no audited opt-in, so it silently widens the partition (set crossScope:true so the bypass is declared and surfaces in the audit row)`,
        // advisory: `runtime-assert` derives to a non-ship-blocking warn — a nudge, never a shipped break.
        rung: "runtime-assert",
        responsible: {
          kind: "unknown",
          why: `consumer '${label}' is scope:"cross" without crossScope:true`,
        },
      });
    }
  }
  return out;
}

/** Every app-level gate, as `[where, key]`. DERIVED from the App cards that carry a `gate`, never a
 *  hand-list: a fourth gated app-level face joins this fold on the commit that adds it. */
export function appGates(
  app: Pick<App, "openapi" | "version" | "mcpRuntime">,
): Array<readonly [string, string]> {
  const cards: Array<
    readonly [string, { readonly gate?: string } | undefined]
  > = [
    ["openapi.gate", app.openapi],
    ["version.gate", app.version],
    ["mcp.runtime.gate", app.mcpRuntime],
  ];
  return cards.flatMap(([where, card]) =>
    typeof card?.gate === "string" && card.gate !== ""
      ? [[where, card.gate] as const]
      : []
  );
}

/**
 * `authz/gate-resolves` (authz cluster, static — 13-authz.md §authz-seam): the APP-LEVEL sibling of
 * `authz/key-resolves`. `can()` is exact-string membership over resolver-minted claims, so a gate naming a
 * key the vocabulary does not carry is false for every caller: the face serves 403 forever and reads as
 * deny-by-default working correctly. The op face has been checked since day one; the three app-level gates
 * had no check at all, and the framework's own `mcp/runtime-gate-required` message suggested `system:ops` —
 * a key its own checker rejected until `defineConfig({ perms })` gave the declared half a home.
 */
export function checkGateResolves(
  app: Pick<App, "openapi" | "version" | "mcpRuntime" | "perms">,
): AppViolation[] {
  const vocab = new Set(app.perms ?? []);
  return appGates(app).filter(([, key]) => !vocab.has(key)).map((
    [where, key],
  ) => ({
    id: "authz/gate-resolves",
    message:
      `\`${where}\` gates on permission '${key}', which resolves to no key in the app's permission vocabulary — no resource seeds it and \`defineConfig({ perms })\` does not declare it, so \`can(actor, '${key}')\` is false for every caller and the face is a permanent 403 that reads as deny-by-default working. Declare it — \`perms: definePerms({ ${
        key.split(":")[0]
      }: ["${
        key.split(":")[1] ?? key
      }"] })\` — or gate on a key the vocabulary already carries`,
    rung: "static" as const,
    responsible: { kind: "unknown" as const, why: `${where} names '${key}'` },
  }));
}

/**
 * `task/name-resolves` (universal, static — `cross-module-face.type-test.ts §NAME_KEYED_OPEN`): every
 * literal `ctx.tasks.<name>` a handler reaches must name a `defineTask` this app declares. The door is a
 * `Record<string, TaskSurface>` keyed only on declared names, so `noUncheckedIndexedAccess` forces `?.`
 * whether the name resolves or not — a typo compiles clean and is a SILENT no-op at runtime: `?.`
 * short-circuits, the caller's `await` resolves to `undefined`, and the op still returns ok.
 */
export function checkTaskNameResolves(app: App): AppViolation[] {
  const declared = new Set((app.tasks ?? []).map((t) => t.name));
  const out: AppViolation[] = [];
  for (const site of ctxHandlerSites(app)) {
    for (
      const name of literalDoorPropertyNames(site.fn, "tasks", [
        "submit",
        "cancel",
      ])
    ) {
      if (!declared.has(name)) {
        out.push({
          id: "task/name-resolves",
          message:
            `'${site.label}' calls \`ctx.tasks.${name}\` and '${name}' resolves to no declared task — no defineTask names it, so \`?.\` short-circuits: the call returns undefined and the task never runs`,
          rung: "static",
          responsible: {
            kind: "unknown",
            why: `${site.label} names task '${name}'`,
          },
        });
      }
    }
  }
  return out;
}

/** `workflow/name-resolves` — the `ctx.workflows.<name>.start(...)` sibling of `task/name-resolves`, same
 *  `Record<string, WorkflowSurface>` shape and the same silent-no-op consequence. */
export function checkWorkflowNameResolves(app: App): AppViolation[] {
  const declared = new Set((app.workflows ?? []).map((w) => w.name));
  const out: AppViolation[] = [];
  for (const site of ctxHandlerSites(app)) {
    for (
      const name of literalDoorPropertyNames(site.fn, "workflows", ["start"])
    ) {
      if (!declared.has(name)) {
        out.push({
          id: "workflow/name-resolves",
          message:
            `'${site.label}' calls \`ctx.workflows.${name}\` and '${name}' resolves to no declared workflow — no defineWorkflow names it, so \`?.\` short-circuits: the call returns undefined and the workflow never starts`,
          rung: "static",
          responsible: {
            kind: "unknown",
            why: `${site.label} names workflow '${name}'`,
          },
        });
      }
    }
  }
  return out;
}

/** `config/singleton-resolves` — the `ctx.config.<name>` sibling: the declared name set is every resource
 *  that marks `features.singleton`, read straight off the model (`data/data-verbs.ts §configOf` builds the
 *  same door the identical way). Same silent-no-op consequence as `task/name-resolves`. */
export function checkConfigSingletonResolves(app: App): AppViolation[] {
  const declared = new Set(
    app.model.filter((m) => m.features.singleton).map((m) => m.name),
  );
  const out: AppViolation[] = [];
  for (const site of ctxHandlerSites(app)) {
    for (
      const name of literalDoorPropertyNames(site.fn, "config", [
        "getOrSeedConfig",
        "replace",
      ])
    ) {
      if (!declared.has(name)) {
        out.push({
          id: "config/singleton-resolves",
          message:
            `'${site.label}' calls \`ctx.config.${name}\` and '${name}' resolves to no declared singleton — no resource named '${name}' declares features.singleton, so \`?.\` short-circuits: the call returns undefined and the config read/replace never happens`,
          rung: "static",
          responsible: {
            kind: "unknown",
            why: `${site.label} names config singleton '${name}'`,
          },
        });
      }
    }
  }
  return out;
}

/**
 * `datasource/name-resolves` — the `ctx.datasource("<name>")` sibling. This door's runtime shape differs
 * from its three property-keyed siblings: `datasource(name: string)` is a plain method, so an invented name
 * compiles for a different reason (no closed string-literal union to check against, not an index-signature
 * `?.`), and the registry itself throws loud on an unresolved name rather than no-op'ing
 * (`data/data-ctx.ts §datasourceAccessor`) — fail-closed, not silent. The value here is the same one
 * `authz/key-resolves` delivers for a dangling `can()` literal: surfacing the typo at build time instead of
 * a live throw the first time this code path executes.
 */
export function checkDatasourceNameResolves(app: App): AppViolation[] {
  const declared = new Set(Object.keys(app.datasources ?? {}));
  const out: AppViolation[] = [];
  for (const site of ctxHandlerSites(app)) {
    for (const name of literalDatasourceNames(site.fn)) {
      if (!declared.has(name)) {
        out.push({
          id: "datasource/name-resolves",
          message:
            `'${site.label}' calls \`ctx.datasource('${name}')\` and '${name}' resolves to no declared datasource — no config.datasources entry names it, so this call throws at runtime the first time it executes rather than at build time`,
          rung: "static",
          responsible: {
            kind: "unknown",
            why: `${site.label} names datasource '${name}'`,
          },
        });
      }
    }
  }
  return out;
}
