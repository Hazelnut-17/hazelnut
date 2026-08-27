import { type App, createApp, defineResource } from "../core/app.ts";
import { LAUNCH_UNCONDITIONAL_FLAGS } from "./permissions.ts";
import { APP_DEPENDENCY_PINS } from "../core/version.ts";
import { DEFAULT_SERVE_PORT, DENO_BASE_IMAGE } from "../core/version.ts";
import { z } from "zod";

/** CLI SCAFFOLD + ADD verbs: `new` (scaffoldFiles + scaffoldInitPlan) and `add` (nutModule/nutResource
 *  registration planning). Pure emitters returning `{path: content}` maps/plans; `hazelnut.ts` does the disk I/O. */
/** The three grants the LAUNCHER itself needs — read (the app tree it scans + imports), env (the config
 *  site's own `Deno.env.get` reads), and run (spawning `deno` for the served app). Never `-A`: a supervisor
 *  holding every capability for the life of the child would give back exactly what `launch` takes away.
 *  Exported so a drift tooth pins the set as an equality, not a spot-check. */
export const LAUNCHER_GRANTS: readonly string[] = [
  "--allow-read",
  "--allow-env",
  "--allow-run=deno",
];

/** Grants to run `hazelnut new` from a checkout or registry — write the app under cwd, warm the lock
 *  (`--allow-net` + `run=deno`), optionally `git init`. Never `-A`: the first command the handbook
 *  teaches must not be the insecure shortcut (SEC-3 / Secure Path Is Shortest). Absolute target paths
 *  outside cwd need a wider `--allow-write`; the tutorial always scaffolds under `.`. */
export const SCAFFOLD_NEW_GRANTS: readonly string[] = [
  "--allow-read",
  "--allow-write=.",
  "--allow-env",
  "--allow-run=deno,git",
  "--allow-net",
];

/** Joined form for handbook / CLI argv — one owner with `SCAFFOLD_NEW_GRANTS`. */
export const SCAFFOLD_NEW_GRANT_FLAGS: string = SCAFFOLD_NEW_GRANTS.join(" ");

/** The compiler discipline an emitted app carries — EQUAL to this framework's own `deno.json` and to
 * both reference apps'. A tightening on one side without the other is a rule the dogfood keeps and the
 * scaffold drops — a rule with no consumer.
 */
export const SCAFFOLD_COMPILER_OPTIONS: Readonly<Record<string, boolean>> = {
  strict: true,
  noUncheckedIndexedAccess: true,
  noImplicitOverride: true,
};

/** Grants for scaffolded app tasks that invoke the framework CLI — same shape as `new` without `git`.
 *  Never `-A`: those task lines are imitation surface (rundown / examples copy them), and a blanket grant
 *  there trains the insecure shortcut. */
export const SCAFFOLD_TOOLING_GRANTS: readonly string[] = [
  "--allow-read",
  "--allow-write=.",
  "--allow-env",
  "--allow-run=deno",
];

/**
 * The tooling verbs that OPEN A SOCKET, and the only reason any of them holds a bare `--allow-net`.
 *
 * `doctor` and `migrate` connect to `DATABASE_URL`. Its host is the consumer's, and it does not exist when
 * this file is written — so the grant cannot name a domain, and pretending otherwise would emit a task
 * that fails the first time someone points it at a real database. `verify` and `add` open nothing: both
 * were measured against a live Postgres with the grant removed and neither asks for it.
 *
 * Stated as data rather than left implicit, because "why is this one bare" is a question a reader of the
 * emitted `deno.json` will ask, and the answer has to be somewhere they can find it.
 */
export const SCAFFOLD_NET_VERBS: readonly string[] = ["doctor", "migrate"];

/** Grants for a tooling verb that reaches `DATABASE_URL`. */
export const SCAFFOLD_TOOLING_GRANTS_NET: readonly string[] = [
  ...SCAFFOLD_TOOLING_GRANTS,
  "--allow-net",
];

/** `doctor` alone also spawns `git` — `supply-chain/lock` asks whether deno.lock is COMMITTED, and that
 *  is the only state the running process cannot manufacture for itself. Without the grant the probe fails
 *  NotCapable and the check certifies a lock it never looked at. Least privilege is per verb, not one set. */
export const SCAFFOLD_DOCTOR_GRANTS: readonly string[] =
  SCAFFOLD_TOOLING_GRANTS_NET
    .map((g) => g === "--allow-run=deno" ? "--allow-run=deno,git" : g);

/** Joined form — one owner with `SCAFFOLD_TOOLING_GRANTS`. */
export const SCAFFOLD_TOOLING_GRANT_FLAGS: string = SCAFFOLD_TOOLING_GRANTS
  .join(" ");

/** How a scaffolded app INVOKES the framework CLI. Three pin shapes, three different lines — collapsing
 *  them is what emitted `hazelnut-core add` into an app whose owner never installed a binary:
 *
 *  | pin shape                    | the app runs                                    |
 *  | ---------------------------- | ----------------------------------------------- |
 *  | source tree (`file://…/src`) | `deno run … <pin>/cli/<entry>.ts <verb>`        |
 *  | registry (`jsr:…`, `https:`) | `deno run … <pin>/cli <verb>`  ← the `./cli` export |
 *  | a name on PATH               | `<name> <verb>`                                 |
 *
 *  The registry row is why the package exports `./cli` at all: without it the specifier resolves nothing
 *  and every emitted task is dead on arrival. */
export function cliArgv(
  pin: string,
  cliEntry: string,
  binaryMode: boolean,
  grants: readonly string[],
  verb: readonly string[],
): string[] {
  if (!binaryMode) {
    // a source-tree pin: the concrete entry FILE inside the pinned `src/`
    return [
      "deno",
      "run",
      ...grants,
      "-c",
      "deno.json",
      `${pin}/cli/${cliEntry}.ts`,
      ...verb,
    ];
  }
  if (isModuleSpecifier(pin)) {
    // a registry/URL pin: the package's `./cli` export, resolvable with no prior install
    return ["deno", "run", ...grants, "-c", "deno.json", `${pin}/cli`, ...verb];
  }
  return [pin, ...verb]; // a compiled binary already on PATH, called by its own name
}

/** The scaffolded launch invocation as argv. The `start` task joins it; the Dockerfile CMD drops the
 *  leading `deno` (the base image's ENTRYPOINT already is deno) and JSON-encodes the rest. */
export function launchArgv(
  pin: string,
  cliEntry: string,
  binaryMode: boolean,
): string[] {
  // `--entry main.ts` is spelled out even though it is the launcher's default: a deployed command should
  // say what it serves, so a reader of the Dockerfile never has to know a CLI default to answer "what runs".
  return cliArgv(pin, cliEntry, binaryMode, LAUNCHER_GRANTS, [
    "launch",
    "./app.ts",
    "--entry",
    "main.ts",
  ]);
}

/** The scaffolded `start` command: the launcher, under its own three grants, deriving the app's set. */
export function launchCommand(
  pin: string,
  cliEntry: string,
  binaryMode: boolean,
): string {
  return launchArgv(pin, cliEntry, binaryMode).join(" ");
}

/** The command that runs an emitted MCP transport entry, spelled the way THIS pin actually invokes the CLI
 *  — a registry consumer has no `hazelnut` on PATH, so the printed line must be `deno run … <pin>/cli launch`. */
export function mcpInvokeCommand(
  entry: string,
  pin: string,
  cliEntry: string,
  binaryMode: boolean,
): string {
  return cliArgv(pin, cliEntry, binaryMode, LAUNCHER_GRANTS, [
    "launch",
    "./app.ts",
    "--entry",
    entry,
  ]).join(" ");
}

/** The Dockerfile `CMD [...]` line for the same invocation. `deno` is the base image's ENTRYPOINT, so it
 *  is dropped when the argv starts with it — keyed on the ARGV, not on the pin mode: a registry pin is
 *  "binary mode" by flag but still runs through `deno`, and keying on the mode emitted a CMD that asked
 *  the image to execute `deno` as an argument to itself. */
export function launchDockerCmd(
  pin: string,
  cliEntry: string,
  binaryMode: boolean,
): string {
  const argv = launchArgv(pin, cliEntry, binaryMode);
  const args = argv[0] === "deno" ? argv.slice(1) : argv;
  return `CMD ${JSON.stringify(args)}`;
}

/** The package specifier a CLI that is RUNNING FROM A REGISTRY should pin, derived from its own module
 *  URL — the registry half of "the CLI pins where it runs from", which the checkout door already does.
 *
 *  Without this, the first command a published consumer types (`deno run <grants> jsr:<pkg>/cli new my-app`)
 *  has no on-disk tree to derive from and must be told `--pin jsr:<pkg>` — asking them to retype the very
 *  thing they just ran. A flag whose only job is to repeat the invocation is a detail pushed onto the user.
 *
 *  JSR serves a package as `https://jsr.io/@scope/name/<version>/<path>`; the version is captured so a
 *  scaffolded app pins the EXACT release that generated it, never a floating one. Any other non-file URL
 *  yields `null` — there is no package identity to infer from an arbitrary host, and guessing one would
 *  emit an app pinned to something unresolvable. */
export function registryPinFromModuleUrl(moduleUrl: string): string | null {
  const m = /^https:\/\/jsr\.io\/(@[^/]+\/[^/]+)\/([^/]+)\//.exec(moduleUrl);
  return m ? `jsr:${m[1]}@${m[2]}` : null;
}

/** True when a pin is something `deno run` resolves directly (a registry or URL specifier), as opposed to
 *  the name of a compiled binary already on PATH. The two need DIFFERENT task lines — `deno run <pin>/cli
 *  <verb>` vs a bare `<name> <verb>` — and conflating them emitted a scaffold whose every task assumed an
 *  install that a `deno run jsr:…` consumer never performed. */
export function isModuleSpecifier(pin: string): boolean {
  return /^(?:jsr:|npm:|https?:)/.test(pin);
}

/** Which module a framework checkout can serve, decided by the barrel files present in its `src/`.
 *  `mod-core.ts` is in EVERY hazelnut tree; `mod.ts` only in one carrying the verify envelope. */
export type TreeModule = "full" | "core" | null;

/** Probe a framework checkout. The probe cannot be a single `stat src/mod.ts`: the PUBLIC CORE artifact
 *  (`scripts/release-core.ts`) deliberately does not ship `mod.ts`, so that test reads a perfectly good
 *  core checkout as "not a hazelnut repo" — including the artifact's own tree, which made the core module's
 *  `hazelnut new` refuse to run anywhere it shipped. The barrel that is always present is `mod-core.ts`. */
export function frameworkTreeModule(
  exists: (rel: string) => boolean,
): TreeModule {
  if (exists("src/mod.ts")) return "full";
  if (exists("src/mod-core.ts")) return "core";
  return null;
}

/** The pin decision for one source-pin door: the message to refuse with, or `null` to accept.
 *  A core checkout serves a `--core` scaffold and refuses a full one BY NAME — never by pretending the
 *  tree is not a hazelnut repo, and never by emitting an app pinned to a `mod.ts` that is not there. */
export function pinRefusal(
  treeModule: TreeModule,
  wantCore: boolean,
  arg: string,
  door: string,
): string | null {
  if (treeModule === null) {
    return `hazelnut new ${door}: '${arg}' is not a hazelnut checkout (no src/mod-core.ts) — pass the framework REPO ROOT`;
  }
  if (treeModule === "core" && !wantCore) {
    return `hazelnut new ${door}: '${arg}' is a CORE-module checkout (no src/mod.ts — no verify envelope), so it cannot pin a full app. Re-run with --core.`;
  }
  return null;
}

/** The `hazelnut new` flags only the VERIFY module can honour. `--rules` names a principle profile that module
 *  resolves; `--steer` picks how AGENTS.md renders. Neither is a core-module config key, so a core scaffold
 *  emits neither line and has nothing to act on. */
export const VERIFY_MODULE_SCAFFOLD_FLAGS: readonly string[] = [
  "--rules",
  "--steer",
];

/** The refusal for a core scaffold handed a verify-module flag, or `null` to accept.
 *
 *  A flag this build cannot act on is refused BY NAME — the same honesty the CLI already gives verify-module
 *  VERBS. Accepting one and dropping it hands back an app the caller believes is profiled or index-steered.
 *  Matching is on the flag NAME only: the registry that validates a `--rules` VALUE is verify-module, and the
 *  core dispatcher must not reach it statically. */
export function verifyModuleFlagRefusal(
  core: boolean,
  argv: readonly string[],
): string | null {
  if (!core) return null;
  const given = VERIFY_MODULE_SCAFFOLD_FLAGS.filter((f) =>
    argv.some((a) => a === f || a.startsWith(`${f}=`))
  );
  if (given.length === 0) return null;
  const plural = given.length > 1;
  return `hazelnut new: ${given.join(" and ")} ${
    plural ? "are" : "is"
  } verify-module — a core app has no principle profile and no AGENTS.md, so ` +
    `this build cannot honour ${plural ? "them" : "it"}. Drop ${
      plural ? "the flags" : "the flag"
    }, or scaffold from a full build.`;
}

/** `hazelnut new <name>` — scaffold a starter app as a `{path: content}` map (the entrypoint writes it).
 *  Empty by default; `--example` seeds a `widget` resource (cli/new.md §design-decisions, §Dockerfile). */
/** The concern subpaths a scaffolded app must be able to import. Held equal to the declared groups —
 *  this file SHIPS, so it carries the names rather than importing the roster. */
const CONCERN_SUBPATHS = [
  "query",
  "async",
  "crypto",
  "faces",
  "schema",
] as const;

/** Published deep file exports the handbook / example cite as `hazelnut/<path>`. A registry pin's
 * `hazelnut/` prefix join does NOT consult package `exports`, so these need exact import-map keys.
 * Local/vendor prefixes already resolve them as files — keys are registry-only. Every DEEP FILE export
 * of the package, as the app's import map must key it. A registry pin resolves `hazelnut/<p>` through
 * an EXACT key or not at all — the `hazelnut/` prefix skips `exports` — so this list must equal the
 * file-shaped keys of `release-core.ts §PUBLIC_EXPORTS`. Hand-kept, it was three of ten: the two MCP
 * transports `hazelnut mcp stdio|gateway` emit an import of could not resolve for any registry
 * consumer, and neither could the five paths a capability module addresses.
 */
export const SCAFFOLD_DEEP_EXPORTS = [
  "test.ts",
  "data/repo.ts",
  "authz/auth.ts",
  "core/module-spi.ts",
  "core/app-define.ts",
  "core/ctx-surface.ts",
  "core/validation.ts",
  "runtime/safe-fetch.ts",
  "runtime/serve.ts",
  "runtime/observe-derive.ts",
  "runtime/mcp-stdio.ts",
  "runtime/mcp-gateway.ts",
] as const;

/** The grant set the SERVE lanes get. Measured as the minimum a scaffolded app boots and answers under —
 *  no `--allow-run`, `--allow-ffi`, `--allow-sys`, so a dependency in the inner loop can neither spawn a
 *  process nor load native code. Read/write/net/env stay unnarrowed: only `launch` can derive those, and
 *  only from a composed app. */
/** The DEV/TEST lane's grants, and they are deliberately wider than production's. `launch` derives the
 *  serve grants by reading the app's own source (named env vars, one port); a static task line cannot —
 *  narrow `--allow-env` here and the first `Deno.env.get` a consumer adds fails NotCapable in their dev
 *  loop. So the split is real and the emitted README says so: this is not the production set. */
const APP_GRANTS = [
  "--allow-net --allow-env --allow-read --allow-write=. --unstable-cron",
  // `dev` and `test` run main.ts DIRECTLY, so `launch`'s unconditional flags are theirs to carry: without
  // them the process the author develops against is not the process `deno task start` serves.
  ...LAUNCH_UNCONDITIONAL_FLAGS,
].join(" ");

/** The TEST lane adds exactly one grant: a test that boots the app under a different env spawns `deno`.
 *  It is a weak boundary (a `deno` child re-requests whatever it likes) and it is still not `-A` — no ffi,
 *  no arbitrary binary, and widening it further is an edit someone has to write. */
const TEST_GRANTS = `${APP_GRANTS} --allow-run=deno`;

export function scaffoldFiles(
  appName: string,
  opts: {
    example?: boolean;
    rules?: string;
    local?: string;
    steer?: "full" | "index";
    vendor?: boolean;
    core?: boolean;
    /** Binary-mode pin: a registry/URL specifier for `imports.hazelnut` — the compiled-binary scaffold
     *  shape (CLI tasks call the binary BY NAME, no ambient lint plugin; the verify verbs still run the
     *  same rules). The public core release names the official value; any specifier works today. */
    binaryPin?: string;
    /** The full build's committed projections, INJECTED. This emitter is synchronous and ships in the core
     *  artifact, so it cannot import the projectors — that import published the principle bodies. The async
     *  dispatcher lazy-imports them and supplies this; a core scaffold passes nothing and emits neither file. */
    /** `steer` rides the CALLBACK, not the composed app: the render mode is a verify-module knob and this
     *  emitter composes with the core entry, which has no such config key. */
    project?: (
      app: App,
      steer?: "index",
    ) => { agents: string; architecture: string };
  } = {},
): Record<string, string> {
  // The only pins are file-based: `--local` points at a `file://` src/ checkout, `--vendor` copies src/
  // into the app (self-contained, portable). A registry pin arrives with the public core release; there is
  // NO remote-git pin — the CLI derives the checkout automatically (hazelnut-scaffold-cmd.ts), so a
  // missing pin here is a caller bug, refused loudly.
  if (!opts.vendor && !opts.local && !opts.binaryPin) {
    throw new Error(
      "scaffold/pin-required: no framework pin — pass --local <framework-repo-path> (auto-derived when the CLI runs from a checkout), --vendor, or --pin <registry-specifier>",
    );
  }
  const binaryMode = opts.binaryPin !== undefined && !opts.local &&
    !opts.vendor;
  const pin = opts.vendor
    ? "./.hazelnut/modules"
    : (opts.local ?? opts.binaryPin!);
  // `--core` selects the module barrel/CLI/lint only — a surface signal, not source removal (verify internals
  // still boot via direct path). Orthogonal to the pin source. ALWAYS the core barrel for the bare `hazelnut`
  // specifier — a full app included. That specifier is what `main.ts` and the model config import, i.e. the
  // SERVED process, and a barrel is ONE module: importing `createApp` through the full one pulled everything it
  // re-exports along, 45 tooling files a fresh scaffold never calls. Tooling is reached by subpath
  // (`hazelnut/mod.ts`) from `app.ts` — the entry only the CLI reads.
  const barrel = "mod-core";
  const cliEntry = opts.core ? "hazelnut-core" : "hazelnut";
  /** One CLI task line, in whichever of the three pin shapes applies (`cliArgv`). The scaffolded tasks all
   *  route through this, so a new pin shape is taught once rather than at every task. Named grants — never
   *  `-A` — because these lines are imitation surface (SEC-3); only `start` goes through `launch`. */
  // The grant set is DERIVED from the verb, not chosen per call site. Passing it by hand made
  // `SCAFFOLD_NET_VERBS` a parallel declaration that nothing consulted — a roster the emitter could
  // silently disagree with, which is the shape this file exists to avoid everywhere else.
  const cliTask = (
    verb: readonly string[],
    grants?: readonly string[],
  ): string =>
    cliArgv(
      pin,
      cliEntry,
      binaryMode,
      grants ??
        (SCAFFOLD_NET_VERBS.includes(verb[0] ?? "")
          ? SCAFFOLD_TOOLING_GRANTS_NET
          : SCAFFOLD_TOOLING_GRANTS),
      verb,
    ).join(" ");
  const denoJson = {
    // no `name` field: a scaffolded app is not a published package, and `name` without `exports` makes Deno
    // warn on every invocation.
    imports: {
      ...(binaryMode
        // A registry pin must spell the concern exports EXACTLY (`hazelnut/faces` → `…@x/faces`). The
        // slash form alone (`hazelnut/` → `…@x/`) does NOT route through package `exports` in Deno's
        // import-map join — `hazelnut/faces` then fails to URL-parse. Exact keys match local mode and
        // the published `./faces` / `./query` / … export map. Deep file exports the handbook cites
        // (`hazelnut/data/repo.ts`) need the same exact keys — prefix join skips `exports`.
        ? {
          "hazelnut": pin,
          ...Object.fromEntries(
            CONCERN_SUBPATHS.map((g) => [`hazelnut/${g}`, `${pin}/${g}`]),
          ),
          ...Object.fromEntries(
            SCAFFOLD_DEEP_EXPORTS.map((p) => [`hazelnut/${p}`, `${pin}/${p}`]),
          ),
          "hazelnut/": `${pin}/`,
          // A capability module addresses core BY PACKAGE NAME, so a tree carrying one needs that name
          // resolvable too — the same pin, under the identity the module's own sources use.
          "@hazelnut/core": pin,
          ...Object.fromEntries(
            CONCERN_SUBPATHS.map((g) => [`@hazelnut/core/${g}`, `${pin}/${g}`]),
          ),
          ...Object.fromEntries(
            SCAFFOLD_DEEP_EXPORTS.map((
              p,
            ) => [`@hazelnut/core/${p}`, `${pin}/${p}`]),
          ),
          "@hazelnut/core/": `${pin}/`,
        }
        : {
          "hazelnut": `${pin}/${barrel}.ts`, // ALWAYS `mod-core.ts` — see the block above for why
          // The CONCERN SUBPATHS, spelled EXACTLY. The `hazelnut/` prefix below would resolve
          // `hazelnut/query` to the `data/` DIRECTORY, which is not a module — an exact key wins over a
          // prefix key, so these must be present and must come from the same roster the barrels do.
          ...Object.fromEntries(
            CONCERN_SUBPATHS.map((
              g,
            ) => [`hazelnut/${g}`, `${pin}/surface/${g}.ts`]),
          ),
          "hazelnut/": `${pin}/`,
          "@hazelnut/core": `${pin}/mod-core.ts`,
          ...Object.fromEntries(
            CONCERN_SUBPATHS.map((
              g,
            ) => [`@hazelnut/core/${g}`, `${pin}/surface/${g}.ts`]),
          ),
          "@hazelnut/core/": `${pin}/`,
        }),
      ...APP_DEPENDENCY_PINS,
    },
    nodeModulesDir: "auto",
    // The SAME compiler discipline this framework and both reference apps hold themselves to. Deno's
    // default leaves `noUncheckedIndexedAccess` OFF, and the framework's name-keyed doors are
    // `Record<string, …>` — so `ctx.tasks.typo.submit()` was a compile error here and a runtime TypeError
    // in every scaffolded app. The dogfood could not feel it; the consumer got it on the first typo.
    compilerOptions: SCAFFOLD_COMPILER_OPTIONS,
    // `drizzle/` is drizzle-kit's output, committed verbatim: `migrate generate` writes a snapshot.json with
    // no trailing newline, so a formatter rewrites the artifact on sight and the next generate rewrites it
    // back. Excluded rather than hand-formatted — the bytes belong to the tool that authored them.
    fmt: { exclude: ["drizzle"] },
    // the lint plugin path must match the real pinned-tree layout or every scaffolded `deno lint` 404s.
    // A SOURCE/VENDOR scaffold wires a lint rung — the split is only WHICH one. A core consumer gets the
    // 9-rule safety FLOOR (`invariants/lint-floor.ts`, shipped in the public artifact); the full/dogfood build
    // gets the whole 33-rule plugin (floor + the 24 verify-module discipline rules).
    //
    // A REGISTRY pin (`jsr:…` / `npm:…` / URL — any pin containing `:`) wires the package's `./lint` export
    // (same floor). Omitting it left `lint/floor-rung-narrowed` SHIP-BLOCKING on a fresh `--pin` app while
    // `deno task ci` still chained `verify`. A bare PATH-binary name (`--pin hazelnut`) has no resolvable
    // plugin URL — leave rung-less; doctor already skips ambient-rung advice when the pin is not on disk.
    ...(binaryMode && !pin.includes(":") ? {} : {
      lint: {
        plugins: [
          binaryMode
            ? `${pin}/lint`
            : opts.core
            ? `${pin}/invariants/lint-floor.ts`
            : `${pin}/verify/lint-plugin.ts`,
        ],
      },
    }),
    tasks: {
      // `dev` runs the serve entry under --watch (01-deliverables.md §1); root-relative since app.ts/main.ts
      // live at repo root, not under src/.
      // `HAZELNUT_DEV=1` is the dev substrate's PROOF — `main.ts` refuses the embedded PGlite without it,
      // so the zero-infra loop still costs no infrastructure but a lost DATABASE_URL cannot impersonate it.
      // The inner loop runs the app, so it holds no capability the served process would not: no
      // `--allow-run`, `--allow-ffi`, `--allow-sys`. Read/write/net/env stay unnarrowed because dev cannot
      // derive them per-app the way `launch` does below — broad, not blanket, and never a taught `-A`.
      dev: `HAZELNUT_DEV=1 deno run ${APP_GRANTS} --watch main.ts`,
      // `start` is the prod serve command (mirrors the Dockerfile CMD). It goes through `hazelnut launch`,
      // which DERIVES the app's permission set from its own declarations (egress hosts from defineWebhook,
      // env keys from the entry sources, write only when a file() field forces it) and refuses to widen to
      // -A. The launcher itself holds only the three grants it needs to derive-and-spawn, and forwards
      // SIGTERM so the app's graceful drain still runs (cli/launch.md).
      start: launchCommand(pin, cliEntry, binaryMode),
      // no `--env-file`: a fresh scaffold ships `.env.example`, not `.env`, so `--env-file=.env` would fail
      // `deno task test` out of the box. Default tests run on embedded PGlite (no DATABASE_URL needed).
      test: `deno test ${TEST_GRANTS}`,
      // `test:pg` runs the same suite against a real Postgres — DB-semantic tests (concurrency, 3-valued NULL
      // WHERE, real unique enforcement) that a testCtx run would false-green. Needs `.env`'s DATABASE_URL.
      "test:pg": `deno test ${TEST_GRANTS} --env-file`,
      // the CLI entrypoint lives at `src/cli/hazelnut.ts` in the pinned tree (`--core` → `hazelnut-core.ts`,
      // which refuses verify-envelope verbs) — a bare `<pin>/hazelnut.ts` resolves to nothing.
      // BOTH builds get the task: `verify` is one verb over one fold, and a core build runs the structural
      // rung and declares its own scope. What a full build adds under that name is rungs, not a verb.
      verify: cliTask(["verify", "./app.ts"]),
      add: cliTask(["add"]),
      // `doctor` checks the ENVIRONMENT (Deno line, lock, cron flag, pin, Postgres floor) — verify checks the app.
      doctor: cliTask(["doctor"], SCAFFOLD_DOCTOR_GRANTS),
      migrate: cliTask(["migrate", "./app.ts"]),
      // `deno audit` reads YOUR dependency graph, not the framework's — a scanner the framework ran once at
      // release says nothing about the packages you add. No `--ignore-registry-errors`: it fails closed when
      // the advisory feed is unreachable, and that default is the whole guarantee.
      audit: "deno audit",
      // `ci` chains lint→check→verify→(surfaces)→drift→test (no `deno fmt --check` — its output is
      // Deno-version-dependent and would redden a clean tree). BOTH builds chain `verify`; the chains differ
      // by exactly the `--surfaces` step, which compares committed locks a core build never writes.
      // `migrate drift` is the committed-`drizzle/` staleness gate: offline, no DB, no drizzle-kit spawn, so
      // it belongs in the default lane and a fresh scaffold — nothing on disk yet — passes it with a notice.
      // `CI=1` on verify is the ship-gate posture: ignore `defineConfig({ mute })` so an agent cannot mute
      // advisory findings past the release lane (bare `deno task verify` still honours mute locally).
      ci: opts.core
        ? "deno lint && deno check . && CI=1 deno task verify && deno task migrate drift && deno task test"
        : "deno lint && deno check . && CI=1 deno task verify && CI=1 deno task verify --surfaces && deno task migrate drift && deno task test",
      // The audit sits HERE, not in `ci`: it fails closed on an unreachable feed, and a verdict that needs
      // network cannot be the one the build loop runs every few minutes. Run `ci:full` before you release.
      "ci:full": "deno task ci && deno task audit",
    },
  };
  // AGENTS.md is stamped from this same seed model verify re-projects, so first verify matches (a mismatch
  // trips a spurious version/projection-fresh advisory). Keep `seedResource` in lock-step with the widget string.
  const example = opts.example ?? false;
  const seedResource = defineResource({
    name: "widget",
    schema: z.object({ title: z.string(), owner_id: z.string() }),
    features: { timestamps: true, scope: true, versioning: false },
    rowPolicy: "owner_id",
    http: {
      list: { policy: "policy", columns: ["id", "title", "owner_id"] },
      find: { policy: "policy", columns: ["id", "title", "owner_id"] },
      create: "policy",
    },
    mcp: { list: { describe: "List widgets the caller may see." } },
  });
  // `--steer=index` projects AGENTS.md in the same mode the emitted config declares, so first verify re-projects
  // the identical digest. Core module ships no AGENTS.md — the verify-projection header a core app cannot honor.
  // the seed app feeds BOTH committed projections (AGENTS.md + the ARCHITECTURE.md canvas twin) so each
  // is born-fresh against the same model; full build only — core cannot verify-refresh either.
  const seedApp = opts.core
    ? null
    : createApp({ resources: example ? [seedResource] : [] });
  const projected = seedApp === null || opts.project === undefined
    ? null
    : opts.project(seedApp, opts.steer === "index" ? "index" : undefined);
  const agents = projected?.agents ?? null;
  const architecture = projected?.architecture ?? null;
  // `rules` profile (cli/new.md §rules) — omit this key and the recommended soft half is silently off.
  // It lands in `app.ts`, NOT in `hazelnut.config.ts`: the config is read by `main.ts` too, and that file
  // resolves `defineConfig` from the CORE barrel, whose config surface has no `rules`. A `--core` scaffold
  // emits the key nowhere at all — its boot refuses it as `decl/unknown-key`.
  const rulesProfile = `@hazelnut/${opts.rules ?? "recommended"}`;
  const rulesLine = opts.core ? "" : `  rules: ["${rulesProfile}"],\n`;
  // `--steer=index`: declare the render mode in the config so verify re-projects in the same mode (the born
  // AGENTS.md above was projected identically). Omitted for the default "full" so a full-mode config is unchanged.
  // core-conditional for the same reason as `rules`: `steer` is a verify-module key, so a core app declaring
  // it boot-refuses `decl/unknown-key`. A core scaffold has no AGENTS.md to render either way.
  const steerLine = !opts.core && opts.steer === "index"
    ? `  steer: "index",\n`
    : "";
  // Both verify-module keys travel together into `app.ts`, spread over the core-typed config.
  const envelopeKeys = rulesLine + steerLine;
  // The entry the SERVED process composes from. A full build takes the AI module's, so a declared model call
  // reaches `ctx.llm` inside a request — that module is runtime-phase and must be composable WITHOUT the
  // tooling-phase one, which is what `app.ts` adds on top and no served process ever loads.
  const modelEntry = opts.core ? "hazelnut" : "hazelnut/ai/app-ai.ts";
  // `defineConfig` carries the `modules: [` anchor `hazelnut add module` auto-registers into (cli/add.md
  // §auto-wiring); `--example` seeds `resources: [widget]`, empty default seeds `resources: []`.
  const configTs = example
    ? `import { defineConfig } from "${modelEntry}";
import { widget } from "./widget.resource.ts";

// One central config. \`hazelnut add module <name>\` registers new modules into \`modules\` (import + array) and
// \`app.ts\` boots from it, so a scaffolded module is live with no hand-wiring.
export const config = defineConfig({
  resources: [widget],
  modules: [],
  // The OpenAPI face: \`GET /openapi.json\` serves the doc derived from the declarations. Serving it is an
  // OPT-IN declaration like any exposed route, and it ships GATED — the same permission the read routes
  // carry. \`hazelnut launch\` (what \`deno task start\` and the container run) REFUSES to start on an
  // UNGATED document, so \`{ public: true }\` is a deliberate act, never a leftover.
  openapi: { gate: "widget:list" },
  // The MCP transport posture. \`widget\` exposes an MCP tool, so this app SERVES a door a browser can
  // reach, and the framework refuses to boot until the declaration says who may reach it — silence is not
  // a default here (\`mcp/origin-declared\`). Empty = no browser Origin is accepted, which is what a fresh
  // app wants: a headless agent sends no Origin and is unaffected. Add your host to widen it, or write
  // \`allowedOrigins: null\` to say the door is open on purpose.
  mcp: { allowedOrigins: [] },
  // \`widget\` opts into row-scoping (\`features:{ scope:true }\`); this resolver supplies the per-request scope
  // value for \`ctx.scope\`. DERIVE IT FROM THE AUTHENTICATED actor (never a client header — a header is
  // spoofable). This starter has no auth wired, so it returns one fixed scope; swap in e.g. \`({ actor }) => …\`.
  // \`scope\` is the GENERIC row-partition key — the core has no tenant concept (multi-tenancy is a recipe
  // atop row-scoping); rename the column to YOUR partition axis (org / workspace / …) when you wire real auth.
  scope: { key: "scope", resolve: ({ actor }) => actor?.id ?? "public" },
});
`
    : `import { defineConfig } from "${modelEntry}";

// One central config. \`hazelnut add module <name>\` registers new modules into \`modules\` (import + array) and
// \`hazelnut add resource <module>/<name>\` adds resources; \`app.ts\` boots from it. Empty by default — run
// \`hazelnut add\` to add your first declaration, or re-scaffold with \`--example\` for a seeded widget.
export const config = defineConfig({
  resources: [],
  modules: [],
  // The OpenAPI face is OPT-IN, like any exposed route: undeclared, \`GET /openapi.json\` does not mount.
  // Turn it on with \`openapi: { gate: "<perm>" }\` — and \`hazelnut launch\` (what \`deno task start\` and the
  // container run) REFUSES to start on an UNGATED document, so \`{ public: true }\` is a deliberate act.
});
`;
  // README Dev list: both builds run `verify`; the bullet names what each build's rung actually covers, so a
  // core reader is never sold the ambient-lint half their CLI does not carry.
  const verifyBullet = opts.core
    ? "- `deno task verify` — the structural rung over your composed model (it prints what it does NOT check)\n"
    : "- `deno task verify` — architecture conformance (+ `deno lint` live in the editor)\n";
  // Core-module coherence: strip verify references a core app cannot honor — the AGENTS.md pointer in
  // README, the rowPolicy-spec clause (its spec file is dropped below).
  const modelBootComment = "what `hazelnut verify` / `hazelnut migrate` boot";
  const ironRulesSentence = opts.core
    ? ""
    : " The iron rules are in `AGENTS.md`.";
  const widgetSpecClause = opts.core
    ? ""
    : `\n// widget.rowpolicy.spec.ts states that same rule independently, so verify differentials impl⊨spec.`;
  const files: Record<string, string> = {
    "deno.json": JSON.stringify(denoJson, null, 2) + "\n",
    "hazelnut.config.ts": configTs,
    // `app.ts` is the pure model composition the CLI verbs consume — no boot seams, so verify/migrate never
    // construct a database just to read the model. The served boot lives in `main.ts` (05-runtime.md §createApp).
    "app.ts": `${
      opts.core
        ? `import { createApp } from "hazelnut";`
        : `// The MODULE's own composition entry — the core one plus the config keys it owns. Not the\n` +
          `// full barrel: that is one module, and importing \`createApp\` through it loads five times as much.\n` +
          `// This entry is TOOLING-phase, and only CLI verbs read this file. \`main.ts\` — the process that\n` +
          `// SERVES — composes from the runtime-phase entry instead, so no tooling module reaches production.\n` +
          `import { createApp } from "hazelnut/verify/app-verify.ts";`
    }
import { config } from "./hazelnut.config.ts";

// The pure model — ${modelBootComment} (offline, no db).
// The served app (db seam + fetch) is composed in main.ts.
export const app = createApp(${
      envelopeKeys === "" ? "config" : `{\n  ...config,\n${envelopeKeys}}`
    });
`,
    // The db is the one obligatory boot seam, project-constructed here (DATABASE_URL); a deployment never
    // migrates on boot (05-runtime.md §createApp, §relay-mode; cli/migrate.md — migrate is a gated release step).
    "main.ts": `${
      opts.core
        ? `import { applySchema, createApp, pgliteDb, postgresDb } from "hazelnut";`
        : `import { applySchema, pgliteDb, postgresDb } from "hazelnut";\n` +
          `import { createApp } from "${modelEntry}";`
    }
import { PGlite } from "@electric-sql/pglite";
import postgres from "postgres";
import { config } from "./hazelnut.config.ts";

// The served boot: db is the one obligatory seam, constructed by the project at the entry. The embedded
// PGlite substrate is PROVEN by HAZELNUT_DEV, never inferred from an absence a deployment can drop.
const url = Deno.env.get("DATABASE_URL");
if (!url && Deno.env.get("HAZELNUT_DEV") !== "1") {
  console.error(
    "refusing to serve: DATABASE_URL is unset. Set DATABASE_URL to serve against Postgres, or set HAZELNUT_DEV=1 to boot the throwaway embedded PGlite (development only — every write is lost on exit).",
  );
  Deno.exit(1);
}
const db = url ? postgresDb(postgres(url)) : pgliteDb(new PGlite());
// \`relay: "in-process"\` drains the outbox in this process: the first \`defineTask\`/\`defineSubscriber\`/
// read-model you add fires out-of-the-box, not silently until the backlog watermark. Multi-replica-safe (each
// drain claims its rows exclusively, so N replicas never double-process); split it to a dedicated
// \`hazelnut relay --loop\` process at scale (acknowledge with \`relay: "external"\`).
// \`scheduler: "in-process"\` registers the feature TTL sweeps + expiry purge on Deno.cron (leaderless across
// replicas; keeps the framework _* tables from growing unbounded) — the dev/container commands pass --unstable-cron.
export const app = createApp(config, {
  db,
  relay: "in-process",
  scheduler: "in-process",
});
if (!url) await applySchema(db, app); // dev-only: sync the derived DDL into the empty embedded PGlite. Prod schema lands via \`hazelnut migrate\`, never on boot.

const server = Deno.serve(
  { port: Number(Deno.env.get("PORT") ?? "${DEFAULT_SERVE_PORT}") },
  app.fetch,
);

let shuttingDown = false;
const shutdown = async (sig: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(\`\\n\${sig} received — draining + shutting down gracefully…\`);
  await server.shutdown(); // stop NEW connections, await in-flight requests
  app.stopInProcessRelay?.(); // stop the poll timer if createApp booted an in-process relay
  Deno.exit(0);
};
const signals: Deno.Signal[] = Deno.build.os === "windows"
  ? ["SIGINT"]
  : ["SIGTERM", "SIGINT"];
for (const sig of signals) {
  Deno.addSignalListener(sig, () => void shutdown(sig));
}
`,
    // Host-agnostic production container (cli/new.md §Dockerfile) — multi-replica boot is safe (SKIP LOCKED
    // relay, leaderless cron). Migration is never a boot step; `hazelnut migrate` is a separate gated release.
    "Dockerfile": `# syntax=docker/dockerfile:1
# Host-agnostic production container for ${appName} (Hazelnut). Run \`hazelnut migrate\` as a SEPARATE gated release
# step (never on boot); multi-replica boot is safe (SKIP LOCKED relay + leaderless cron).
FROM ${DENO_BASE_IMAGE}

WORKDIR /app
COPY . .

# Cache deps at build (deno.lock-pinned → supply-chain tamper-evident). No token of any kind: a container
# build requires the SELF-CONTAINED form — scaffold with \`--vendor\` (framework copied under vendor/) —
# because a --local file:// pin points outside the build context and cannot resolve in here.
RUN deno cache main.ts

# Least privilege at the OS layer, matching what the launcher does at the runtime layer: the base image
# leaves the container as root. \`-R\` so a \`file()\` resource's FILES_DIR can still be created under /app.
RUN chown -R deno:deno /app
USER deno

EXPOSE ${DEFAULT_SERVE_PORT}
# Serve only — \`app.fetch\` is the boot closure's router (main.ts → Deno.serve(app.fetch)). No boot-migrate.
# The container runs \`hazelnut launch\`, NOT \`deno run -A\`: the launcher derives the served process's
# permission set from this app's own declarations at start (so the DATABASE_URL host is a real grant, not a
# build-time guess), holds only read/env/run itself, and forwards SIGTERM so the graceful drain still runs.
# It binds --unstable-cron for you (the boot's scheduler:"in-process" needs it for TTL sweeps + expiry purge).
# \`deno task start\` runs the identical command outside a container — see cli/launch.md.
${launchDockerCmd(pin, cliEntry, binaryMode)}
`,
    // \`.gitignore\` does not apply to a Docker build context — only this file does — so without it \`COPY . .\`
    // would bake \`.env\` plaintext into a layer (a secret leak). NEVER copy \`.env\` or \`.git\`.
    // `.hazelnut/` is framework-owned and mostly derived, but `modules/` is the source a vendored app's own
    // CMD executes out of, so the image must carry it. git answers what belongs in the REPO, the image what
    // the PROCESS needs to run — different questions, and here they give different answers.
    ".dockerignore": `.git
.env
*.local
.hazelnut/
!.hazelnut/modules/
`,
    ".env.example":
      `# Hazelnut app env — copy to .env (gitignored) and fill in. This app ${
        opts.vendor
          ? "VENDORS the framework\n# source under .hazelnut/modules/ (self-contained; git-ignored — a clone restores it with `hazelnut install --from`)"
          : "pins the framework at a\n# file:// checkout"
      }; no read token of any kind is needed.

# Postgres connection used by 'hazelnut migrate' (never on app boot — migration is a gated release step).
DATABASE_URL=postgres://user:pass@localhost:5432/${appName}
`,
    // `.hazelnut/` is framework-owned → out, derived or vendored alike: the derived half is stale by default,
    // and the vendored half is framework source the repo does not carry; `hazelnut install --from` restores it.
    // deno.lock pins the supply chain → in (committed).
    ".gitignore": `.hazelnut/
.env
*.local
node_modules/
# deno.lock is NOT ignored — the supply-chain lock is committed.
# node_modules/ IS ignored — deno.json nodeModulesDir:"auto" materializes it on first run; a naive
# \`git add .\` must never commit it (the lock, not the tree, pins the supply chain).
`,
    // EVERY lock the diff verb writes — the three surface locks and the two additive baselines — bound to a
    // `hazelnut-regen` merge driver; unregistered, it falls back to git's default text merge. Safety never
    // depends on the driver: `surface/lock-matches-derived` catches a stale or corrupted lock at verify time.
    //
    // WITHHELD FROM A CORE APP: the verb that WRITES these files (`diff`) and the flag that CHECKS them
    // (`--surfaces`) are both capability-module surface a core build does not serve, so such an app can
    // neither produce a lock nor detect a stale one. Emitted unconditionally, this shipped git merge hints
    // for five filenames that app could never have — the scaffold answering "does a core consumer get
    // surface locks?" by accident. It answers no.
    ...(opts.core ? {} : {
      ".gitattributes": `**/mcp-surface.lock   merge=hazelnut-regen
**/mcp-additive.lock  merge=hazelnut-regen
**/http-surface.lock  merge=hazelnut-regen
**/http-additive.lock merge=hazelnut-regen
**/event-surface.lock merge=hazelnut-regen
`,
    }),
    "README.md": `# ${appName}

Built with Hazelnut.

## Dev
> The \`dev\` and \`test\` grants above are the DEV set, and they are wider than what ships:
> \`deno task start\` runs \`hazelnut launch\`, which reads this app's own source and derives the
> narrowest grants that serve it. Copy the production line from there, never from here.

- \`deno task dev\` — serve (sets HAZELNUT_DEV=1 to ask for the embedded PGlite; set DATABASE_URL for real
  Postgres. With neither, \`main.ts\` refuses to start — a lost DATABASE_URL never means "development")
${verifyBullet}- \`deno task add <resource|module>\` — add a resource/module
- \`deno test\` — tests
- \`deno task migrate\` — migration (loads DATABASE_URL from \`.env\`; \`--env <name>\` loads \`.env.<name>\`; prod schema never lands on boot)

## Setup
1. Copy \`.env.example\` to \`.env\` (only \`DATABASE_URL\` for real-Postgres runs; no tokens of any kind).

## Structure
You write declarations (\`hazelnut add\` scaffolds them — or start with \`hazelnut new --example\`) and the business
logic. Everything else — CRUD, routes, DB schema, MCP tools — the framework derives at boot and runs; it is not
in the repo. Starter cost is 8 concepts (a CRUD backend runs); a guarded custom op is 21; everything past
that is +1 verb per concern, loaded only when the concern is real.

A fresh resource ships with NO reachable surface (deny-by-default): to put it on the wire, declare
\`http: { list: { policy: "policy", columns: ["id", …] }, … }\` — reads carry a \`rowPolicy\`; writes carry the perm gate — the worked example is the
\`--example\` widget.${ironRulesSentence}
`,
  };
  // `--example` (cli/new.md flag table) seeds the runnable `widget` declaration; the default ships no
  // domain.ts — an empty project. `hazelnut add resource <module>/<name>` adds the first declaration.
  if (example) {
    // Emitted as `widget.resource.ts` (the `*.resource.ts` declaration-file convention the placement lint rule
    // and the framework's discovery key on) — not `domain.ts`, which would trip `hazelnut/placement-declaration`.
    files["widget.resource.ts"] = `import { defineResource } from "hazelnut";
import { z } from "zod";

// One declaration → type faces + DB schema + HTTP routes + MCP tools + verified invariants, at boot.
// The starter posture IS the production posture: every route policy-gated (deny-by-default) plus a
// rowPolicy that narrows on the ROW's own owner. Swap \`owner_id\` for whatever column carries ownership
// once real auth lands; use http:"public" only for a surface you DELIBERATELY serve to every actor,
// agent, and crawler.${widgetSpecClause}
export const widget = defineResource({
  name: "widget",
  schema: z.object({
    title: z.string(),
    owner_id: z.string(), // who the row belongs to — the column the row rule narrows on
  }),
  // Last-write-wins, stated: \`update\` overwrites whatever it is given. Switch to \`versioning: true\` when a
  // field is derived from the value just read — the row then carries \`version\` and update requires it.
  features: { timestamps: true, scope: true, versioning: false },
  // WHICH ROWS, per caller. The permission already decided whether they reach the route; this decides what
  // they see once there. A bare column name is the ownership rule: the caller sees the rows they own, and an
  // unauthenticated request arrives as an ANONYMOUS actor, which owns nothing, so it matches no row. The
  // column is checked against this schema, so a typo is a compile error, not a rule that matches nothing.
  // Write \`(actor: Actor | null) => …\` instead once the rule is more than ownership.
  rowPolicy: "owner_id",
  // Name the WHOLE read response — a short-form "policy" string defaults to nothing and boot-refuses.
  // created_at / updated_at / scope_key are stored; they reach the wire only when listed here.
  http: {
    list: { policy: "policy", columns: ["id", "title", "owner_id"] },
    find: { policy: "policy", columns: ["id", "title", "owner_id"] },
    create: "policy",
  },
  // The MCP face is the same double-opt-in as http: curate the op AND keep it row-guarded — this line is
  // why \`POST /mcp tools/list\` shows a widget tool. The tool returns that same projection, so the agent
  // surface is never wider than the route it mirrors.
  mcp: { list: { describe: "List widgets the caller may see." } },
});
`;
    // The rowPolicy's independent spec sibling (13-authz.md §spec-independence) states "who should see the
    // row" without importing the impl, so verify's impl⊨spec differential catches drift as a leak. Dropped by --core.
    if (!opts.core) {
      files["widget.rowpolicy.spec.ts"] =
        `import { type Actor } from "hazelnut";
import { isAnonymous } from "hazelnut/authz/auth.ts";

/**
 * Row-visibility SPEC for \`widget\` — "who SHOULD see this row", in plain business terms, stated
 * INDEPENDENTLY of widget.resource.ts's rowPolicy impl (never importing it). Verify differentials the two:
 * any row the rowPolicy admits that this spec forbids (or vice-versa) is a caught leak, not a silent one.
 *
 * The starter rule: a caller may see a widget row they OWN, and no other. It is a question about the ROW,
 * not about what the caller holds — a rule that answers the same rows to two holders of the same grant is
 * the leak, and boot refuses it. Narrow BOTH halves together when you tighten visibility further.
 *
 * \`isAnonymous\`, never \`actor !== null\`: an unauthenticated request reaches here as a NON-NULL actor whose
 * id is the literal "anonymous", so a null test admits it and every row owned by "anonymous" goes on the wire.
 */
export const spec = (
  actor: Actor | null,
  row: { title: string; owner_id: string },
): boolean => !isAnonymous(actor) && row.owner_id === actor?.id;
`;
    }
  }
  // A boot smoke test so a fresh scaffold's \`deno task test\` is green by construction — it boots the served
  // path on embedded PGlite, so a broken template (e.g. \`scope:true\` with no resolver) fails here, loudly.
  files["app.test.ts"] = `import { assert } from "@std/assert";
import { applySchema, createApp, pgliteDb } from "hazelnut";
import { PGlite } from "@electric-sql/pglite";
import { config } from "./hazelnut.config.ts";

Deno.test("app boots and serves on embedded PGlite", async () => {
  const db = pgliteDb(new PGlite());
  // scheduler:"external" — this throwaway test process is legitimately NOT the scheduler, so it declares the
  // choice and the boot stays refuse-free (an undeclared scheduler choice REFUSES every served boot).
  const app = createApp(config, { db, scheduler: "external" });
  await applySchema(db, app);
  assert(app.fetch, "the served app exposes a fetch handler");
  const res = await app.fetch(new Request("http://localhost/health"));
  assert(res.ok, "GET /health responds ok");
});
`;
  // The full build emits the verify-projected AGENTS.md; the core module omits it (agents === null) since its
  // header is a `hazelnut verify` re-projection contract a core app cannot honor.
  if (agents !== null) files["AGENTS.md"] = agents;
  if (architecture !== null) files["ARCHITECTURE.md"] = architecture;
  return files;
}

// re-exported so import sites stay stable across the module split.
export * from "./scaffold-nut.ts";
