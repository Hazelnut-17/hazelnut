/**
 * Mixed published-pin coherence — ships with the floor plugin so `deno lint` (ci step 1) catches a
 * leftover task line at the previous version even when that task still runs the old CLI (which
 * has no mixed-literal ship-block). Not FLOOR_LOCKED: this is pin hygiene, not SQL/actor safety.
 *
 * Anchored on `app.ts` (every scaffold has one) so a `deno lint` pass reports once. Reads the nearest
 * `deno.json`/`deno.jsonc` at or above the anchor (a `src/` layout keeps the anchor working), strips
 * its comments so a `// bumped from …` breadcrumb is not a second pin, and walks the sibling tree
 * through `inspectAppSourcesSync` — the same file set `verify`'s async walk gathers, symlinks
 * and all. An unreadable seat is a diagnostic, not a file the scan never had. No CLI import — the
 * floor plugin must stay core-light.
 */
import {
  inspectAppSourcesSync,
  readPinCoherenceExtraReport,
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

/** The version-literals body for one anchor directory. Null when the scan finished on at most one version. */
export function versionLiteralsAt(anchorDir: string): string | null {
  const cfg = readDenoConfigUpward(anchorDir);
  if (cfg === null) return null;
  const extras = readPinCoherenceExtraReport(cfg.dir);
  const walked = inspectAppSourcesSync(cfg.dir);
  const rel: Record<string, string> = {
    "deno.json": stripJsoncComments(cfg.text),
    ...extras.text,
  };
  const prefix = `${cfg.dir}/`;
  for (const [path, text] of Object.entries(walked.files)) {
    rel[path.startsWith(prefix) ? path.slice(prefix.length) : path] = text;
  }
  const mixed = describeMixedFrameworkVersions(
    collectFrameworkVersionLiterals(rel),
  );
  const unread = [...extras.unreadable, ...walked.unreadable];
  const skipped = unread.length === 0
    ? null
    : `${
      unread.join(", ")
    } could not be read; a framework pin there was not checked`;
  if (mixed === null) return skipped;
  return skipped === null ? mixed : `${mixed}; ${skipped}`;
}

export const pinCoherenceRules: Record<string, Deno.lint.Rule> = {
  "version-literals": {
    create(context) {
      if (!isAppTs(context.filename)) return {};
      const fname = context.filename.replaceAll("\\", "/");
      const anchorDir = fname.includes("/")
        ? fname.slice(0, fname.lastIndexOf("/"))
        : ".";
      const message = versionLiteralsAt(anchorDir);
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
