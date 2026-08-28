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
