/**
 * The SAFETY FLOOR's shield: the structural rung refuses when the app has switched the floor rung off.
 *
 * The floor's nine rules run inside `deno lint`, under the APP's own config — so the app owns the switch,
 * and deleting one line from its `deno.json` silences SQL injection, actor forgery and the row-policy read
 * leak while every other gate stays green. The rung's own honesty list says `deno lint` covers the source
 * half; that sentence has to be TRUE, and this is what makes it so.
 *
 * Core, not the capability module: the module's wider shield (all 33 rules, source directives, gitignore)
 * stays there — this is the floor's half, and it ships with the floor.
 */
import { FLOOR_RULE_CANONICAL_IDS } from "./lint-floor.ts";
import {
  parseDenoConfig,
  pinnedPluginSpecifiers,
  resolvePluginSpecifier,
} from "../cli/doctor.ts";
import {
  deriveBlocks,
  fingerprint,
  type Violation,
} from "../core/verifier-contract.ts";

/** The floor plugin's own module path, as the scaffold writes it. */
const FLOOR_MODULE = "invariants/lint-floor.ts";

/** The floor rule ids this shield speaks for — named in the refusal so the reader knows what went dark. */
export const FLOOR_IDS: readonly string[] = Object.values(
  FLOOR_RULE_CANONICAL_IDS,
).sort();

/** How an app's `deno.json` can leave the floor rung not running. Each is a DISTINCT edit, so each names
 *  itself: "no plugins at all" and "plugins, none of them the floor" are different mistakes. */
type Narrowing =
  | { readonly kind: "no-config" }
  | { readonly kind: "no-plugins" }
  | { readonly kind: "not-the-floor"; readonly named: readonly string[] }
  | { readonly kind: "muted"; readonly rules: readonly string[] };

/** Read the app's deno config and say which narrowing (if any) it carries. Pure over its inputs. */
export function floorNarrowing(
  configText: string | null,
  absDir: string,
  exists: (path: string) => boolean,
): Narrowing | null {
  if (configText === null) return { kind: "no-config" };
  const cfg = parseDenoConfig(configText) as {
    lint?: { plugins?: unknown; rules?: { exclude?: unknown } };
    imports?: Record<string, string>;
  } | null;
  if (cfg === null) return { kind: "no-config" };

  // A project config may never mute a floor id — the same position `resolveProfileConfig` holds for the
  // override surface, restated over the one knob `deno lint` itself offers.
  const excluded = cfg.lint?.rules?.exclude;
  if (Array.isArray(excluded)) {
    const muted = excluded
      .filter((r): r is string => typeof r === "string")
      .filter((r) =>
        Object.keys(FLOOR_RULE_CANONICAL_IDS).some((k) => r === `hazelnut/${k}`)
      );
    if (muted.length > 0) return { kind: "muted", rules: muted.sort() };
  }

  const plugins = cfg.lint?.plugins;
  if (!Array.isArray(plugins) || plugins.length === 0) {
    return { kind: "no-plugins" };
  }
  const named = plugins.filter((p): p is string => typeof p === "string");
  // The floor is wired when SOME named plugin resolves to a hazelnut plugin the app's own pin carries. The
  // full plugin composes the floor, so either one satisfies this — a full-build app is not narrowed.
  const carried = pinnedPluginSpecifiers(cfg.imports ?? {}, exists);
  const wired = named.some((p) => {
    const path = resolvePluginSpecifier(p, absDir);
    if (path === null) return true; // a registry specifier — unresolvable here, and not this check's business
    return path.endsWith(FLOOR_MODULE) || carried.includes(path) ||
      path.endsWith("lint-plugin.ts");
  });
  return wired ? null : { kind: "not-the-floor", named: named.slice().sort() };
}

/** The refusal text for one narrowing — names the edit, the consequence, and the one action that clears it. */
function refusal(n: Narrowing): string {
  const floor = `the ${FLOOR_IDS.length} floor rules (${FLOOR_IDS.join(", ")})`;
  const fix =
    `restore it: \`"lint": { "plugins": ["<your hazelnut pin>/${FLOOR_MODULE}"] }\` in this app's deno.json`;
  switch (n.kind) {
    case "no-config":
      return `no readable deno.json beside the app, so ${floor} cannot be wired and this verdict does not cover your source — ${fix}`;
    case "no-plugins":
      return `the app's deno.json names no lint plugin, so ${floor} run nowhere in this app and this verdict does not cover your source — ${fix}`;
    case "not-the-floor":
      return `the app's deno.json wires lint plugin(s) ${
        n.named.join(", ")
      } — none of them the framework's, so ${floor} run nowhere and this verdict does not cover your source — ${fix}`;
    case "muted":
      return `the app's deno.json mutes ${
        n.rules.join(", ")
      } — a floor rule is never mutable by project config: a muted rule reads as absent, and absent reads as clean. Delete the exclusion`;
  }
}

/**
 * The shield's violations for an app directory. Empty when the rung is wired.
 *
 * `blocks: "ship"`: a verdict that says "clean" while the source rung ran nowhere is the one output worse
 * than no verdict, and warning about it puts the decision on a reader who has already been told clean.
 */
export async function floorRungViolations(
  absDir: string,
  read: (p: string) => Promise<string> = Deno.readTextFile,
  exists: (p: string) => boolean = (p) => {
    try {
      Deno.lstatSync(p);
      return true;
    } catch {
      return false;
    }
  },
): Promise<Violation[]> {
  let text: string | null = null;
  for (const name of ["deno.json", "deno.jsonc"]) {
    try {
      text = await read(`${absDir.replace(/\/+$/, "")}/${name}`);
      break;
    } catch { /* try the next spelling; both absent ⇒ no-config */ }
  }
  const n = floorNarrowing(text, absDir, exists);
  if (n === null) return [];
  const at = { file: "deno.json", startLine: 1 };
  const responsible = { kind: "unknown" as const, why: n.kind };
  const id = "lint/floor-rung-narrowed";
  return [{
    id,
    rung: "static" as const,
    blocks: deriveBlocks("static", { concern: "lint" }),
    phase: "pre-ship" as const,
    at,
    responsible,
    message: refusal(n),
    fingerprint: fingerprint({ id, at, responsible }),
    source: "verify" as const,
  }];
}
