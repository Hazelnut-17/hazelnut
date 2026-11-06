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
import { findDenoConfigUpward, loadDoctorSources } from "../core/app-walk.ts";
import {
  collectFrameworkVersionLiterals,
  describeMixedFrameworkVersions,
  stripJsoncComments,
} from "../core/framework-literals.ts";
import { lintMessage } from "../runtime/channels.ts";

function isAppTs(filename: string): boolean {
  const norm = filename.replaceAll("\\", "/");
  return /(^|\/)app\.ts$/.test(norm);
}

/** The version-literals body for one anchor directory. Null when the scan finished on at most one version. */
export function versionLiteralsAt(anchorDir: string): string | null {
  const cfg = findDenoConfigUpward(anchorDir);
  if (cfg === null) return null;
  if (cfg.unreadable) {
    return `${cfg.unreadable} could not be read; a framework pin there was not checked`;
  }
  const walked = loadDoctorSources(cfg.dir, cfg.text);
  const rel: Record<string, string> = {
    "deno.json": stripJsoncComments(cfg.text!),
  };
  const prefix = `${cfg.dir}/`;
  for (const [path, text] of Object.entries(walked.sources)) {
    rel[path.startsWith(prefix) ? path.slice(prefix.length) : path] = text;
  }
  const mixed = describeMixedFrameworkVersions(
    collectFrameworkVersionLiterals(rel),
  );
  const unread = walked.unreadable;
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
