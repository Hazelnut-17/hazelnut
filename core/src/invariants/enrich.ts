// The raw-finding → canonical `Violation` widening, and the boot import graph it routes `responsible`
// through. Reads the composed model only, so it sits with the structural roster rather than the envelope.
import type { ResourceModel } from "../core/app.ts";
import { resolveBare, resolveFromSlot } from "../core/slot.ts";
import {
  deriveBlocks,
  fingerprint,
  type ImportEdge,
  type ImportGraph,
  type Invariant,
  type Responsible,
  type Rung,
  type Violation as FullViolation,
  WHOLE_MODULE,
} from "../core/verifier-contract.ts";
import { docRefFor } from "../core/docref.ts";
import { docsOnDisk } from "../core/docs-probe.ts";
import type { AppViolation, Violation } from "../core/structural-violation.ts";

/** Enrich an app-singleton finding (no owning resource) into the canonical Violation — `at`/`responsible` use the
 *  honest `kind:"unknown"` floor the raw finding already carries, mirroring the per-resource `enrich`. */
export function enrichApp(raw: AppViolation): FullViolation {
  const rung: Rung = raw.rung ?? "static";
  const at = { file: "<app>", startLine: 1 };
  return {
    id: raw.id,
    rung,
    blocks: deriveBlocks(rung, { concern: raw.id.split("/")[0] }),
    phase: "pre-ship",
    at,
    responsible: raw.responsible,
    message: raw.message,
    // resolvable axis-section pointer (or the id's own card) — stamped only when the canon tree is on disk
    // beside the running framework, else it is a path the reader cannot open (`alarm.ts` gates the same way).
    docRef: docsOnDisk() ? docRefFor(raw.id, rung) : undefined,
    fingerprint: fingerprint({
      id: raw.id,
      at,
      responsible: raw.responsible,
      clause: raw.clause,
    }),
    source: "verify",
  };
}

// importGraph (09-verifier.md §5 CH1, §13): built once at boot; cross-model invariants and CH1
// `responsible` chain-mining both share it. Exported so `hazelnut diff` reuses the same graph.

/** Path-based framework-vs-app resolver (09-verifier.md §5 CH3): a repo-relative `src/<file>.ts` under the
 *  framework root is `framework`; an app module/resource path is `app`; anything unclassifiable degrades
 *  to `unknown` (never confident-wrong). */
function frameworkVsApp(file: string): "framework" | "app" | "unknown" {
  if (file === "") return "unknown";
  const f = file.replace(/^\.\//, "");
  // the framework's own source tree (the verifier rides `src/*.ts`); a `.d.ts`/cache path is framework too.
  if (
    /^src\/[^/]+\.ts$/.test(f) || f.endsWith(".d.ts") || f.includes("/.cache/")
  ) return "framework";
  // an app-authored span: a module/resource path (`<module>/<resource>`) the enrich `at` uses, or an app file.
  if (
    /^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(f) || f.startsWith("app/") ||
    /\.(ts|tsx)$/.test(f)
  ) return "app";
  return "unknown";
}

/** Build the boot import graph: one `ImportEdge` per cross-module coupling (a `references.<field>` or a
 *  cross-module `parent`), plus one module-level `via:"deps"` edge per declared consumer→producer module
 *  pair in `moduleEdges`. Intra-module edges are excluded — a same-schema FK, no cross-module coupling.
 *  The two channels stay separate: a `deps` coupling names no resource, so it can only be matched
 *  module-wise (`ctx.modules.<dep>.<op>` needs no FK, and the FK set is not a superset of the dep set). */
export function buildImportGraph(
  model: ReadonlyArray<ResourceModel>,
): ImportGraph {
  const edges: ImportEdge[] = [];
  for (const m of model) {
    const couplings: Array<
      { to: string; via: "reference" | "parent"; field?: string }
    > = [
      ...Object.entries(m.references).filter(([, r]) => !r.external).map((
        [field, r],
      ) => ({ to: r.to, via: "reference" as const, field })),
      ...(m.parent
        ? [{ to: m.parent, via: "parent" as const, field: "parent" }]
        : []),
    ];
    for (const c of couplings) {
      const producerHit = resolveFromSlot(model, c.to, m.pgSchema);
      if (producerHit.kind !== "hit") continue;
      const producerModule = producerHit.value.module;
      if (producerModule !== m.module) {
        edges.push({
          from: m.module,
          to: producerModule,
          via: c.via,
          consumerResource: m.name,
          producerResource: c.to,
          field: c.field,
        });
      }
    }
  }
  // `moduleDeps` is the module's declared `deps`, replicated on each of its resources — so the pair is
  // deduped, never emitted per resource. A self-dep is not a cross-module coupling.
  const moduleEdges: ImportEdge[] = [];
  const pairs = new Set<string>();
  for (const m of model) {
    for (const dep of m.moduleDeps) {
      const key = `${m.module} ${dep}`;
      if (dep === m.module || pairs.has(key)) continue;
      pairs.add(key);
      moduleEdges.push({
        from: m.module,
        to: dep,
        via: "deps",
        consumerResource: WHOLE_MODULE,
      });
    }
  }
  const byFrom = new Map<string, ImportEdge[]>();
  for (const e of edges) {
    (byFrom.get(e.from) ?? byFrom.set(e.from, []).get(e.from)!).push(e);
  }
  return {
    edges,
    moduleEdges,
    moduleOf: (resource) => {
      const hit = resolveBare(model, resource);
      return hit.kind === "hit" ? hit.value.module : undefined;
    },
    dependenciesOf: (module) => byFrom.get(module) ?? [],
    packageOf: frameworkVsApp,
  };
}

/** The clause a raw finding rides, when it names a `references.<field>` (the field the cross-module edge couples
 *  on). `boundary/*` and `refs/*` findings carry `references.<target-or-field>`; we read the segment after the dot. */
function refFieldOfClause(clause: string | undefined): string | undefined {
  if (clause?.startsWith("references.")) {
    return clause.slice("references.".length);
  }
  return undefined;
}

/** CH1 `responsible` chain-mine (09-verifier.md §5 CH1, §13): a cross-module fault attributes to both the
 *  consumer symptom and the producer declaration it couples to, upgrading `responsible` from `declaration`
 *  to `cross` so an agent edits the producer, not the symptom. Non-cross faults keep the declaration floor. */
function resolveResponsible(
  raw: Violation,
  m: ResourceModel,
  ig: ImportGraph,
): Responsible {
  const consumerRef = raw.clause === undefined
    ? { module: m.module, resource: m.name }
    : { module: m.module, resource: m.name, clause: raw.clause };
  // only the relational families chain-mine; a per-resource structural fault is owned by its own declaration.
  const isCrossFamily = raw.id.startsWith("boundary/") ||
    raw.id === "refs/point-to-exposed";
  if (!isCrossFamily) return { kind: "declaration", ref: consumerRef };
  // find the edge this finding rides — the cross-module coupling whose field matches the finding's clause.
  const field = refFieldOfClause(raw.clause);
  const edge = ig.dependenciesOf(m.module).find((e) =>
    e.consumerResource === m.name &&
    (field === undefined || e.field === field || e.producerResource === field)
  );
  if (edge === undefined || edge.producerResource === undefined) {
    return { kind: "declaration", ref: consumerRef };
  }
  const producerModule = ig.moduleOf(edge.producerResource) ?? edge.to;
  const producerRef = {
    module: producerModule,
    resource: edge.producerResource,
  };
  // shallowest app-authored span guard (§5 CH3): only chain-mine into app space, never framework — a producer
  // the resolver classifies as framework degrades to the structural declaration floor.
  if (
    ig.packageOf(`${producerModule}/${edge.producerResource}`) === "framework"
  ) return { kind: "declaration", ref: consumerRef };
  return {
    kind: "cross",
    consumer: consumerRef,
    producer: producerRef,
    via: edge.via,
  };
}

/** Enrich a raw finding into the canonical Violation. The raw `clause` is preserved into `responsible` —
 *  load-bearing for finding identity (09-verifier.md §dedupe): `fingerprint`/`suppressKey` key on it via
 *  `clauseOf`, so two same-id faults on the same resource keep distinct keys, not resource granularity. */
export function enrich(
  raw: Violation,
  m: ResourceModel,
  inv: Invariant,
  ig: ImportGraph,
): FullViolation {
  const rung: Rung = inv.determinism ?? "static";
  const responsible = resolveResponsible(raw, m, ig);
  const at = { file: `${m.module}/${m.name}`, startLine: 1 };
  return {
    id: raw.id,
    rung,
    blocks: deriveBlocks(rung, { concern: raw.id.split("/")[0] }),
    phase: "pre-ship",
    at,
    responsible,
    message: raw.message,
    // resolvable axis-section pointer (or the id's own card) — stamped only when the canon tree is on disk
    // beside the running framework, else it is a path the reader cannot open (`alarm.ts` gates the same way).
    docRef: docsOnDisk() ? docRefFor(raw.id, rung) : undefined,
    fingerprint: fingerprint({ id: raw.id, at, responsible }),
    source: "verify",
  };
}
