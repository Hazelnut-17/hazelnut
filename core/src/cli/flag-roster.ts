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

/** THE FLAGS WHOSE READER PARSES `--flag=value`. The `=` spelling is legal exactly where a reader handles it
 * (`flagValue`, `parseSurfacesFlag`, the scaffold `flagVal`) and nowhere else: every other reader tests an
 * exact token, so `--json=true` matched no flag NAME check, matched no `includes`, and ran the verb as if
 * the flag were absent.
 */
export const EQUALS_AWARE_FLAGS: ReadonlySet<string> = new Set([
  "--surfaces",
  "--local",
  "--vendor",
  "--pin",
  "--features",
  "--ops",
  "--rules",
  "--steer",
]);

/**
 * THE FLAGS WHOSE VALUE IS THE NEXT ARGV TOKEN.
 *
 * Two gates read this: a missing value is refused rather than silently falling back to a default, and the
 * value is never mistaken for a positional (`--dir audit` names a directory called `audit`, not the verb).
 */
export const NEXT_TOKEN_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--dir",
  "--immutable",
  "--out",
  "--env",
  "--from",
  "--to",
  "--entry",
  "--interval",
  "--health-port",
  "--reason",
  "--topic",
  "--limit",
  "--new-key-env",
  "--old-key-env",
  "--workflow",
  "--step",
  "--features",
  "--ops",
  "--local",
  "--vendor",
  "--pin",
  "--rules",
  "--steer",
]);

/** HOW A ROSTER'S FLAGS ARE SPELLED — declared BESIDE the roster it describes, never centrally. A module owns
 * its verbs' flags, so it owns their spelling too: naming one of them here would publish a withheld module's
 * vocabulary in the core artifact, the same reason the verb roster is per-build.
 */
export interface FlagSpelling {
  /** Flags whose reader parses `--flag=value`. */
  readonly equalsAware: ReadonlySet<string>;
  /** Flags whose value is the next argv token. */
  readonly nextTokenValue: ReadonlySet<string>;
}

/** Core's own classification. A module contributes its own; nothing states another module's here. */
export const CORE_SPELLING: FlagSpelling = {
  equalsAware: EQUALS_AWARE_FLAGS,
  nextTokenValue: NEXT_TOKEN_VALUE_FLAGS,
};

/** Folds the module spellings onto core's — the mirror of `mergeFlagRosters`, and passed beside it. */
export function mergeFlagSpellings(
  ...spellings: readonly FlagSpelling[]
): FlagSpelling {
  return {
    equalsAware: new Set(spellings.flatMap((s) => [...s.equalsAware])),
    nextTokenValue: new Set(spellings.flatMap((s) => [...s.nextTokenValue])),
  };
}

/** The `migrate` spellings that OCCUPY the app-path slot and belong to the migrate-cmd dispatcher.
 * `dispatchSchema` runs first and takes whatever is in that slot for an app path, so a mode spelled as a
 * flag died in `importAppModule` and the handler behind it never ran — written, rostered, catalogued, and
 * unreachable.
 */
export const MIGRATE_SLOT_MODES: ReadonlySet<string> = new Set(["--safe-ddl"]);

/**
 * `--` IN THE APP-PATH SLOT, CONSUMED — the escape for an app file whose name starts with `-`.
 *
 * Half of this shipped: the flag gates honoured `--` by breaking out of their scan, while the dispatcher
 * still took the `--` itself for the app path and refused it — so `hazelnut <verb> -- -n.ts` never worked,
 * and the break that was meant to enable it was instead a one-token bypass of every flag gate
 * (`<app> -- --bogus` exited 0 having discarded an invented flag). Consuming it here finishes the escape and
 * removes the reason for the break.
 *
 * `escaped` says the slot is a PATH the caller vouched for, so the flag scan skips it — that is the whole
 * point of the token. It means nothing anywhere else: hazelnut has exactly one positional and this is it, so
 * a `--` after the path names nothing and every flag that follows it is still scanned.
 */
export function consumeAppPathEscape(
  modPath: string | undefined,
  rest: readonly string[],
): { modPath: string | undefined; rest: string[]; escaped: boolean } {
  if (modPath !== "--") return { modPath, rest: [...rest], escaped: false };
  // A PATH IS NOT A FLAG. Vouching for a `--`-prefixed token exempted it from the scan on a verb that then
  // ignores the slot — `doctor -- --bogus` exited 0 having discarded an invented flag the allowlist catches
  // when it is written plainly. Decline the escape there and let the ordinary gates answer, which they do
  // with the message the caller needs. A leading-dash PATH keeps its single dash, so nothing real is lost.
  if (rest[0]?.startsWith("--")) {
    return { modPath, rest: [...rest], escaped: false };
  }
  return { modPath: rest[0], rest: rest.slice(1), escaped: true };
}

/** The positional tokens of an argv tail — flags and their values removed. The ONE reader of what a bare
 *  token means, so the unknown-verb guard and the dispatcher cannot disagree about it. Core's value flags are
 *  the whole question: only `migrate` resolves a subcommand positionally, and its flags are all core's. */
export function positionalTokens(rest: readonly string[]): string[] {
  return rest.filter((a, i) =>
    !a.startsWith("--") &&
    !(i > 0 && NEXT_TOKEN_VALUE_FLAGS.has(rest[i - 1]!))
  );
}

/** The migrate verb an argv tail selects, or `null` for none — the first `MIGRATE_SUBCOMMANDS` entry that
 *  appears as a POSITIONAL token. The dispatcher branches on this and nothing else, so a flag's value can no
 *  longer select a verb (`generate --dir audit` used to run `audit`, silently, exit 0). */
export function migrateVerb(rest: readonly string[]): string | null {
  const positional = new Set(positionalTokens(rest));
  return MIGRATE_SUBCOMMANDS.find((s) => positional.has(s)) ?? null;
}

/** The migrate SUBCOMMAND vocabulary, in the precedence the dispatcher resolves it — `migrateVerb` reads
 *  this order and `dispatchSchema` branches on its answer, so the order here IS the order that runs.
 *  Single-sourced: the dispatcher imports it rather than restating it. */
export const MIGRATE_SUBCOMMANDS = [
  "drift",
  "generate",
  "audit",
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
  // POSITIONAL, for the same reason `migrateVerb` is: a flag's VALUE is not a subcommand. Read off raw
  // tokens, `generate --dir drift --online` resolved the scope `drift` and refused `--online` — a legal call
  // rejected — while `status --dir generate --allow-destructive` admitted a flag the verb then ignored.
  const tokens = argv.filter((a): a is string => a !== undefined);
  const positional = new Set(positionalTokens(tokens));
  // A scope key spelled as a flag (`explain --diagram`) is a MODE, not a value — it is matched as written.
  const flags = new Set(tokens.filter((a) => a.startsWith("-")));
  return Object.keys(scoped.scopes).find((s) =>
    s.startsWith("-") ? flags.has(s) : positional.has(s)
  ) ?? scoped.fallback;
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
      generate: ["--online", "--allow-destructive", "--allow-unsafe-ddl"],
      // `audit` is ADVISORY by default (exit 0); `--strict` is what makes a committed finding an error.
      audit: ["--strict"],
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
 * Three tokens are not flag NAMES: `-` is the stdin convention, `--` names nothing, and a negative number
 * is an argument (`ops cap <key> -5`), whose own dispatcher refuses it with the reason.
 *
 * `--` is NOT a general end-of-flags marker. The gates once stopped scanning at it on that belief, which
 * made it a one-token bypass of all three of them — `<app> -- --json=true` printed human text at exit 0,
 * and `-- --bogus` sailed past the allowlist. It means one thing, in one slot: `consumeAppPathEscape`.
 */
function isFlagToken(raw: string): boolean {
  if (!raw.startsWith("-") || raw === "-" || raw === "--") return false;
  return !Number.isFinite(Number(raw));
}

/** Surfaces `--surfaces=` may name. Empty / bare `--surfaces` means all three. */
export const SURFACE_FILTERS = ["http", "mcp", "event"] as const;
export type SurfaceFilter = typeof SURFACE_FILTERS[number];

/**
 * `--surfaces` / `--surfaces=` / `--surfaces=http,mcp`. The `=` form is a known flag to `unknownFlag`
 * (compared by name), so a dispatcher that only `includes("--surfaces")` runs the unfiltered structural
 * pass and prints a clean pass for a check that never ran.
 */
export function parseSurfacesFlag(argv: readonly string[]): {
  readonly present: boolean;
  readonly only?: ReadonlySet<SurfaceFilter>;
  readonly error?: string;
} {
  const tok = argv.find((a) =>
    a === "--surfaces" || a.startsWith("--surfaces=")
  );
  if (tok === undefined) return { present: false };
  if (tok === "--surfaces" || tok === "--surfaces=") return { present: true };
  const parts = tok.slice("--surfaces=".length).split(",").map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return { present: true };
  const only = new Set<SurfaceFilter>();
  for (const p of parts) {
    if (!(SURFACE_FILTERS as readonly string[]).includes(p)) {
      return {
        present: true,
        error: `verify: unknown --surfaces filter '${p}' — takes: ${
          SURFACE_FILTERS.join(" · ")
        }`,
      };
    }
    only.add(p as SurfaceFilter);
  }
  return { present: true, only };
}

/**
 * A `--flag value` / `--flag=value` slot. A missing value or a following flag token is an error, never
 * a silent fall-through that treats the next argv item as the specifier (or drops the flag entirely).
 */
export function flagValue(
  argv: readonly string[],
  flag: string,
):
  | { readonly present: false }
  | { readonly present: true; readonly value: string }
  | { readonly present: true; readonly error: string } {
  const prefix = `${flag}=`;
  const eq = argv.find((a) => a.startsWith(prefix));
  if (eq !== undefined) {
    const value = eq.slice(prefix.length);
    if (value === "") {
      return { present: true, error: `${flag} needs a value` };
    }
    return { present: true, value };
  }
  const at = argv.indexOf(flag);
  if (at === -1) return { present: false };
  const value = argv[at + 1];
  if (value === undefined || isFlagToken(value)) {
    return { present: true, error: `${flag} needs a value` };
  }
  return { present: true, value };
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
    if (raw === undefined) continue;
    if (!isFlagToken(raw)) continue;
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

/**
 * The first `--flag=value` token whose reader cannot read that spelling, or undefined.
 *
 * A `=` form is a KNOWN flag to `unknownFlag`, which compares by name — so every reader that tests an exact
 * token accepted the spelling and then ran as if the flag were absent: `--strict=true` reported success over
 * findings, `--out=nosuchdir` audited the DEFAULT directory and called it clean, `--print=true` served live
 * traffic on a call that asked to print a plan. Runs AFTER the unknown-flag gate, so an unknown NAME is
 * refused as unknown rather than mis-described as a spelling error.
 */
export function equalsSpelledFlag(
  roster: FlagRoster,
  verb: string,
  argv: ReadonlyArray<string | undefined>,
  spelling: FlagSpelling = CORE_SPELLING,
): string | undefined {
  const { known } = legalFlags(roster, verb, argv);
  for (const raw of argv) {
    if (raw === undefined) continue;
    if (!isFlagToken(raw) || !raw.includes("=")) continue;
    const name = raw.slice(0, raw.indexOf("="));
    if (known.includes(name) && !spelling.equalsAware.has(name)) return raw;
  }
  return undefined;
}

/** The refusal for an unreadable `=` spelling: teach the spelling that works, and name what the accepted
 *  form silently did instead — the consequence is the reason the refusal is worth an exit code. */
export function equalsSpellingMessage(
  verb: string,
  token: string,
  spelling: FlagSpelling = CORE_SPELLING,
): string {
  const name = token.slice(0, token.indexOf("="));
  const value = token.slice(token.indexOf("=") + 1);
  return spelling.nextTokenValue.has(name)
    ? `hazelnut ${verb}: '${token}' — write the value as the next argument: '${name} ${value}'. (Spelled with '=', it was accepted and then ignored, and the verb ran against its default instead of what you named.)`
    : `hazelnut ${verb}: '${token}' — '${name}' is a boolean flag and takes no value. Write '${name}' on its own to turn it on, or omit it. (Spelled with '=', it was accepted and then ignored, which is how a --strict CI reported success over findings.)`;
}

/**
 * The first value flag given with no value, or undefined — a trailing `--out`, or one followed by another
 * flag. Every reader here hand-rolls `indexOf(flag)` and then reads the next token, so an absent value fell
 * back to a default silently: `audit --out` audited `drizzle/` and exited 0, `redrive --topic` processed
 * EVERY topic. The `=` spelling is skipped: `flagValue` owns the empty-value refusal for the flags that read it.
 */
export function missingValueFlag(
  roster: FlagRoster,
  verb: string,
  argv: ReadonlyArray<string | undefined>,
  spelling: FlagSpelling = CORE_SPELLING,
): string | undefined {
  const { known } = legalFlags(roster, verb, argv);
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === undefined) continue;
    if (!spelling.nextTokenValue.has(raw) || !known.includes(raw)) continue;
    const next = argv[i + 1];
    if (next === undefined || next === "--" || isFlagToken(next)) return raw;
  }
  return undefined;
}

/** The refusal for a value flag with no value — the contract `flagValue` already states, applied to the
 *  readers that predate it. */
export function missingValueMessage(verb: string, flag: string): string {
  return `hazelnut ${verb}: '${flag}' needs a value — write it as the next argument: '${flag} <value>'. (Given with none, it was dropped and the verb ran against its default instead.)`;
}
