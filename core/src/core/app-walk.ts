/**
 * Directory-skip sets every walk over an app tree shares — CLI corpus, authored-source upgrade, and the
 * lint pin-coherence rule. One spelling: a walk-local copy of these names is how `drizzle/` came to sit
 * in four copies, three of which nobody owned.
 *
 * `drizzle/` is deliberately absent from the corpus set: the scaffold gitignores neither it nor its
 * contents, and `deno lint` READS it, so a directive there silenced the safety floor with the linter
 * green and the census blind. Authored-source walks add it back.
 *
 * `.hazelnut/` stays out because `deno lint` honours `.gitignore` and the scaffold ignores it — it is
 * dark to the oracle, and `--vendor` fills it with the framework's own `src/`, not the app's.
 */
import { stripJsoncComments } from "./framework-literals.ts";

/** Framework scratch only; never an authored module namespace. */
export const VERIFY_SCRATCH_DIR = ".hazelnut-verify";

export const CORPUS_SKIP: ReadonlySet<string> = new Set([
  ".hazelnut",
  VERIFY_SCRATCH_DIR,
  "node_modules",
  ".git",
]);

/** Authored-source walks: the corpus set plus generated `drizzle/`. */
export const APP_SOURCE_SKIP: ReadonlySet<string> = new Set([
  ...CORPUS_SKIP,
  "drizzle",
]);

/** The TS family a first-party source walk reads — not `.ts` alone. */
export const APP_SOURCE_EXTS: readonly string[] = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
];

/** Files the scaffold writes a `jsr:@hazelnut/core@<v>` pin into that the `.ts` walk and `deno.json`
 * reader do NOT cover — the deployed container's launcher is here. The pin-coherence readers scan these
 * too, so a `Dockerfile` frozen at an old CLI while the tree moved is caught, not left to a first-hour
 * production surprise. A rewritten Dockerfile with no `jsr:` pin contributes nothing — the matcher finds
 * no literal. /
 */
export const PIN_COHERENCE_EXTRA_FILES: readonly string[] = ["Dockerfile"];

/** A pin-coherence extra that was opened, or present and unreadable. Absence is `NotFound` only. */
export interface PinExtraReport {
  readonly text: Record<string, string>;
  readonly unreadable: readonly string[];
}

/**
 * Read every `PIN_COHERENCE_EXTRA_FILES` entry under `dir`.
 * `NotFound` is absence. Any other error is an unreadable seat — a scan must not call that file missing.
 */
export function readPinCoherenceExtraReport(dir: string): PinExtraReport {
  const text: Record<string, string> = {};
  const unreadable: string[] = [];
  for (const name of PIN_COHERENCE_EXTRA_FILES) {
    try {
      text[name] = Deno.readTextFileSync(`${dir}/${name}`);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) continue;
      unreadable.push(name);
    }
  }
  return { text, unreadable };
}

/** The config spellings Deno resolves for a directory, in Deno's own precedence. */
export const DENO_CONFIG_NAMES: readonly string[] = ["deno.json", "deno.jsonc"];

/**
 * Every WORKSPACE MEMBER's deno config, as `path → text`.
 *
 * `pin/version-coherent` read the ROOT config and nothing else, so a workspace member pinning an older
 * `@hazelnut/core` was invisible in BOTH spellings — the tree doctor-greened while a member's tasks ran a
 * different CLI against the same model, which is the exact divergence that check exists to name. Members
 * are read as TEXT and folded into the same literal scan the root's own extras go through, so a member's
 * finding names the member's path rather than blaming the root.
 *
 * Only the root's own `workspace` array is followed — Deno does not nest workspaces, so neither does this.
 * An unreadable or unparseable root contributes nothing, which is what it contributed before.
 */
export function readWorkspaceMemberConfigs(
  dir: string,
  rootText: string | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (rootText === null || rootText === undefined) return out;
  let members: unknown;
  try {
    members = (JSON.parse(stripJsoncComments(rootText)) as {
      workspace?: unknown;
    }).workspace;
  } catch {
    return out; // a config Deno itself would reject — its own parse finding owns that
  }
  if (!Array.isArray(members)) return out;
  for (const m of members) {
    if (typeof m !== "string") continue;
    const rel = m.replace(/^\.\//, "").replace(/\/+$/, "");
    if (rel === "" || rel.startsWith("..")) continue; // a member outside the tree is not this tree's pin
    for (const name of DENO_CONFIG_NAMES) {
      try {
        out[`${rel}/${name}`] = Deno.readTextFileSync(`${dir}/${rel}/${name}`);
        break; // Deno resolves the first spelling that exists; so does this
      } catch { /* try the next spelling */ }
    }
  }
  return out;
}

/**
 * Every NESTED deno config in the tree that is not a declared workspace member, as `path → text`.
 *
 * `readWorkspaceMemberConfigs` follows the root's `workspace` array, which is what Deno itself resolves —
 * so a nested `deno.json` nobody declared was read by nothing. `doctor` then reported the tree coherent
 * while that config pinned an older `@hazelnut/core`, and its tasks run a different CLI against the same
 * model. A check that names its scope in prose and not in its finding is the silent half.
 *
 * Bounded by `APP_SOURCE_SKIP`, the same set the source walk uses: a vendored or generated tree is not the
 * app's pin. Follows linked first-party directories with a realpath cycle guard, matching the source walk;
 * otherwise a linked tree can hide a second CLI pin from the coherence verdict. The root's own config is
 * excluded — it is read directly, and reporting it here would double-name it.
 */
export function readOrphanConfigs(
  dir: string,
  members: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const known = new Set(Object.keys(members));
  const seen = new Set<string>();
  const walk = (rel: string) => {
    const at = rel === "" ? dir : `${dir}/${rel}`;
    let real: string;
    try {
      real = Deno.realPathSync(at);
    } catch {
      return; // unreadable or broken — contributes nothing, as before
    }
    if (seen.has(real)) return;
    seen.add(real);
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(at)];
    } catch {
      return; // unreadable — the same per-entry recovery the source walk has
    }
    for (const e of entries) {
      const path = rel === "" ? e.name : `${rel}/${e.name}`;
      const entry = `${dir}/${path}`;
      let kind: { isDirectory: boolean; isFile: boolean };
      if (e.isSymlink) {
        try {
          kind = Deno.statSync(entry);
        } catch {
          continue; // broken link — nothing to read
        }
      } else {
        kind = e;
      }
      if (kind.isDirectory) {
        if (APP_SOURCE_SKIP.has(e.name)) continue;
        walk(path);
      } else if (
        kind.isFile && rel !== "" && DENO_CONFIG_NAMES.includes(e.name) &&
        !known.has(path)
      ) {
        try {
          out[path] = Deno.readTextFileSync(entry);
        } catch { /* unreadable — contributes nothing, as before */ }
      }
    }
  };
  walk("");
  return out;
}

/** Sync source walk: files that opened, and entries that were present but could not be read. */
export interface AppSourceReport {
  readonly files: Record<string, string>;
  readonly unreadable: readonly string[];
}

/**
 * Sync walk of an app tree for every `APP_SOURCE_EXTS` file outside `APP_SOURCE_SKIP`. Follows a
 * symlinked source directory with a realpath cycle guard — the same population `collectAppSources`
 * gathers async. The lint plugin runs synchronously and cannot call that one. The async walk throws
 * on the first unreadable file; this one records that path and keeps going. A caller that drops the
 * `unreadable` list and still reports a finished scan is the false ok this split exists to prevent.
 */
export function inspectAppSourcesSync(dir: string): AppSourceReport {
  const files: Record<string, string> = {};
  const unreadable: string[] = [];
  const seen = new Set<string>();
  const walk = (d: string): void => {
    let real: string;
    try {
      real = Deno.realPathSync(d);
    } catch {
      real = d;
    }
    if (seen.has(real)) return;
    seen.add(real);
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(d)];
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) unreadable.push(d);
      return;
    }
    for (const e of entries) {
      const p = `${d}/${e.name}`;
      let kind: { isDirectory: boolean; isFile: boolean };
      if (e.isSymlink) {
        try {
          kind = Deno.statSync(p);
        } catch {
          continue; // broken link — nothing to read
        }
      } else {
        kind = e;
      }
      if (kind.isDirectory) {
        if (!APP_SOURCE_SKIP.has(e.name)) walk(p);
        continue;
      }
      if (kind.isFile && APP_SOURCE_EXTS.some((x) => e.name.endsWith(x))) {
        try {
          files[p] = Deno.readTextFileSync(p);
        } catch (e) {
          if (!(e instanceof Deno.errors.NotFound)) unreadable.push(p);
        }
      }
    }
  };
  walk(dir);
  return { files, unreadable };
}

/**
 * Doctor's pin scan: extras, workspace and orphan configs, and the source walk. `unreadable` is every
 * seat that was present but did not open. Absence stays out of that list.
 */
export function loadDoctorSources(
  dir: string,
  rootText: string | null | undefined,
): {
  readonly sources: Record<string, string>;
  readonly unreadable: readonly string[];
} {
  const extras = readPinCoherenceExtraReport(dir);
  const sources: Record<string, string> = { ...extras.text };
  const members = readWorkspaceMemberConfigs(dir, rootText);
  Object.assign(sources, members);
  Object.assign(sources, readOrphanConfigs(dir, members));
  const walked = inspectAppSourcesSync(dir);
  Object.assign(sources, walked.files);
  return {
    sources,
    unreadable: [...extras.unreadable, ...walked.unreadable],
  };
}
