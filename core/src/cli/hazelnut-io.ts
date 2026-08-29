// Barrel re-exports keep import sites stable.
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripJsoncComments } from "../core/framework-literals.ts";
import type { App } from "../core/app.ts";
import type { Db } from "../data/db.ts";
import { drainFrameworkTopics } from "../data/repo.ts";
import type { StorageDriver } from "../data/storage.ts";
import type { EmbeddingProvider } from "../features/embed.ts";
import type { Kms } from "../features/encrypt.ts"; // relaySeams threads kms so encrypted consumers work on the external relay
import type { Datasources } from "../data/datasources.ts"; // relaySeams threads datasources for cross-source consumers
import type { DrainResult } from "../runtime/outbox.ts";
import {
  DEFAULT_RESTART_POLICY,
  nextRestart,
  relayHealthHandler,
} from "../runtime/outbox.ts";
import { runLiveRelay } from "../runtime/relay.ts";
import { renderAndRouteAlarms } from "../runtime/alarm.ts";
import type {
  VerifyCacheEntry,
  VerifyCacheStore,
} from "../core/verifier-contract.ts";
import {
  APP_SOURCE_EXTS,
  APP_SOURCE_SKIP,
  CORPUS_SKIP,
} from "../core/app-walk.ts";
import { SCAFFOLD_TOOLING_GRANT_FLAGS } from "./scaffold.ts";

export { APP_SOURCE_EXTS, APP_SOURCE_SKIP, CORPUS_SKIP };

/** The dynamic-`import()` specifier for a CLI app-path arg: a URL passes through, a path becomes a `file:`
 *  URL via `pathToFileURL` (hand-composing it breaks on a Windows-drive path). */
export function moduleSpec(arg: string): string {
  // A flag in the app-path slot is a typo or a missing argument, never a module. Passed through it became
  // `file:///<cwd>/--typo` and surfaced as an uncaught `Module not found` under a framework stack — the
  // shape this CLI reserves for its own bugs — on five of the ten core verbs.
  if (arg.startsWith("-")) {
    throw new CliRefusal(
      `expected an app path, got the flag '${arg}'.\n\n` +
        `  The app path comes FIRST: \`hazelnut <verb> <app> [flags]\`.`,
    );
  }
  if (arg.startsWith("file:") || arg.startsWith("http")) return arg;
  return pathToFileURL(arg).href; // resolves a relative path against cwd; handles both absolute forms
}

/** Imports the app module for a CLI verb, turning Deno's bare-specifier failure into the one instruction
 *  that fixes it.
 *
 *  Every verb loads the app the same way, and every verb can hit the same wall: the CLI ENTRY lives inside
 *  the framework tree, so Deno discovers the FRAMEWORK's `deno.json` — while the `hazelnut` pin the app's
 *  modules import lives in the APP's. Deno then reports `Import "hazelnut" not a dependency` against the
 *  app file, which names neither the cause nor the cure, and the cure (`-c <app>/deno.json`) was written
 *  down only inside the scaffolded task strings — invisible to anyone invoking the CLI by hand. A first-run
 *  wall whose fix is undiscoverable is a DX failure even when the tool is behaving correctly. */
/** A refusal the USER can act on, as opposed to a framework crash. The CLI entry renders it as a plain
 *  message + exit 2 (the convention every other verb refusal follows) and keeps the stack trace for
 *  genuine bugs — a wall of framework stack above the one line that says what to type is what makes a
 *  fixable situation read as broken. */
export class CliRefusal extends Error {}

/**
 * The one reading of a caught error the CLI prints. `String(e)` on an `AggregateError` is the literal text
 * `"AggregateError"` — the class name and nothing else — and every failed database connect arrives as one
 * (the driver races the resolved addresses and aggregates what each attempt threw), so the verb that applies
 * DDL reported its most common failure as a word with no cause, no host and no fix.
 *
 * Unwraps the aggregate and the `cause` chain, de-duplicated: N attempts against one unreachable host say
 * the same thing N times, and a repeated sentence reads as N distinct problems.
 */
export function explainError(e: unknown): string {
  const seen = new Set<string>();
  const push = (v: unknown): void => {
    if (v instanceof AggregateError) {
      // the aggregate's own message is usually the generic "All promises were rejected" — keep it only when
      // it carries something the members do not.
      for (const inner of v.errors) push(inner);
      if (seen.size > 0) return;
    }
    const msg = v instanceof Error ? v.message : String(v);
    if (msg.trim() !== "") seen.add(msg);
    if (v instanceof Error && v.cause !== undefined && v.cause !== null) {
      push(v.cause);
    }
  };
  push(e);
  const parts = [...seen];
  return parts.length === 0 ? String(e) : parts.join(" · ");
}

export async function importAppModule(
  spec: string,
): Promise<Record<string, unknown>> {
  try {
    return await import(spec) as Record<string, unknown>;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A BOOT REFUSAL is user-actionable, not a framework bug: `app.ts` calls `createApp` at module scope, so
    // every model guard fires HERE, during the import. It used to fall through to the bare rethrow and print
    // as an uncaught exception with a framework stack — the one failure a consumer meets most often was the
    // only one without the `id → cause → fix` envelope every other violation gets, and it leaked internal
    // paths besides. The id shape (`<concern>/<slug>: `) is the framework's own, so `explain` can resolve it.
    const guard = /^([a-z][a-z0-9]*\/[a-z0-9*-]+): /.exec(msg);
    if (guard) {
      throw new CliRefusal(
        `${msg}\n\n` +
          `  id:   ${guard[1]}\n` +
          `  docs: hazelnut explain ${guard[1]}\n` +
          `  note: this fired while LOADING the app — \`createApp\` runs at module scope, so a boot guard\n` +
          `        refuses before any verb reads the model. Fix the declaration and re-run the same command.`,
      );
    }
    if (!/not a dependency|not in (the )?import map/i.test(msg)) throw e;
    const shown = spec.startsWith("file:") ? fileURLToPath(spec) : spec;
    throw new CliRefusal(
      `cannot resolve the imports of ${shown}\n  ${msg.split("\n")[0]}\n\n` +
        `  The CLI entry lives in the FRAMEWORK tree, so Deno read the framework's deno.json — but the\n` +
        `  \`hazelnut\` pin your app imports lives in the APP's. Point the CLI at the app's config:\n\n` +
        `      deno run ${SCAFFOLD_TOOLING_GRANT_FLAGS} -c deno.json <cli-entry> <verb> ${shown}\n\n` +
        `  A scaffolded app already carries \`-c deno.json\` in its verify / add / doctor / migrate / start tasks,\n` +
        `  so \`deno task <verb>\` works without the flag (cli/new.md §acquisition).`,
    );
  }
}

/** Load the composed `App` a CLI verb was pointed at, refusing with the one instruction that fixes each
 *  failure. ONE copy: two dispatchers now take an app path, and a second inline block is where the flag-slot
 *  refusal and the missing-export message drift apart. */
export async function loadApp(appArg: string): Promise<App> {
  const spec = moduleSpec(appArg);
  const mod = await importAppModule(spec) as { app?: App; default?: App };
  const app = mod.app ?? mod.default;
  if (!app) {
    console.error(`module '${appArg}' does not export 'app'`);
    Deno.exit(2);
  }
  return app;
}

/** Parses a `.env` file's text into a `{ KEY → value }` map (cli/migrate.md §prod-guard). Splits on the
 *  first `=` only, so a connection URL's `?a=b` query never mis-splits the value. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const body = line.startsWith("export ")
      ? line.slice("export ".length).trim()
      : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue; // no key, or `=value` — skip
    const key = body.slice(0, eq).trim();
    let value = body.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** A path the corpus walk could not read, and why. Named so a caller can FIRE on it: a consumer that only
 *  ever sees `sources` cannot tell a complete corpus from a truncated one. */
export interface CorpusReadError {
  readonly path: string;
  readonly error: string;
}

/**
 * The extensions `deno lint` and `deno check` READ. The corpus is what every "did we see everything" claim
 * in the verifier rests on, so it is the linter's population and not a narrower guess: a `.mjs` file fires
 * the same safety-floor rules a `.ts` one does, and a corpus that stops at `.ts` cannot see the directive
 * that silences them. Measured against `deno lint`, one extension at a time.
 */
export const LINTED_EXTENSIONS: readonly string[] = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

/** True iff `deno lint` would read a file by this name. */
export function isLintedSource(name: string): boolean {
  return LINTED_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/**
 * The app's config text for the pin-coherence readers: `deno.json` OR `deno.jsonc` (Deno resolves either),
 * comment-stripped so a `// bumped from …@0.6.3` breadcrumb is not counted as a second pin. `undefined`
 * when neither exists — the version-literal clause then stays inert.
 */
export async function readAppDenoConfigText(
  dir = ".",
): Promise<string | undefined> {
  for (const name of ["deno.json", "deno.jsonc"]) {
    try {
      return stripJsoncComments(await Deno.readTextFile(`${dir}/${name}`));
    } catch { /* not this one */ }
  }
  return undefined;
}

/**
 * Every first-party source file under `dir` — the ONE walk both `upgrade --plan` and `upgrade --apply-plan`
 * read their corpus through. Two copies of it had already diverged: only one resolved symlinks and only one
 * carried the cycle guard, so `--plan` and `--apply-plan` could see different populations of the same tree
 * and the second half of a two-step verb silently covered less than the first.
 *
 * The extension set is the whole TS family, not `.ts` alone: a `.tsx` declaration was not even in the
 * DENOMINATOR — it produced no edit, no failure and no warning, so a tree that upgrades to nothing reads
 * exactly like a tree with nothing to upgrade. Skip roots live in `core/app-walk.ts`.
 */

export async function collectAppSources(
  dir: string,
): Promise<Record<string, string>> {
  const sources: Record<string, string> = {};
  const walked = new Set<string>();
  const walk = async (d: string): Promise<void> => {
    // Keyed on the RESOLVED path: symlinked sources are first-party (a linked shared/vendor dir), so the
    // walk follows them, and a link back into an ancestor would otherwise recurse forever.
    const real = await Deno.realPath(d).catch(() => d);
    if (walked.has(real)) return;
    walked.add(real);
    for await (const e of Deno.readDir(d)) {
      const p = `${d}/${e.name}`;
      // A DirEntry reports a symlink as neither file nor directory, so an unresolved entry is silently
      // skipped — a linked source tree then upgrades to nothing with no warning.
      const kind = e.isSymlink ? await Deno.stat(p).catch(() => null) : e;
      if (!kind) continue; // broken link — nothing to read
      if (kind.isDirectory) {
        if (!APP_SOURCE_SKIP.has(e.name)) await walk(p);
        continue;
      }
      if (kind.isFile && APP_SOURCE_EXTS.some((x) => e.name.endsWith(x))) {
        sources[p] = await Deno.readTextFile(p);
      }
    }
  };
  await walk(dir);
  return sources;
}

// ── the `.gitignore` chain, because `deno lint` honours it and the corpus deliberately does not ──────────
//
// MEASURED against `deno lint` (Deno 2.x) on this machine: it applies `.gitignore` with OR without a `.git`
// directory, honours a nested `.gitignore` in a subdirectory and a `!` re-include, does NOT read
// `.git/info/exclude`, and DOES read a `.gitignore` in a directory above its own root. So a source directory
// an app gitignores leaves the corpus while the linter stops reading it, and the two populations diverge.

/** One compiled `.gitignore` line. `base` is the directory the pattern is relative to. */
export interface IgnoreRule {
  readonly base: string; // "" for the app root, else a `dir/` prefix
  readonly re: RegExp; // matched against the path relative to `base`
  readonly negated: boolean;
  readonly dirOnly: boolean;
  readonly source: string; // the `<file>:<line>` this came from, for the report
}

/** A `.gitignore` line this compiler does not fully implement — reported rather than silently skipped. */
export interface IgnoreUnknown {
  readonly source: string;
  readonly pattern: string;
  readonly why: string;
}

/** Escapes a literal run for a RegExp; `*`, `?` and `[` are handled by the caller. */
const reLit = (s: string) => s.replace(/[.+^${}()|\\]/g, "\\$&");

/** Compiles one gitignore glob (already stripped of `!` and a trailing `/`) into a RegExp source, anchored
 *  per git's rule: a pattern with an inner `/` is rooted at its `.gitignore`, otherwise it matches a
 *  basename at any depth. Null when the pattern uses a form this compiler does not implement. */
function globToRe(pattern: string): string | null {
  if (/\\|\[/.test(pattern)) return null; // escapes and character classes: not implemented, so reported
  const rooted = pattern.slice(0, -1).includes("/") || pattern.startsWith("/");
  const body = pattern.replace(/^\//, "");
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === "*") {
      if (body[i + 1] === "*") {
        // `**/` = any number of leading segments; a trailing `/**` = everything inside
        if (body[i + 2] === "/") {
          out += "(?:[^/]+/)*";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
        continue;
      }
      out += "[^/]*";
      continue;
    }
    if (c === "?") {
      out += "[^/]";
      continue;
    }
    out += reLit(c);
  }
  return rooted ? `^${out}$` : `^(?:.*/)?${out}$`;
}

/** Compiles a `.gitignore` file. `base` is its directory relative to the app root (`""` or `sub/`). */
export function compileGitignore(
  text: string,
  base: string,
  label: string,
): { rules: IgnoreRule[]; unknown: IgnoreUnknown[] } {
  const rules: IgnoreRule[] = [];
  const unknown: IgnoreUnknown[] = [];
  text.split("\n").forEach((raw, i) => {
    const source = `${label}:${i + 1}`;
    if (/\\\s*$/.test(raw)) {
      unknown.push({ source, pattern: raw, why: "a trailing escape" });
      return;
    }
    let line = raw.replace(/\s+$/, "");
    if (line === "" || line.startsWith("#")) return;
    const negated = line.startsWith("!");
    if (negated) line = line.slice(1);
    const dirOnly = line.endsWith("/");
    if (dirOnly) line = line.slice(0, -1);
    if (line === "") return;
    const src = globToRe(line);
    if (src === null) {
      unknown.push({
        source,
        pattern: raw.trim(),
        why: "a character class or an escape",
      });
      return;
    }
    rules.push({ base, re: new RegExp(src), negated, dirOnly, source });
  });
  return { rules, unknown };
}

/** True iff one path (relative to the app root) is matched, with the LAST matching rule winning — git's
 *  precedence, so a `!` re-include below the pattern that ignored it takes effect. */
function matchedBy(
  rules: readonly IgnoreRule[],
  path: string,
  isDir: boolean,
): IgnoreRule | null {
  let hit: IgnoreRule | null = null;
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    if (r.base !== "" && !path.startsWith(r.base)) continue;
    if (r.re.test(path.slice(r.base.length))) hit = r;
  }
  return hit;
}

/**
 * The corpus paths `deno lint` would NOT read, each with the `.gitignore` line that darkens it.
 *
 * Evaluated ancestor-first, per git: a directory that is ignored cannot have a child re-included, so each
 * path's ancestors are tested before the path itself.
 */
export function gitignoreDarkened(
  paths: readonly string[],
  rules: readonly IgnoreRule[],
): Array<{ path: string; by: string }> {
  const out: Array<{ path: string; by: string }> = [];
  for (const p of paths) {
    const segs = p.split("/");
    let by: string | null = null;
    for (let i = 0; i < segs.length - 1 && by === null; i++) {
      const anc = segs.slice(0, i + 1).join("/");
      const m = matchedBy(rules, anc, true);
      if (m !== null && !m.negated) by = m.source;
    }
    if (by === null) {
      const m = matchedBy(rules, p, false);
      if (m !== null && !m.negated) by = m.source;
    }
    if (by !== null) out.push({ path: p, by });
  }
  return out;
}

/** Reads the `.gitignore` chain that governs `dir` — its own tree plus every ancestor up to the repo root
 *  (`deno lint` reads those too, measured), each compiled against the app-root-relative corpus. */
export async function readGitignoreChain(dir: string): Promise<{
  rules: IgnoreRule[];
  unknown: IgnoreUnknown[];
}> {
  const rules: IgnoreRule[] = [];
  const unknown: IgnoreUnknown[] = [];
  const abs = await Deno.realPath(dir).catch(() => dir);
  // ancestors, outermost first: their patterns are relative to a directory ABOVE the corpus, so only the
  // basename-shaped ones can reach into it — an anchored ancestor pattern is rooted outside and cannot.
  const chain: string[] = [];
  for (let d = abs;;) {
    const parent = d.slice(0, d.lastIndexOf("/"));
    if (parent === "" || parent === d) break;
    chain.unshift(parent);
    if (await fileExistsAt(`${d}/.git`)) break;
    d = parent;
  }
  for (const anc of chain) {
    const text = await Deno.readTextFile(`${anc}/.gitignore`).catch(() => null);
    if (text === null) continue;
    const c = compileGitignore(text, "", `${anc}/.gitignore`);
    // an ancestor's ANCHORED pattern is rooted at the ancestor, not inside this app — it cannot name a
    // corpus path, and pretending it does would darken the wrong tree.
    rules.push(...c.rules.filter((r) => r.re.source.startsWith("^(?:.*/)?")));
    unknown.push(...c.unknown);
  }
  const walk = async (rel: string): Promise<void> => {
    const here = rel === "" ? abs : `${abs}/${rel.slice(0, -1)}`;
    const text = await Deno.readTextFile(`${here}/.gitignore`).catch(() =>
      null
    );
    if (text !== null) {
      const c = compileGitignore(text, rel, `${rel}.gitignore`);
      rules.push(...c.rules);
      unknown.push(...c.unknown);
    }
    for await (const e of readDirSafe(here)) {
      if (e.isDirectory && !CORPUS_SKIP.has(e.name)) {
        await walk(`${rel}${e.name}/`);
      }
    }
  };
  await walk("");
  return { rules, unknown };
}

async function fileExistsAt(p: string): Promise<boolean> {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function* readDirSafe(d: string): AsyncIterable<Deno.DirEntry> {
  try {
    for await (const e of Deno.readDir(d)) yield e;
  } catch {
    /* an unreadable branch is the corpus reader's finding, not this one's */
  }
}

/**
 * Reads every source under `dir` that `deno lint` reads, reporting each path it could not read alongside
 * what it got.
 *
 * The walk recovers PER ENTRY, never at the top: one catch around the whole traversal ends it at the first
 * failure, and since `Deno.readDir` order is unspecified, the corpus that survives is an arbitrary prefix.
 * Every source-scanning check then reads clean on the files that vanished from it.
 */
export async function readSourceTreeChecked(dir: string): Promise<{
  readonly sources: Record<string, string>;
  readonly errors: ReadonlyArray<CorpusReadError>;
}> {
  const sources: Record<string, string> = {};
  const errors: CorpusReadError[] = [];
  const why = (e: unknown) => e instanceof Error ? e.message : String(e);
  const SKIP = CORPUS_SKIP;
  const walk = async (d: string): Promise<void> => {
    const entries: Deno.DirEntry[] = [];
    try {
      for await (const e of Deno.readDir(d)) entries.push(e);
    } catch (e) {
      errors.push({ path: d, error: why(e) });
      return; // this branch is lost; the siblings are not
    }
    for (const e of entries) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory) {
        if (!SKIP.has(e.name)) await walk(p);
        continue;
      }
      if (e.isFile && isLintedSource(e.name)) {
        try {
          sources[p] = await Deno.readTextFile(p);
        } catch (err) {
          errors.push({ path: p, error: why(err) });
        }
      }
    }
  };
  await walk(dir);
  return { sources, errors };
}

/** The corpus alone, for readers with no channel to report a gap on (scaffold-time scans). A caller that
 *  gates on the corpus being WHOLE takes `readSourceTreeChecked` instead. */
export async function readSourceTree(
  dir: string,
): Promise<Record<string, string>> {
  return (await readSourceTreeChecked(dir)).sources;
}

/**
 * The directory `atomicWrite` creates before the sibling temp file. Both `/` and `\` count: a Windows
 * path `D:\\foo\\bar.txt` has no `/`, so a slash-only split would mkdir `.` and write the temp next to
 * cwd rather than next to the target.
 */
export function parentDir(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (slash <= 0) return ".";
  const dir = path.slice(0, slash);
  return /^[A-Za-z]:$/.test(dir) ? `${dir}\\` : dir;
}

/**
 * Writes `content` to `path` atomically via a sibling temp file + `rename` — atomic on POSIX, so a reader
 * never sees a half-written byte and a crash mid-write leaves the old file intact.
 */
export async function atomicWrite(
  path: string,
  content: string,
): Promise<void> {
  const dir = parentDir(path);
  await Deno.mkdir(dir, { recursive: true });
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await Deno.writeTextFile(tmp, content);
    await Deno.rename(tmp, path);
  } catch (e) {
    await Deno.remove(tmp).catch(() => {}); // sweep the partial temp; never leave a torn sibling
    throw e;
  }
}

/**
 * A disk-backed verify cache store over `.hazelnut/verify-cache.json`: `load` hits only on an exact key
 * match (a corrupt/absent file never throws); `store` writes fire-and-forget — await `flush` before exit.
 */
export function makeDiskVerifyCacheStore(
  path: string,
): { store: VerifyCacheStore; flush: () => Promise<void> } {
  let loaded = false;
  let entry: VerifyCacheEntry | undefined;
  const pendingWrites: Array<Promise<void>> = [];
  const ensureLoaded = (): void => {
    if (loaded) return;
    loaded = true;
    try {
      const raw = Deno.readTextFileSync(path);
      const parsed = JSON.parse(raw) as VerifyCacheEntry;
      // a structurally-valid entry carries a string key and a violations array; anything else is treated as
      // corrupt (a miss), never trusted — the cache must never rehydrate a wrong-shaped result.
      if (
        parsed && typeof parsed.key === "string" &&
        Array.isArray(parsed.violations)
      ) entry = parsed;
    } catch {
      entry = undefined; // absent or corrupt/unparseable → a miss; the next verify runs a fresh cold pass
    }
  };
  return {
    store: {
      load(key) {
        ensureLoaded();
        return entry && entry.key === key ? entry.violations : undefined; // a vector mismatch is a miss
      },
      store(key, violations) {
        const next: VerifyCacheEntry = { key, violations };
        entry = next;
        pendingWrites.push(
          atomicWrite(path, JSON.stringify(next)).catch(() => {}),
        ); // best-effort; never gates verify
      },
    },
    flush: async () => {
      await Promise.all(pendingWrites);
    },
  };
}

/**
 * The `hazelnut relay` live entrypoint (05-runtime.md §relay-mode): drains `_outbox` via `runLiveRelay`,
 * running `drainFrameworkTopics` first each pass — after, its rows are already processed and skipped.
 */
/**
 * The seam bundle `hazelnut relay <app>` threads so file()/vector/encrypted/cross-source consumers work off
 * the served process; absent, relay startup refuses fail-closed rather than silently no-op draining.
 */
export interface RelaySeams {
  readonly storage?: StorageDriver | null;
  readonly embed?: EmbeddingProvider | null;
  readonly kms?: Kms;
  readonly datasources?: Datasources;
}

/** The seams an app declares (file()→storage, vector→embed, encrypted→kms) that `relaySeams` did not
 *  provide; non-empty means the CLI refuses at startup naming the gaps, never a silent no-op drain. */
export function relaySeamsGap(app: App, seams: RelaySeams): string[] {
  const missing: string[] = [];
  if (app.model.some((m) => m.files.length > 0) && !seams.storage) {
    missing.push("storage (file() resources — _file_gc)");
  }
  if (app.model.some((m) => m.vector != null) && !seams.embed) {
    missing.push("embed (vector resources — _vector_reembed)");
  }
  if (app.model.some((m) => m.encrypted.length > 0) && !seams.kms) {
    missing.push("kms (encrypted resources — consumer decrypt)");
  }
  return missing;
}

export async function hazelRelay(
  db: Db,
  app: App,
  opts: {
    readonly loop?: boolean;
    readonly intervalMs?: number;
    readonly signal?: AbortSignal;
    readonly maxCycles?: number;
    readonly healthPort?: number;
  } = {},
  frameworkSeams: RelaySeams = {},
): Promise<DrainResult> {
  const registry = app.relay ?? {}; // empty registry when the app declares no async verb (a clean no-op drain)
  const total: DrainResult = { processed: 0, failed: 0, dead: 0 };
  const add = (r: DrainResult) =>
    Object.assign(total, {
      processed: total.processed + r.processed,
      failed: total.failed + r.failed,
      dead: total.dead + r.dead,
    });
  // The standing framework-topic backstop: a topic-scoped `_file_gc`/`_vector_reembed` sweep that can never
  // consume a subscriber/emit job the live relay owns.
  const drainFramework = (): Promise<unknown> =>
    drainFrameworkTopics(db, {
      models: app.model,
      app,
      storage: frameworkSeams.storage ?? null,
      embed: frameworkSeams.embed ?? null,
    });
  // After each pass, renders relay-health signals (DLQ depth, liveness) into the installed AlarmSink — the
  // noop default stays zero-cost. Reverting this call leaves a DLQ corpse silent (05-runtime.md §5).
  const health = { lastDrainAt: null as number | null };
  const routeAlarms = async (): Promise<void> => {
    await renderAndRouteAlarms(db, {
      lastDrainAt: health.lastDrainAt,
      backpressure: app.backpressure,
    });
    health.lastDrainAt = Date.now();
  };
  // The headless worker's own liveness surface (05-runtime.md §5.1): `--health-port` serves GET /healthz
  // over the same relayLiveness classification `/ready` uses. Shuts down with the loop — a dead port is the signal.
  const healthServer = opts.healthPort !== undefined
    ? Deno.serve({
      port: opts.healthPort,
      onListen: ({ port }) => console.log(`relay /healthz on :${port}`),
    }, relayHealthHandler(db, health))
    : null;
  if (!opts.loop) {
    try {
      await drainFramework(); // the framework-topic backstop; runs before runLiveRelay so it never sees those rows
      add(
        await runLiveRelay(
          db,
          registry,
          { maxCycles: opts.maxCycles },
          app,
          frameworkSeams.kms,
          frameworkSeams.datasources,
          frameworkSeams.storage ?? undefined,
        ),
      ); // single drain pass — kms/datasources/storage let encrypted/cross-source consumers work on the external relay
      await routeAlarms(); // delivers the post-drain relay-health alarms to the installed sink (noop default is zero-cost)
      return total;
    } finally {
      await healthServer?.shutdown();
    }
  }
  // Loop mode re-drains on the interval until aborted; SKIP LOCKED + the advisory lock keep multiple relay
  // instances safe, and it self-supervises with restart-with-backoff — `maxRestarts` failures crash loudly.
  const interval = opts.intervalMs ?? 1_000;
  const wait = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      opts.signal?.addEventListener("abort", () => {
        clearTimeout(t);
        resolve();
      }, { once: true });
    });
  let failures = 0; // consecutive failed passes (feeds nextRestart; reset on any clean pass)
  try {
    while (!opts.signal?.aborted) {
      try {
        await drainFramework(); // the framework-topic backstop, once per iteration, before runLiveRelay
        add(
          await runLiveRelay(
            db,
            registry,
            { maxCycles: opts.maxCycles },
            app,
            frameworkSeams.kms,
            frameworkSeams.datasources,
            frameworkSeams.storage ?? undefined,
          ),
        );
        await routeAlarms(); // delivers this pass's relay-health alarms into the installed sink
        failures = 0;
      } catch (e) {
        const decision = nextRestart(failures++);
        if (decision.action === "crash") {
          console.error(
            `relay loop: restart budget exhausted after ${failures} consecutive failures — crashing (last error: ${e})`,
          );
          throw e; // fail the process loudly — an orchestrator restart is the correct next rung
        }
        console.error(
          `relay loop: pass failed (${e}) — restart ${decision.attempt}/${DEFAULT_RESTART_POLICY.maxRestarts} in ${decision.delayMs}ms`,
        );
        await wait(decision.delayMs);
        continue; // re-enter without the normal interval sleep — the backoff was the sleep
      }
      if (opts.signal?.aborted) break;
      await wait(interval);
    }
    return total;
  } finally {
    await healthServer?.shutdown(); // the worker's port goes dark with the loop — a dead worker never serves a live probe
  }
}

/**
 * Copy a framework checkout's `src/` into an app's `.hazelnut/modules/`, and report how many files landed.
 *
 * ONE implementation behind both doors that vendor: `hazelnut new --vendor` at scaffold time and
 * `hazelnut install --from` afterwards. Two copies of a copy would drift on exactly the detail that matters —
 * `tests/` is excluded, matching what `scripts/build-hash.ts` hashes, so a vendored tree and a released one
 * are the same set.
 */
export async function vendorFrameworkTree(
  frameworkRoot: string,
  appRoot: string,
): Promise<number> {
  const srcRoot = `${frameworkRoot}/src`;
  const dstRoot = `${appRoot}/.hazelnut/modules`;
  let copied = 0;
  const copyTree = async (relDir: string): Promise<void> => {
    for await (const e of Deno.readDir(`${srcRoot}${relDir}`)) {
      const rel = `${relDir}/${e.name}`;
      if (e.isDirectory) {
        if (e.name === "tests") continue; // tests are not shipped (build-hash.ts parity)
        await copyTree(rel);
      } else if (e.isFile) {
        await Deno.mkdir(`${dstRoot}${relDir}`, { recursive: true });
        await Deno.copyFile(`${srcRoot}${rel}`, `${dstRoot}${rel}`);
        copied++;
      }
    }
  };
  await copyTree("");
  return copied;
}
