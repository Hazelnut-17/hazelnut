// The app-singleton checks that read the composed MODEL and nothing else — the declared module-dep graph
// and the composed async-consumer set. Siblings of the per-resource roster, not of the rungs that read
// authored source, a committed baseline or the principle roster.
import type { App, ResourceModel } from "../core/app.ts";
import { DATA_ROW_READ_VERBS } from "../data/data-verbs.ts";
import type { AnySubscriber, AnyWorker } from "../runtime/events.ts";
import type { AppViolation } from "../core/structural-violation.ts";
import { mcpToolNames } from "../features/view.ts";
import {
  ctxHandlerSites,
  literalDatasourceNames,
  literalDoorPropertyNames,
  literalQueueTopics,
  literalScheduleJobs,
  rowVerbsCalled,
} from "./name-keyed-probe.ts";

/** `boundary/no-cycle` (universal, static — 10-invariants.md §static-conformance; 06-generators.md §Phase-1). Gates
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
            clause: `cycle.${key}`,
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
        clause: `consumer.${label}`,
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
    clause: where,
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
 * `mcp/gate-declared` (universal, static — 12-mcp.md §gate-declared): an app that serves MCP tools declares
 * `mcp.gate` — a permission string, or `null` for the catalogue that is open on purpose.
 *
 * `tools/list` returns every curated tool, its description and its whole input schema. That is the same
 * shape `/openapi.json` refuses to serve ungated, and for the reason that refusal states in its own words:
 * the document names every route, field and filter the app has. The two doors described one thing and took
 * opposite default postures — openapi shipped gated and launch-refused, the MCP catalogue was anonymous
 * with no gate to declare.
 *
 * The sibling `mcp/origin-declared` answers a DIFFERENT question: which browser may reach the door at all.
 * An Origin allowlist stops a page and never a client, and an MCP caller is a client by definition — so
 * neither check substitutes for the other. ABSENCE is what refuses here too, so this reads PRESENCE and
 * never truthiness: `null` IS the declaration and is carried onto the App verbatim.
 */
export function checkMcpGateDeclared(app: App): AppViolation[] {
  if (mcpToolNames(app).length === 0) return []; // no MCP surface — no door to take a posture on
  if (app.mcpGate !== undefined) return [];
  return [{
    id: "mcp/gate-declared",
    clause: "mcp.gate",
    message: `this app serves ${
      mcpToolNames(app).length
    } MCP tool(s) and declares no \`mcp.gate\` — \`POST /mcp\` \`tools/list\` returns every curated tool with its description and full input schema to whoever asks, which is the shape \`/openapi.json\` refuses to serve ungated. Name who may read it: mcp: { gate: "<perm>" } — or mcp: { gate: null } to say the agent surface is open on purpose. \`allowedOrigins\` does not answer this: it stops a browser page, and an MCP caller is a client.`,
    rung: "static",
    responsible: { kind: "unknown", why: "mcp.gate is absent" },
  }];
}

/**
 * `mcp/origin-declared` (universal, static — 12-mcp.md §origin-declared): an app that serves MCP tools
 * declares `mcp.allowedOrigins` — a list, or `null` for the open door said out loud.
 *
 * ABSENCE is what refuses, so this reads PRESENCE and never truthiness: `null` IS the declaration, carried
 * onto the composed `App` verbatim for exactly this reason. `hazelnut launch` asks the same question at the
 * production door; asking it HERE is what puts it inside `ci`, because the door an author develops against
 * (`deno task dev` runs `main.ts` directly) binds a port with no Origin check at all — so the posture used
 * to arrive on the first deploy rather than in the gate.
 */
export function checkMcpOriginDeclared(app: App): AppViolation[] {
  if (mcpToolNames(app).length === 0) return []; // no MCP surface — no door to take a posture on
  if (app.mcpAllowedOrigins !== undefined) return [];
  return [{
    id: "mcp/origin-declared",
    clause: "mcp.allowedOrigins",
    message: `this app serves ${
      mcpToolNames(app).length
    } MCP tool(s) and declares no \`mcp.allowedOrigins\` — a browser page can reach POST /mcp, and \`capabilityFilter\` answers an anonymous caller, so DNS rebinding turns a cross-origin page into a same-origin reader of whatever is anon-visible. Name who may reach it: mcp: { allowedOrigins: ["https://your-host"] } — or mcp: { allowedOrigins: null } to say the door is open on purpose. An empty list accepts no browser Origin at all, which is what a fresh app wants.`,
    rung: "static",
    responsible: { kind: "unknown", why: "mcp.allowedOrigins is absent" },
  }];
}

/**
 * `task/name-resolves` (universal, static — `cross-module-face.type-test.ts §NAME_KEYED_OPEN`): every
 * literal `ctx.tasks.<name>` a handler reaches must name a `defineTask` this app declares. The door is a
 * `Record<string, TaskSurface>` keyed only on declared names, so `noUncheckedIndexedAccess` forces `?.`
 * whether the name resolves or not and a typo compiles clean. The RUNTIME door throws on an undeclared name
 * (`core/ctx-core.ts §loudNameDoor`), so this check is the static half: it names the literal up front
 * rather than leaving it to fail on the call.
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
          clause: `${site.label}.${name}`,
          message:
            `'${site.label}' calls \`ctx.tasks.${name}\` and '${name}' resolves to no declared task — no defineTask names it, so the runtime door throws at this call site and the task never runs`,
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
 *  `Record<string, WorkflowSurface>` shape and the same loud runtime door behind it. */
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
          clause: `${site.label}.${name}`,
          message:
            `'${site.label}' calls \`ctx.workflows.${name}\` and '${name}' resolves to no declared workflow — no defineWorkflow names it, so the runtime door throws at this call site and the workflow never starts`,
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
 *  same door the identical way). Same loud runtime door as `task/name-resolves`. */
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
          clause: `${site.label}.${name}`,
          message:
            `'${site.label}' calls \`ctx.config.${name}\` and '${name}' resolves to no declared singleton — no resource named '${name}' declares features.singleton, so the runtime door throws at this call site and the config read/replace never happens`,
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
          clause: `${site.label}.${name}`,
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

/**
 * `hygiene/async-name-literal` (warn, NOT a ship-block): a literal topic or job name that no declared
 * consumer answers.
 *
 * `ctx.queue.enqueue(name, …)` and `ctx.schedule(at, job, …)` take the name as a plain string argument,
 * and that vocabulary is imperative BY DESIGN — a caller may hand work to a consumer this app does not
 * declare, which is why neither door carries the closed name set `ctx.tasks` and `ctx.workflows` do. So
 * this never refuses: it reports, and the ad-hoc call stays legal.
 *
 * What it ends is the typo. A LITERAL that matches no declared `defineWorker` / `defineSubscriber` topic
 * (or, for schedule, no `defineJob` name) enqueues a row nothing drains — silently, for as long as the app
 * is deployed. A computed name stays invisible here, exactly as it does for `task/name-resolves`.
 *
 * The concern prefix is what makes it a warn: `deriveBlocks` reads the id's first segment, and `hygiene`
 * is the non-blocking tier. The exit code does not move, so no call that passes today starts failing.
 */
export function checkAsyncNameLiterals(app: App): AppViolation[] {
  const topics = new Set<string>([
    ...(app.relay?.workers ?? []).map((w) => w.topic),
    ...(app.relay?.subscribers ?? []).map((c) => c.topic),
  ]);
  const jobs = new Set<string>((app.jobs ?? []).map((j) => j.name));
  const out: AppViolation[] = [];
  for (const site of ctxHandlerSites(app)) {
    for (
      const [names, declared, door, what] of [
        [literalQueueTopics(site.fn), topics, "ctx.queue.enqueue", "topic"],
        [literalScheduleJobs(site.fn), jobs, "ctx.schedule", "job"],
      ] as const
    ) {
      for (const name of names) {
        if (declared.has(name)) continue;
        out.push({
          id: "hygiene/async-name-literal",
          clause: `${site.label}.${name}`,
          message:
            `'${site.label}' calls \`${door}("${name}", …)\` and no declared consumer answers '${name}' — ${
              declared.size === 0
                ? `this app declares none, so the row is enqueued and never drained`
                : `declared: ${[...declared].sort().join(", ")}`
            }. The row lands in \`_outbox\` and nothing picks it up, silently, for as long as the app is deployed. Declare the consumer, or fix the spelling. This is a WARNING, not a refusal: the job vocabulary is deliberately open, so a name answered by a consumer outside this app is legal and will report here.`,
          rung: "static",
          responsible: {
            kind: "unknown",
            why: `${site.label} names ${what} '${name}'`,
          },
        });
      }
    }
  }
  return out;
}

/** The single-row reads that take NO lock — derived from the row-read roster so a new `find*` verb joins by
 *  construction, minus the one verb whose whole purpose is the lock. */
const UNLOCKED_ROW_READS: readonly string[] = DATA_ROW_READ_VERBS.filter((
  v: string,
) => v.startsWith("find") && v !== "findForUpdate");

/**
 * `tx/read-modify-write` — an unlocked read of a row, then a write of that row, in one handler.
 *
 * This is what an agent writes for "increment a counter": `ctx.data.<r>.find(id)`, compute, then
 * `ctx.data.<r>.update(id, …)`. Between the two, another transaction commits its own update and this one
 * overwrites it. The app's own suite cannot catch it — that suite is written by the same generator and runs
 * in one process, so the interleaving that falsifies the handler never occurs in the loop that produced it.
 *
 * Both remedies already exist and neither is the short spelling, which is the inversion this rule closes:
 * `findForUpdate(id)` holds the row lock to the op tx's commit, and `versioning: true` makes `update`
 * require the version that was read, so a stale write is refused rather than silently applied.
 *
 * SCOPE, stated rather than implied: the read set is derived (`find*` minus `findForUpdate`) and the write
 * is `update` — the single-row, value-carrying write. `updateWhere` / `updateMany` do not carry a value read
 * from a specific row, and `delete` loses no update. A resource that declares `versioning: true` is exempt
 * because its own `update` already refuses the stale write.
 */
export function checkReadModifyWrite(app: App): AppViolation[] {
  const out: AppViolation[] = [];
  for (const site of ctxHandlerSites(app)) {
    for (const m of app.model) {
      if (m.features.versioning) continue; // `update` already refuses a stale write
      const reads = rowVerbsCalled(site.fn, m.name, UNLOCKED_ROW_READS);
      if (reads.size === 0) continue;
      if (rowVerbsCalled(site.fn, m.name, ["update"]).size === 0) continue;
      // the lock IS the fix — a handler that also takes it has made the decision
      if (rowVerbsCalled(site.fn, m.name, ["findForUpdate"]).size > 0) continue;
      out.push({
        id: "tx/read-modify-write",
        clause: `${site.label}.${m.name}`,
        message: `'${site.label}' reads '${m.name}' with \`${
          [...reads].sort().join("`/`")
        }\` and then writes it with \`update\`, and '${m.name}' does not declare \`versioning: true\` — between the read and the write another transaction can commit its own update, and this handler overwrites it. The loss is silent and this app's own tests cannot produce it: they run in one process. Take the row lock for the read — \`ctx.data.${m.name}.findForUpdate(id)\`, held to this op's commit — or declare \`features: { versioning: true }\` on '${m.name}', which makes \`update\` require the version it read and refuse a stale write. If last-write-wins is the decision, say so with the lock and overwrite deliberately.`,
        rung: "static",
        responsible: {
          kind: "unknown",
          why: `${site.label} reads and writes '${m.name}' unlocked`,
        },
      });
    }
  }
  return out;
}
