/**
 * The ONE CLI dispatch body. Both entrypoints are thin: each states which capability module this build serves and which verbs
 * it serves, and nothing else.
 *
 * The module being a parameter is the point. It used to be inferred by probing the filesystem beside the CLI
 * (`scaffold.ts §frameworkTreeModule`), which answers "is there a checkout here", not "what am I" — so a CLI
 * served from a registry, or reached through `--pin`, derived the WRONG module and scaffolded a full app
 * out of the core artifact. A build knows what it is at compile time; nothing should have to look.
 *
 * Two entries rather than one is also deliberate: the entry file IS the module signal a `deno compile` build
 * carries, and the core artifact must not contain the verify roster. What was duplicated — and had already
 * drifted, one entry catching `CliRefusal` and the other not — is this body, so this is the only copy.
 */
import { CliRefusal } from "./hazelnut-io.ts";
// TYPE-only: erased at runtime, and `core/app.ts` is core content either way.
import type { App } from "../core/app.ts";
import {
  consumeAppPathEscape,
  CORE_SPELLING,
  equalsSpelledFlag,
  equalsSpellingMessage,
  type FlagRoster,
  type FlagSpelling,
  missingValueFlag,
  missingValueMessage,
  unknownFlag,
  unknownFlagMessage,
} from "./flag-roster.ts";

/** Which build this is. Set by the entrypoint, never inferred from disk. */
export type BuildModule = "core" | "full";

/** A capability module's own dispatch body, SUPPLIED by the entrypoint that carries it. */
export type ModuleDispatch = (
  cmd: string,
  modPath: string,
  rest: string[],
) => Promise<void>;

export async function runCli(
  buildModule: BuildModule,
  /** The verbs this build serves AND the flags each one recognises — one roster, so a verb cannot be served
   *  with an open flag surface. The served list derives from its keys; nothing states them twice. */
  roster: FlagRoster,
  /**
   * The full build's own dispatchers, HANDED IN rather than imported.
   *
   * A literal `await import("./hazelnut-app-cmd.ts")` here is a specifier Deno statically analyses, so the
   * withheld file — and everything it reaches — entered the CORE artifact's module graph: a core consumer's
   * first CLI run printed a dozen `Download …/src/verify/…` lines before the 404s were tolerated. That is
   * the table of contents `help` twenty lines above deliberately refuses to print, published by the loader
   * instead. Passing them in closes the core graph over core files by CONSTRUCTION, rather than defeating
   * the analyser with a computed specifier — which would hide the same import behind a string.
   */
  moduleDispatch: readonly ModuleDispatch[] = [],
  /** The verify envelope's own body — same reason as `moduleDispatch`, for the verb whose SCOPE (not its
   *  existence) depends on the build. */
  fullVerify?: (
    app: App,
    modPath: string,
    rest: string[],
  ) => Promise<void>,
  /** How THIS build's flags are spelled — folded from the same modules the roster is, so a module verb is
   *  gated by its own classification rather than by core's guess about it. */
  spelling: FlagSpelling = CORE_SPELLING,
): Promise<void> {
  const served = Object.keys(roster);
  // `modPath` stays undefined for a bare verb — handlers key on that; never coerce it.
  const [rawCmd, rawModPath, ...rawRest] = Deno.args as [
    string,
    string,
    ...string[],
  ];
  // `hazelnut <verb> -- -n.ts` — the escape for an app file whose name starts with `-`. Consumed HERE so the
  // token never reaches the gates, where it used to stop the scan and hide every flag behind it.
  // The slot's declared type is `string` and its VALUE is undefined for a bare verb — the destructure above
  // has always carried that, and handlers key on it. The escape preserves it rather than coercing.
  const { modPath, rest, escaped } = consumeAppPathEscape(
    rawModPath,
    rawRest,
  ) as { modPath: string; rest: string[]; escaped: boolean };
  // The app-path slot is scanned for flags like every other slot — a flag there is a typo — EXCEPT when the
  // caller used the escape to vouch that it is a path.
  const flagArgv = [escaped ? undefined : modPath, ...rest];
  // `--help`/`-h` are what everyone types first, and they are not verbs, so the allowlist below refused them
  // with exit 2 — a discovery attempt that reads as a broken tool and fails any script wrapping it.
  const cmd = rawCmd === "--help" || rawCmd === "-h" ? "help" : rawCmd;
  // ALLOWLIST, not a denylist: this build serves exactly `served`, and anything else is refused here, before
  // a dispatcher can load. Stating what it serves rather than what it withholds is the whole point — naming
  // the withheld verbs would publish a table of contents for a module the reader does not have.
  if (cmd === undefined || !served.includes(cmd)) {
    console.error(
      `hazelnut: unknown verb${
        cmd === undefined ? "" : ` '${cmd}'`
      } — this build serves: ${served.join(" · ")}`,
    );
    Deno.exit(2);
  }
  // THE SAME ALLOWLIST POSTURE, ONE LEVEL DOWN. A verb that accepts any flag name teaches invention: the
  // framework validated the VALUE of flags it knew (`--rules=bogus` exits 2) while discarding any flag NAME,
  // so a plausible analogy — `--dry-run` for `--print`, `--feature` for `--features` — exited 0 having done
  // something else. Every argv slot is scanned, the positional one included: a flag there is a typo too — and
  // the legal set is the SUBCOMMAND's, so a flag another subcommand reads is refused here rather than
  // silently discarded (`migrate <app> drift --include-audit` did nothing and said nothing).
  const invented = unknownFlag(roster, cmd, flagArgv);
  if (invented !== undefined) {
    console.error(
      unknownFlagMessage(roster, cmd, invented, flagArgv),
    );
    Deno.exit(2);
  }
  // THE SPELLING, ONE LEVEL DOWN AGAIN. The gates above rule on a flag's NAME; these rule on how it was
  // written. Both were once migrate's alone, and every sibling verb went on accepting `--json=true` and a
  // valueless `--topic` and running as if neither had been given. They sit HERE, before any dispatcher
  // loads, so no verb can be served with a spelling its reader cannot read — and an app module's top-level
  // side effects no longer run ahead of the refusal.
  const misspelled = equalsSpelledFlag(roster, cmd, flagArgv, spelling);
  if (misspelled !== undefined) {
    console.error(equalsSpellingMessage(cmd, misspelled, spelling));
    Deno.exit(2);
  }
  const valueless = missingValueFlag(roster, cmd, flagArgv, spelling);
  if (valueless !== undefined) {
    console.error(missingValueMessage(cmd, valueless));
    Deno.exit(2);
  }
  if (cmd === "help") {
    // ONLY `served`. The withheld verbs are not listed even as unavailable: naming them would publish a table
    // of contents for a capability module the reader does not have (the same rule the allowlist above keeps).
    console.log(
      `hazelnut — a Deno backend framework.\n\n` +
        `  usage: hazelnut <verb> [args]\n\n` +
        `  this build serves:\n${
          served.map((v) => `    ${v}`).join("\n")
        }\n\n` +
        `  \`hazelnut <verb>\` with no arguments prints that verb's usage.`,
    );
    Deno.exit(0);
  }
  try {
    const { dispatchRuntime } = await import("./hazelnut-run-cmd.ts");
    await dispatchRuntime(cmd, modPath, rest);
    const { dispatchScaffold } = await import("./hazelnut-scaffold-cmd.ts");
    await dispatchScaffold(cmd, modPath, rest, buildModule);
    // `migrate` — a CORE verb, in its own core-owned dispatcher (never beside the withheld app family).
    const { dispatchInstall } = await import("./hazelnut-install-cmd.ts");
    await dispatchInstall(cmd, modPath, rest);
    const { dispatchSchema } = await import("./hazelnut-schema-cmd.ts");
    await dispatchSchema(cmd, modPath, rest);
    const { dispatchMigrate } = await import("./hazelnut-migrate-cmd.ts");
    // `served` is threaded, not defaulted: the usage line this dispatcher prints names what THIS BUILD
    // serves. Left to its `= CORE_VERBS` default it advertised ten verbs on a build that serves seventeen —
    // a parameter that exists to be passed and never was.
    await dispatchMigrate(cmd, modPath, rest, served);
    // `verify` — a CORE verb whose SCOPE depends on the build: the structural fold here, the whole envelope
    // on a full build. The dispatcher owns that branch, so the verb has exactly one dispatch point.
    const { dispatchStructural } = await import("./hazelnut-structural-cmd.ts");
    await dispatchStructural(cmd, modPath, rest, buildModule, fullVerify);
    // Upgrade / range-diff live only on a full build, and this body never NAMES their module: the full
    // entrypoint hands its dispatchers in, so the core graph closes over core files.
    for (const dispatchModule of moduleDispatch) {
      await dispatchModule(cmd, modPath, rest);
    }
  } catch (e) {
    // Only a user-actionable refusal is rendered bare; a genuine framework bug keeps its stack, because
    // swallowing that would trade one bad first-run experience for undebuggable crashes everywhere else.
    if (!(e instanceof CliRefusal)) throw e;
    console.error(e.message);
    Deno.exit(2);
  }
}
