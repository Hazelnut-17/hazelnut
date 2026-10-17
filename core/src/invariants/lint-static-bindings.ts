/** Lexical bindings for the lint floor's finite static reads. No evaluation, module loading or inference
 *  of a runtime key: an unknown value stays unknown, and a local declaration always shadows a global. */
import { rangeOf } from "./lint-helpers-node.ts";

export interface StaticReference {
  readonly origin:
    | { readonly kind: "global"; readonly name: string }
    | {
      readonly kind: "import";
      readonly source: string;
      readonly name: string;
    };
  readonly members: readonly (string | null)[];
}

type LintContext = Parameters<Deno.lint.Rule["create"]>[0];

interface Binding {
  readonly name: string;
  readonly scope: Deno.lint.Node;
  readonly node: Deno.lint.Node;
  readonly value?: Deno.lint.Node;
  readonly path: readonly (string | Deno.lint.Node)[];
  readonly imported?: StaticReference;
}

export function unwrapStatic(node: Deno.lint.Node): Deno.lint.Node {
  let cur = node as Deno.lint.Node & { expression?: Deno.lint.Node };
  while (
    (cur.type === "TSAsExpression" || cur.type === "TSSatisfiesExpression" ||
      cur.type === "TSNonNullExpression" || cur.type === "TSTypeAssertion" ||
      cur.type === "ChainExpression") && cur.expression !== undefined
  ) cur = cur.expression;
  return cur;
}

const isFunction = (node: Deno.lint.Node) =>
  node.type === "FunctionDeclaration" || node.type === "FunctionExpression" ||
  node.type === "ArrowFunctionExpression";
const isScope = (node: Deno.lint.Node) =>
  isFunction(node) || node.type === "Program" ||
  node.type === "BlockStatement" ||
  node.type === "ForStatement" || node.type === "ForInStatement" ||
  node.type === "ForOfStatement" || node.type === "SwitchStatement" ||
  node.type === "CatchClause" || node.type === "ClassDeclaration" ||
  node.type === "ClassExpression";
const sameNode = (a: Deno.lint.Node, b: Deno.lint.Node) =>
  a.type === b.type && rangeOf(a)[0] === rangeOf(b)[0];
const computed = (node: Deno.lint.Node) =>
  (node as Deno.lint.Node & { computed?: boolean }).computed === true;

/** One instance per rule/file. Populate from the existing binding visitors, resolve at Program:exit so a
 *  declaration below a closure still shadows correctly. Assignments are source-ordered, not control-flow
 *  execution: arbitrary returned values and cross-function mutation remain outside this static reader. */
export class StaticBindings {
  readonly #context: LintContext;
  readonly #bindings = new Map<string, Map<string, Binding>>();
  readonly #shadows = new Map<string, Set<string>>();
  readonly #writes: Array<
    { target: Deno.lint.Identifier; value: Deno.lint.Node }
  > = [];

  constructor(context: LintContext) {
    this.#context = context;
  }

  #scopeKey(node: Deno.lint.Node): string {
    return `${node.type}:${rangeOf(node)[0]}`;
  }

  #add(binding: Binding): void {
    const key = this.#scopeKey(binding.scope);
    let names = this.#bindings.get(key);
    if (!names) this.#bindings.set(key, names = new Map());
    names.set(binding.name, binding);
  }

  #ancestors(node: Deno.lint.Node): Deno.lint.Node[] {
    return this.#context.sourceCode.getAncestors(node);
  }

  #scope(node: Deno.lint.Node, variable = false): Deno.lint.Node {
    return this.#ancestors(node).findLast((parent) =>
      variable
        ? isFunction(parent) || parent.type === "Program"
        : isScope(parent)
    )!;
  }

  #pattern(
    pattern: Deno.lint.Node,
    add: (
      id: Deno.lint.Identifier,
      path: readonly (string | Deno.lint.Node)[],
    ) => void,
    path: readonly (string | Deno.lint.Node)[] = [],
  ): void {
    if (pattern.type === "Identifier") add(pattern, path);
    else if (pattern.type === "AssignmentPattern") {
      this.#pattern(pattern.left, add, path);
    } else if (pattern.type === "RestElement") {
      this.#pattern(pattern.argument, add, path);
    } else if (pattern.type === "ObjectPattern") {
      for (const p of pattern.properties) {
        if (p.type === "RestElement") {
          // Object rest creates a different value; it still declares a name that shadows any global.
          this.#pattern(p.argument, add, [...path, "#rest"]);
          continue;
        }
        if (p.type !== "Property") continue;
        const key = !computed(p) && p.key.type === "Identifier"
          ? p.key.name
          : p.key;
        this.#pattern(p.value, add, [...path, key]);
      }
    } else if (pattern.type === "ArrayPattern") {
      for (const [index, item] of pattern.elements.entries()) {
        if (item !== null) this.#pattern(item, add, [...path, String(index)]);
      }
    }
  }

  variable(node: Deno.lint.VariableDeclarator): void {
    const declaration = this.#ancestors(node).findLast((parent) =>
      parent.type === "VariableDeclaration"
    );
    const scope = this.#scope(
      node,
      declaration?.type === "VariableDeclaration" && declaration.kind === "var",
    );
    this.#pattern(node.id, (id, path) => {
      this.#add({
        name: id.name,
        scope,
        node: id,
        value: node.init ?? undefined,
        path,
      });
    });
  }

  assignment(node: Deno.lint.AssignmentExpression): void {
    if (node.operator === "=" && node.left.type === "Identifier") {
      this.#writes.push({ target: node.left, value: node.right });
    }
  }

  imports(node: Deno.lint.ImportDeclaration): void {
    const typeOnly =
      (node as Deno.lint.Node & { importKind?: string }).importKind === "type";
    for (const spec of node.specifiers) {
      const imported = spec.type === "ImportSpecifier"
        ? spec.imported.type === "Identifier"
          ? spec.imported.name
          : String(spec.imported.value)
        : "*";
      const valueImport = !typeOnly &&
        (spec as Deno.lint.Node & { importKind?: string }).importKind !==
          "type";
      this.#add({
        name: spec.local.name,
        scope: this.#scope(node),
        node: spec.local,
        path: [],
        ...(valueImport
          ? {
            imported: {
              origin: {
                kind: "import" as const,
                source: String(node.source.value),
                name: imported,
              },
              members: [],
            },
          }
          : {}),
      });
    }
  }

  /** The parameter receiving a statically named dynamic import's .then callback. */
  parameter(
    pattern: Deno.lint.Node,
    value: Deno.lint.Node,
    fn: Deno.lint.Node,
  ): void {
    this.#pattern(pattern, (id, path) => {
      this.#add({ name: id.name, scope: fn, node: id, value, path });
    });
  }

  #binding(id: Deno.lint.Identifier): Binding | null | undefined {
    for (const scope of this.#ancestors(id).filter(isScope).reverse()) {
      const binding = this.#bindings.get(this.#scopeKey(scope))?.get(id.name);
      if (binding !== undefined) return binding;
      const key = this.#scopeKey(scope);
      let shadows = this.#shadows.get(key);
      if (shadows === undefined) {
        shadows = new Set();
        if (
          scope.type === "FunctionDeclaration" ||
          scope.type === "FunctionExpression" ||
          scope.type === "ArrowFunctionExpression"
        ) {
          for (const parameter of scope.params) {
            // The parser's shared parameter type includes TypeScript constructor parameter properties.
            const pattern = parameter.type === "TSParameterProperty"
              ? parameter.parameter
              : parameter;
            this.#pattern(pattern, (name) => shadows!.add(name.name));
          }
          if (scope.type !== "ArrowFunctionExpression" && scope.id) {
            shadows.add(scope.id.name);
          }
        }
        if (scope.type === "CatchClause" && scope.param) {
          this.#pattern(scope.param, (name) => shadows!.add(name.name));
        }
        if (
          (scope.type === "ClassDeclaration" ||
            scope.type === "ClassExpression") && scope.id
        ) shadows.add(scope.id.name);
        // Declarations shadow without adding bookkeeping visitors to each rule.
        if (scope.type === "Program" || scope.type === "BlockStatement") {
          for (const statement of scope.body) {
            const decl = statement.type === "ExportNamedDeclaration" ||
                statement.type === "ExportDefaultDeclaration"
              ? statement.declaration
              : statement;
            if (
              (decl?.type === "FunctionDeclaration" ||
                decl?.type === "ClassDeclaration") && decl.id
            ) shadows.add(decl.id.name);
          }
        }
        this.#shadows.set(key, shadows);
      }
      if (shadows.has(id.name)) return null;
    }
    return undefined;
  }

  #value(binding: Binding, at: Deno.lint.Node): Deno.lint.Node | undefined {
    const owner = this.#ancestors(at).findLast(isFunction);
    let value = binding.value;
    for (const write of this.#writes) {
      if (rangeOf(write.target)[0] >= rangeOf(at)[0]) continue;
      const target = this.#binding(write.target);
      if (target !== binding) continue;
      const writingOwner = this.#ancestors(write.target).findLast(isFunction);
      if (writingOwner && (!owner || !sameNode(writingOwner, owner))) continue;
      value = write.value;
    }
    return value;
  }

  string(node: Deno.lint.Node, seen = new Set<Binding>()): string | null {
    const n = unwrapStatic(node);
    if (n.type === "Literal" && typeof n.value === "string") return n.value;
    if (n.type === "TemplateLiteral" && n.expressions.length === 0) {
      return n.quasis[0]?.cooked ?? null;
    }
    if (n.type === "BinaryExpression" && n.operator === "+") {
      const left = this.string(n.left, new Set(seen)),
        right = this.string(n.right, new Set(seen));
      return left === null || right === null ? null : left + right;
    }
    if (n.type !== "Identifier") return null;
    const binding = this.#binding(n);
    if (!binding || binding.path.length > 0 || seen.has(binding)) return null;
    seen.add(binding);
    const value = this.#value(binding, n);
    return value ? this.string(value, seen) : null;
  }

  key(node: Deno.lint.MemberExpression | Deno.lint.Property): string | null {
    const property = node.type === "MemberExpression"
      ? node.property
      : node.key;
    return !computed(node) && property.type === "Identifier"
      ? property.name
      : this.string(property);
  }

  reference(
    node: Deno.lint.Node,
    seen = new Set<Binding>(),
  ): StaticReference | null {
    const n = unwrapStatic(node);
    if (n.type === "AssignmentExpression") return this.reference(n.right, seen);
    if (n.type === "AwaitExpression") return this.reference(n.argument, seen);
    if (n.type === "ImportExpression") {
      const source = this.string(n.source);
      return source === null
        ? null
        : { origin: { kind: "import", source, name: "*" }, members: [] };
    }
    if (n.type === "CallExpression") {
      const callee = unwrapStatic(n.callee);
      return callee.type === "MemberExpression" && this.key(callee) === "bind"
        ? this.reference(callee.object, seen)
        : null;
    }
    if (n.type === "MemberExpression") {
      const parent = this.reference(n.object, seen);
      return parent && { ...parent, members: [...parent.members, this.key(n)] };
    }
    if (n.type !== "Identifier") return null;
    const binding = this.#binding(n);
    if (binding === null) return null;
    if (binding === undefined) {
      return { origin: { kind: "global", name: n.name }, members: [] };
    }
    if (seen.has(binding)) return null;
    seen.add(binding);
    if (binding.imported) return binding.imported;
    const value = this.#value(binding, n);
    const parent = value ? this.reference(value, seen) : null;
    return parent &&
      {
        ...parent,
        members: [
          ...parent.members,
          ...binding.path.map((p) =>
            typeof p === "string" ? p : this.string(p)
          ),
        ],
      };
  }

  /** Each property taken by an object pattern is a read, including nested destructuring. */
  patternReads(
    pattern: Deno.lint.Node,
    source: StaticReference,
  ): Array<{ node: Deno.lint.Node; reference: StaticReference }> {
    const reads: Array<{ node: Deno.lint.Node; reference: StaticReference }> =
      [];
    if (pattern.type === "AssignmentPattern") {
      return this.patternReads(pattern.left, source);
    }
    if (pattern.type !== "ObjectPattern") return reads;
    for (const p of pattern.properties) {
      if (p.type !== "Property") continue;
      const reference = {
        ...source,
        members: [...source.members, this.key(p)],
      };
      reads.push({ node: p, reference });
      reads.push(...this.patternReads(p.value, reference));
    }
    return reads;
  }
}
