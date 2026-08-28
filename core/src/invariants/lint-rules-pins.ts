/**
 * Mixed published-pin coherence — ships with the floor plugin so `deno lint` (ci step 1) catches a
 * leftover task line at the previous version even when that task still runs the old CLI (which
 * has no mixed-literal ship-block). Not FLOOR_LOCKED: this is pin hygiene, not SQL/actor safety.
 *
 * Anchored on `app.ts` (every scaffold has one) so a `deno lint` pass reports once. Walks the sibling
 * tree; a pin hiding under `src/` is in scope. No CLI import — the floor plugin must stay core-light.
 */
import { APP_SOURCE_EXTS, APP_SOURCE_SKIP } from "../core/app-walk.ts";
import {
  collectFrameworkVersionLiterals,
  describeMixedFrameworkVersions,
} from "../core/framework-literals.ts";
import { lintMessage } from "../runtime/channels.ts";

function walkTs(dir: string, out: Record<string, string>): void {
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(dir)];
  } catch {
    return;
  }
  for (const e of entries) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory) {
      if (APP_SOURCE_SKIP.has(e.name)) continue;
      walkTs(p, out);
      continue;
    }
    if (e.isFile && APP_SOURCE_EXTS.some((x) => e.name.endsWith(x))) {
      try {
        out[p] = Deno.readTextFileSync(p);
      } catch { /* unreadable — skip, same as the fold's per-entry recovery */ }
    }
  }
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
      const slash = fname.lastIndexOf("/");
      const dir = slash === -1 ? "." : fname.slice(0, slash);
      let denoJson: string;
      try {
        denoJson = Deno.readTextFileSync(`${dir}/deno.json`);
      } catch {
        return {};
      }
      const sources: Record<string, string> = {};
      walkTs(dir, sources);
      const rel: Record<string, string> = { "deno.json": denoJson };
      const prefix = `${dir}/`;
      for (const [path, text] of Object.entries(sources)) {
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
