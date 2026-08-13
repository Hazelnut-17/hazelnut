/**
 * THE CLI FLAG SURFACE — what each verb RECOGNISES, stated per build the way the verb set is.
 *
 * The verb allowlist was closed and the flag surface was open: every core verb silently discarded any
 * invented `--flag`, so `--jsonn` printed human text to a caller parsing JSON and `--dry-run` served live
 * traffic. Invention has to be refused BY NAME here for the same reason it is refused for verbs — a coherent
 * guess (`--no-example` beside the real `--no-git`) is the failure mode, and a silent no-op teaches it.
 *
 * A module's own flags live with that module's verb roster, never here: a roster of withheld verbs shipped
 * in the core artifact is a table of contents for a module the reader does not have.
 */

import { CORE_VERBS } from "./build-module.ts";

/** The migrate SUBCOMMAND vocabulary, in the precedence the dispatcher matches it — `dispatchSchema` asks
 *  `rest.includes(<sub>)` in this order, so reading the first present one here resolves the SAME branch that
 *  will run. Single-sourced: the dispatcher imports it rather than restating it. */
export const MIGRATE_SUBCOMMANDS = [
  "drift",
  "generate",
  "rebase",
  "preview",
  "status",
  "check",
  "reset",
  "apply",
] as const;

/**
 * A verb whose flags differ PER SUBCOMMAND. The verb-level union was the whole surface, so `--include-audit`
 * (read only by `reset`) sailed through `drift` and did nothing — the same silent no-op the flag gate exists
 * to end, one granularity down.
 *
 * `scopes` is BOTH the subcommand vocabulary and the per-subcommand surface, so a subcommand added without a
 * flag list is a type error; `shared` is what every subcommand reads; `fallback` is the subcommand a bare
 * invocation runs.
 */
export interface ScopedFlags<Sub extends string = string> {
  readonly shared: readonly string[];
  readonly scopes: Readonly<Record<Sub, readonly string[]>>;
  readonly fallback: Sub;
}

/** verb → the flags that verb recognises on this build, either as one surface or scoped per subcommand. A
 *  flag a build cannot ACT on may still be listed: the owning dispatcher refuses it by name with the reason
 *  (`verify --surfaces` on a core build). */
export type FlagRoster = Readonly<
  Record<string, readonly string[] | ScopedFlags>
>;

/** True for the scoped shape — the two are distinguished structurally, never by a caller-passed tag. */
function isScoped(v: readonly string[] | ScopedFlags): v is ScopedFlags {
  return !Array.isArray(v);
}

/** Which subcommand this argv runs: the first `scopes` key present, in the roster's declared precedence —
 *  the dispatcher's own matching order — else `fallback`. */
function resolveScope(
  scoped: ScopedFlags,
  argv: ReadonlyArray<string | undefined>,
): string {
  const present = new Set(argv.filter((a): a is string => a !== undefined));
  return Object.keys(scoped.scopes).find((s) => present.has(s)) ??
    scoped.fallback;
}

/** The scope keys that are themselves flags — `explain --diagram` is a MODE spelled as one, so it belongs to
 *  the verb's vocabulary in every scope; which mode's MODIFIERS apply is the separate question below. */
export function modeFlags(scoped: ScopedFlags): readonly string[] {
  return Object.keys(scoped.scopes).filter((k) => k.startsWith("-"));
}

/** The flags legal for this argv: a flat verb surface, or `shared` + the resolved subcommand's own + the
 *  flag-spelled scope keys. */
function legalFlags(
  roster: FlagRoster,
  verb: string,
  argv: ReadonlyArray<string | undefined>,
): { known: readonly string[]; scope: string | null } {
  const entry = roster[verb];
  if (entry === undefined) return { known: [], scope: null };
  if (!isScoped(entry)) return { known: entry, scope: null };
  const scope = resolveScope(entry, argv);
  return {
    known: [
      ...entry.shared,
      ...(entry.scopes[scope] ?? []),
      ...modeFlags(entry),
    ],
    scope,
  };
}

/** The CORE build's flag surface. Keyed by `CORE_VERBS` itself, so a verb declared without a flag surface —
 *  or a flag surface for a verb this build does not serve — is a TYPE error, not a test someone must write. */
export const CORE_FLAGS: Readonly<
  Record<typeof CORE_VERBS[number], readonly string[] | ScopedFlags>
> = {
  help: [],
  new: [
    "--example",
    "--no-git",
    "--rules",
    "--steer",
    "--core",
    "--local",
    "--vendor",
    "--pin",
  ],
  add: ["--features", "--ops"],
  install: ["--from"],
  doctor: [],
  // `--surfaces` is recognised so the core build can refuse it with its reason (hazelnut-structural-cmd.ts);
  // a build carrying extra rungs widens this key with the flags they add.
  verify: ["--json", "--surfaces"],
  // SCOPED: every flag below sits on the subcommand that READS it. `--safe-ddl` is the standalone
  // `migrate --safe-ddl <file>` mode — it occupies the app-path slot and names no subcommand, so it and the
  // two flags it reads (`--dir`, `--immutable`) ride `shared`.
  migrate: {
    shared: ["--safe-ddl", "--out", "--dir", "--immutable"],
    scopes: {
      drift: [],
      generate: ["--online", "--allow-destructive"],
      rebase: ["--env", "--yes", "--execute"],
      preview: ["--env"],
      status: ["--env"],
      check: ["--env"],
      reset: ["--env", "--yes", "--include-audit"],
      apply: ["--env", "--yes"],
    },
    fallback: "apply",
  } satisfies ScopedFlags<typeof MIGRATE_SUBCOMMANDS[number]>,
  launch: ["--print", "--explain", "--entry"],
  mcp: [],
  relay: ["--loop", "--interval", "--health-port"],
  ops: ["--reason", "--execute"],
  redrive: ["--topic", "--limit", "--execute"],
  "rotate-key": [
    "--from",
    "--to",
    "--new-key-env",
    "--old-key-env",
    "--execute",
  ],
  "run-workflow": ["--execute"],
  "unstick-workflow": ["--workflow", "--step", "--execute"],
};

/** Folds the module rosters onto core's. A verb both sides name is UNIONED, never overwritten: `verify` is a
 *  core verb whose flag surface WIDENS under the verification envelope, and an overwrite would drop `--json`. */
export function mergeFlagRosters(...rosters: FlagRoster[]): FlagRoster {
  const union = (a: readonly string[], b: readonly string[]): string[] => [
    ...a,
    ...b.filter((f) => !a.includes(f)),
  ];
  const out: Record<string, readonly string[] | ScopedFlags> = {};
  for (const roster of rosters) {
    for (const [verb, entry] of Object.entries(roster)) {
      const prior = out[verb];
      if (prior === undefined) {
        out[verb] = entry;
        continue;
      }
      // A module knows the VERB it widens, never that verb's subcommands, so a flat list it contributes
      // widens `shared` — dropping it into one scope would hide it from the others.
      const flat = (v: readonly string[] | ScopedFlags) =>
        isScoped(v) ? null : v;
      const [ps, es] = [flat(prior), flat(entry)];
      if (ps && es) {
        out[verb] = union(ps, es);
      } else if (isScoped(prior) && isScoped(entry)) {
        const scopes: Record<string, readonly string[]> = { ...prior.scopes };
        for (const [s, fs] of Object.entries(entry.scopes)) {
          scopes[s] = union(scopes[s] ?? [], fs);
        }
        out[verb] = {
          shared: union(prior.shared, entry.shared),
          scopes,
          fallback: prior.fallback,
        };
      } else {
        const base = (isScoped(prior) ? prior : entry) as ScopedFlags;
        out[verb] = {
          ...base,
          shared: union(base.shared, (ps ?? es)!),
        };
      }
    }
  }
  return out;
}

/**
 * True iff `raw` occupies a FLAG slot rather than a value slot. Any leading `-` counts: scanning only `--`
 * left the single-dash spelling of every invented flag silently discarded, so `launch app.ts -print` served
 * live traffic where `--print` previews, and `-json` printed human text at a caller parsing JSON — the
 * same failure the `--` gate exists to end, one dash narrower.
 *
 * Three tokens are values, not flags: `-` and `--` are the stdin/end-of-flags conventions, and a negative
 * number is an argument (`ops cap <key> -5`), whose own dispatcher refuses it with the reason.
 */
function isFlagToken(raw: string): boolean {
  if (!raw.startsWith("-") || raw === "-" || raw === "--") return false;
  return !Number.isFinite(Number(raw));
}

/**
 * The first argv token that is a flag THIS INVOCATION does not recognise, or undefined. Scope-aware: the
 * legal set is the resolved subcommand's, not the verb-wide union, so a flag only another subcommand reads
 * is refused here rather than silently discarded. `=`-valued forms are compared by NAME (`--rules=bogus` is
 * a known flag with an unknown value — the dispatcher that reads it owns that refusal, and it names the
 * legal values).
 */
export function unknownFlag(
  roster: FlagRoster,
  verb: string,
  argv: ReadonlyArray<string | undefined>,
): string | undefined {
  const { known } = legalFlags(roster, verb, argv);
  for (const raw of argv) {
    if (raw === undefined || !isFlagToken(raw)) continue;
    const name = raw.slice(
      0,
      raw.indexOf("=") === -1 ? undefined : raw.indexOf("="),
    );
    if (!known.includes(name)) return name;
  }
  return undefined;
}

/** The refusal, in the shape every other CLI refusal uses: name what was rejected, then what is legal HERE —
 *  a scoped verb names the subcommand, because "migrate takes …" would list flags this run still refuses. */
export function unknownFlagMessage(
  roster: FlagRoster,
  verb: string,
  flag: string,
  argv: ReadonlyArray<string | undefined> = [],
): string {
  const { known, scope } = legalFlags(roster, verb, argv);
  const subject = scope === null ? verb : `${verb} ${scope}`;
  return `hazelnut ${verb}: unknown flag '${flag}' — ${
    known.length === 0
      ? `${subject} takes no flags`
      : `${subject} takes: ${[...known].sort().join(" · ")}`
  }`;
}
