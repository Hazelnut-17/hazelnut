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
import { collectAppSources } from "../cli/hazelnut-io.ts";
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
  | { readonly kind: "muted"; readonly rules: readonly string[] }
  | { readonly kind: "silenced"; readonly where: readonly string[] };

/** The floor rule ids as `deno lint` spells them in an ignore directive. */
const FLOOR_DIRECTIVE_IDS: readonly string[] = Object.keys(
  FLOOR_RULE_CANONICAL_IDS,
).map((k) => `hazelnut/${k}`);

/**
 * The ignore directives in one source that switch a floor rule off.
 *
 * A directive naming only OTHER rules is not a narrowing — an app writing `// deno-lint-ignore
 * no-explicit-any` on a line has silenced nothing this shield speaks for, and refusing it would make the
 * floor a reason to stop using `deno lint` at all. What counts is a BLANKET directive, which takes every
 * rule including these nine, or one that names a floor id outright.
 */
export function floorSilencers(source: string, path = ""): string[] {
  // A TEST file is not served. The floor guards what reaches a request — SQL injection in a handler,
  // a forged actor, a row-policy leak — and a test seeding fixtures with raw SQL is none of those. So a
  // directive that NAMES a floor rule is a scoped, visible decision there and fires only outside tests;
  // a BLANKET one still fires everywhere, because it takes rules its author never looked at.
  // Measured on this framework's own two reference apps: ~30 test files carry a named
  // `hazelnut/raw-sql-only-in-queries`, and refusing those would teach a consumer to delete the plugin.
  const isTest = /(^|\/)[^/]*\.test\.ts$/.test(path);
  const hits: string[] = [];
  for (const [i, line] of source.split("\n").entries()) {
    const m = /\/\/\s*(deno-lint-ignore(?:-file)?)\b([^\n]*)/.exec(line);
    if (m === null) continue;
    const named = (m[2] ?? "").trim().replace(/^--.*$/, "").trim();
    const rules = named === ""
      ? []
      : named.split(/[\s,]+/).filter((r) => /^[a-z@][\w/-]*$/i.test(r));
    const blanket = rules.length === 0;
    const floor = rules.filter((r) => FLOOR_DIRECTIVE_IDS.includes(r));
    if (blanket) hits.push(`${m[1]} (blanket) at line ${i + 1}`);
    else if (floor.length > 0 && !isTest) {
      hits.push(`${m[1]} ${floor.sort().join(", ")} at line ${i + 1}`);
    }
  }
  return hits;
}

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
  // ONE comparison frame: `pinnedPluginSpecifiers` answers in the pin's own spelling (a vendored pin stays
  // `./.hazelnut/…`) while `resolvePluginSpecifier` joins against the app dir. Comparing the two raw made
  // the identity check miss on every vendored app, which is what the old path-tail escape was covering up.
  const carried = pinnedPluginSpecifiers(cfg.imports ?? {}, exists)
    .map((c) => resolvePluginSpecifier(c, absDir) ?? c);
  // The `./lint` export of the app's OWN registry pin — the identity `doctor` compares against, not a
  // bare suffix, so a foreign package's `./lint` is still the floor going dark.
  const carriedRegistry = new Set(
    registryLintSpecifiers(cfg.imports ?? {})
      .map(registryLintPackage)
      .filter((pkg): pkg is string => pkg !== null),
  );
  // IDENTITY, never a path tail. A bare `endsWith("invariants/lint-floor.ts")` accepted any local file
  // whose path happened to end that way — a decoy exporting zero rules satisfied the SHIP-BLOCKING rung
  // while `doctor`, which compares against the pin, still reported the rung dark. The two doors now ask
  // the same question: does a named plugin resolve to one the APP'S OWN pin carries?
  // A BARE specifier resolves through the app's OWN import map (`lint.plugins:
  // ["hazelnut/invariants/lint-floor.ts"]` under a `"hazelnut/"` prefix key). Expanding it here is what
  // makes the identity check total: the old code accepted that shape on a path tail alone, which is the
  // same door a decoy walked through.
  const viaImportMap = (spec: string): string => {
    const imports = cfg.imports ?? {};
    if (imports[spec] !== undefined) return imports[spec]!;
    for (const [k, v] of Object.entries(imports)) {
      if (k.endsWith("/") && spec.startsWith(k)) {
        return `${v}${spec.slice(k.length)}`;
      }
    }
    return spec;
  };
  const wired = named.some((raw) => {
    const p = viaImportMap(raw);
    const path = resolvePluginSpecifier(p, absDir);
    if (path === null) {
      const pkg = registryLintPackage(p);
      return pkg !== null && carriedRegistry.has(pkg);
    }
    return carried.includes(path);
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
    case "silenced":
      return `the app's own sources switch the lint rung off with an ignore directive — ${
        n.where.join("; ")
      }. A blanket \`deno-lint-ignore-file\` takes ${floor} with it, so this verdict does not cover those files; a directive naming only rules outside the floor is untouched. Name the rules you mean, or delete the directive`;
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
  sources: (dir: string) => Promise<Record<string, string>> = collectAppSources,
): Promise<Violation[]> {
  let text: string | null = null;
  for (const name of ["deno.json", "deno.jsonc"]) {
    try {
      text = await read(`${absDir.replace(/\/+$/, "")}/${name}`);
      break;
    } catch { /* try the next spelling; both absent ⇒ no-config */ }
  }
  let n = floorNarrowing(text, absDir, exists);
  // The config half says the rung is WIRED. The source half asks whether it still RUNS: a blanket
  // `deno-lint-ignore-file` silences every rule in that file, floor included, and reading `deno.json`
  // alone cannot see it. Only asked when the config is clean — an app with no plugin at all is already
  // refused for a bigger reason, and naming both would bury it.
  if (n === null) {
    const base = absDir.replace(/\/+$/, "");
    const where: string[] = [];
    // THE walk, not a second one. Two copies of this had already diverged once — only one resolved
    // symlinks, only one carried the cycle guard — so `upgrade --plan` and `--apply-plan` could see
    // different populations of the same tree. A shield that spelled its own skip list would be the third.
    // A walk that cannot run answers nothing, and nothing must not read as clean here — but it also must
    // not throw: `verify` owes a VERDICT, and an exception is the one output that is neither. An
    // unreadable tree is reported as its own narrowing rather than swallowed.
    let walked: Record<string, string> | null = null;
    try {
      walked = await sources(base);
    } catch { /* named below, never silently skipped */ }
    if (walked === null) {
      n = {
        kind: "silenced",
        where: ["the app's sources could not be read, so nothing checked them"],
      };
    } else {
      for (const [rel, src] of Object.entries(walked).sort()) {
        for (const hit of floorSilencers(src, rel)) {
          where.push(`${rel}: ${hit}`);
        }
      }
    }
    if (n === null && where.length > 0) n = { kind: "silenced", where };
  }
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
