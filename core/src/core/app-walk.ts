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
export const CORPUS_SKIP: ReadonlySet<string> = new Set([
  ".hazelnut",
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

/** Read every `PIN_COHERENCE_EXTRA_FILES` entry that exists under `dir`, as `path → text`. */
export function readPinCoherenceExtras(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of PIN_COHERENCE_EXTRA_FILES) {
    try {
      out[name] = Deno.readTextFileSync(`${dir}/${name}`);
    } catch { /* not present — a rewritten container form, or none */ }
  }
  return out;
}

/**
 * Sync walk of an app tree, returning `path → text` for every `APP_SOURCE_EXTS` file outside
 * `APP_SOURCE_SKIP`. Follows a symlinked source directory (a linked shared/vendor tree is first-party)
 * with a realpath cycle guard — the same population `collectAppSources` gathers async. The lint plugin
 * runs synchronously and cannot call that one; sharing this keeps the two coherence readers over one
 * file set. Unreadable entries are skipped, matching the async walk's per-entry recovery.
 */
export function walkAppSourcesSync(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
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
    } catch {
      return;
    }
    for (const e of entries) {
      const p = `${d}/${e.name}`;
      let kind: { isDirectory: boolean; isFile: boolean };
      if (e.isSymlink) {
        try {
          kind = Deno.statSync(p);
        } catch {
          continue; // broken link
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
          out[p] = Deno.readTextFileSync(p);
        } catch { /* unreadable — skip */ }
      }
    }
  };
  walk(dir);
  return out;
}
