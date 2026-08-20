/**
 * The `verify` dispatcher. A CORE build runs the STRUCTURAL rung — a fold over the composed model — and says
 * so in its own output. A full build delegates to the verification envelope, which runs the same fold plus
 * the rungs that read something outside the model.
 *
 * ONE verb, one dispatch point, two envelopes over ONE fold. A second verb name would fork every `ci` task,
 * every handbook page and every consumer's muscle memory for a difference the output states in one line —
 * and the honesty the split needs is the SCOPE statement, not the name (09-verifier.md §rung-delivery).
 */
import { applyOptIn, runStructural } from "../invariants/run-structural.ts";
import {
  FLOOR_IDS,
  floorRungViolations,
} from "../invariants/floor-rung-shield.ts";
import { toolExplosionAdvisory } from "../mcp/mcp-tooldefs.ts";
import {
  STRUCTURAL_APP_META,
  structuralInvariants,
} from "../invariants/roster.ts";
import { loadApp } from "./hazelnut-io.ts";
import { parseSurfacesFlag } from "./flag-roster.ts";
import type { BuildModule } from "./dispatch.ts";
import {
  BLOCKS_LABEL,
  BLOCKS_ORDER,
  blocksLabelBare,
  renderFix,
  renderFixHint,
  rungRank,
} from "./render-blocks.ts";
import {
  deriveBlocks,
  fingerprint,
  type Violation,
} from "../core/verifier-contract.ts";
import type { App } from "../core/app.ts";

/**
 * What this rung does NOT look at.
 *
 * Stated by SUBJECT, never by verb or module name: naming the verbs a build withholds publishes a table of
 * contents for something the reader does not have (`dispatch.ts`'s help rule). Stated AT ALL, because a
 * narrower checker reporting clean under a familiar name is exactly the failure `type/channel-unavailable`
 * exists to prevent — applied here to a whole build rather than one dark channel.
 */
export const UNCHECKED_SUBJECTS: readonly string[] = [
  `the SOURCE of your handlers, queries and tests — \`deno check\` and \`deno lint\` in \`deno task ci\` cover the compiler's half of it, and \`lint/floor-rung-narrowed\` above refuses if this app switched that rung off. That rung is the ${FLOOR_IDS.length}-rule safety floor, not every discipline rule this framework has`,
  "files sitting beside your declarations that a richer build regenerates and compares (a discovered `*.prompt.ts`, a generated project brief)",
  "your HTTP / MCP / event surface against a committed baseline",
  "your rowPolicy implementations against a written specification",
  "your migration history against the schema your declarations now derive to — `deno task migrate` checks that",
  "anything that needs a language model to judge",
];

/**
 * `mcp/tool-explosion` as a full advisory `Violation` (12-mcp.md §curation, unregistered like foreign-shape).
 *
 * It runs on EVERY build, not just the envelope's: the check is pure over the composed model and reads
 * nothing a core build lacks, so withholding it printed `0 advisory` on a 45-tool agent surface — a narrower
 * checker reporting clean under a familiar name, which is what the banner below exists to prevent.
 */
export function toolExplosionViolations(app: App): Violation[] {
  return toolExplosionAdvisory(app).map((t) => {
    const at = { file: t.resource, startLine: 1 };
    const responsible = { kind: "unknown" as const, why: t.message };
    return {
      id: t.id,
      rung: "runtime-assert" as const,
      blocks: deriveBlocks("runtime-assert", { concern: "mcp" }),
      phase: "pre-ship" as const,
      at,
      responsible,
      message: t.message,
      // no docRef: this build ships no canon for one to resolve against, and the message carries the count,
      // the threshold and the fix without needing a pointer
      fingerprint: fingerprint({ id: t.id, at, responsible }),
      source: "verify" as const,
    };
  });
}

/** The core report: the scope line, the verdict, the findings, and what the rung did not look at. The
 *  banner is UNCONDITIONAL — a clean run is exactly when a reader most needs to know what "clean" covered. */
export function renderStructuralReport(
  violations: ReadonlyArray<Violation>,
): string {
  const checks = structuralInvariants.length + STRUCTURAL_APP_META.length;
  const count = (b: Violation["blocks"]) =>
    violations.filter((v) => v.blocks === b).length;
  const lines = [
    `verify (structural rung) — ${checks} checks over the model your declarations compose to`,
    `${count("ship") === 0 ? "✓" : "✗"} ${count("ship")} ship-blocking (${
      count("warn")
    } warn · ${count("advisory")} advisory)`,
  ];
  for (const b of BLOCKS_ORDER) {
    const items = violations.filter((v) => v.blocks === b).slice().sort((
      a,
      z,
    ) => rungRank(a.rung) - rungRank(z.rung));
    if (items.length === 0) continue;
    lines.push("", `${BLOCKS_LABEL[b]} (${items.length})`);
    for (const v of items) {
      lines.push(`  ${blocksLabelBare(v.blocks)} ${v.id} · ${v.message}`);
      lines.push(renderFix(v));
      if (v.fixHint) lines.push(`          → ${renderFixHint(v.fixHint)}`);
      lines.push(`    at:   ${v.at.file}:${v.at.startLine}`);
    }
  }
  lines.push("", "not checked by this rung:");
  for (const s of UNCHECKED_SUBJECTS) lines.push(`  · ${s}`);
  return lines.join("\n");
}

export async function dispatchStructural(
  cmd: string,
  modPath: string,
  rest: string[],
  buildModule: BuildModule,
): Promise<void> {
  if (!(cmd === "verify")) return; // the `cmd === "<verb>"` form the dispatch scans read as the served set
  if (!modPath) {
    console.error("usage: hazelnut verify <app> [--json]");
    Deno.exit(2);
  }
  const app = await loadApp(modPath);
  if (buildModule === "full") {
    // the envelope owns every rung above the fold; it loads LAZILY so the core path never touches it.
    const { cmdVerifyImpl } = await import("./hazelnut-verify-cmd.ts");
    await cmdVerifyImpl(app, modPath, rest);
    return;
  }
  // A flag this build cannot honour is REFUSED, never ignored. Accepting `--surfaces` here would print a
  // clean structural report and exit 0 on a check that never ran — a verdict reporting clean having looked
  // at nothing, which is worse than no verdict. The lock this flag reads is minted by `diff`, a verb a core
  // build does not serve, so there is nothing here for it to check.
  const unserved = parseSurfacesFlag([modPath, ...rest]);
  if (unserved.present) {
    console.error(
      `verify: this build does not serve --surfaces — the surface locks it reads are written by \`hazelnut diff\`, which this build does not serve either, so there is no committed surface for it to compare. Run \`verify\` alone for the structural rung, or use a build that carries the verification envelope.`,
    );
    Deno.exit(2);
  }
  // Core has no override surface (`rules`/`mute`/`promote` are envelope config keys a core app's boot
  // refuses), so the opt-in set is always suppressed here — never promoted.
  //
  // The tool-explosion advisory joins the fold rather than the banner: it is pure over the composed model,
  // reads nothing a core build lacks, and a core consumer who ships an MCP surface can explode it. Withholding
  // a check this build can run, under a verdict that says "clean", is the failure the banner exists to name.
  const violations = [
    ...applyOptIn(runStructural(app)),
    ...toolExplosionViolations(app),
    // The floor rung's shield. The banner below tells the reader `deno lint` covers their source; that is a
    // CLAIM about the app's own config, and an app that dropped `lint.plugins` makes it false while every
    // other gate stays green. Checked here so the sentence and the verdict cannot disagree.
    ...await floorRungViolations(Deno.cwd()),
  ];
  console.log(
    rest.includes("--json")
      ? JSON.stringify(violations, null, 2)
      : renderStructuralReport(violations),
  );
  Deno.exit(violations.some((v) => v.blocks === "ship") ? 1 : 0);
}
