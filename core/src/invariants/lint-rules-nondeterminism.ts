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

function memberPath(node: Deno.lint.Node): string[] | null {
  const path: string[] = [];
  let cur = node;
  while (cur.type === "MemberExpression") {
    const prop = cur.property;
    const key = isComputed(cur)
      ? (prop.type === "Literal" && typeof prop.value === "string"
        ? prop.value
        : null)
      : (prop.type === "Identifier" ? prop.name : null);
    if (key === null) return null;
    path.unshift(key);
    cur = cur.object;
  }
  if (cur.type !== "Identifier") return null;
  path.unshift(cur.name);
  if (path.length > 1 && GLOBAL_ALIASES.has(path[0]!)) path.shift();
  return path;
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
    const pending: Array<{ node: Deno.lint.Node; obj: string; mem: string }> =
      [];
    return {
      MemberExpression(node) {
        const path = memberPath(node);
        if (path === null) {
          const obj = memberPath(node.object);
          if (
            obj?.length === 1 &&
            NONDETERMINISTIC_MEMBERS[obj[0]!] !== undefined
          ) reportUnreadable(node, obj[0]!);
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
        const path = memberPath(node.callee);
        if (path?.length === 1 && path[0] === "Date") report(node, "Date()");
      },
      VariableDeclarator(node) {
        if (!node.init) return;
        const path = memberPath(node.init);
        if (path?.length !== 1) return;
        if (node.id.type === "Identifier") {
          if (NONDETERMINISTIC_MEMBERS[path[0]!] !== undefined) {
            boundObjects.set(node.id.name, path[0]!);
          }
          return;
        }
        if (node.id.type !== "ObjectPattern") return;
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
