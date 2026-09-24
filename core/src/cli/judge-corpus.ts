// The judge corpus selector (09-verifier.md §judge): resolves the source the live judge grades per
// `--judge-mode` (full = whole tree, update = git-changed files only). Git/tree readers are injectable
// for tests. Files concatenate in sorted order under `// === file: <path> ===` headers for attribution.
import type { CorpusMode } from "../core/verifier-contract.ts";
import { readSourceTree } from "./hazelnut-io.ts";

export interface CorpusResult {
  readonly code: string; // the concatenated source the judge grades ("" ⇒ nothing to grade)
  readonly files: readonly string[]; // the file paths included (sorted)
  /** `update` only: git could not answer (absent / not a repo / no HEAD), so the corpus fell back to the
   *  WHOLE tree. An unanswerable git must never read as "nothing changed" and grade an empty corpus green. */
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
      paths = paths.filter((p) => changed.has(relativeToDir(p, dir)));
    }
  }
  const code = paths.map((p) => `// === file: ${norm(p)} ===\n${tree[p]}`).join(
    "\n\n",
  );
  return { code, files: paths, ...(degraded ? { degradedToFull: true } : {}) };
}
