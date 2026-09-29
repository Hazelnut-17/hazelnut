// The judge corpus selector (09-verifier.md §judge): resolves the source the live judge grades per
// `--judge-mode` (full = whole tree, update = Git-changed files plus linked external source). Git/tree readers
// are injectable for tests. Files concatenate in sorted order under `// === file: <path> ===` headers.
import type { CorpusMode } from "../core/verifier-contract.ts";
import { readSourceTree } from "./hazelnut-io.ts";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export interface CorpusResult {
  readonly code: string; // the concatenated source the judge grades ("" ⇒ nothing to grade)
  readonly files: readonly string[]; // the file paths included (sorted)
  /** `update` only: Git or external-link classification could not answer, so the corpus fell back to the
   *  WHOLE tree. An unanswerable source set must never read as "nothing changed" and grade an empty corpus green. */
  readonly degradedToFull?: boolean;
}

/** Strip a leading `./` so a tree key (`./ops.ts`) and a git path (`ops.ts`) compare equal. */
const norm = (p: string): string =>
  p.replaceAll("\\", "/").replace(/^\.\//, "");

/** A tree key is `${dir}/<path>`; git (run WITH `cwd: dir`) speaks `<path>`. Both sides are keyed on the
 *  dir-relative path — a repo-root-relative comparison matches nothing whenever `dir` is a subdirectory. */
function relativeToDir(key: string, dir: string): string {
  const k = norm(key);
  const d = norm(dir).replace(/\/+$/, "");
  return d === "" || d === "." || !k.startsWith(`${d}/`)
    ? k
    : k.slice(d.length + 1);
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** External symlink contents are first-party source to the walker but have no Git diff in this repo.
 * Include those files on every update pass; if the links cannot be classified, force a full corpus. */
async function externalLinkedSources(
  dir: string,
  files: readonly string[],
): Promise<Set<string> | null> {
  try {
    const rootPath = resolve(dir);
    const rootReal = await Deno.realPath(rootPath);
    const inspected = new Map<string, boolean>();
    const external = new Set<string>();
    for (const file of files) {
      const filePath = resolve(file);
      if (!isWithin(rootPath, filePath)) return null;
      let cursor = filePath;
      while (cursor !== rootPath) {
        let isLink = inspected.get(cursor);
        if (isLink === undefined) {
          const info = await Deno.lstat(cursor);
          isLink = info.isSymlink;
          inspected.set(cursor, isLink);
        }
        if (isLink && !isWithin(rootReal, await Deno.realPath(cursor))) {
          external.add(file);
          break;
        }
        const parent = dirname(cursor);
        if (parent === cursor) return null;
        cursor = parent;
      }
    }
    return external;
  } catch {
    return null;
  }
}

/** The changed source files per `git`, RELATIVE TO `dir` — tracked changes vs HEAD (staged ∪ unstaged) ∪ new
 *  untracked files. `null` (never an empty set) when git cannot answer: "not a repo" and "nothing changed"
 *  are different facts, and only one of them may grade nothing. */
export async function gitChangedFiles(
  dir: string,
): Promise<Set<string> | null> {
  const run = async (args: string[]): Promise<string[] | null> => {
    try {
      const out = await new Deno.Command("git", {
        args,
        cwd: dir,
        stdout: "piped",
        stderr: "null",
      }).output();
      return out.code === 0
        ? new TextDecoder().decode(out.stdout).split("\n").filter((l) =>
          l.length > 0
        )
        : null;
    } catch {
      return null; // git absent on PATH / dir unreadable
    }
  };
  // `--relative` makes `git diff` speak cwd-relative paths like `ls-files` already does; without it the two
  // halves of the change set arrive on DIFFERENT bases and one of them silently matches no tree key.
  const tracked = await run(["diff", "--name-only", "--relative", "HEAD"]);
  const untracked = await run(["ls-files", "--others", "--exclude-standard"]);
  if (tracked === null || untracked === null) return null;
  return new Set([...tracked, ...untracked].map(norm));
}

/** Resolve the corpus the judge should grade for `mode`. `deps` inject the tree reader + changed-file lister for tests. */
export async function selectJudgeCorpus(
  dir: string,
  mode: CorpusMode,
  deps: {
    readTree?: (d: string) => Promise<Record<string, string>>;
    changedFiles?: (d: string) => Promise<Set<string> | null>;
    externalLinkedFiles?: (
      d: string,
      files: readonly string[],
    ) => Promise<Set<string> | null>;
  } = {},
): Promise<CorpusResult> {
  const tree = await (deps.readTree ?? readSourceTree)(dir);
  // Grades production code, not tests — `.test.ts` follows different conventions (would flag noise) and
  // would bloat the corpus. Excluded from both modes; `readSourceTree` still includes them for meta id refs.
  let paths = Object.keys(tree).filter((p) => !p.endsWith(".test.ts")).sort(); // deterministic order → byte-stable corpus
  let degraded = false;
  if (mode === "update") {
    const changed = await (deps.changedFiles ?? gitChangedFiles)(dir);
    // git unanswerable ⇒ grade everything. It costs a full-tree judge call, which is the honest price of an
    // undeterminable diff; the alternative reports a green run over a corpus of zero files.
    if (changed === null) degraded = true;
    else {
      const linked = deps.externalLinkedFiles
        ? await deps.externalLinkedFiles(dir, paths)
        : deps.readTree
        ? new Set<string>() // injected source maps have no filesystem link metadata
        : await externalLinkedSources(dir, paths);
      if (linked === null) degraded = true;
      else {
        const selected = new Set(changed);
        for (const path of linked) selected.add(relativeToDir(path, dir));
        paths = paths.filter((p) => selected.has(relativeToDir(p, dir)));
      }
    }
  }
  const code = paths.map((p) => `// === file: ${norm(p)} ===\n${tree[p]}`).join(
    "\n\n",
  );
  return { code, files: paths, ...(degraded ? { degradedToFull: true } : {}) };
}
