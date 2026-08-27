// deno-lint-ignore-file no-explicit-any -- `ExplainSlot`'s members are bare callables on purpose: a
// precise signature here would import the capability module's TYPES into a core file, and a type-only
// import is still a specifier in the graph — the exact leak this file exists to close.
/**
 * The one place a CORE file reaches a CAPABILITY MODULE's body — by KEY, never by specifier.
 *
 * A literal `await import("../verify/…")` is a specifier Deno statically analyses, so the withheld file and
 * everything it reaches entered the CORE artifact's module graph: a core consumer's first CLI run printed a
 * column of `Download …/src/verify/…` lines before the 404s were tolerated — the table of contents `help`
 * deliberately refuses to print, published by the loader instead. Gating the CALL on the build does not
 * help; the analyser reads the specifier, not the branch.
 *
 * So the module's own entrypoint INSTALLS its bodies here, and core files LOOK THEM UP. A core build
 * installs nothing, and its graph closes over core files by construction rather than by a computed
 * specifier — which would hide the same import behind a string and leave the next reader guessing.
 *
 * A key names the BODY, never the module that supplies it (`cmd.explain`, not `<module>.explain`). Which
 * module carries a body is that module's business, and a key spelling it would put the same table of
 * contents in the artifact by another route.
 */

const slots = new Map<string, unknown>();

/** Called by a capability module's entrypoint, once, before dispatch. */
export function installModuleSlot(key: string, body: unknown): void {
  slots.set(key, body);
}

/** The installed body, or `undefined` on a build that does not carry the module. A caller that cannot
 *  proceed without one must say so itself — silence here is the core build's honest answer. */
export function moduleSlot<T>(key: string): T | undefined {
  return slots.get(key) as T | undefined;
}

/**
 * The `explain` verb's bodies, as ONE slot: the verb needs six modules, and six keys would be six chances
 * to install half a verb.
 *
 * The members are typed as bare callables ON PURPOSE. Naming their real signatures here would import the
 * module's types into a CORE file, which is the leak this whole indirection exists to close — a type-only
 * import is erased at runtime, but it is still a specifier in the graph. The call sites keep their own
 * argument types; what this interface pins is that the slot carries all twelve members or none.
 */
export interface ExplainSlot {
  readonly cliExplain: (...a: any[]) => any;
  readonly cliExplainFeature: (...a: any[]) => any;
  readonly cliExplainObligations: (...a: any[]) => any;
  readonly cliExplainResidualStubs: (...a: any[]) => any;
  readonly scanEscalatedMarkers: (...a: any[]) => any;
  readonly scanWaiverMarkers: (...a: any[]) => any;
  readonly cliExplainAs: (...a: any[]) => any;
  readonly cliExplainAsRow: (...a: any[]) => any;
  readonly cliExplainResidual: (...a: any[]) => any;
  readonly cliExplainDiagram: (...a: any[]) => any;
  readonly cliConsumers: (...a: any[]) => any;
  readonly featureCatalog: Readonly<Record<string, unknown>>;
}

/** The projectors `hazelnut new` runs on a FULL build — AGENTS.md / ARCHITECTURE.md and the principle
 *  roster they render from. Same reason as `ExplainSlot`: the emitter is core and synchronous, so a static
 *  import of these published the principle bodies into the core artifact. */
export interface ProjectSlot {
  readonly cliProjectAgents: (...a: any[]) => { content: string };
  readonly projectArchitectureMd: (...a: any[]) => string;
  readonly principlesForApp: (...a: any[]) => ReadonlyArray<object>;
  readonly featuresOfResource: (...a: any[]) => string[];
}

/** The AGENTS.md / steer projectors. Same reason again: naming `verify/project.ts` from the core scaffold
 *  dispatcher put the authored principle bodies in the core artifact's graph. */
export interface SteerSlot {
  readonly projectAgentsMd: (...a: any[]) => string;
  readonly projectSteer: (...a: any[]) => string | null;
  readonly projectSteerJson: (...a: any[]) => string;
  readonly projectSteerResourceSlice: (...a: any[]) => string;
  readonly projectSteerSlice: (...a: any[]) => string;
}
