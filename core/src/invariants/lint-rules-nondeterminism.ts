/**
 * The clock and randomness rule backing the published core lint-floor export.
 * The object/member and module/export rosters are also consumed by its exhaustive tests.
 */
import { lintMessage } from "../runtime/channels.ts";
import {
  hasEscapeValve,
  type LintComment,
  rangeOf,
} from "./lint-helpers-node.ts";
import {
  StaticBindings,
  type StaticReference,
  unwrapStatic,
} from "./lint-static-bindings.ts";

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

/** A real global object, including a statically resolved alias of globalThis/self/window. */
function globalObject(
  reference: StaticReference,
): { name: string; members: readonly (string | null)[] } | null {
  if (reference.origin.kind !== "global") return null;
  const { name } = reference.origin;
  if (!GLOBAL_ALIASES.has(name)) return { name, members: reference.members };
  const object = reference.members[0];
  return typeof object === "string"
    ? { name: object, members: reference.members.slice(1) }
    : null;
}

export const noNondeterminismRule: Deno.lint.Rule = {
  create(context) {
    const sc = context.sourceCode as unknown as {
      text: string;
      getAllComments(): LintComment[];
    };
    const bindings = new StaticBindings(context);
    const reported = new Set<string>();
    const say = (node: Deno.lint.Node, body: string) => {
      if (hasEscapeValve(sc.text, sc.getAllComments(), rangeOf(node)[0])) {
        return;
      }
      const key = `${rangeOf(node)[0]}:${body}`;
      if (reported.has(key)) return;
      reported.add(key);
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
    const read = (node: Deno.lint.Node, reference: StaticReference | null) => {
      if (reference === null) return;
      const object = globalObject(reference);
      if (object !== null && object.members.length === 1) {
        const members = NONDETERMINISTIC_MEMBERS[object.name];
        if (members === undefined) return;
        const member = object.members[0];
        if (member === null) {
          say(
            node,
            `${object.name}[…] takes a computed member of a non-deterministic namespace, and the key is not statically readable — so \`${object.name}.${
              members[0]
            }\` cannot be ruled out. Name the member, or annotate \`// hazelnut-escape: <why>\``,
          );
        } else if (member !== undefined && members.includes(member)) {
          report(node, `${object.name}.${member}`);
        }
        return;
      }
      if (reference.origin.kind !== "import") return;
      const mod = entropyModuleOf(reference.origin.source);
      if (mod === null) return;
      const names = NONDETERMINISTIC_IMPORTS[mod]!;
      const path = reference.origin.name === "*"
        ? reference.members
        : [reference.origin.name, ...reference.members];
      if (
        path.length === 1 && typeof path[0] === "string" &&
        names.includes(path[0])
      ) report(node, `${mod}#${path[0]}`);
    };
    const members: Deno.lint.MemberExpression[] = [];
    const constructors: Deno.lint.NewExpression[] = [];
    const calls: Deno.lint.CallExpression[] = [];
    const imports: Deno.lint.ImportDeclaration[] = [];
    const patterns: Array<{ pattern: Deno.lint.Node; value: Deno.lint.Node }> =
      [];
    return {
      MemberExpression(node) {
        members.push(node);
      },
      NewExpression(node) {
        constructors.push(node);
      },
      CallExpression(node) {
        calls.push(node);
        const callee = unwrapStatic(node.callee);
        if (
          callee.type !== "MemberExpression" || bindings.key(callee) !== "then"
        ) return;
        const imported = unwrapStatic(callee.object);
        if (imported.type !== "ImportExpression") return;
        const fn = node.arguments[0];
        if (
          fn?.type !== "ArrowFunctionExpression" &&
          fn?.type !== "FunctionExpression"
        ) return;
        const parameter = fn.params[0];
        // Parameter properties are constructor syntax, never a module-receiving callback binding.
        if (
          parameter === undefined || parameter.type === "TSParameterProperty"
        ) return;
        bindings.parameter(parameter, imported, fn);
        patterns.push({ pattern: parameter, value: imported });
      },
      AssignmentExpression(node) {
        bindings.assignment(node);
      },
      VariableDeclarator(node) {
        bindings.variable(node);
        if (node.init) patterns.push({ pattern: node.id, value: node.init });
      },
      ImportDeclaration(node) {
        bindings.imports(node);
        imports.push(node);
      },
      "Program:exit"() {
        for (const node of members) read(node, bindings.reference(node));
        for (const { pattern, value } of patterns) {
          const reference = bindings.reference(value);
          if (reference === null) continue;
          for (const entry of bindings.patternReads(pattern, reference)) {
            read(entry.node, entry.reference);
          }
        }
        for (const node of imports) {
          for (const spec of node.specifiers) {
            if (spec.type === "ImportSpecifier") {
              read(spec, bindings.reference(spec.local));
            }
          }
        }
        for (const node of [...constructors, ...calls]) {
          const reference = bindings.reference(node.callee);
          const object = reference && globalObject(reference);
          if (object?.name !== "Date") continue;
          if (node.type === "NewExpression") {
            if (object.members.length !== 0) continue;
            if (
              node.arguments.length === 0 ||
              node.arguments.every((a) => a.type === "SpreadElement")
            ) report(node, "new Date()");
          } else if (
            object.members.length === 0 || object.members.length === 1 &&
              (object.members[0] === "call" || object.members[0] === "apply")
          ) report(node, "Date()");
        }
      },
    };
  },
};
