/**
 * THE SAFETY FLOOR — the 9 source-lint rules a core consumer's own `deno lint` must run, so the shipped
 * artifact carries the floor and not only the paid discipline. These are the `FLOOR_LOCKED` ids
 * (the FLOOR_LOCKED safety-floor ids): SQL injection, the row-policy read leak, actor fabrication,
 * an encrypted-column WHERE, and the three spec-honesty rules that keep `impl \u22a8 spec` from passing
 * vacuously. A project config may never mute a floor id; carving them out of the public artifact was the
 * stronger version of the same hole — muted rules read as absent, absent rules read as clean.
 *
 * CORE, not the capability module: the implementations reach only the AST helpers (now
 * `invariants/lint-helpers-*.ts`) and `runtime/channels.ts` — no capability-module reach — so
 * ships them clean. The remaining 24 discipline rules stay in the full plugin, which
 * composes THIS floor with its own.
 */
import { lintMessage } from "../runtime/channels.ts";
import {
  encryptedColsInScope,
  encryptedColsOf,
  equalityColsOf,
  exportedBindingSource,
  fieldAccessorCol,
  isLogicSeam,
  isQueriesSeam,
  rangeOf,
  RAW_SQL,
  resolveRelative,
  WHERE_BUILDERS,
} from "./lint-helpers-node.ts";
import {
  calledIdentifiersIn,
  handlerFnOf,
  referencedSymbolsIn,
} from "./lint-helpers-seam.ts";
import {
  isOpDecisionProperty,
  isUnguardedRawRead,
} from "./lint-helpers-sql.ts";
import { specRules } from "./lint-rules-floor-spec.ts";

/** The five floor rules that lived beside discipline rules in the capability module's rule groups;
 *  the spec quartet is `specRules`, moved whole (every rule in that file is floor). */
const miscFloorRules: Record<string, Deno.lint.Rule> = {
  "no-actor-fabrication": {
    create(context) {
      // Two subjects, two scopes. `userActor` / `{ claims }` are the AUTHN SEAM's own idiom — a resolver
      // mints them for a living — so those stay logic-gated. `systemActor` mints the framework's branded
      // rowPolicy-write-bypass principal and belongs to NO app seam, so it is ungated: an auth resolver was
      // the shipped way around the gate, and every forgery of the brand needs one real call to make.
      const logic = isLogicSeam(context.filename);
      return {
        CallExpression(node) {
          const callee = node.callee;
          if (callee.type !== "Identifier") return;
          if (callee.name === "systemActor") {
            context.report({
              node,
              message: lintMessage(
                "authz/actor-from-seam",
                "app code must not mint the framework system principal — `systemActor(...)` is the rowPolicy write-bypass the framework mints for its own rails (outbox relay, purge, workflow); an app cannot need one, and a resolver returning one skips the row rule on every write. Read the caller via ctx.actor",
              ),
            });
            return;
          }
          if (logic && callee.name === "userActor") {
            context.report({
              node,
              message: lintMessage(
                "authz/actor-from-seam",
                `logic must not fabricate an actor — \`${callee.name}(...)\` mints authority the authn seam owns; read the caller via ctx.actor, never re-mint it`,
              ),
            });
          }
        },
        // an Actor-shaped object literal (`{ claims: ... }`) — hand-rolling the actor shape to forge authority.
        ObjectExpression(node) {
          if (!logic) return;
          const hasClaims = node.properties.some((p) =>
            p.type === "Property" && p.key.type === "Identifier" &&
            p.key.name === "claims"
          );
          if (hasClaims) {
            context.report({
              node,
              message: lintMessage(
                "authz/actor-from-seam",
                "logic must not hand-roll an Actor-shaped `{ claims: ... }` literal — authority comes from the authn seam as ctx.actor, never a forged claims set",
              ),
            });
          }
        },
      };
    },
  },
  "raw-sql-only-in-queries": {
    create(context) {
      if (isQueriesSeam(context.filename)) return {}; // the sanctioned seam — raw SQL is allowed here.
      const msg =
        "raw SQL is allowed only in the `queries/` seam — move this read into a queries/ file behind ctx.query";
      return {
        TemplateLiteral(node) {
          if (node.quasis.some((q) => RAW_SQL.test(q.raw))) {
            context.report({
              node,
              message: lintMessage("sql/raw-only-in-queries", msg),
            });
          }
        },
        Literal(node) {
          if (typeof node.value === "string" && RAW_SQL.test(node.value)) {
            context.report({
              node,
              message: lintMessage("sql/raw-only-in-queries", msg),
            });
          }
        },
      };
    },
  },
  "sql-parameterized": {
    create(context) {
      const msg =
        "SQL must be parameterized — interpolating a value into the SQL string is an injection vector; use a bound parameter";
      return {
        // raw-SQL template literal with an interpolation (`${...}`) → a value spliced into the statement.
        TemplateLiteral(node) {
          if (node.expressions.length === 0) return; // no interpolation → nothing spliced.
          if (node.quasis.some((q) => RAW_SQL.test(q.raw))) {
            context.report({
              node,
              message: lintMessage("sql/parameterized", msg),
            });
          }
        },
        // `"... SELECT/INSERT/UPDATE/DELETE ..." + x` — a `+` chain whose string side opens a raw statement.
        BinaryExpression(node) {
          if (node.operator !== "+") return;
          const sidesHaveSql = [node.left, node.right].some(
            (s) =>
              s.type === "Literal" && typeof s.value === "string" &&
              RAW_SQL.test(s.value),
          );
          // require a non-string operand (the value being concatenated in) so `"a " + "b "` of two
          // string literals is not flagged — the injection is a runtime value joined to SQL text.
          const sidesHaveValue = [node.left, node.right].some((s) =>
            s.type !== "Literal"
          );
          if (sidesHaveSql && sidesHaveValue) {
            context.report({
              node,
              message: lintMessage("sql/parameterized", msg),
            });
          }
        },
      };
    },
  },
  "encrypted-no-where": {
    create(context) {
      const msg =
        "no WHERE/filter over an encrypted column — ciphertext is an unordered bytea envelope, so a predicate over the plaintext never matches the stored bytes (it silently returns nothing)";
      // The encrypted column set in scope: this file's own declaration literals UNION its module's. A
      // file-only set is empty in any app obeying `placement/declaration` + `placement/logic`, which put the
      // declaration and the where-authoring handler in different files by rule.
      const inScope = encryptedColsInScope(context.filename);
      const fileEncryptedSet = new Set<string>(inScope.encrypted);
      // the equality-declared subset (04-features.md §encrypted equality): eq/inArray/isNull over these ARE
      // legal — rewritten onto the `<f>_bidx` blind index. Ranges/likes stay flagged (impossible on a keyed MAC).
      const fileEqualitySet = new Set<string>(inScope.equality);
      const EQUALITY_LEGAL_BUILDERS = new Set(["eq", "inArray", "isNull"]);
      // a `where:` / `rowPolicy:` value's shorthand-object keys that name an encrypted column — the object-shorthand path.
      const reportShorthandKeys = (value: Deno.lint.Node, enc: Set<string>) => {
        if (value.type !== "ObjectExpression") return;
        for (const p of value.properties) {
          if (
            p.type === "Property" && p.key.type === "Identifier" &&
            enc.has(p.key.name) && !fileEqualitySet.has(p.key.name)
          ) {
            context.report({
              node: p,
              message: lintMessage("encrypted/no-where", msg),
            }); // shorthand = eq semantics — equality-declared fields are exempt
          }
        }
      };
      const walkObject = (obj: Deno.lint.Node) => {
        const enc = new Set(encryptedColsOf(obj));
        if (enc.size === 0 || obj.type !== "ObjectExpression") return;
        for (const p of obj.properties) {
          if (p.type !== "Property" || p.key.type !== "Identifier") continue;
          if (p.key.name === "where" || p.key.name === "rowPolicy") {
            // an arrow `(ctx) => ({ ssn: … })` / `(a) => eq(fields.ssn, …)` body, or a bare object shorthand.
            const body = (p.value.type === "ArrowFunctionExpression" ||
                p.value.type === "FunctionExpression")
              ? p.value.body
              : p.value;
            if (body.type === "ObjectExpression") {
              reportShorthandKeys(body, enc);
            }
          }
        }
        // builder calls anywhere inside this declaration object (`eq(fields.ssn, …)` in a where body) — flagged by
        // scanning the object's own source span for the builder + encrypted-accessor shape via a CallExpression walk.
      };
      return {
        // (a) the builder-call path: `eq(fields.<enc>, …)`. We resolve the encrypted set from the nearest enclosing
        // declaration object by scanning all declaration objects in the file and matching the accessor column.
        CallExpression(node) {
          if (
            node.callee.type !== "Identifier" ||
            !WHERE_BUILDERS.has(node.callee.name)
          ) return;
          const col = fieldAccessorCol(node.arguments[0]);
          if (col === null) return;
          // the encrypted set is the union of every declaration object's `encrypted` list in this file (a where over
          // an encrypted column is a fault regardless of which co-located declaration owns the encrypted decl).
          if (
            fileEncryptedSet.has(col) &&
            !(fileEqualitySet.has(col) &&
              EQUALITY_LEGAL_BUILDERS.has(node.callee.name))
          ) {
            context.report({
              node,
              message: lintMessage("encrypted/no-where", msg),
            });
          }
        },
        // (b) build the file-wide encrypted set + flag the object-shorthand where/rowPolicy path per declaration object.
        ObjectExpression(node) {
          for (const c of encryptedColsOf(node)) fileEncryptedSet.add(c);
          for (const c of equalityColsOf(node)) fileEqualitySet.add(c);
          walkObject(node);
        },
      };
    },
  },
  "custom-read-applies-rowpolicy": {
    create(context) {
      const sc = context.sourceCode as unknown as { text: string };
      const text = sc.text;
      // The message says "a table", not "a protected table": this rung has no model, so it cannot know whether
      // the table declares a rowPolicy — claiming it does would misreport the one case the author can check.
      const msg =
        "a custom op raw-reads a table without re-applying the rowPolicy — an escalated read must REUSE the fragment (route through ctx.data/ctx.reads or re-call buildReadWhere/the rowPolicy), never silently drop it (directly, via a same-file helper, OR via one imported from the queries/ seam), or a row-scoped read becomes a whole-table leak. Every op is judged whatever its `tx`: the handler returns the same rows in a write transaction";
      // file-local function bodies: name → source slice of the body. Resolved at exit so a helper declared
      // AFTER the op (decl-after-use) is still resolvable when the handler is examined.
      const helperBodies = new Map<string, string>();
      const recordHelper = (name: string, fn: Deno.lint.Node) => {
        if (
          fn.type === "ArrowFunctionExpression" ||
          fn.type === "FunctionExpression" || fn.type === "FunctionDeclaration"
        ) {
          const [s, e] = rangeOf(fn);
          helperBodies.set(name, text.slice(s, e));
        }
      };
      // local binding name → the relative file it comes from + the name exported there.
      const imported = new Map<string, { file: string; name: string }>();
      const namespaces = new Map<string, string>(); // `import * as q` → local `q` → file
      // start offsets of object literals that are op declarations BY POSITION — the argument of `defineOp(…)`
      // and each member of an `operations:` literal. Recorded from the parent node, so an op decl that omits
      // both tx-decision keys (a type error, but a shape source text can still hold) is still in scope.
      const opByPosition = new Set<number>();
      // each op handler found: its inline source, the symbols it references, and a report node.
      const readHandlers: Array<
        {
          src: string;
          calls: Set<string>;
          refs: ReturnType<typeof referencedSymbolsIn>;
          node: Deno.lint.Node;
        }
      > = [];
      return {
        // a value import with a RELATIVE specifier — the only hop resolvable from source alone.
        ImportDeclaration(node) {
          if (
            (node as unknown as { importKind?: string }).importKind === "type"
          ) {
            return; // erased at runtime — cannot be the read
          }
          const spec = typeof node.source.value === "string"
            ? node.source.value
            : "";
          const file = resolveRelative(context.filename, spec);
          if (file === null) return;
          for (const s of node.specifiers) {
            if (
              (s as unknown as { importKind?: string }).importKind === "type"
            ) continue;
            if (s.type === "ImportNamespaceSpecifier") {
              namespaces.set(s.local.name, file);
            } else if (s.type === "ImportDefaultSpecifier") {
              imported.set(s.local.name, { file, name: "default" });
            } else if (s.type === "ImportSpecifier") {
              const from = s.imported.type === "Identifier"
                ? s.imported.name
                : s.local.name;
              imported.set(s.local.name, { file, name: from });
            }
          }
        },
        // `function helper(){…}` — a named same-module helper declaration.
        FunctionDeclaration(node) {
          if (node.id?.type === "Identifier") recordHelper(node.id.name, node);
        },
        // `const helper = (…) => …` / `= function(){…}` — a const-bound same-module helper.
        VariableDeclarator(node) {
          if (node.id.type === "Identifier" && node.init) {
            recordHelper(node.id.name, node.init);
          }
        },
        // `defineOp({…})` — the declared op-decl position; its argument is an op whatever keys it spells.
        CallExpression(node) {
          if (
            node.callee.type === "Identifier" && node.callee.name === "defineOp"
          ) {
            const arg = node.arguments[0];
            if (arg?.type === "ObjectExpression") {
              opByPosition.add(rangeOf(arg)[0]);
            }
          }
        },
        // `operations: { <name>: {…} }` — the other declared op-decl position (a resource's own op map).
        Property(node) {
          if (
            node.key.type !== "Identifier" || node.key.name !== "operations" ||
            node.value.type !== "ObjectExpression"
          ) return;
          for (const p of node.value.properties) {
            if (p.type === "Property" && p.value.type === "ObjectExpression") {
              opByPosition.add(rangeOf(p.value)[0]);
            }
          }
        },
        // an op-object literal with a function `handler` — record it for the exit pass. `tx` is NOT the gate:
        // a default-tx (write) handler hands the caller the same rows a `tx:"read"` one does.
        ObjectExpression(node) {
          if (
            !opByPosition.has(rangeOf(node)[0]) &&
            !node.properties.some(isOpDecisionProperty)
          ) return;
          const fn = handlerFnOf(node);
          if (fn === null) return; // an op-object without a function handler (e.g. a string ref) is out of scope here.
          const [s, e] = rangeOf(fn);
          const src = text.slice(s, e);
          readHandlers.push({
            src,
            calls: calledIdentifiersIn(text, fn),
            refs: referencedSymbolsIn(text, fn),
            node,
          });
        },
        "Program:exit"() {
          const report = (node: Deno.lint.Node) =>
            context.report({
              node,
              message: lintMessage("policy/custom-read-applies-rowpolicy", msg),
            });
          for (const h of readHandlers) {
            // INLINE: the handler body itself is an unguarded raw read.
            if (isUnguardedRawRead(h.src)) {
              report(h.node);
              continue; // one finding per op-handler — the leak is the same offence whether inline or one-hop.
            }
            // ONE-HOP, SAME FILE: a helper the handler calls is itself an unguarded raw read. This is the door the
            // runtime verifier cannot see (the helper body is excluded from handler.toString()).
            const localLeak = [...h.calls].some((name) => {
              const body = helperBodies.get(name);
              return body !== undefined && isUnguardedRawRead(body);
            });
            if (localLeak) {
              report(h.node);
              continue;
            }
            // ONE-HOP, ACROSS THE IMPORT GRAPH: the `queries/` seam the framework's own placement rules push the
            // raw SQL into. A binding that cannot be resolved (unreadable file, bare specifier) is NOT judged.
            const targets: Array<{ file: string; name: string }> = [];
            for (const name of h.refs.names) {
              const t = imported.get(name);
              if (t !== undefined) targets.push(t);
            }
            for (const [ns, props] of h.refs.members) {
              const file = namespaces.get(ns);
              if (file === undefined) continue;
              for (const p of props) targets.push({ file, name: p });
            }
            const importedLeak = targets.some((t) => {
              const body = exportedBindingSource(t.file, t.name);
              return body !== null && isUnguardedRawRead(body);
            });
            if (importedLeak) report(h.node);
          }
        },
      };
    },
  },
};

/** The 9-rule safety floor: the five above plus the spec quartet. */
export const floorRules: Record<string, Deno.lint.Rule> = {
  ...miscFloorRules,
  ...specRules,
};

/** The dash-key -> canonical slash-id map for the floor rules only — the core half of the split
 *  `RULE_CANONICAL_IDS` was. The full plugin unions this with the discipline ids. */
export const FLOOR_RULE_CANONICAL_IDS: Readonly<Record<string, string>> = {
  "no-actor-fabrication": "authz/actor-from-seam",
  "raw-sql-only-in-queries": "sql/raw-only-in-queries",
  "sql-parameterized": "sql/parameterized",
  "encrypted-no-where": "encrypted/no-where",
  "custom-read-applies-rowpolicy": "policy/custom-read-applies-rowpolicy",
  "spec-aliases-impl": "spec/aliases-impl",
  "spec-uses-algebra": "spec/uses-algebra",
  "spec-vacuous": "spec/vacuous",
  "sql-protected-write": "sql/protected-write",
};

/** The floor plugin a core consumer wires via `lint.plugins`. Same `hazelnut/` namespace as the full
 *  plugin — a consumer holds one or the other, never both. */
const floorPlugin: Deno.lint.Plugin = {
  name: "hazelnut",
  rules: floorRules,
};

export default floorPlugin;
