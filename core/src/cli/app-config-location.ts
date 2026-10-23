/** Source attribution for config findings. The structural fold remains pure over the composed model. */
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SourceAst,
  type SourceNode,
  sourceNode,
} from "../invariants/source-ast.ts";
import {
  fingerprint,
  type Span,
  type Violation,
} from "../core/verifier-contract.ts";

type File = {
  readonly file: string;
  readonly path: string;
  readonly text: string;
  readonly ast: SourceAst;
};
type Ref =
  | { readonly kind: "node"; readonly file: File; readonly node: SourceNode }
  | { readonly kind: "builder"; readonly name: string }
  | {
    readonly kind: "namespace";
    readonly file?: File;
    readonly framework?: true;
  };
type Property = { readonly kind: "absent" } | { readonly kind: "unknown" } | {
  readonly kind: "present";
  readonly value: Ref;
  readonly key: SourceNode;
};
const nameOf = (node: unknown): string | null =>
  sourceNode(node) && node.type === "Identifier" &&
    typeof node.name === "string"
    ? node.name
    : sourceNode(node) && typeof node.value === "string"
    ? node.value
    : null;
const framework = (source: string): boolean =>
  /^(?:hazelnut(?:\/|$)|(?:jsr:)?@hazelnut\/(?:core|ai)(?:@[^/]+)?(?:\/|$))/
    .test(source);

/** Only a unique exported app with a statically resolved config is localized. No app code is evaluated. */
export function attributeAppConfigFindings(
  violations: readonly Violation[],
  sources: Readonly<Record<string, string>>,
): Violation[] {
  const fields: Readonly<Record<string, string>> = {
    "mcp/origin-declared": "allowedOrigins",
    "mcp/gate-declared": "gate",
  };
  if (
    !violations.some((v) =>
      fields[v.id] !== undefined && v.responsible.kind === "unknown"
    )
  ) {
    return [...violations];
  }
  const files = new Map<string, File>();
  const mutated = new Set<SourceNode>();
  for (const [file, text] of Object.entries(sources)) {
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    try {
      const path = file.startsWith("file:") ? fileURLToPath(file) : file;
      files.set(resolve(path), {
        file,
        path: resolve(path),
        text,
        ast: new SourceAst(text, file),
      });
    } catch { /* unreadable syntax supplies no trustworthy coordinates */ }
  }
  const imported = (file: File, spec: string): File | null => {
    if (!spec.startsWith(".")) return null;
    return files.get(resolve(dirname(file.path), spec)) ?? null;
  };
  const statements = (file: File): SourceNode[] => {
    const body = file.ast.nodes.find((n) => n.type === "Program")?.body;
    return Array.isArray(body) ? body.filter(sourceNode) : [];
  };
  const external = (source: string, name: string): Ref | null =>
    framework(source)
      ? name === "*"
        ? { kind: "namespace", framework: true }
        : { kind: "builder", name }
      : null;
  const fromModule = (
    file: File,
    source: string,
    name: string,
    seen: Set<string>,
  ): Ref | null => {
    const target = imported(file, source);
    return target
      ? name === "*"
        ? { kind: "namespace", file: target }
        : exported(target, name, seen)
      : external(source, name);
  };
  const value = (file: File, input: unknown, seen: Set<string>): Ref | null => {
    if (!sourceNode(input)) return null;
    const node = file.ast.unwrap(input);
    const identity = `${file.file}:${node.start}:${node.type}`;
    if (seen.has(identity)) return null;
    const next = new Set(seen).add(identity);
    if (node.type === "Identifier") {
      const bound = file.ast.binding(node);
      if (bound) return value(file, bound, next);
      // Imported bindings live in the program scope; a parameter/local shadow is never an import.
      if (file.ast.scope(node)?.type !== "Program") return null;
      for (const statement of statements(file)) {
        if (
          statement.type !== "ImportDeclaration" ||
          !Array.isArray(statement.specifiers) ||
          statement.importKind === "type"
        ) continue;
        const source = nameOf(statement.source);
        if (source === null) continue;
        for (const spec of statement.specifiers) {
          if (
            !sourceNode(spec) || nameOf(spec.local) !== node.name ||
            spec.importKind === "type"
          ) continue;
          const name = spec.type === "ImportNamespaceSpecifier"
            ? "*"
            : spec.type === "ImportDefaultSpecifier"
            ? "default"
            : nameOf(spec.imported);
          return name === null ? null : fromModule(file, source, name, next);
        }
      }
      return null;
    }
    if (node.type === "MemberExpression") {
      const object = value(file, node.object, next);
      const key = node.computed === true
        ? file.ast.string(node.property)
        : nameOf(node.property);
      if (object?.kind !== "namespace" || key === null) return null;
      return object.file
        ? exported(object.file, key, next)
        : { kind: "builder", name: key };
    }
    return { kind: "node", file, node };
  };
  const exported = (
    file: File,
    name: string,
    seen: Set<string>,
  ): Ref | null => {
    const identity = `${file.file}:export:${name}`;
    if (seen.has(identity)) return null;
    const next = new Set(seen).add(identity);
    const hits: Ref[] = [];
    for (const statement of statements(file)) {
      if (statement.type === "ExportDefaultDeclaration" && name === "default") {
        const ref = value(file, statement.declaration, next);
        if (ref) hits.push(ref);
      }
      if (statement.type === "ExportAllDeclaration") {
        const source = nameOf(statement.source);
        const ref = source === null
          ? null
          : fromModule(file, source, name, next);
        if (ref) hits.push(ref);
      }
      if (statement.type !== "ExportNamedDeclaration") continue;
      const declaration = statement.declaration;
      if (
        sourceNode(declaration) && declaration.type === "VariableDeclaration" &&
        declaration.kind === "const" && Array.isArray(declaration.declarations)
      ) {
        for (const binding of declaration.declarations) {
          if (!sourceNode(binding) || nameOf(binding.id) !== name) continue;
          const ref = value(file, binding.init, next);
          if (ref) hits.push(ref);
        }
      }
      if (!Array.isArray(statement.specifiers)) continue;
      for (const spec of statement.specifiers) {
        if (!sourceNode(spec) || nameOf(spec.exported) !== name) continue;
        const source = nameOf(statement.source), local = nameOf(spec.local);
        const ref = source === null
          ? value(file, spec.local, next)
          : local === null
          ? null
          : fromModule(file, source, local, next);
        if (ref) hits.push(ref);
      }
    }
    return hits.length === 1 ? hits[0]! : null;
  };
  const object = (
    ref: Ref | null,
    seen = new Set<SourceNode>(),
  ): Extract<Ref, { kind: "node" }> | null => {
    if (ref?.kind !== "node") return null;
    if (seen.has(ref.node)) return null;
    const next = new Set(seen).add(ref.node);
    if (ref.node.type === "ObjectExpression") return ref;
    if (
      ref.node.type !== "CallExpression" || !Array.isArray(ref.node.arguments)
    ) return null;
    const builder = value(ref.file, ref.node.callee, new Set());
    return builder?.kind === "builder" && builder.name === "defineConfig"
      ? object(value(ref.file, ref.node.arguments[0], new Set()), next)
      : null;
  };
  const property = (
    ref: Extract<Ref, { kind: "node" }>,
    key: string,
    seen = new Set<SourceNode>(),
  ): Property => {
    if (
      seen.has(ref.node) || mutated.has(ref.node) ||
      !Array.isArray(ref.node.properties)
    ) {
      return { kind: "unknown" };
    }
    const next = new Set(seen).add(ref.node);
    for (const prop of [...ref.node.properties].reverse()) {
      if (!sourceNode(prop)) return { kind: "unknown" };
      if (prop.type === "SpreadElement") {
        const spread = object(value(ref.file, prop.argument, new Set()));
        if (spread === null) return { kind: "unknown" };
        const found = property(spread, key, next);
        if (found.kind !== "absent") return found;
      } else {
        const name = prop.computed === true
          ? ref.file.ast.string(prop.key)
          : nameOf(prop.key);
        if (name === null) return { kind: "unknown" };
        if (name !== key) continue;
        const found = value(ref.file, prop.value, new Set());
        return prop.type === "ObjectProperty" && found && sourceNode(prop.key)
          ? { kind: "present", value: found, key: prop.key }
          : { kind: "unknown" };
      }
    }
    return { kind: "absent" };
  };
  // A const binding does not freeze its object. Writes or handing that object to opaque code invalidate
  // the literal as current-value evidence, including mutations through a relative-import alias.
  const objectRoot = (
    file: File,
    input: unknown,
    seen = new Set<SourceNode>(),
  ): SourceNode | null => {
    if (!sourceNode(input) || seen.has(input)) return null;
    const next = new Set(seen).add(input);
    const known = object(value(file, input, new Set()));
    if (known) return known.node;
    const node = file.ast.unwrap(input);
    if (node.type === "MemberExpression") {
      return objectRoot(file, node.object, next);
    }
    if (node.type === "Identifier") {
      return objectRoot(file, file.ast.binding(node), next);
    }
    return null;
  };
  for (const file of files.values()) {
    for (const node of file.ast.nodes) {
      if (
        node.type === "AssignmentExpression" ||
        node.type === "UpdateExpression" ||
        (node.type === "UnaryExpression" && node.operator === "delete")
      ) {
        const root = objectRoot(
          file,
          node.type === "AssignmentExpression" ? node.left : node.argument,
        );
        if (root) mutated.add(root);
      } else if (
        node.type === "CallExpression" && Array.isArray(node.arguments)
      ) {
        const callee = value(file, node.callee, new Set());
        if (
          callee?.kind === "builder" &&
          ["createApp", "defineConfig"].includes(callee.name)
        ) continue;
        for (const argument of node.arguments) {
          const root = objectRoot(file, argument);
          if (root) mutated.add(root);
        }
      }
    }
  }
  const configs: Array<Extract<Ref, { kind: "node" }>> = [];
  const seenApps = new Set<SourceNode>();
  for (const file of files.values()) {
    for (const name of ["app", "default"]) {
      const app = exported(file, name, new Set());
      if (
        name === "app" && app !== null &&
        (app.kind !== "node" || app.node.type !== "CallExpression")
      ) return [...violations];
      if (
        app?.kind !== "node" || app.node.type !== "CallExpression" ||
        !Array.isArray(app.node.arguments)
      ) continue;
      const builder = value(app.file, app.node.callee, new Set());
      if (builder?.kind !== "builder") return [...violations];
      if (
        builder?.kind !== "builder" || builder.name !== "createApp" ||
        seenApps.has(app.node)
      ) continue;
      seenApps.add(app.node);
      const config = object(value(app.file, app.node.arguments[0], new Set()));
      // An unresolved app candidate makes attribution ambiguous, even beside a resolved one.
      if (config === null) return [...violations];
      configs.push(config);
    }
  }
  if (configs.length !== 1) return [...violations];
  const config = configs[0]!;
  const mcp = property(config, "mcp");
  const owner = mcp.kind === "absent"
    ? config
    : mcp.kind === "present"
    ? object(mcp.value)
    : null;
  if (owner === null || typeof owner.node.start !== "number") {
    return [...violations];
  }
  const span: Span = {
    file: relative(Deno.cwd(), owner.file.path).replaceAll("\\", "/"),
    startLine: owner.file.text.slice(0, owner.node.start).split("\n").length,
  };
  return violations.map((v) => {
    const field = fields[v.id];
    if (field === undefined || v.responsible.kind !== "unknown") return v;
    if (mcp.kind !== "absent" && property(owner, field).kind === "unknown") {
      return v;
    }
    const responsible = {
      kind: "declaration" as const,
      ref: { module: "<app>", clause: `mcp.${field}`, span },
    };
    return {
      ...v,
      at: span,
      responsible,
      fingerprint: fingerprint({ id: v.id, at: span, responsible }),
    };
  });
}
