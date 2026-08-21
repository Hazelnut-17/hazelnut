import { rangeOf } from "./lint-helpers-node.ts";
import { withoutCommentsOrStrings } from "./source-view.ts";
import { OP_CODE_SLOTS } from "../core/op-slots.ts";

/** Every function-valued code slot on an op-object literal (`handler`/`before`/`after`/`replace`/`around`).
 *  A hook is a door — the lint companion of `opCodeFns`. */
export function opSlotFnsOf(
  obj: Deno.lint.Node,
): ReadonlyArray<{ readonly slot: string; readonly fn: Deno.lint.Node }> {
  if (obj.type !== "ObjectExpression") return [];
  const out: { slot: string; fn: Deno.lint.Node }[] = [];
  for (const p of obj.properties) {
    if (p.type !== "Property" || p.key.type !== "Identifier") continue;
    if (!(OP_CODE_SLOTS as readonly string[]).includes(p.key.name)) continue;
    const v = p.value;
    if (
      v.type === "ArrowFunctionExpression" || v.type === "FunctionExpression"
    ) {
      out.push({ slot: p.key.name, fn: v });
    }
  }
  return out;
}

/** The function value of the `run:` property of a `defineView({...})` call, or null when absent / not a function.
 *  A `run` body is verified like a `tx:"read"` op handler (02-dsl.md §defineView line 86) — writes forbidden. */
export function viewRunFnOf(call: Deno.lint.Node): Deno.lint.Node | null {
  if (call.type !== "CallExpression") return null;
  if (call.callee.type !== "Identifier" || call.callee.name !== "defineView") {
    return null;
  }
  const obj = call.arguments[0];
  if (obj?.type !== "ObjectExpression") return null;
  const prop = obj.properties.find((p) =>
    p.type === "Property" && p.key.type === "Identifier" && p.key.name === "run"
  );
  if (prop?.type !== "Property") return null;
  const v = prop.value;
  return (v.type === "ArrowFunctionExpression" ||
      v.type === "FunctionExpression")
    ? v
    : null;
}

/** The bare-identifier callee names a function body CALLS — the same-module helper candidates to resolve one hop.
 *  Scans the source span of `fn` for `name(` call shapes; a member call (`x.y(`) is not a same-module helper. */
export function calledIdentifiersIn(
  text: string,
  fn: Deno.lint.Node,
): Set<string> {
  const [s, e] = rangeOf(fn);
  const body = withoutCommentsOrStrings(text.slice(s, e));
  const out = new Set<string>();
  // `foo(` not preceded by `.` or a word char; a member call is not a same-module helper. Non-consuming
  // lookbehind so back-to-back calls (`ok(fetchAllDocs(`) both match.
  for (const m of body.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    out.add(m[1]!);
  }
  return out;
}

/** Every symbol a function body REFERENCES: bare identifiers, and the properties reached on each object
 *  (`q` → `{peekAll}` for `q.peekAll(ctx)`). A superset of `calledIdentifiersIn` on purpose — a helper is
 *  PASSED as often as it is called (`ctx.query(peek)`), and a resolver keyed on call shape alone would miss
 *  exactly the seam-runner idiom the framework prescribes. Comments and string literals are blanked first,
 *  so prose naming a symbol is not a reference to it. */
export function referencedSymbolsIn(text: string, fn: Deno.lint.Node): {
  readonly names: ReadonlySet<string>;
  readonly members: ReadonlyMap<string, Set<string>>;
} {
  const [s, e] = rangeOf(fn);
  const body = withoutCommentsOrStrings(text.slice(s, e));
  const names = new Set<string>();
  const members = new Map<string, Set<string>>();
  for (const m of body.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1]!);
  }
  for (
    const m of body.matchAll(
      /(?<![.\w$])([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)/g,
    )
  ) {
    const props = members.get(m[1]!) ?? new Set<string>();
    props.add(m[2]!);
    members.set(m[1]!, props);
  }
  return { names, members };
}

// spec-independence (13-authz.md §spec-independence): the co-located `<r>.rowpolicy.spec.ts` `export const
// spec` must be independently-derived; these helpers foreclose value-importing the impl or the Condition algebra.

/** True iff a source path is a row-visibility SPEC file (`<r>.rowpolicy.spec.ts`) — the only file these
 *  anti-copy rules judge; a plain `*.spec.ts` is out of scope. */
export function isRowPolicySpecFile(filename: string): boolean {
  return /\.rowpolicy\.spec\.ts$/.test(filename);
}

/** Where an import specifier's module comes from, as far as a pass over ONE file can PROVE.
 *
 *  A spec's independence cannot be judged from the specifier's spelling: the impl reaches the spec under any
 *  filename (`license`'s rowPolicy lives in `domain.module.ts`), through any barrel, at any depth. So the
 *  door is the ORIGIN. `app` is the cannot-prove-otherwise bucket — a bare specifier resolves through the
 *  app's own import map, which this pass never reads, so it is judged app source rather than waved through. */
export type SpecifierOrigin = "framework" | "external" | "app";

/** Classify an import specifier. A `..` inside a framework-prefixed specifier escapes the framework tree
 *  (`hazelnut/../domain.module.ts`), so it is app source, not framework. `@hazelnut/core` is the published
 *  core barrel's name — the same framework under its registry spelling. */
export function specifierOrigin(source: string): SpecifierOrigin {
  const frameworkSpelling = source === "hazelnut" ||
    source.startsWith("hazelnut/") || source === "@hazelnut/core" ||
    source.startsWith("@hazelnut/core/");
  if (frameworkSpelling && !source.split("/").includes("..")) {
    return "framework";
  }
  // A scheme-prefixed specifier (`npm:`/`jsr:`/`https:`/`node:`) is literal — no import map redirects it.
  if (/^[a-z][a-z0-9+.-]*:/i.test(source)) return "external";
  return "app";
}

/** The `where.ts` Condition-algebra value exports a spec may not import (`spec/uses-algebra`) — the full
 *  builder set plus the lowering doors (`fields`, `toNode`/`toDrizzle`/`evaluate`). A plain-business-term
 *  boolean needs none of them; importing one reaches for the same algebra the impl uses. */
export const ALGEBRA_VALUE_NAMES: ReadonlySet<string> = new Set([
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "inArray",
  "isNull",
  "and",
  "or",
  "not",
  "all",
  "none",
  "fields",
  "toNode",
  "toDrizzle",
  "evaluate",
]);

/** The `import type` whitelist for `aliases-impl` (13-authz.md §spec-independence): a type-only import is
 *  exempt only for `Actor`, `Row` (`Row<R>`), needed to type `(actor, row) => boolean`. A type-import of an
 *  impl-module export re-couples the spec to the impl's vocabulary and is not exempt. */
export const TYPE_IMPORT_WHITELIST: ReadonlySet<string> = new Set([
  "Actor",
  "Row",
]);

/** The local binding names an import declaration introduces — each specifier's LOCAL name (`import { a as b }`
 *  → `b`; default/namespace → their local). Used to judge which imported value names a rule body must watch. */
export function importedLocalNames(node: Deno.lint.Node): string[] {
  if (node.type !== "ImportDeclaration") return [];
  const out: string[] = [];
  for (const s of node.specifiers) {
    if (
      s.type === "ImportSpecifier" || s.type === "ImportDefaultSpecifier" ||
      s.type === "ImportNamespaceSpecifier"
    ) {
      if (s.local.type === "Identifier") out.push(s.local.name);
    }
  }
  return out;
}

/** True iff an import declaration is a TYPE-ONLY import (`import type { … }`), so a value-import gate does
 *  not bite a pure type pull. An inline `import { type Foo }` mixes per-specifier kinds (read on the specifier). */
export function isTypeOnlyImport(node: Deno.lint.Node): boolean {
  return node.type === "ImportDeclaration" &&
    (node as { importKind?: string }).importKind === "type";
}

/** The imported NAMES that are VALUE imports — drops `import type {…}` wholesale and any inline
 *  `import { type Foo }` specifier, leaving what `aliases-impl`/`uses-algebra` must watch. */
export function valueImportedNames(node: Deno.lint.Node): string[] {
  if (node.type !== "ImportDeclaration" || isTypeOnlyImport(node)) return [];
  const out: string[] = [];
  for (const s of node.specifiers) {
    if (
      s.type === "ImportSpecifier" &&
      (s as { importKind?: string }).importKind === "type"
    ) continue; // inline `type`
    if (
      s.type === "ImportSpecifier" || s.type === "ImportDefaultSpecifier" ||
      s.type === "ImportNamespaceSpecifier"
    ) {
      if (s.local.type === "Identifier") out.push(s.local.name);
    }
  }
  return out;
}
