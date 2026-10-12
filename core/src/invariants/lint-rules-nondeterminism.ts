/**
 * The clock and randomness rule backing the published core lint-floor export.
 * The object/member and module/export rosters are also consumed by its exhaustive tests.
 */
import { lintMessage } from "../runtime/channels.ts";
import {
  hasEscapeValve,
  type LintComment,
  propKeyName,
  rangeOf,
} from "./lint-helpers-node.ts";

export const NONDETERMINISTIC_MEMBERS: Readonly<
  Record<string, readonly string[]>
> = {
  Date: ["now"],
  Math: ["random"],
  crypto: ["randomUUID", "getRandomValues"],
  performance: ["now", "timeOrigin"],
  process: ["hrtime"],
  Temporal: ["Now"],
};

export const NONDETERMINISTIC_IMPORTS: Readonly<
  Record<string, readonly string[]>
> = {
  "node:crypto": [
    "randomUUID",
    "randomBytes",
    "randomInt",
    "randomFillSync",
    "webcrypto",
  ],
  "uuid": ["v1", "v4", "v6", "v7"],
  "nanoid": ["nanoid", "customAlphabet", "customRandom"],
  "@std/ulid": ["ulid", "monotonicUlid", "monotonicFactory"],
  "@std/uuid/v1": ["generate"],
  "@std/uuid/v4": ["generate"],
  "@std/uuid/v6": ["generate"],
  "@std/uuid/v7": ["generate"],
};

export function entropyModuleOf(spec: unknown): string | null {
  if (typeof spec !== "string") return null;
  let s = spec.replace(/^(?:npm|jsr):/, "");
  const pin = s.indexOf("@", 1);
  if (pin > 0) s = s.slice(0, pin);
  for (
    const k of Object.keys(NONDETERMINISTIC_IMPORTS).sort((a, b) =>
      b.length - a.length
    )
  ) {
    if (s === k || s.startsWith(`${k}/`)) return k;
  }
  return null;
}

const GLOBAL_ALIASES: ReadonlySet<string> = new Set([
  "globalThis",
  "self",
  "window",
]);

function isComputed(node: Deno.lint.Node): boolean {
  return (node as unknown as { computed?: boolean }).computed === true;
}

/** A member's statically readable key — `o.k` or `o["k"]` — else null. */
function memberKey(node: Deno.lint.MemberExpression): string | null {
  const prop = node.property;
  return isComputed(node)
    ? (prop.type === "Literal" && typeof prop.value === "string"
      ? prop.value
      : null)
    : (prop.type === "Identifier" ? prop.name : null);
}

function memberPath(
  node: Deno.lint.Node,
  globals: ReadonlySet<string> = GLOBAL_ALIASES,
): string[] | null {
  const path: string[] = [];
  let cur = node;
  while (cur.type === "MemberExpression") {
    const key = memberKey(cur);
    if (key === null) return null;
    path.unshift(key);
    cur = cur.object;
  }
  if (cur.type !== "Identifier") return null;
  path.unshift(cur.name);
  if (path.length > 1 && globals.has(path[0]!)) path.shift();
  return path;
}

/** The entropy module an `import("<spec>")` (awaited or not) loads, or null. */
function dynamicImportOf(node: Deno.lint.Node): string | null {
  const inner = node.type === "AwaitExpression" ? node.argument : node;
  if (inner.type !== "ImportExpression") return null;
  return inner.source.type === "Literal"
    ? entropyModuleOf(inner.source.value)
    : null;
}

export const noNondeterminismRule: Deno.lint.Rule = {
  create(context) {
    const sc = context.sourceCode as unknown as {
      text: string;
      getAllComments(): LintComment[];
    };
    const say = (node: Deno.lint.Node, body: string) => {
      if (hasEscapeValve(sc.text, sc.getAllComments(), rangeOf(node)[0])) {
        return;
      }
      context.report({
        node,
        message: lintMessage("lint/no-nondeterminism", body),
      });
    };
    const report = (node: Deno.lint.Node, spelling: string) =>
      say(
        node,
        `${spelling} is non-deterministic — read the clock through \`ctx.now()\`, and let the framework mint row ids (a test freezes both with \`testCtx({ now, idSeed })\`), or annotate \`// hazelnut-escape: <why>\``,
      );
    const reportUnreadable = (node: Deno.lint.Node, obj: string) =>
      say(
        node,
        `${obj}[…] takes a computed member of a non-deterministic namespace, and the key is not statically readable — so \`${obj}.${
          NONDETERMINISTIC_MEMBERS[obj]![0]
        }\` cannot be ruled out. Name the member, or annotate \`// hazelnut-escape: <why>\``,
      );
    const boundModules = new Map<string, string>();
    const boundObjects = new Map<string, string>();
    const globals = new Set(GLOBAL_ALIASES);
    const pending: Array<{ node: Deno.lint.Node; obj: string; mem: string }> =
      [];
    const viaGlobal: Array<
      { node: Deno.lint.Node; head: string; obj: string; mem: string }
    > = [];
    const destructured = (
      pattern: Deno.lint.Node,
      mod: string,
    ) => {
      if (pattern.type === "Identifier") {
        boundModules.set(pattern.name, mod);
        return;
      }
      if (pattern.type !== "ObjectPattern") return;
      for (const p of pattern.properties) {
        const key = propKeyName(p);
        if (key !== null && NONDETERMINISTIC_IMPORTS[mod]!.includes(key)) {
          report(p, `${mod}#${key}`);
        }
      }
    };
    return {
      MemberExpression(node) {
        const mod = dynamicImportOf(node.object);
        if (mod !== null) {
          const key = memberKey(node);
          if (
            key !== null && NONDETERMINISTIC_IMPORTS[mod]!.includes(key)
          ) {
            report(node, `${mod}#${key}`);
          }
          return;
        }
        const path = memberPath(node, globals);
        if (path === null) {
          const obj = memberPath(node.object, globals);
          if (
            obj?.length === 1 &&
            NONDETERMINISTIC_MEMBERS[obj[0]!] !== undefined
          ) reportUnreadable(node, obj[0]!);
          return;
        }
        if (path.length === 3) {
          viaGlobal.push({
            node,
            head: path[0]!,
            obj: path[1]!,
            mem: path[2]!,
          });
          return;
        }
        if (path.length !== 2) return;
        if (NONDETERMINISTIC_MEMBERS[path[0]!]?.includes(path[1]!)) {
          report(node, `${path[0]}.${path[1]}`);
          return;
        }
        pending.push({ node, obj: path[0]!, mem: path[1]! });
      },
      NewExpression(node) {
        const path = memberPath(node.callee);
        if (path?.length !== 1 || path[0] !== "Date") return;
        const args = node.arguments;
        if (
          args.length === 0 || args.every((a) => a.type === "SpreadElement")
        ) {
          report(node, "new Date()");
        }
      },
      CallExpression(node) {
        const path = memberPath(node.callee, globals);
        if (path?.length === 1 && path[0] === "Date") report(node, "Date()");
        // `import("<entropy>").then((m) => …)`: the callback's first parameter is the module
        const callee = node.callee;
        if (
          callee.type === "MemberExpression" &&
          callee.property.type === "Identifier" &&
          callee.property.name === "then"
        ) {
          const mod = dynamicImportOf(callee.object);
          const fn = node.arguments[0];
          const param = fn !== undefined &&
              (fn.type === "ArrowFunctionExpression" ||
                fn.type === "FunctionExpression")
            ? fn.params[0]
            : undefined;
          if (
            mod !== null &&
            (param?.type === "Identifier" || param?.type === "ObjectPattern")
          ) destructured(param, mod);
        }
      },
      VariableDeclarator(node) {
        if (!node.init) return;
        const mod = dynamicImportOf(node.init);
        if (mod !== null) {
          destructured(node.id, mod);
          return;
        }
        if (node.init.type === "Identifier" && node.id.type === "Identifier") {
          const from = node.init.name;
          if (globals.has(from)) globals.add(node.id.name);
          const obj = boundObjects.get(from);
          if (obj !== undefined) boundObjects.set(node.id.name, obj);
          const aliased = boundModules.get(from);
          if (aliased !== undefined) boundModules.set(node.id.name, aliased);
        }
        const path = memberPath(node.init, globals);
        if (path?.length !== 1) return;
        if (node.id.type === "Identifier") {
          if (NONDETERMINISTIC_MEMBERS[path[0]!] !== undefined) {
            boundObjects.set(node.id.name, path[0]!);
          }
          return;
        }
        if (node.id.type !== "ObjectPattern") return;
        if (globals.has(path[0]!)) {
          // `const { Date: D, crypto } = globalThis` binds the objects themselves
          for (const p of node.id.properties) {
            const key = propKeyName(p);
            if (
              p.type === "Property" && p.value.type === "Identifier" &&
              key !== null && NONDETERMINISTIC_MEMBERS[key] !== undefined
            ) boundObjects.set(p.value.name, key);
          }
          return;
        }
        const members = NONDETERMINISTIC_MEMBERS[path[0]!];
        if (members === undefined) return;
        for (const p of node.id.properties) {
          const key = propKeyName(p);
          if (key !== null && members.includes(key)) {
            report(p, `${path[0]}.${key}`);
          }
        }
      },
      ImportDeclaration(node) {
        const mod = entropyModuleOf(node.source.value);
        if (mod === null) return;
        const names = NONDETERMINISTIC_IMPORTS[mod]!;
        for (const s of node.specifiers) {
          if (
            s.type === "ImportNamespaceSpecifier" ||
            s.type === "ImportDefaultSpecifier"
          ) {
            boundModules.set(s.local.name, mod);
            continue;
          }
          if (s.type !== "ImportSpecifier") continue;
          const imported = s.imported;
          if (imported.type === "Identifier" && names.includes(imported.name)) {
            report(s, `${mod}#${imported.name}`);
          }
        }
      },
      "Program:exit"() {
        for (const g of viaGlobal) {
          if (
            globals.has(g.head) &&
            NONDETERMINISTIC_MEMBERS[g.obj]?.includes(g.mem)
          ) report(g.node, `${g.obj}.${g.mem}`);
        }
        for (const p of pending) {
          const mod = boundModules.get(p.obj);
          if (
            mod !== undefined &&
            NONDETERMINISTIC_IMPORTS[mod]!.includes(p.mem)
          ) {
            report(p.node, `${mod}#${p.mem}`);
            continue;
          }
          const obj = boundObjects.get(p.obj);
          if (
            obj !== undefined && NONDETERMINISTIC_MEMBERS[obj]!.includes(p.mem)
          ) {
            report(p.node, `${obj}.${p.mem}`);
          }
        }
      },
    };
  },
};
