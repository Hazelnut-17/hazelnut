import type { ResourceModel } from "./app.ts";
import { fnv1a } from "./version.ts";

/**
 * The canonical verifier finding contract (09-verifier.md §3-4) — the cross-channel API every rung
 * (type/lint/verify/test/judge) folds into. `rung` orders (fix hard rungs first); `blocks` gates and is
 * derived, never hand-written. `at` is where the tool saw the symptom; `responsible` is where the agent
 * must edit the cause (never null — `kind:"unknown"` with a `why` is the honest floor).
 */

export type Rung =
  | "by-construction"
  | "type"
  | "static"
  | "property"
  | "runtime-assert"
  | "judge";
export type Channel = "type" | "lint" | "verify" | "test" | "judge";
export type Phase = "pre-ship" | "runtime";

/** The `phase` axis discriminant (additive): `pre-ship` gates the build (static verify-time pass); `runtime`
 *  is emitted post-ship by a runtime assert reading the live database (e.g. `outbox/dlq-drained`), routed to
 *  a monitor/alarm channel instead. An alarm router keys on this to deliver only live findings (alarm.ts). */
export const isRuntimePhase = (v: { readonly phase: Phase }): boolean =>
  v.phase === "runtime";
export type Blocks = "ship" | "warn" | "advisory";

export interface Span {
  readonly file: string;
  readonly startLine: number;
  readonly startCol?: number;
  readonly endLine?: number;
  readonly endCol?: number;
}
export interface DeclRef {
  readonly module: string;
  readonly resource?: string;
  readonly clause?: string;
  readonly span?: Span;
}

export type Responsible =
  | { readonly kind: "declaration"; readonly ref: DeclRef }
  | { readonly kind: "logic"; readonly file: string; readonly opId: string }
  | { readonly kind: "query"; readonly file: string }
  | {
    readonly kind: "cross";
    readonly consumer: DeclRef;
    readonly producer: DeclRef;
    readonly via: string;
  }
  | {
    readonly kind: "spec";
    readonly ref: DeclRef;
    readonly specFile: string;
    readonly side: "impl" | "spec";
  }
  | { readonly kind: "unknown"; readonly why: string };

export type FixHint =
  | { readonly kind: "rename-id"; readonly from: string; readonly to: string }
  | { readonly kind: "edit"; readonly span: Span; readonly replacement: string }
  | {
    readonly kind: "add-clause";
    readonly ref: DeclRef;
    readonly clause: string;
    readonly exampleFrom?: string;
  }
  | { readonly kind: "remove"; readonly span: Span }
  | { readonly kind: "add-escape"; readonly comment: string }
  | { readonly kind: "text"; readonly guidance: string };

export interface ReplaySlot {
  readonly seed: number;
  readonly shrunkInput: unknown;
  readonly fidelity: "real-pg" | "in-memory";
  readonly reproCmd?: string;
}

export interface Violation {
  readonly id: string; // canonical (aliases resolved before emit)
  readonly rung: Rung; // orders — fix the hard rungs first
  readonly blocks: Blocks; // gates — derived via deriveBlocks, never hand-written
  readonly phase: Phase;
  readonly at: Span; // where the symptom was observed (may be derived/generated space)
  readonly responsible: Responsible; // where the cause is declared and must be edited
  readonly related?: ReadonlyArray<DeclRef>;
  readonly message: string; // one actionable, leak-free NL line
  readonly fixHint?: FixHint; // advisory — never auto-applied
  readonly docRef?: string; // derived from id
  readonly replay?: ReplaySlot; // property rung only
  readonly fingerprint: string; // = dedupeKey
  readonly source: Channel;
}

export interface VerifyHarness {
  readonly run: (name: string) => Promise<unknown>;
} // property/judge seam (substrate)

/** A cross-module dependency edge in the boot `ImportGraph`: `from` (consumer) depends on `to` (producer)
 *  `via` a named coupling. `producerResource` lets CH1 chain-mining attribute a cross-module fault to the
 *  producer declaration, not the symptom at the consumer (09-verifier.md §5 CH1 · §13).
 *  A `via:"deps"` edge is MODULE-level: `deps: ["catalog"]` licenses `ctx.modules.catalog.<op>` from any op
 *  body, and a body is opaque to the model — so it names no producer resource and carries the wildcard `*`
 *  as its consumer resource. Such an edge answers "which module breaks", never "which resource". */
export interface ImportEdge {
  readonly from: string; // consumer module
  readonly to: string; // producer module
  readonly via: "deps" | "reference" | "parent";
  readonly consumerResource: string; // `*` on a module-level (`deps`) edge — the whole consumer module
  readonly producerResource?: string; // absent on a module-level (`deps`) edge
  readonly field?: string; // the `references.<field>` (or "parent") clause the edge rides
}

/** The consumer-resource wildcard a module-level (`deps`) edge carries: no single resource declares the
 *  coupling, so the edge stands for every resource in `from`. Never a legal resource name. */
export const WHOLE_MODULE = "*";

/**
 * The boot-time module→module reverse-dep graph the cross-module invariants and CH1 `responsible`
 * resolution read (09-verifier.md §5 CH1 · §13). Built once per `runVerify`, shared with `hazelnut diff`'s
 * ImpactReport. `packageOf` is a path-based framework-vs-app resolution heuristic (CH3 attribution keys on it).
 */
export interface ImportGraph {
  readonly edges: ReadonlyArray<ImportEdge>; // resource-level couplings only (`reference` / `parent`)
  // The module-level (`deps`) couplings, kept in their OWN channel: they are keyed by module, not by
  // producer resource, so a reader that indexes `edges` by `producerResource` would silently drop them —
  // the fail-open that let a removed `exposes` op reach no consumer. A reader must ask for them by name.
  readonly moduleEdges: ReadonlyArray<ImportEdge>;
  readonly moduleOf: (resource: string) => string | undefined; // resource name → owning module
  // producers a consumer module imports (resource-level `edges` out of `from`); used to mine a cross-fault to
  // its producer declaration — so it excludes `moduleEdges`, which name no producer resource to mine to.
  readonly dependenciesOf: (module: string) => ReadonlyArray<ImportEdge>;
  readonly packageOf: (file: string) => "framework" | "app" | "unknown"; // resolution seam (framework vs app)
}

/** The per-check context (09-verifier.md §3 — `VerifyCtx = {model, importGraph, harness}`). `model` is the
 *  whole composed model (cross-model invariants read it); `resource` is the one under check. `importGraph`
 *  routes CH1's `responsible`; `harness` is the property/judge substrate seam. */
export interface VerifyCtx {
  readonly resource: ResourceModel; // the resource under check (per-resource invariants read this)
  readonly model: ReadonlyArray<ResourceModel>; // the whole composed model (cross-model invariants read this)
  readonly importGraph: ImportGraph; // the boot dep-graph — CH1 resolves `responsible` through it
  readonly harness?: VerifyHarness; // property/judge substrate seam
  // Per-run memo of the whole-model lookups cross-model per-resource invariants need: without it, each of N
  // checks rebuilds an index → O(n²)-ish. Optional — a hand-built ctx without it falls back to rebuilding.
  readonly modelIndex?: ModelIndex;
}

/** The whole-model lookup tables the cross-model per-resource invariants consult, built ONCE per `runVerify`
 *  (the verify-O(n) memo). Each field mirrors a per-check rebuild that was previously O(n)-per-resource. */
export interface ModelIndex {
  readonly schemaOf: ReadonlyMap<string, string>; // resource name → pgSchema (last-wins, == `new Map(model.map(...))`)
  readonly moduleOf: ReadonlyMap<string, string>; // resource name → module
  readonly permsVocab: ReadonlySet<string>; // ∪ of every resource's auto-seeded perms
  readonly names: ReadonlySet<string>; // every registered resource name
  readonly bySlot: ReadonlyMap<string, ReadonlyArray<ResourceModel>>; // `${name}::${pgSchema}` → models in decl order
  readonly byTable: ReadonlyMap<string, ResourceModel>; // `"${pgSchema}"."${name}"` → first model (== `.find`)
  readonly firstOfModule: ReadonlyMap<string, ResourceModel>; // module → its FIRST declared model (== `.find`)
}

/** The raw finding an `Invariant.check` emits — `{id, resource, message, clause?}`. `enrich` (verify.ts)
 *  upgrades each into the full cross-channel `Violation` above. The narrow authoring shape keeps each
 *  invariant terse; the full shape is the wire contract. */
export interface RawFinding {
  readonly id: string;
  readonly resource: string;
  readonly message: string;
  readonly clause?: string; // dotted clause inside the decl (load-bearing for suppress/dedupe identity, §dedupe)
}

/** The structural-rung `Invariant` — the spec's `{id, determinism?, check}` contract (09-verifier.md §3).
 *  `check(ctx: VerifyCtx)` reads the focused `ctx.resource`, the whole `ctx.model`, and `ctx.importGraph`
 *  (CH1 routes `responsible` through it). */
export interface Invariant {
  readonly id: string;
  readonly determinism?: Rung; // axis position, hard→floor; every structural invariant is `static` (runVerify default)
  readonly phase?: Phase;
  readonly feature?: string; // present = runs only when that feature is enabled
  readonly check: (ctx: VerifyCtx) => RawFinding[];
}

export interface Verdict {
  readonly verdict: "pass" | "fail";
  readonly findings: ReadonlyArray<Violation>;
  readonly tags?: ReadonlyArray<string>;
}

/** `blocks` is derived, never hand-written (09-verifier.md §4): hygiene/perf are static-rung warn;
 *  otherwise a hard rung (by-construction/type/static/property) or a curated-gating judge finding ships;
 *  else advisory. `rung` orders, `blocks` gates — independent reads. */
export function deriveBlocks(
  rung: Rung,
  opts: { concern?: string; judgeGating?: boolean } = {},
): Blocks {
  if (opts.concern === "hygiene" || opts.concern === "perf") return "warn";
  if (
    rung === "by-construction" || rung === "type" || rung === "static" ||
    rung === "property"
  ) return "ship";
  if (rung === "judge" && opts.judgeGating) return "ship";
  return "advisory";
}

const declPath = (d: DeclRef): string =>
  `${d.module}/${d.resource ?? ""}#${d.clause ?? ""}`;

/** The canonical "where to edit" path — stable across line shifts, distinct per responsible-kind. */
export function responsiblePath(r: Responsible): string {
  switch (r.kind) {
    case "declaration":
      return `decl:${declPath(r.ref)}`;
    case "logic":
      return `logic:${r.file}:${r.opId}`;
    case "query":
      return `query:${r.file}`;
    case "cross":
      return `cross:${declPath(r.consumer)}~${declPath(r.producer)}`;
    case "spec":
      return `spec:${declPath(r.ref)}:${r.side}`;
    case "unknown":
      return `unknown:${r.why}`;
  }
}

const clauseOf = (r: Responsible): string =>
  r.kind === "declaration" || r.kind === "spec"
    ? (r.ref.clause ?? "")
    : r.kind === "cross"
    ? (r.consumer.clause ?? "")
    : "";

/** `dedupeKey` (09-verifier.md §dedupe): id + responsible path + at.file + line-bucket + clause — includes
 *  the symptom point so a second distinct fault is not merged into the already-fixed first; the line-bucket
 *  (10 lines) survives small line shifts across runs. */
export function fingerprint(
  v: Pick<Violation, "id" | "at" | "responsible">,
): string {
  const lineBucket = Math.floor(v.at.startLine / 10);
  return fnv1a(
    [
      v.id,
      responsiblePath(v.responsible),
      v.at.file,
      String(lineBucket),
      clauseOf(v.responsible),
    ].join("\x00"),
  );
}

/** `suppressKey` (09-verifier.md §dedupe): drops `at` entirely (survives any line shift) but keeps the
 *  clause — so a waiver matches only same-clause faults, never "any future fault on this declaration." */
export function suppressKey(v: Pick<Violation, "id" | "responsible">): string {
  return fnv1a(
    [v.id, responsiblePath(v.responsible), clauseOf(v.responsible)].join(
      "\x00",
    ),
  );
}

/** The explain-card contract: the shape `hazelnut explain` renders and the MCP `hazelnut-semantics://`
 *  resource serves. Lives runtime-side since the semantics surface is a served cold path; the renderers
 *  (explainInvariant/explainFeature) stay verify-tooling, reached lazily. */
export interface Explanation {
  readonly id: string;
  readonly known: boolean; // is this a SHIPPED invariant (in the contract surface)?
  readonly concerns?: readonly string[];
  readonly introducedIn?: string;
  readonly shadowedBy?: string; // the principle id this invariant hardens
  readonly principleTitle?: string;
  readonly principleBody?: string;
  readonly docRef: string;
}

/** One cached verify result: the memo key + the enriched findings it resolved to. Lives runtime-side so
 *  the CLI IO layer can type against it without pulling in the verify tooling. */
export interface VerifyCacheEntry {
  readonly key: string;
  readonly violations: ReadonlyArray<Violation>;
}

/** The pluggable verify-cache STORE seam — `load` returns the cached findings for a key (undefined = miss),
 *  `store` persists a fresh result. A corrupt backing MUST surface as a miss (never a throw) — a bad cache
 *  always falls back to a fresh cold pass. */
export interface VerifyCacheStore {
  load(key: string): ReadonlyArray<Violation> | undefined;
  store(key: string, violations: ReadonlyArray<Violation>): void;
}

/** A committed surface lock's on-disk SHAPE — the bytes a core path reads back and compares.
 *
 *  The shape lives in core while every producer of it stays verify-module. It was typed by importing the
 * verify module directly, and `import type` is erased at runtime so it looked — but it is a
 * STATIC edge into a withheld directory, and the could not see it: `deno info` merges a
 *  static-type edge and a dynamic edge on the same specifier into ONE entry flagged dynamic, which every
 *  closure walk skips. Naming the shape here removes the edge instead of hiding it. */
export type SurfaceLockShape = Readonly<Record<string, unknown>>;
