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
  registryLintSpecifiers,
  resolvePluginSpecifier,
} from "../cli/doctor.ts";
import {
  deriveBlocks,
  fingerprint,
  type Violation,
} from "../core/verifier-contract.ts";

/** The floor plugin's own module path, as the scaffold writes it. */
const FLOOR_MODULE = "invariants/lint-floor.ts";

/** The package export a REGISTRY pin spells the floor as. A published artifact maps `./lint` and no
 *  `./invariants/…` path, so this is the only floor spelling a `jsr:`/`npm:`/URL consumer can write. */
const FLOOR_EXPORT = "/lint";

/** The package a registry `./lint` specifier names, version stripped: `jsr:@hazelnut/core@0.4.0/lint`
 *  → `jsr:@hazelnut/core`. Version skew between the runtime pin and the lint pin is a DIFFERENT finding
 *  with its own message (`project.ts`); an older floor still runs, so it clears here. */
function registryLintPackage(spec: string): string | null {
  if (!spec.endsWith(FLOOR_EXPORT)) return null;
  return spec.slice(0, -FLOOR_EXPORT.length).replace(/@\d[^/@]*$/, "");
}

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
  // The `./lint` export of the app's OWN registry pin — the identity `doctor` compares against, not a
  // bare suffix, so a foreign package's `./lint` is still the floor going dark.
  const carriedRegistry = new Set(
    registryLintSpecifiers(cfg.imports ?? {})
      .map(registryLintPackage)
      .filter((pkg): pkg is string => pkg !== null),
  );
  const wired = named.some((p) => {
    const path = resolvePluginSpecifier(p, absDir);
    if (path === null) {
      // A registry specifier is not proof the floor is wired — treating any unresolvable pin as
      // "wired" is how `lint.plugins: ["jsr:@other/lint"]` went dark under a clean verdict. Only a
      // specifier that NAMES the floor counts: by module path, or as the app's own pin's `./lint`.
      const pkg = registryLintPackage(p);
      return p.endsWith(FLOOR_MODULE) || p.endsWith("lint-plugin.ts") ||
        (pkg !== null && carriedRegistry.has(pkg));
    }
    return path.endsWith(FLOOR_MODULE) || carried.includes(path) ||
      path.endsWith("lint-plugin.ts");
  });
  return wired ? null : { kind: "not-the-floor", named: named.slice().sort() };
}

/** The refusal text for one narrowing — names the edit, the consequence, and the one action that clears it. */
function refusal(n: Narrowing): string {
  const floor = `the ${FLOOR_IDS.length} floor rules (${FLOOR_IDS.join(", ")})`;
  // Name the spelling that RESOLVES for the pin the reader has. A registry pin carries the floor as its
  // `./lint` export and no `./invariants/…` path — advising the file there is advice that 404s.
  const fix =
    `restore it in this app's deno.json — a registry pin wires the package export, \`"lint": { "plugins": ["<your jsr:/npm:/URL pin>/lint"] }\`; a source or vendored pin wires the file, \`"lint": { "plugins": ["<your path pin>/${FLOOR_MODULE}"] }\``;
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
