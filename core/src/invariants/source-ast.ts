/** Finite syntax evidence shared by model permission inference and source reach. Never evaluates code. */
import { parse } from "@babel/parser";

export interface SourceNode {
  readonly type: string;
  readonly start?: number | null;
  readonly end?: number | null;
  readonly [key: string]: unknown;
}
export function sourceNode(value: unknown): value is SourceNode {
  return value !== null && typeof value === "object" && "type" in value &&
    typeof value.type === "string";
}
const functionNode = (node: SourceNode) =>
  /^(?:Function|ArrowFunction|ObjectMethod|ClassMethod|ClassPrivateMethod)/
    .test(node.type);
const scopeNode = (node: SourceNode) =>
  functionNode(node) ||
  [
    "Program",
    "BlockStatement",
    "CatchClause",
    "ForStatement",
    "ForOfStatement",
    "ForInStatement",
  ].includes(node.type);
const identifier = (node: unknown): string | undefined =>
  sourceNode(node) && node.type === "Identifier" &&
    typeof node.name === "string"
    ? node.name
    : undefined;

/** The node surface is checked structurally at the parser boundary; callers never cast arbitrary data. */
export class SourceAst {
  readonly nodes: SourceNode[] = [];
  readonly #parents = new Map<SourceNode, SourceNode>();
  readonly #bindings = new Map<SourceNode, Map<string, SourceNode | null>>();
  readonly #writes = new Set<SourceNode>();
  constructor(source: string, filename = "source.ts") {
    const root: unknown = parse(source, {
      sourceType: "unambiguous",
      plugins: /\.[jt]sx$/.test(filename)
        ? ["typescript", "jsx"]
        : ["typescript"],
      allowAwaitOutsideFunction: true,
    });
    if (!sourceNode(root)) {
      throw new Error("source parser did not produce a syntax tree");
    }
    const visit = (node: SourceNode, parent?: SourceNode) => {
      if (parent) this.#parents.set(node, parent);
      this.nodes.push(node);
      for (const [key, value] of Object.entries(node)) {
        if (
          [
            "loc",
            "leadingComments",
            "trailingComments",
            "innerComments",
            "extra",
            "tokens",
            "comments",
          ].includes(key)
        ) continue;
        if (sourceNode(value)) visit(value, node);
        else if (Array.isArray(value)) {
          for (const child of value) {
            if (sourceNode(child)) visit(child, node);
          }
        }
      }
    };
    visit(root);
    const names = (pattern: unknown): string[] => {
      if (!sourceNode(pattern)) return [];
      const name = identifier(pattern);
      if (name) return [name];
      if (pattern.type === "AssignmentPattern") return names(pattern.left);
      if (pattern.type === "RestElement") return names(pattern.argument);
      if (
        pattern.type === "ObjectPattern" && Array.isArray(pattern.properties)
      ) {
        return pattern.properties.flatMap((p: unknown) =>
          sourceNode(p)
            ? names(p.type === "RestElement" ? p.argument : p.value)
            : []
        );
      }
      if (pattern.type === "ArrayPattern" && Array.isArray(pattern.elements)) {
        return pattern.elements.flatMap(names);
      }
      return [];
    };
    const bind = (
      scope: SourceNode | undefined,
      name: string,
      value: SourceNode | null,
    ) => {
      if (!scope) return;
      let map = this.#bindings.get(scope);
      if (!map) this.#bindings.set(scope, map = new Map());
      // Redeclaration ambiguity is unknown; source order never manufactures a constant.
      map.set(name, map.has(name) ? null : value);
    };
    for (const node of this.nodes) {
      if (functionNode(node)) {
        if (Array.isArray(node.params)) {
          for (const param of node.params) {
            for (const name of names(param)) bind(node, name, null);
          }
        }
        const name = identifier(node.id);
        if (name) {
          bind(
            node.type === "FunctionDeclaration" ? this.scope(node) : node,
            name,
            null,
          );
        }
      } else if (node.type === "VariableDeclarator") {
        const parent = this.#parents.get(node),
          scope = this.scope(node, parent?.kind === "var");
        const name = identifier(node.id);
        for (const bound of names(node.id)) {
          bind(
            scope,
            bound,
            bound === name && parent?.kind === "const" && sourceNode(node.init)
              ? node.init
              : null,
          );
        }
      } else if (
        node.type === "ImportDeclaration" && Array.isArray(node.specifiers)
      ) {
        for (const spec of node.specifiers) {
          if (sourceNode(spec)) {
            const name = identifier(spec.local);
            if (name) bind(this.scope(node), name, null);
          }
        }
      } else if (node.type === "ClassDeclaration") {
        const name = identifier(node.id);
        if (name) bind(this.scope(node), name, null);
      } else if (node.type === "CatchClause") {
        for (const name of names(node.param)) {
          bind(node, name, null);
        }
      }
    }
    for (const node of this.nodes) {
      if (
        node.type !== "AssignmentExpression" && node.type !== "UpdateExpression"
      ) continue;
      const target = node.type === "AssignmentExpression"
        ? node.left
        : node.argument;
      if (sourceNode(target) && identifier(target)) {
        const binding = this.binding(target);
        if (binding) this.#writes.add(binding);
      }
    }
  }
  scope(node: SourceNode, variable = false): SourceNode | undefined {
    let parent = this.#parents.get(node);
    while (parent) {
      if (
        variable
          ? functionNode(parent) || parent.type === "Program"
          : scopeNode(parent)
      ) return parent;
      parent = this.#parents.get(parent);
    }
    return undefined;
  }
  /** undefined = an unbound closure/global name; null = locally bound but not a proved constant. */
  binding(node: SourceNode): SourceNode | null | undefined {
    const name = identifier(node);
    if (!name) return null;
    for (let at = this.scope(node); at; at = this.scope(at)) {
      const bindings = this.#bindings.get(at);
      if (bindings?.has(name)) return bindings.get(name);
    }
    return undefined;
  }
  unwrap(node: SourceNode): SourceNode {
    let cur = node;
    while (
      [
        "TSAsExpression",
        "TSSatisfiesExpression",
        "TSNonNullExpression",
        "ParenthesizedExpression",
        "TypeCastExpression",
      ].includes(cur.type) && sourceNode(cur.expression)
    ) cur = cur.expression;
    return cur;
  }
  constant(node: unknown, seen = new Set<SourceNode>()): SourceNode | null {
    if (!sourceNode(node)) return null;
    const value = this.unwrap(node);
    if (value.type !== "Identifier") return value;
    const bound = this.binding(value);
    if (!bound || this.#writes.has(bound) || seen.has(bound)) return null;
    seen.add(bound);
    return this.constant(bound, seen);
  }
  string(node: unknown, seen = new Set<SourceNode>()): string | null {
    const value = this.constant(node, seen);
    if (!value) return null;
    if (value.type === "StringLiteral" && typeof value.value === "string") {
      return value.value;
    }
    if (value.type === "BinaryExpression" && value.operator === "+") {
      const a = this.string(value.left, new Set(seen)),
        b = this.string(value.right, new Set(seen));
      return a === null || b === null ? null : a + b;
    }
    if (
      value.type === "TemplateLiteral" && Array.isArray(value.quasis) &&
      Array.isArray(value.expressions)
    ) {
      let out = "";
      for (let i = 0; i < value.quasis.length; i++) {
        const quasi: unknown = value.quasis[i];
        if (
          !sourceNode(quasi) || !quasi.value ||
          typeof quasi.value !== "object" || !("cooked" in quasi.value) ||
          typeof quasi.value.cooked !== "string"
        ) return null;
        out += quasi.value.cooked;
        if (i < value.expressions.length) {
          const next = this.string(value.expressions[i], new Set(seen));
          if (next === null) return null;
          out += next;
        }
      }
      return out;
    }
    return null;
  }
  /** Recognize a same-source alias of an unbound canonical function, while respecting lexical shadows. */
  freeName(node: unknown, seen = new Set<SourceNode>()): string | null {
    if (!sourceNode(node)) return null;
    const value = this.unwrap(node);
    if (value.type !== "Identifier") return null;
    const bound = this.binding(value);
    if (bound === undefined) return identifier(value) ?? null;
    if (!bound || this.#writes.has(bound) || seen.has(bound)) return null;
    seen.add(bound);
    return this.freeName(bound, seen);
  }
}
