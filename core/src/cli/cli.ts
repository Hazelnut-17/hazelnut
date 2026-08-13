// verb impls extracted into cohesive submodules, re-exported so hazelnut.ts + tests import from cli.ts unchanged.
export * from "./render-blocks.ts";
export * from "./render.ts";
export * from "./ops.ts";
export * from "./migrate-verbs.ts";
export * from "./scaffold.ts";
// The barrel re-exports only CORE-VERB modules — the core path imports cli.ts, so a barrel line is a STATIC
// edge that ships whatever it names. `explain-diagram.ts` sat here while `explain` is a verb the core CLI
// refuses, so 99 lines of an unreachable verb rode into the public artifact — the rule stated two paragraphs
// down, unapplied to the line above it. `withheld-verb-reach.test.ts` now checks it instead of stating it.
// explain/verify-verbs/
// project-tooling/impact stay off the barrel so their verify-module consumers import them directly.
// `project-agents.ts` is off it for the same reason: it reaches the AGENTS.md projector, which only the
// full build emits, and a barrel edge is enough to put all 421 lines of it in the core artifact.
//
// `upgrade.ts` / `upgrade-structural.ts` are off it for exactly that reason too: `upgrade` is a verb the
// core CLI refuses, so a barrel edge put both files in the artifact serving a verb no core consumer can
// run. Their consumers import them directly, like every other verify-module module.

/** The `hazelnut` CLI core (pure + testable; the entrypoint is `hazelnut.ts`). `hazelnut verify` maps the
 *  outcome to an exit code by the worst `blocks` rung (09-verifier.md §positioning): ship-blocking → 1,
 *  warn/advisory → 0, could-not-assemble → 2. `--json` emits the canonical stream (CH1 §5). */
export interface CliResult {
  readonly code: 0 | 1 | 2;
  readonly stdout: string;
}
