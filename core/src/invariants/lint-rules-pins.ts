/**
 * Mixed published-pin coherence — ships with the floor plugin so `deno lint` (ci step 1) catches a
 * leftover task line at the previous version even when that task still runs the old CLI (which
 * has no mixed-literal ship-block). Not FLOOR_LOCKED: this is pin hygiene, not SQL/actor safety.
 *
 * Anchored on `app.ts` (every scaffold has one) so a `deno lint` pass reports once. Reads the nearest
 * `deno.json`/`deno.jsonc` at or above the anchor (a `src/` layout keeps the anchor working), strips
 * its comments so a `// bumped from …` breadcrumb is not a second pin, and walks the sibling tree
 * through the shared `walkAppSourcesSync` — the same file set `verify`'s async walk gathers, symlinks
 * and all. No CLI import — the floor plugin must stay core-light.
 */
import {
  readPinCoherenceExtras,
  walkAppSourcesSync,
} from "../core/app-walk.ts";
import {
  collectFrameworkVersionLiterals,
  describeMixedFrameworkVersions,
  stripJsoncComments,
} from "../core/framework-literals.ts";
import { lintMessage } from "../runtime/channels.ts";

/** The nearest `deno.json` / `deno.jsonc` at or above `startDir`, with its raw text — so an app whose
 *  entry sits under `src/` still finds the root config the coherence check reads. */
function readDenoConfigUpward(
  startDir: string,
): { dir: string; text: string } | null {
  let dir = startDir;
  for (let hops = 0; hops < 40; hops++) {
    for (const name of ["deno.json", "deno.jsonc"]) {
      try {
        return { dir, text: Deno.readTextFileSync(`${dir}/${name}`) };
      } catch { /* not at this level */ }
    }
    const parent = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
    if (parent === "" || parent === dir) break;
    dir = parent;
  }
  return null;
}

function isAppTs(filename: string): boolean {
  const norm = filename.replaceAll("\\", "/");
  return /(^|\/)app\.ts$/.test(norm);
}

export const pinCoherenceRules: Record<string, Deno.lint.Rule> = {
  "version-literals": {
    create(context) {
      if (!isAppTs(context.filename)) return {};
      const fname = context.filename.replaceAll("\\", "/");
      const anchorDir = fname.includes("/")
        ? fname.slice(0, fname.lastIndexOf("/"))
        : ".";
      const cfg = readDenoConfigUpward(anchorDir);
      if (cfg === null) return {};
      const rel: Record<string, string> = {
        "deno.json": stripJsoncComments(cfg.text),
        ...readPinCoherenceExtras(cfg.dir),
      };
      const prefix = `${cfg.dir}/`;
      for (const [path, text] of Object.entries(walkAppSourcesSync(cfg.dir))) {
        rel[path.startsWith(prefix) ? path.slice(prefix.length) : path] = text;
      }
      const message = describeMixedFrameworkVersions(
        collectFrameworkVersionLiterals(rel),
      );
      if (message === null) return {};
      return {
        Program(node) {
          context.report({
            node,
            message: lintMessage("version/projection-fresh", message),
          });
        },
      };
    },
  },
};
