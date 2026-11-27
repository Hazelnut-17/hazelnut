import { scanRelativeImports } from "./permissions.ts";

/** The app entry the launcher runs and walks: `main.ts` is the served boot (05-runtime.md §createApp).
 *  Everything the served process can reach — and therefore every env key it can read — is reachable from
 *  here, so the entry is the only root the scan needs. */
export const LAUNCH_ENTRY = "main.ts";

/** Resolves a relative specifier against the importing file, in the app-root-relative forward-slash form
 *  the walk keys on. Returns null when the path escapes the app root — the read grant is `--allow-read=.`,
 *  so a module outside the tree is not readable by the served process either; the scan's reach and the
 *  read grant's reach are deliberately the same boundary. */
function resolveRelative(fromFile: string, spec: string): string | null {
  const at = fromFile.lastIndexOf("/");
  const base = at === -1 ? [] : fromFile.slice(0, at).split("/");
  const out = [...base];
  for (const part of spec.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null; // escaped the app root
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}

/** Walks the served entry's module graph and returns every reachable APP file, keyed by its root-relative
 *  path. This is what the env scan runs over.
 *
 *  A fixed list of entry filenames was the earlier shape and it was wrong in the one way that matters: a
 *  `Deno.env.get` in a `*.module.ts` is as real to the running process as one in `main.ts`, but the list
 *  could not see it, so the derived set looked complete (exit 0, no refusal) and the app died at boot with
 *  `NotCapable`. The graph cannot have that blind spot — its boundary is the app tree itself. */
export async function readAppGraph(
  root: string,
  entry: string = LAUNCH_ENTRY,
  readFile: (path: string) => Promise<string> = (p) => Deno.readTextFile(p),
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const queue = [entry];
  const seen = new Set<string>(queue);
  while (queue.length > 0) {
    const path = queue.shift()!;
    let source: string;
    try {
      source = await readFile(`${root}/${path}`);
    } catch {
      // An unreadable import is the app's own build error — `deno run` will report it far better than the
      // launcher could. Skipping keeps the launcher's job to permissions.
      continue;
    }
    out[path] = source;
    for (const spec of scanRelativeImports(source)) {
      const next = resolveRelative(path, spec);
      if (next !== null && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return out;
}
