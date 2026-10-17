/** Test fixtures lose their lint exemption when executable app imports can reach them. */
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LINTED_EXTENSIONS } from "../cli/hazelnut-io.ts";
import { stripJsoncComments } from "../core/framework-literals.ts";
import { SourceAst, sourceNode } from "./source-ast.ts";

export interface SourceReachConfig {
  readonly root?: string;
  readonly base?: string;
  readonly imports?: Readonly<Record<string, string>>;
  readonly scopes?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly unknown?: boolean;
}
const isTestFile = (file: string) =>
  LINTED_EXTENSIONS.some((ext) => file.endsWith(`.test${ext}`));
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): value is Record<string, string> =>
  object(value) &&
  Object.values(value).every((entry) => typeof entry === "string");

/** Read only local configuration as data; no app import, network fetch or code evaluation. */
export async function sourceReachConfig(
  dir: string,
): Promise<SourceReachConfig> {
  const root = resolve(dir), directory = pathToFileURL(`${root}/`).href;
  let raw: string | undefined;
  for (const name of ["deno.json", "deno.jsonc"]) {
    try {
      raw = await Deno.readTextFile(resolve(root, name));
      break;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        return { root, unknown: true };
      }
    }
  }
  if (raw === undefined) return { root, base: directory };
  try {
    let config: unknown = JSON.parse(stripJsoncComments(raw)), base = directory;
    if (!object(config)) return { root, unknown: true };
    if (config.importMap !== undefined) {
      if (typeof config.importMap !== "string") return { root, unknown: true };
      const url = new URL(config.importMap, directory);
      if (url.protocol !== "file:") return { root, unknown: true };
      base = url.href;
      config = JSON.parse(stripJsoncComments(await Deno.readTextFile(url)));
    }
    if (
      !object(config) ||
      (config.imports !== undefined && !strings(config.imports))
    ) return { root, unknown: true };
    if (
      config.scopes !== undefined &&
      (!object(config.scopes) || !Object.values(config.scopes).every(strings))
    ) return { root, unknown: true };
    return {
      root,
      base,
      imports: config.imports as Record<string, string> | undefined,
      scopes: config.scopes as
        | Record<string, Record<string, string>>
        | undefined,
    };
  } catch {
    return { root, unknown: true };
  }
}

/** Finite import reach. Unknown reachable dynamic edges withhold exemptions; external packages do not. */
export function appSourceFiles(
  sources: Readonly<Record<string, string>>,
  config: SourceReachConfig = {},
): ReadonlySet<string> {
  const files = Object.keys(sources),
    root = resolve(config.root ?? "."),
    base = config.base ?? pathToFileURL(`${root}/`).href;
  const reached = new Set(files.filter((file) => !isTestFile(file))),
    pending = [...reached];
  if (config.unknown) return new Set(files);
  const urlOf = (file: string) =>
    pathToFileURL(isAbsolute(file) ? file : resolve(root, file)).href;
  const urls = new Map(files.map((file) => [urlOf(file), file]));
  const normalize = (specifier: string, from: string): string =>
    /^(?:\.|\/|[a-z][\w+.-]*:)/i.test(specifier)
      ? new URL(specifier, from).href
      : specifier;
  const mapSpecifier = (specifier: string, referrer: string): string | null => {
    const normalized = normalize(specifier, referrer);
    const maps = Object.entries(config.scopes ?? {}).filter(([scope]) =>
      referrer.startsWith(new URL(scope, base).href)
    ).sort(([a], [b]) => b.length - a.length).map(([, map]) => map);
    maps.push(config.imports ?? {});
    for (const map of maps) {
      const match = Object.entries(map).filter(([key]) => {
        const normalizedKey = normalize(key, base);
        return normalized === normalizedKey ||
          normalizedKey.endsWith("/") && normalized.startsWith(normalizedKey);
      }).sort(([a], [b]) => b.length - a.length)[0];
      if (match) {
        const [key, target] = match, normalizedKey = normalize(key, base);
        if (normalized !== normalizedKey && !target.endsWith("/")) return null;
        return normalize(target + normalized.slice(normalizedKey.length), base);
      }
    }
    if (normalized.startsWith("#")) return null;
    return normalized;
  };
  for (let index = 0; index < pending.length; index++) {
    const file = pending[index]!, text = sources[file]!;
    let ast: SourceAst;
    try {
      ast = new SourceAst(text, file);
    } catch {
      return new Set(files);
    }
    const specs: Array<string | null> = [];
    for (const node of ast.nodes) {
      if (node.type === "ImportExpression") specs.push(ast.string(node.source));
      else if (node.type === "ImportDeclaration") {
        if (node.importKind === "type") continue;
        if (
          Array.isArray(node.specifiers) && node.specifiers.length > 0 &&
          node.specifiers.every((spec: unknown) =>
            sourceNode(spec) && spec.importKind === "type"
          )
        ) continue;
        specs.push(ast.string(node.source));
      } else if (
        (node.type === "ExportNamedDeclaration" ||
          node.type === "ExportAllDeclaration") &&
        node.source && node.exportKind !== "type"
      ) specs.push(ast.string(node.source));
    }
    for (const specifier of specs) {
      if (specifier === null) return new Set(files);
      let target: string | null;
      try {
        target = mapSpecifier(specifier, urlOf(file));
      } catch {
        return new Set(files);
      }
      if (target === null) return new Set(files);
      if (!target.startsWith("file:")) continue;
      const url = new URL(target);
      url.search = "";
      url.hash = "";
      // A pinned framework/vendor dependency outside the app corpus is not an app test fixture.
      const appBase = pathToFileURL(`${root}/`).href;
      if (
        !url.href.startsWith(appBase) ||
        url.href.startsWith(`${appBase}.hazelnut/`) ||
        url.href.startsWith(`${appBase}node_modules/`)
      ) continue;
      if (/\.json$/i.test(fileURLToPath(url))) continue; // JSON data has no executable fixture-import graph
      const next = urls.get(url.href);
      if (!next) return new Set(files);
      if (!reached.has(next)) {
        reached.add(next);
        pending.push(next);
      }
    }
  }
  return reached;
}
