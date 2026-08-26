// `hazelnut doctor` — the environment checkup: is THIS machine/app dir ready to run a Hazelnut app?
// Checks the runtime + supporting kit (Deno line, lock discipline, cron flag, node_modules mode, pin
// resolution, Postgres floor + pgvector), NOT the app's correctness — that is `hazelnut verify`'s job.
import { APP_DEPENDENCY_PINS, DENO_TESTED_LINE } from "../core/version.ts";
import { certifiedCore } from "../core/module-pins.ts";
import { fileURLToPath } from "node:url"; // file-URL → fs path (URL.pathname yields /C:/… on Windows)

export type DoctorStatus = "ok" | "warn" | "fail";

/** Every id a check can report. A finding's `id` is typed to it, so a new check joins the roster to
 *  compile, and the reference page's table is held equal to the roster. */
export const DOCTOR_CHECK_IDS = [
  "deno/version",
  "env/path-shape",
  "supply-chain/lock",
  "config/deno-json",
  "tasks/least-privilege",
  "tasks/unstable-cron",
  "config/node-modules",
  "pin/resolves",
  "pin/portable",
  "pin/certified",
  "pin/dependencies",
  "lint/static-rung",
  "db/postgres",
  "db/pgvector",
] as const;

export type DoctorCheckId = (typeof DOCTOR_CHECK_IDS)[number];

export interface DoctorFinding {
  readonly id: DoctorCheckId;
  readonly status: DoctorStatus;
  readonly detail: string;
  readonly fix?: string; // present on warn/fail — the one action that clears it
}

/** Everything the checks read from the world, injectable so every path is unit-testable. */
export interface DoctorProbes {
  readonly denoVersion: string; // Deno.version.deno
  /** The PATH env verbatim — empty string when unset. Without the running deno's own directory on
   *  it, bare-name run grants cannot resolve (`hazelnut launch`'s serve lane). */
  readonly pathEnv: string;
  readonly denoJson: string | null; // ./deno.json content, null when absent
  readonly lockExists: boolean; // ./deno.lock on disk
  /** What git says about `deno.lock`, from `lockStateFromPorcelain`. `"denied"` is its own state, not a
   *  null: the emitted `doctor` task grants `--allow-run=deno`, so the probe this check turns on used to
   *  fail NotCapable and land in the same bucket as "no repo" — reported ok, for every consumer, always. */
  readonly lockTracked: LockState;
  readonly databaseUrl: string | undefined; // env DATABASE_URL
  /** Connect + inspect; null when databaseUrl is unset. `error` carries a connect/query failure. */
  readonly pg:
    | { serverVersion: string; hasVector: boolean }
    | { error: string }
    | null;
}

/** Deno line check: 1.x is below the boot floor (createApp refuses); a 2.x line other than the tested
 *  one runs but is unverified — the framework CI pins `v<DENO_TESTED_LINE>.x`. */
function checkDeno(version: string): DoctorFinding {
  const major = Number(version.split(".")[0]);
  if (!(major >= 2)) {
    return {
      id: "deno/version",
      status: "fail",
      detail:
        `Deno ${version} is below the 2.x floor — createApp refuses at boot`,
      fix: `install Deno ${DENO_TESTED_LINE}.x (the framework's tested line)`,
    };
  }
  const line = version.split(".").slice(0, 2).join(".");
  if (line !== DENO_TESTED_LINE) {
    return {
      id: "deno/version",
      status: "warn",
      detail:
        `Deno ${version} runs, but the framework is tested against ${DENO_TESTED_LINE}.x — this line is unverified`,
      fix: `pin Deno ${DENO_TESTED_LINE}.x for parity with framework CI`,
    };
  }
  return {
    id: "deno/version",
    status: "ok",
    detail: `Deno ${version} (tested line ${DENO_TESTED_LINE}.x)`,
  };
}

/** True when the current shell's PATH drops the running deno's directory — the condition a serve
 *  lane cannot run under (its bare-name run grants cannot resolve). Test `ignore:` expressions read
 *  this instead of touching PATH themselves, so the env-gate detector does not read them as a suite
 *  gate on PATH. */
export function launchBlockedByPath(): boolean {
  return !denoDirOnPath(Deno.env.get("PATH") ?? "");
}

/** True iff the directory of `execPath` is an entry of `pathEnv` — the condition bare-name
 *  `--allow-run` grants and bare spawns resolve under. */
function denoDirOnPath(
  pathEnv: string,
  execPath = Deno.execPath(),
  os: typeof Deno.build.os = Deno.build.os,
): boolean {
  const norm = (p: string) =>
    (os === "windows" ? p.toLowerCase() : p).replaceAll("\\", "/")
      .replace(/\/+$/, "");
  const dir = norm(execPath.replace(/[\\/][^\\/]*$/, ""));
  const sep = os === "windows" ? ";" : ":";
  return pathEnv.split(sep).some((e) => norm(e) === dir && dir !== "");
}

/** The running deno's own directory is not on PATH — the common cause is an MSYS shell (git-bash),
 *  whose converted PATH drops `~/.deno/bin`. Bare-name `--allow-run` grants cannot resolve there, so
 *  `hazelnut launch`'s derived `--allow-run=deno` dies NotCapable at its own child spawn. The SHELL,
 *  not the install — the same grant resolves under a PATH that carries the deno directory. */
export function checkPathShape(
  pathEnv: string,
  execPath = Deno.execPath(),
  os: typeof Deno.build.os = Deno.build.os,
): DoctorFinding[] {
  if (denoDirOnPath(pathEnv, execPath, os)) {
    return [{
      id: "env/path-shape",
      status: "ok",
      detail: "the running deno's directory is on PATH",
    }];
  }
  return [{
    id: "env/path-shape",
    status: "warn",
    detail:
      `the running deno's directory is not on PATH — bare-name --allow-run grants cannot resolve, so \`hazelnut launch\` will refuse its own child spawn (NotCapable). An MSYS shell (git-bash) is the common cause: its converted PATH drops the deno directory`,
    fix:
      `run the serve lane from a shell whose PATH carries the deno directory (native PowerShell/cmd, or export PATH to include it)`,
  }];
}

/** `exists` alone certifies NOTHING: resolving this CLI's own imports writes deno.lock, so the file is
 *  on disk by the time any check reads it — and the mtime moves on every run, so it cannot separate
 *  "created just now" from "already here". Being TRACKED is the one state this process cannot manufacture,
 *  so it is the only `ok`. */
/** What git knows about `deno.lock`. `true` is the ONLY clean state: a lock that exists, is tracked, and
 *  matches the commit. Anything else is a supply-chain fact the reader has not been told. */
export type LockState =
  | boolean
  | "modified"
  | "ignored"
  | "no-git"
  | "denied";

/**
 * `git status --porcelain --untracked-files=all --ignored=matching -- deno.lock` → a `LockState`.
 *
 * `git ls-files --error-unmatch` used to answer this, and it answers the WRONG QUESTION: it reports the
 * INDEX ENTRY, which survives both deleting the file and rewriting it. Since doctor's own module resolution
 * regenerates a missing lock before any check reads it, deleting `deno.lock` and running `doctor` reported
 * `present and committed` for a lock that git called ` M` — the one verdict worse than no verdict.
 */
export function lockStateFromPorcelain(
  code: number,
  stdout: string,
): LockState {
  if (code !== 0) return "no-git";
  const line = stdout.split("\n").find((l) => l.trim() !== "");
  if (line === undefined) return true; // tracked, and identical to the commit
  const xy = line.slice(0, 2);
  if (xy === "??") return false; // in the tree, in no commit
  if (xy === "!!") return "ignored"; // can never BE committed
  return "modified"; // tracked, and not what the commit holds
}

function checkLock(
  exists: boolean,
  tracked: LockState,
): DoctorFinding {
  if (!exists) {
    return {
      id: "supply-chain/lock",
      status: "warn",
      detail: "no deno.lock — dependency hashes are unbounded until one exists",
      fix: "run `deno cache main.ts` and commit deno.lock",
    };
  }
  if (tracked === "denied") {
    return {
      id: "supply-chain/lock",
      status: "warn",
      detail:
        "deno.lock is present, but this task cannot ask git whether it is committed — so nothing here verified it",
      fix: "widen the doctor task to `--allow-run=deno,git`, then re-run",
    };
  }
  if (tracked === "no-git") {
    return {
      id: "supply-chain/lock",
      status: "warn",
      detail:
        "deno.lock is present but this tree is not a git repo — nothing records that it predates this run, and teammates get no shared hashes",
      fix: "git init && git add deno.lock && git commit",
    };
  }
  if (tracked === false) {
    return {
      id: "supply-chain/lock",
      status: "warn",
      detail:
        "deno.lock exists but is not committed — CI and teammates cannot verify the recorded hashes",
      fix: "git add deno.lock && git commit",
    };
  }
  if (tracked === "ignored") {
    return {
      id: "supply-chain/lock",
      status: "warn",
      detail:
        "deno.lock is gitignored — it can never reach a commit, so CI and teammates resolve their own hashes",
      fix:
        "drop deno.lock from .gitignore, then git add deno.lock && git commit",
    };
  }
  if (tracked === "modified") {
    return {
      id: "supply-chain/lock",
      status: "warn",
      detail:
        "deno.lock differs from the committed one — the hashes CI verifies are not the hashes on disk (deleting the lock regenerates it silently, which is how this reads clean)",
      fix:
        "git diff deno.lock to see what moved, then commit it or git restore deno.lock",
    };
  }
  return {
    id: "supply-chain/lock",
    status: "ok",
    detail: "deno.lock present and committed",
  };
}

/** Whether the app's CLI tasks run a hazelnut CLI entry that carries a lint rung — the full build
 *  (`hazelnut.ts`, all 33 rules) or the core build (`hazelnut-core.ts`, the 9-rule safety floor). A build
 *  fact about which CLI this app invokes, and nothing more: it says which verbs the app can run, NEVER
 *  whether a plugin file exists. A report that reads it as the latter tells the reader a filesystem fact it
 *  never looked at. Core was excluded here while its scaffold shipped no lint plugin; it ships the floor now. */
export function ambientRungAvailable(
  tasks: Readonly<Record<string, string>>,
): boolean {
  const hop = /(?:^|[\s;&|])deno task ([a-zA-Z0-9:_-]+)/g;
  const bodies = new Set<string>(Object.values(tasks));
  for (const t of Object.values(tasks)) {
    for (const m of t.matchAll(hop)) {
      const next = tasks[m[1]!];
      if (next !== undefined) bodies.add(next);
    }
  }
  return [...bodies].some((t) =>
    /\/cli\/hazelnut(-core)?\.ts(\s|$)/.test(t) ||
    /(?:jsr:|npm:|https:)\S*\/cli(\s|$)/.test(t) ||
    /(?:^|\s)hazelnut(\s|$)/.test(t)
  );
}

/** Resolves an app-declared specifier against an ABSOLUTE app dir, or `null` when it is not a local file.
 *  `absDir` must be absolute: resolving `../../src/x.ts` against a relative `.` silently walks off the root
 *  and yields a path that matches nothing — a wrong answer that reads as "the rung is not wired". */
export function resolvePluginSpecifier(
  spec: string,
  absDir: string,
): string | null {
  try {
    // one comparison frame across platforms: forward slashes, a drive-absolute Windows path keeping its
    // drive (`X:/…`) the way a POSIX path keeps its leading `/`
    if (spec.startsWith("file:")) {
      return fileURLToPath(new URL(spec)).replaceAll("\\", "/");
    }
    const isAbs = (p: string) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
    if (!spec.startsWith(".") && !isAbs(spec)) return null; // a bare/registry specifier
    if (!isAbs(absDir) && !isAbs(spec)) return null;
    const base = isAbs(spec)
      ? spec.replaceAll("\\", "/")
      : `${absDir.replace(/\/+$/, "")}/${spec}`;
    // normalize `a/./b` and `a/b/../c` without touching the filesystem
    const parts: string[] = [];
    let drive = "";
    for (const seg of base.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") parts.pop();
      else if (/^[A-Za-z]:$/.test(seg)) drive = seg;
      else parts.push(seg);
    }
    return drive !== "" ? `${drive}/${parts.join("/")}` : `/${parts.join("/")}`;
  } catch {
    return null;
  }
}

/** The app dir every doctor path resolves against. doctor reads the app's config from its cwd, so its
 *  specifiers are all app-relative; comparing two of them under ONE sentinel root is dir-free and exact,
 *  where a real cwd would make the IDENTITY answer depend on where the verb was invoked from. It is a
 *  comparison frame and NEVER a probe frame — see `pinnedPluginSpecifier`. */
const DOCTOR_ROOT = "/__app__";

/** A pin that names something on disk, in the frame it was written in; `null` for a published specifier,
 *  which has no path to probe. `file:` is absolutised because a URL is not a path. */
function localPinPath(pin: string): string | null {
  if (pin.startsWith("file:")) {
    try {
      return fileURLToPath(new URL(pin)).replaceAll("\\", "/");
    } catch {
      return null;
    }
  }
  // a Windows pin is drive-absolute; separator normalisation stays Windows-only because `\` is a
  // legal filename character on POSIX
  const win = Deno.build.os === "windows";
  return pin.startsWith("/") || pin.startsWith("./") || pin.startsWith("../") ||
      (win && /^[A-Za-z]:[\\/]/.test(pin))
    ? (win ? pin.replaceAll("\\", "/") : pin)
    : null;
}

/**
 * The lint plugin the APP'S OWN framework pin carries, AS THE PIN SPELLS IT, or `null` when no pin names a
 * plugin file that exists.
 *
 * The fact both rung reporters need: `lint.plugins` naming a file with the right path TAIL says nothing,
 * since an app's own same-named file satisfies that while exporting no rules. What the app's pin carries is
 * derivable from the pin, so it is derived — ONCE, here.
 *
 * The answer is a PATH in the app's own frame and `exists` is the CALLER's, because the two callers probe
 * from different places: `doctor` runs with the app dir as cwd, so a relative path resolves itself; the
 * shield holds an absolute app dir and resolves before probing. Resolving here against a sentinel root and
 * probing THAT is what made every relative pin — the vendored `./.hazelnut/modules` shape `pin/portable`
 * recommends, and both shipped examples — answer `null`, dropping `lint/static-rung` from the report.
 */
export function pinnedPluginSpecifiers(
  imports: Readonly<Record<string, string>>,
  exists: (spec: string) => boolean,
): string[] {
  for (const key of ["hazelnut", "hazelnut/", "@hazelnut/core"]) {
    const pin = imports[key];
    if (pin === undefined) continue;
    // the pin is the framework `src/` dir, spelled either as the dir itself (`<pin>/`) or as a module
    // inside it (`<pin>/mod-core.ts`) — both scaffold shapes, one rule. Separators normalise first:
    // a Windows pin's `\mod-core.ts` tail is invisible to the module-strip regex.
    const norm = Deno.build.os === "windows" ? pin.replaceAll("\\", "/") : pin;
    const dir = norm.replace(/\/+$/, "").replace(/\/[^/]*\.[cm]?[jt]s$/, "");
    // BOTH hazelnut plugins a pin can carry: the full 33-rule plugin and the 9-rule safety FLOOR. A source
    // tree carries both; a core artifact only the floor. An app wires ONE, so doctor must accept either. one
    // call decides each: a published specifier drops out, and a `file:` URL becomes the path a filesystem
    // probe can take — `Deno.lstatSync("file:///…")` reads that string as a relative path.
    const found: string[] = [];
    for (const rel of ["verify/lint-plugin.ts", "invariants/lint-floor.ts"]) {
      const spec = localPinPath(`${dir}/${rel}`);
      if (spec !== null && exists(spec)) found.push(spec);
    }
    if (found.length > 0) return found; // the first pin key that resolves is the app's framework home
  }
  return [];
}

/** The package `./lint` export a registry pin carries. Not a filesystem path — the shield's
 *  `pinnedPluginSpecifier` stays disk-only, so a published specifier still answers `null` there.
 *  Doctor uses this for identity against `lint.plugins`. */
export function registryLintSpecifiers(
  imports: Readonly<Record<string, string>>,
): string[] {
  for (const key of ["hazelnut", "hazelnut/", "@hazelnut/core"]) {
    const pin = imports[key];
    if (pin === undefined) continue;
    const norm = Deno.build.os === "windows" ? pin.replaceAll("\\", "/") : pin;
    if (!/^(?:jsr:|npm:|https?:)/.test(norm)) continue;
    const dir = norm.replace(/\/+$/, "").replace(/\/[^/]*\.[cm]?[jt]s$/, "");
    return [`${dir}/lint`];
  }
  return [];
}

/** The primary hazelnut plugin a pin carries — the full plugin when present, else the floor. Kept for the
 *  rung shield, which wants one specifier; `doctor` uses the plural form to accept either wired plugin. */
export function pinnedPluginSpecifier(
  imports: Readonly<Record<string, string>>,
  exists: (spec: string) => boolean,
): string | null {
  return pinnedPluginSpecifiers(imports, exists)[0] ?? null;
}

/** Published `@hazelnut/<module>@x.y.z` specifiers — name and version from the specifier, not the key. */
const JSR_HAZELNUT = /^jsr:@hazelnut\/([a-z-]+)@(\d+\.\d+\.\d+)/;

function checkCertifiedPins(
  imports: Readonly<Record<string, string>> | undefined,
): DoctorFinding {
  const pins: Array<{ name: string; version: string }> = [];
  for (const spec of Object.values(imports ?? {})) {
    const m = spec.match(JSR_HAZELNUT);
    if (m !== null) pins.push({ name: m[1]!, version: m[2]! });
  }
  const modules = pins.filter((p) => p.name !== "core");
  if (modules.length === 0) {
    return {
      id: "pin/certified",
      status: "ok",
      detail: "no published capability-module pins",
    };
  }
  const cores = [
    ...new Set(pins.filter((p) => p.name === "core").map((p) => p.version)),
  ];
  if (cores.length !== 1) {
    return {
      id: "pin/certified",
      status: "fail",
      detail: cores.length === 0
        ? "a published capability module is pinned, but `@hazelnut/core` is not a published specifier — the pair cannot be certified"
        : `imports pin more than one @hazelnut/core version (${
          cores.join(", ")
        })`,
      fix:
        "pin exactly one `jsr:@hazelnut/core@<version>` and a module version certified against it",
    };
  }
  const core = cores[0]!;
  const seen = new Map<string, string>();
  for (const p of modules) {
    const prev = seen.get(p.name);
    if (prev !== undefined && prev !== p.version) {
      return {
        id: "pin/certified",
        status: "fail",
        detail:
          `imports pin @hazelnut/${p.name} at both ${prev} and ${p.version}`,
        fix: `pin exactly one version of @hazelnut/${p.name}`,
      };
    }
    seen.set(p.name, p.version);
    const want = certifiedCore(p.name, p.version);
    if (want === null) {
      return {
        id: "pin/certified",
        status: "fail",
        detail:
          `@hazelnut/${p.name}@${p.version} is not a certified module version`,
        fix:
          "pin a module version from the release that certified it against your core pin",
      };
    }
    if (want !== core) {
      return {
        id: "pin/certified",
        status: "fail",
        detail:
          `@hazelnut/${p.name}@${p.version} is certified against @hazelnut/core@${want}, not @${core}`,
        fix:
          `pin jsr:@hazelnut/core@${want} (or a module version certified against ${core})`,
      };
    }
  }
  return {
    id: "pin/certified",
    status: "ok",
    detail:
      `${seen.size} published module pin(s) certified against core ${core}`,
  };
}

/**
 * `JSON.parse` over an app's deno config text, with `//` and block comments stripped.
 *
 * Deno reads `deno.json` as JSONC — measured — so a plain `JSON.parse` reports a config deno itself accepts
 * as broken, and every check downstream of that parse vanishes from the report.
 */
export function parseDenoConfig(text: string): unknown {
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += c;
  }
  return JSON.parse(out);
}

/** deno.json shape checks: cron flag on serve tasks + node_modules mode + a resolvable framework pin. */
/** True iff a task command runs THIS PROJECT'S source. Every framework-CLI task names the hazelnut entry
 *  (a `hazelnut.ts`/`hazelnut-core.ts` module or the compiled binary) — that is the discriminator, so a
 *  task the emitter has not been taught about still lands in the checked half. */
function taskHops(
  tasks: Readonly<Record<string, string>>,
  cmd: string,
): string[] {
  const hops = [...cmd.matchAll(/(?:^|[\s;&|])deno task ([a-zA-Z0-9:_-]+)/g)]
    .map((m) => tasks[m[1]!])
    .filter((c): c is string => c !== undefined);
  return [cmd, ...hops];
}

function runsProjectCode(cmd: string): boolean {
  // lowercase `hazelnut` covers all three CLI pin shapes — `…/cli/hazelnut.ts`, `jsr:@hazelnut/core/cli`,
  // and a bare binary on PATH. The env prefix `HAZELNUT_DEV=1` is uppercase, so it is not a false exclusion.
  return /(^|\s|&&\s*)deno\s+(run|test)(\s|$)/.test(cmd) &&
    !cmd.includes("hazelnut");
}

/**
 * The app's own third-party pins against the ones this framework resolves (`APP_DEPENDENCY_PINS`).
 *
 * The app's import map is not decoration: a framework file pinned into it resolves hono/zod/drizzle THROUGH
 * that map, so a skew loads two copies in one process — two Hono contexts, two zod registries, and a type
 * error that names two paths in the same cache. `hazelnut new` writes the matching set; an app that bumped
 * only its `hazelnut` pin keeps whatever it was born with, and until now nothing said so.
 *
 * WARN, never fail: a deliberate newer pin is a choice this check reports rather than overrules.
 */
function checkDependencyPins(
  imports: Readonly<Record<string, string>> | undefined,
): DoctorFinding {
  const app = imports ?? {};
  // Only keys the app actually carries — a map that never pinned `postgres` is not drifting on it.
  const drifted = Object.entries(APP_DEPENDENCY_PINS)
    .filter(([k]) => app[k] !== undefined && app[k] !== APP_DEPENDENCY_PINS[k])
    .map(([k, want]) => `${k} ${app[k]} (this build resolves ${want})`)
    .sort();
  if (drifted.length === 0) {
    const shared = Object.keys(APP_DEPENDENCY_PINS).filter((k) =>
      app[k] !== undefined
    ).length;
    return {
      id: "pin/dependencies",
      status: "ok",
      detail: shared === 0
        ? "this app pins none of the framework's own dependencies"
        : `${shared} shared dependency pin(s) match this build`,
    };
  }
  return {
    id: "pin/dependencies",
    status: "warn",
    detail:
      `dependency pin(s) differ from the ones this framework build resolves — ${
        drifted.join("; ")
      }; a shared package pinned twice loads twice`,
    fix:
      "match them in this app's deno.json, or re-scaffold and copy the import map across",
  };
}

function checkDenoJson(
  raw: string | null,
  pinExists: (path: string) => boolean,
): DoctorFinding[] {
  if (raw === null) {
    return [{
      id: "config/deno-json",
      status: "fail",
      detail: "no ./deno.json — run doctor from the app root",
      fix: "cd <app> (the dir `hazelnut new` scaffolded)",
    }];
  }
  let cfg: {
    tasks?: Record<string, string>;
    nodeModulesDir?: string;
    imports?: Record<string, string>;
    exclude?: readonly string[];
    lint?: {
      plugins?: readonly string[];
      include?: readonly string[];
      exclude?: readonly string[];
      rules?: { exclude?: readonly string[] };
    };
  };
  try {
    cfg = parseDenoConfig(raw) as typeof cfg;
  } catch {
    return [{
      id: "config/deno-json",
      status: "fail",
      detail: "./deno.json is not valid JSONC",
      fix: "fix the syntax error (deno lint names it)",
    }];
  }
  const out: DoctorFinding[] = [];
  // No task that runs THIS PROJECT'S code may hold a blanket grant. `start` is what a deployment runs, and
  // an -A there means the served process holds every capability Deno can give regardless of what the app
  // declares — the exact hole `hazelnut launch` exists to close. The rest of the door set is DERIVED, not
  // named: a `deno run`/`deno test` whose target is project-local runs the author's own code, while every
  // framework-CLI task targets an absolute `file:`/`jsr:`/`https:` entry and is a build tool, not the app.
  const tasks = cfg.tasks ?? {};
  const startCmd = tasks.start;
  const blanketStart = startCmd !== undefined && (
    /(^|\s)(-A|--allow-all)(\s|$)/.test(startCmd) ||
    taskHops(tasks, startCmd).slice(1).some((c) =>
      /(^|\s)(-A|--allow-all)(\s|$)/.test(c) && runsProjectCode(c)
    )
  );
  const blanketAppTasks = Object.entries(tasks)
    .filter(([name, cmd]) =>
      name !== "start" &&
      taskHops(tasks, cmd).some((c) =>
        runsProjectCode(c) && /(^|\s)(-A|--allow-all)(\s|$)/.test(c)
      )
    )
    .map(([name]) => name).sort();
  out.push(
    blanketStart || blanketAppTasks.length > 0
      ? {
        id: "tasks/least-privilege",
        status: "warn",
        detail: blanketStart
          ? "the `start` task grants -A — the served process holds every capability, not the set its declarations imply"
          : `the task(s) ${
            blanketAppTasks.join(", ")
          } grant -A — they run this project's own code with every capability Deno can give, including run and ffi`,
        fix: blanketStart
          ? "route `start` through `hazelnut launch ./app.ts` (derives the set; `--explain` shows each grant and what forced it)"
          : "name the grants the app needs (`--allow-net --allow-env --allow-read --allow-write=. --unstable-cron`) instead of -A; run `hazelnut launch ./app.ts --explain` to see what the served lane derives",
      }
      : {
        id: "tasks/least-privilege",
        status: "ok",
        detail: cfg.tasks?.start === undefined
          ? "no `start` task (nothing claims to be the prod serve command)"
          : "no task that runs this project's code carries a blanket grant",
      },
  );
  // `launch` derives --unstable-cron itself, so a launcher-routed task needs no literal flag.
  const serveTasks = ["dev", "start"].filter((t) => cfg.tasks?.[t]);
  const missingCron = serveTasks.filter((t) =>
    !cfg.tasks![t]!.includes("--unstable-cron") &&
    !cfg.tasks![t]!.includes(" launch ")
  );
  out.push(
    missingCron.length > 0
      ? {
        id: "tasks/unstable-cron",
        status: "warn",
        detail: `task(s) ${
          missingCron.join(", ")
        } lack --unstable-cron — feature TTL sweeps and cron jobs silently no-op`,
        fix: "add --unstable-cron to the serve task(s)",
      }
      : {
        id: "tasks/unstable-cron",
        status: "ok",
        detail: "serve tasks carry --unstable-cron",
      },
  );
  out.push(
    cfg.nodeModulesDir === "auto"
      ? {
        id: "config/node-modules",
        status: "ok",
        detail: 'nodeModulesDir "auto" (drizzle-kit resolvable)',
      }
      : {
        id: "config/node-modules",
        status: "warn",
        detail:
          'nodeModulesDir is not "auto" — drizzle-kit\'s Node loader cannot resolve, `hazelnut migrate` breaks',
        fix: '"nodeModulesDir": "auto" in deno.json',
      },
  );
  const pin = cfg.imports?.["hazelnut"];
  // EVERY framework key, not just the bare one. Layering the surface turned one pin into six — `hazelnut/`
  // plus an exact key per concern subpath, plus the `@hazelnut/core` identity a capability module addresses
  // core by — and a check that reads only `imports["hazelnut"]` reports 7/7 green on an app whose
  // `hazelnut/query` points at a path that was moved. The verb's whole job is to find that before boot does.
  const frameworkPins = Object.entries(cfg.imports ?? {})
    .filter(([k]) =>
      k === "hazelnut" || k.startsWith("hazelnut/") ||
      k === "@hazelnut/core" || k.startsWith("@hazelnut/core/")
    );
  // EVERY pin that names a path, in every spelling that names one. Probing only `file://` reported
  // "N framework pin(s) resolve" for an app whose relative pin pointed at a directory that is not there —
  // and `pin/portable` below tells apps to use exactly that spelling, so the recommended shape was the
  // unprobed one. A published specifier stays unprobed because it has no path, not because it was skipped.
  const dead = frameworkPins.filter(([, v]) => {
    const p = localPinPath(v);
    return p !== null && !pinExists(p);
  });
  if (!pin) {
    out.push({
      id: "pin/resolves",
      status: "fail",
      detail: 'imports["hazelnut"] missing from deno.json',
      fix: "re-scaffold or restore the framework pin",
    });
  } else if (dead.length > 0) {
    out.push({
      id: "pin/resolves",
      status: "fail",
      detail: `${dead.length} framework pin(s) point at a missing path: ${
        dead.map(([k, v]) => `${k} → ${v}`).join(", ")
      }`,
      fix:
        "repoint with `hazelnut new --local <framework-repo>` or restore the checkout",
    });
  } else {
    // The count says how many were PROBED, never how many exist: a published specifier has nothing on this
    // machine to check, and folding it into "resolve" is the claim the `file://`-only filter used to make.
    const probed = frameworkPins.filter(([, v]) => localPinPath(v) !== null);
    out.push({
      id: "pin/resolves",
      status: "ok",
      detail: probed.length === frameworkPins.length
        ? `${frameworkPins.length} framework pin(s) resolve on this machine (${pin})`
        : `${probed.length} of ${frameworkPins.length} framework pin(s) name a local path and resolve; the rest are published specifiers, resolved at fetch time (${pin})`,
    });
  }
  // `pin/resolves` answers "on THIS machine", and answering it `ok` was the whole report a reader got. A
  // `--local` scaffold pins `file:///Users/<someone>/<checkout>/src/mod-core.ts` — true here, false everywhere
  // else, and outside the `COPY . .` of the Dockerfile the same scaffold emits, so the documented production
  // path does not build from the documented quickstart output while the diagnostic verb reports 7/7 green.
  //
  // The property is PORTABILITY, not the `file://` spelling: a host-absolute path is bound to one filesystem
  // however it is written. A pin that travels with the app directory (`./.hazelnut/modules`, what `--vendor`
  // writes), one relative to it, and a published specifier are all portable and stay `ok`.
  if (pin !== undefined) {
    const hostAbsolute = pin.startsWith("file:/") ||
      (pin.startsWith("/") && !pin.startsWith("//"));
    out.push(
      hostAbsolute
        ? {
          id: "pin/portable",
          status: "warn",
          detail:
            `imports["hazelnut"] is a host-absolute path (${pin}) — it resolves on this machine only, and a container build cannot reach outside its build context`,
          fix:
            "re-scaffold self-contained with `hazelnut new <app> --vendor <framework-repo>` (copies the framework under the app), or repoint the pin at a published specifier",
        }
        : {
          id: "pin/portable",
          status: "ok",
          detail: pin.startsWith(".")
            ? `pin travels with the app dir (${pin})`
            : `published specifier (${pin})`,
        },
    );
  }
  out.push(checkCertifiedPins(cfg.imports));
  out.push(checkDependencyPins(cfg.imports));
  // An ambient plugin's rule bodies only ever run inside `deno lint` — no CLI path spawns it — so an app
  // whose `lint.plugins` omits the plugin runs none of them, anywhere, while its `ci` still runs a
  // plugin-less `deno lint` that is green on builtin rules.
  //
  // The message states the CONSEQUENCE, never the rule inventory: this file ships in the core artifact and
  // the inventory belongs to the capability module that owns the rules.
  // Probed in the APP's frame (`pinExists` runs with the app dir as cwd), compared in the sentinel one.
  // BOTH plugins the pin carries (full and/or floor), resolved to disk paths — an app wires ONE, and a source
  // tree carries both, so matching the wired plugin against only the "primary" reported `warn` for a core app
  // that correctly wired the floor beside a pin that also holds the full plugin.
  const pinnedPlugins = [
    ...pinnedPluginSpecifiers(cfg.imports ?? {}, pinExists),
    ...registryLintSpecifiers(cfg.imports ?? {}),
  ].map((s) => resolvePluginSpecifier(s, DOCTOR_ROOT) ?? s);
  const pinnedSpec = pinnedPlugins[0] ?? null;
  // Reported only when this app both runs the build that ships the plugin AND pins a checkout that carries
  // it: telling an app to wire a file its own pin cannot produce is advice it cannot take.
  const rungAvailable = ambientRungAvailable(cfg.tasks ?? {}) &&
    pinnedPlugins.length > 0;
  const plugins = cfg.lint?.plugins ?? [];
  // `lint.exclude` shadows the plugin over whatever it names, and reading only `plugins` reported "ok" for an
  // app whose test files — where a fabricated actor, a raw SQL escape or an `as any` hides — were outside the
  // scan entirely. Whether to exclude is the app's call; making the call INVISIBLE is not.
  // Deno applies the TOP-LEVEL `exclude` to `deno lint` too, so reading only `lint.exclude` reported "ok"
  // for the identical darkening spelled one key up — measured against `deno lint`, not assumed.
  const excluded = [...(cfg.exclude ?? []), ...(cfg.lint?.exclude ?? [])];
  // `lint.include` is the same narrowing inverted: an allowlist scans only what it names.
  const included = cfg.lint?.include ?? [];
  // `lint.rules.exclude` turns a NAMED rule off across the whole repo, and reading only `plugins`+`exclude`
  // reported "ok — static rung wired" for an app that had switched rules off one by one. A path exclude at
  // least narrows to a path; this one is unbounded, so it is the wider hole of the two.
  const mutedRules = (cfg.lint?.rules?.exclude ?? []).filter((r) =>
    r === "hazelnut" || r.startsWith("hazelnut/")
  );
  // IDENTITY against the plugin the app's own pin carries, never a path SHAPE: `./verify/lint-plugin.ts` in
  // the app's own tree satisfies a path-tail test while exporting no rules, and a pin repointed after a
  // checkout move satisfies it while resolving to nothing. Both were reported `ok — static rung wired`.
  const hasHazelnutPlugin = plugins.some((s) => {
    const resolved = resolvePluginSpecifier(s, DOCTOR_ROOT) ?? s;
    return pinnedPlugins.includes(resolved);
  });
  // Every way the config narrows the wired rung, reported TOGETHER: one shadow must not mask the other, and
  // an app that both excludes a path and switches rules off has two gaps, not the first one found.
  const shadows: string[] = [];
  if (mutedRules.length > 0) {
    shadows.push(
      `lint.rules.exclude switches ${
        mutedRules.join(", ")
      } off across the whole app`,
    );
  }
  if (excluded.length > 0) {
    shadows.push(
      `an exclude shadows it over ${
        excluded.join(", ")
      } — the plugin's rules do not run there`,
    );
  }
  if (included.length > 0) {
    shadows.push(
      `lint.include scans only ${
        included.join(", ")
      } — the plugin's rules do not run outside it`,
    );
  }
  if (rungAvailable) {
    out.push(
      hasHazelnutPlugin
        ? shadows.length === 0
          ? {
            id: "lint/static-rung",
            status: "ok" as const,
            detail: `static rung wired (${plugins.length} lint plugin(s))`,
          }
          : {
            id: "lint/static-rung",
            status: "warn" as const,
            detail: `static rung wired, but ${shadows.join("; and ")}`,
            fix:
              "drop the exclude so the whole app is scanned by every rule, or keep it knowingly: what it names is what the static rung does not check",
          }
        : {
          id: "lint/static-rung",
          status: "warn",
          detail:
            `lint.plugins names no entry that resolves to the plugin your pin carries (${pinnedSpec}) — this app's editor-time rule set is not running`,
          fix:
            "add the framework lint plugin to lint.plugins in deno.json, or accept the gap knowingly — `deno lint` without it is green on builtin rules only",
        },
    );
  }
  return out;
}

/** Postgres check: unset URL is the sanctioned dev shape (embedded PGlite); a set URL must reach a
 *  PG >= 16 and SHOULD offer pgvector (vector() columns CREATE EXTENSION it). */
function checkPg(
  url: string | undefined,
  pg: DoctorProbes["pg"],
): DoctorFinding[] {
  if (!url) {
    return [{
      id: "db/postgres",
      status: "ok",
      detail:
        "DATABASE_URL unset — embedded PGlite (dev shape); set it for real-Postgres runs",
    }];
  }
  if (pg === null || "error" in (pg as object)) {
    return [{
      id: "db/postgres",
      status: "fail",
      detail: `DATABASE_URL set but unreachable: ${
        pg && "error" in pg ? pg.error : "no probe"
      }`,
      fix: "check the connection string / that Postgres is up",
    }];
  }
  const v = pg as { serverVersion: string; hasVector: boolean };
  const major = Number(v.serverVersion.split(".")[0]);
  const out: DoctorFinding[] = [];
  out.push(
    major >= 16
      ? {
        id: "db/postgres",
        status: "ok",
        detail: `Postgres ${v.serverVersion} (floor 16)`,
      }
      : {
        id: "db/postgres",
        status: "fail",
        detail: `Postgres ${v.serverVersion} is below the 16 floor`,
        fix: "upgrade the server (the stack pin is PostgreSQL 16+)",
      },
  );
  out.push(
    v.hasVector
      ? { id: "db/pgvector", status: "ok", detail: "pgvector available" }
      : {
        id: "db/pgvector",
        status: "warn",
        detail:
          "pgvector extension unavailable — a vector() field will fail CREATE EXTENSION",
        fix:
          "install pgvector on the server (or use the pgvector/pgvector image)",
      },
  );
  return out;
}

export function runDoctorChecks(
  p: DoctorProbes,
  pinExists: (path: string) => boolean,
): DoctorFinding[] {
  return [
    checkDeno(p.denoVersion),
    ...checkPathShape(p.pathEnv),
    checkLock(p.lockExists, p.lockTracked),
    ...checkDenoJson(p.denoJson, pinExists),
    ...checkPg(p.databaseUrl, p.pg),
  ];
}

const MARK: Record<DoctorStatus, string> = { ok: "✓", warn: "⚠", fail: "✗" };

/** The id column's width, from the roster — a longer new id widens the column instead of ragging it. */
const ID_WIDTH = Math.max(...DOCTOR_CHECK_IDS.map((id) => id.length)) + 1;

/** Render + exit code: any ✗ → 1 (environment not serviceable), else 0 (warns don't block). */
export function renderDoctor(
  findings: readonly DoctorFinding[],
): { lines: string[]; exit: 0 | 1 } {
  const lines = findings.map((f) =>
    `${MARK[f.status]} ${f.id.padEnd(ID_WIDTH)} ${f.detail}${
      f.fix ? `\n    fix: ${f.fix}` : ""
    }`
  );
  const fails = findings.filter((f) => f.status === "fail").length;
  const warns = findings.filter((f) => f.status === "warn").length;
  lines.push(
    fails > 0
      ? `doctor: ${fails} blocker(s), ${warns} warning(s) — not serviceable`
      : `doctor: environment serviceable (${warns} warning(s))`,
  );
  return { lines, exit: fails > 0 ? 1 : 0 };
}
