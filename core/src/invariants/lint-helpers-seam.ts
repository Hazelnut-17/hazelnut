import { rangeOf } from "./lint-helpers-node.ts";
import {
  withoutCommentsOrStrings,
  withoutCommentsStringsAndRegex,
} from "./source-view.ts";
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

/** Every symbol a function body REFERENCES: bare identifiers, and the properties reached on each object
 *  (`q` → `{peekAll}` for `q.peekAll(ctx)`). A helper is PASSED as often as it is called (`ctx.query(peek)`),
 *  so a resolver keyed on call shape alone would miss exactly the seam-runner idiom the framework prescribes.
 *  Comments and string literals are blanked first, so prose naming a symbol is not a reference to it. */
export function referencedSymbolsIn(text: string, fn: Deno.lint.Node): {
  readonly names: ReadonlySet<string>;
  readonly members: ReadonlyMap<string, Set<string>>;
} {
  const [s, e] = rangeOf(fn);
  return referencedSymbolsInSource(text.slice(s, e));
}

/** The symbols a source fragment references, for an exported helper whose AST belongs to another lint file. */
export function referencedSymbolsInSource(source: string): {
  readonly names: ReadonlySet<string>;
  readonly members: ReadonlyMap<string, Set<string>>;
} {
  const body = withoutCommentsOrStrings(source);
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

/** Remove nested function bindings from one function slice before following its references. Their bodies are
 *  added back only when the surrounding helper graph reaches the binding by a static name. Anonymous inline
 *  callbacks remain in the executable slice; they are part of the expression that invokes them. */
export function withoutUnreachedNestedFunctions(source: string): string {
  const code = withoutCommentsStringsAndRegex(source);
  const ranges: Array<{
    readonly span: readonly [number, number];
    readonly maskWhenNested: boolean;
  }> = [];
  const matching = (
    open: number,
    left: string,
    right: string,
  ): number | null => {
    let depth = 0;
    for (let i = open; i < code.length; i++) {
      if (code[i] === left) depth++;
      else if (code[i] === right && --depth === 0) return i;
    }
    return null;
  };
  const variableStart = (before: string, arrow: boolean): number | null => {
    const left = arrow
      ? /(?:^|[;{}\n])[\t ]*((?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*(?:\s*:[^=\n]+)?\s*=\s*(?:async\s*)?(?:\([^()\n]*\)|[A-Za-z_$][\w$]*)\s*)$/
      : /(?:^|[;{}\n])[\t ]*((?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*(?:\s*:[^=\n]+)?\s*=\s*)$/;
    const m = left.exec(before);
    return m === null
      ? null
      : m.index + m[0].search(/(?:export\s+)?(?:const|let|var)\s/);
  };
  const functions = /\bfunction\b/g;
  for (let m = functions.exec(code); m !== null; m = functions.exec(code)) {
    const params = code.indexOf("(", m.index + m[0].length);
    if (params < 0) continue;
    const paramsEnd = matching(params, "(", ")");
    if (paramsEnd === null) continue;
    const body = code.indexOf("{", paramsEnd + 1);
    if (body < 0) continue;
    const bodyEnd = matching(body, "{", "}");
    if (bodyEnd === null) continue;
    const boundAt = variableStart(code.slice(0, m.index), false);
    ranges.push({
      span: [boundAt ?? m.index, bodyEnd + 1],
      maskWhenNested: true,
    });
  }
  const arrows = /=>/g;
  for (let m = arrows.exec(code); m !== null; m = arrows.exec(code)) {
    const boundAt = variableStart(code.slice(0, m.index), true);
    const start = boundAt ?? m.index;
    let body = m.index + m[0].length;
    while (/\s/.test(code[body] ?? "")) body++;
    let end: number;
    if (code[body] === "{") {
      const bodyEnd = matching(body, "{", "}");
      if (bodyEnd === null) continue;
      end = bodyEnd + 1;
    } else {
      let paren = 0, bracket = 0, brace = 0;
      let i = body;
      for (; i < code.length; i++) {
        const c = code[i]!;
        if (c === "(") paren++;
        else if (c === ")") {
          if (paren === 0 && bracket === 0 && brace === 0) break;
          paren--;
        } else if (c === "[") bracket++;
        else if (c === "]") {
          if (paren === 0 && bracket === 0 && brace === 0) break;
          bracket--;
        } else if (c === "{") brace++;
        else if (c === "}") {
          if (paren === 0 && bracket === 0 && brace === 0) break;
          brace--;
        } else if (
          (c === "," || c === ";") && paren === 0 && bracket === 0 &&
          brace === 0
        ) {
          break;
        }
      }
      end = i;
    }
    ranges.push({
      span: [start, end],
      maskWhenNested: boundAt !== null,
    });
  }
  if (ranges.length < 2) return source;
  const root = [...ranges].sort((a, b) =>
    (b.span[1] - b.span[0]) - (a.span[1] - a.span[0])
  )[0]!;
  const chars = source.split("");
  for (const { span: [start, end], maskWhenNested } of ranges) {
    if (!maskWhenNested || (start === root.span[0] && end === root.span[1])) {
      continue;
    }
    for (let i = start; i < end && i < chars.length; i++) {
      if (chars[i] !== "\n" && chars[i] !== "\r") chars[i] = " ";
    }
  }
  return chars.join("");
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
