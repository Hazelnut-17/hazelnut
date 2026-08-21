// Rule group extracted from lint-plugin.ts — the plugin object spreads these back in (composition, not codegen).
import { lintMessage } from "../runtime/channels.ts";
import {
  isQueriesSeam,
  type LintComment,
  protectedWriteMapsInScope,
  rangeOf,
  RAW_SQL,
} from "./lint-helpers-node.ts";
import {
  ALGEBRA_VALUE_NAMES,
  importedLocalNames,
  isRowPolicySpecFile,
  isTypeOnlyImport,
  specifierOrigin,
  TYPE_IMPORT_WHITELIST,
  valueImportedNames,
} from "./lint-helpers-seam.ts";
import {
  immutableConfigOf,
  isReservedFrameworkTable,
  scopeConfigOf,
  sqlWriteTargets,
} from "./lint-helpers-sql.ts";

export const specRules: Record<string, Deno.lint.Rule> = {
  // The door is the import's ORIGIN, never its spelling. Keying on the spec's own stem judged only an impl
  // that happened to be NAMED after the resource, so the direct copy went silent the moment the rowPolicy sat
  // in `domain.module.ts` — the layout the reference consumer itself uses — and any barrel defeated it outright.
  "spec-aliases-impl": {
    create(context) {
      if (!isRowPolicySpecFile(context.filename)) return {};
      return {
        ImportDeclaration(node) {
          if (
            node.source.type !== "Literal" ||
            typeof node.source.value !== "string"
          ) return;
          const source = node.source.value;
          if (specifierOrigin(source) !== "app") return; // the framework's own helpers, and third-party packages, are not the impl
          // (1) a value import of app source — every app module can re-export or wrap the rowPolicy, so the
          // whole origin is the copy door, forbidden outright.
          if (
            !isTypeOnlyImport(node) && valueImportedNames(node).length > 0
          ) {
            context.report({
              node,
              message: lintMessage(
                "spec/aliases-impl",
                `a rowpolicy.spec may not value-import this app's own source ('${source}') — the spec must be derived INDEPENDENTLY of the rowPolicy, never copy it (a barrel or a differently-named module reaches the same impl); state the rule as a plain business-term boolean over the actor and row`,
              ),
            });
            return;
          }
          // (2) a type import of app source re-couples the spec to the impl's vocabulary. `import type` is
          // whitelisted ONLY for `Actor`/`Row` (+ their field types), never a type pulled from the app.
          const names = importedLocalNames(node).filter((n) =>
            !TYPE_IMPORT_WHITELIST.has(n)
          );
          if (names.length > 0) {
            context.report({
              node,
              message: lintMessage(
                "spec/aliases-impl",
                `a rowpolicy.spec may not type-import this app's own types (${
                  names.join(", ")
                }) — only \`Actor\`, \`Row<R>\` and the field types they name are import-type-exempt; an app type re-couples the spec to the impl`,
              ),
            });
          }
        },
      };
    },
  },
  // `spec/uses-algebra` (static, WARN, silenceable): a `<r>.rowpolicy.spec.ts` spec may NOT value-import the
  // Condition algebra (`eq/and/or/all/none/…/toDrizzle/evaluate`/field-proxy) nor call `evaluate` / construct a
  // Condition — the spec is a DIFFERENT abstraction than the algebra (a plain business-term boolean), so leaning
  // on the algebra is a same-vocabulary copy (13-authz.md §spec-independence). Silenced ONLY by a declared
  // `// hazelnut-handrolled: spec-uses-algebra — <why>` (the rare legitimate date-window mirror). Gated to the spec
  // file. WARN (not ship): a date-window mirror is sometimes legitimate, so this surfaces, not blocks.
  "spec-uses-algebra": {
    create(context) {
      if (!isRowPolicySpecFile(context.filename)) return {};
      const sc = context.sourceCode as unknown as {
        getAllComments(): LintComment[];
      };
      // the file-level silence marker — a declared `// hazelnut-handrolled: spec-uses-algebra — <why>` anywhere
      // in the file opts this spec out (the legitimate date-window mirror). The reason text is not validated.
      const silenced = sc.getAllComments().some((c) =>
        /hazelnut-handrolled:\s*spec-uses-algebra\b/.test(c.value)
      );
      if (silenced) return {};
      const msg =
        "a rowpolicy.spec may not use the Condition algebra (eq/and/or/all/none/…/evaluate/field-proxy) — the spec is a plain business-term boolean, a DIFFERENT abstraction than the impl's algebra; reaching for it is a same-vocabulary copy. Silence a legitimate date-window mirror with `// hazelnut-handrolled: spec-uses-algebra — <why>`";
      const algebraLocals = new Set<string>();
      return {
        // a VALUE import of an algebra builder — the import door into the algebra. Judged on the imported
        // NAME plus the origin, because a consumer reaches the algebra as `hazelnut/query`, never as a
        // relative `./where.ts`: matching the specifier's basename left this door shut in every real app.
        ImportDeclaration(node) {
          if (
            node.source.type !== "Literal" ||
            typeof node.source.value !== "string"
          ) return;
          if (specifierOrigin(node.source.value) === "external") return;
          for (const name of valueImportedNames(node)) {
            if (ALGEBRA_VALUE_NAMES.has(name)) {
              algebraLocals.add(name);
              context.report({
                node,
                message: lintMessage("spec/uses-algebra", msg),
              });
            }
          }
        },
        // a CALL to `evaluate(...)` (the lowering/evaluation door) or to an imported algebra builder — even
        // if the import slipped past (a re-export), calling the algebra is the same reach.
        CallExpression(node) {
          if (node.callee.type !== "Identifier") return;
          const name = node.callee.name;
          if (name === "evaluate" || algebraLocals.has(name)) {
            context.report({
              node,
              message: lintMessage("spec/uses-algebra", msg),
            });
          }
        },
      };
    },
  },
  // `spec/vacuous` (13-authz.md §spec-independence, SHIP): a syntactic-constant spec (`() => true`/`false`),
  // or one that ignores its params, is flagged — the floor only; a real tautology is undecidable here (review/golden oracles catch it).
  "spec-vacuous": {
    create(context) {
      if (!isRowPolicySpecFile(context.filename)) return {};
      const sc = context.sourceCode as unknown as { text: string };
      const msg =
        "the row-visibility spec is vacuous — a constant `() => true`/`() => false` (or a body that ignores its actor/row params) verifies nothing; state a real predicate over the actor and row";
      // examine the `export const spec = <fn>` initializer's function value.
      const checkSpecFn = (fn: Deno.lint.Node, reportNode: Deno.lint.Node) => {
        if (
          fn.type !== "ArrowFunctionExpression" &&
          fn.type !== "FunctionExpression" && fn.type !== "FunctionDeclaration"
        ) return;
        const body = fn.body;
        if (body === null) return;
        // (a) a syntactic-constant arrow `(…) => true` / `=> false` — the body IS a boolean literal.
        if (
          body.type === "Literal" &&
          typeof (body as { value?: unknown }).value === "boolean"
        ) {
          context.report({
            node: reportNode,
            message: lintMessage("spec/vacuous", msg),
          });
          return;
        }
        // (b) params not referenced: the named params do not appear as identifiers in the body source span.
        const paramNames = fn.params
          .map((p) => (p.type === "Identifier" ? p.name : null))
          .filter((n): n is string =>
            n !== null && n !== "_" && !n.startsWith("_")
          );
        if (paramNames.length === 0) {
          // all params are `_`-elided (or destructured-away) — the author signalled "ignores its inputs".
          // a block body that returns a constant is the same vacuity; flag when there are declared-but-elided params.
          if (fn.params.length > 0) {
            context.report({
              node: reportNode,
              message: lintMessage("spec/vacuous", msg),
            });
          }
          return;
        }
        const [bs, be] = rangeOf(body);
        const bodyText = sc.text.slice(bs, be);
        const referencesAParam = paramNames.some((n) =>
          new RegExp(`\\b${n}\\b`).test(bodyText)
        );
        if (!referencesAParam) {
          context.report({
            node: reportNode,
            message: lintMessage("spec/vacuous", msg),
          });
        }
      };
      return {
        // `export const spec = (actor, row) => …` — the convention export the framework loads.
        VariableDeclarator(node) {
          if (
            node.id.type !== "Identifier" || node.id.name !== "spec" ||
            !node.init
          ) return;
          checkSpecFn(node.init, node);
        },
        // `export default function spec(actor, row) { … }` / `export const spec = function … ` covered above;
        // a function-DECLARATION named `spec` (the less-common form) is handled here.
        FunctionDeclaration(node) {
          if (node.id?.type === "Identifier" && node.id.name === "spec") {
            checkSpecFn(node, node);
          }
        },
      };
    },
  },
  // `sql/protected-write` (queries/ seam only): a raw-SQL write may not target a framework-reserved table,
  // a frozen immutable column, or an unstamped `scope`d resource — static floor; at-rest isolation needs REVOKE/RLS.
  "sql-protected-write": {
    create(context) {
      if (!isQueriesSeam(context.filename)) return {}; // raw DML only lives in queries/ → only judge there.
      // the file-wide immutable-resource map, accumulated as `defineResource` literals are visited (a queries/
      // file may co-locate the declaration, mirroring encrypted/no-where's file-wide encrypted set).
      const immutables = new Map<
        string,
        { whole: boolean; frozen: Set<string> }
      >();
      // the file-wide scoped-resource set — same co-located self-contained read.
      const scoped = new Set<string>();
      const reservedMsg = (t: string) =>
        `a queries/ raw write to the framework-reserved table "${t}" is forbidden — INSERT/UPDATE/DELETE on \`_audit\`/\`_outbox\`/\`<r>_i18n\`/… forges or erases append-only framework provenance; only the framework repo writes these. (Static floor — at-rest immutability still needs the deploy REVOKE role model.)`;
      const wholeMsg = (t: string) =>
        `a queries/ raw write to the whole-\`immutable\` resource "${t}" is forbidden — \`immutable:true\` is set-once/append-only, so a raw UPDATE/DELETE re-sets or erases a frozen row, bypassing the type + repo guards. (Static floor — at-rest immutability still needs the deploy REVOKE role model.)`;
      const frozenMsg = (t: string, c: string) =>
        `a queries/ raw UPDATE of the frozen field "${c}" on field-immutable resource "${t}" is forbidden — \`immutable:{fields}\` makes it set-once, so a raw SET re-sets a frozen field; a write to a MUTABLE column of "${t}" is clean. (Static floor — at-rest immutability still needs the deploy REVOKE role model.)`;
      const scopeMsg = (t: string, verb: string) =>
        verb === "insert"
          ? `a queries/ raw INSERT into the \`scope\`d resource "${t}" must name \`scope_key\` in its column list — the repo path stamps \`scope_key\` by-construction, but the raw seam is NOT scope-injected, so an unstamped INSERT writes a cross-scope (or empty-scope) row. Add \`scope_key\` to the columns. (Static floor for literal raw writes — airtight isolation is the deploy RLS role model.)`
          : `a queries/ raw ${verb.toUpperCase()} on the \`scope\`d resource "${t}" must constrain \`scope_key\` in its WHERE — the repo path AND-filters \`scope_key\` by-construction, but the raw seam is NOT scope-injected, so an unconstrained ${verb.toUpperCase()} writes/erases across scopes. Add \`scope_key = …\` to the WHERE. (Static floor for literal raw writes — airtight isolation is the deploy RLS role model.)`;
      // collected raw-SQL write sites; scanned at Program:exit so the immutable/scope maps (built from a
      // declaration that may appear after the query in source) are complete — order-independent.
      const sqlSites: Array<{ node: Deno.lint.Node; sql: string }> = [];
      return {
        // build the file-wide immutable- and scoped-resource maps from each co-located `defineResource` literal.
        ObjectExpression(node) {
          const cfg = immutableConfigOf(node);
          if (cfg !== null) {
            immutables.set(cfg.table, { whole: cfg.whole, frozen: cfg.frozen });
          }
          const sc = scopeConfigOf(node);
          if (sc !== null) scoped.add(sc.table);
        },
        // a raw-SQL template literal — join the static quasis (the table/column names are static text).
        TemplateLiteral(node) {
          const text = node.quasis.map((q) => q.raw).join(" ");
          if (RAW_SQL.test(text)) sqlSites.push({ node, sql: text });
        },
        // a raw-SQL string literal.
        Literal(node) {
          if (typeof node.value === "string" && RAW_SQL.test(node.value)) {
            sqlSites.push({ node, sql: node.value });
          }
        },
        "Program:exit"() {
          const dirMaps = protectedWriteMapsInScope(context.filename);
          for (const [t, cfg] of dirMaps.immutables) {
            if (!immutables.has(t)) {
              immutables.set(t, {
                whole: cfg.whole,
                frozen: new Set(cfg.frozen),
              });
            }
          }
          for (const t of dirMaps.scoped) scoped.add(t);
          for (const { node, sql } of sqlSites) {
            for (const w of sqlWriteTargets(sql)) {
              // (96) framework-reserved `_`-table / `<r>_i18n` sidecar — name-based, no model needed.
              if (isReservedFrameworkTable(w.table)) {
                context.report({
                  node,
                  message: lintMessage(
                    "sql/protected-write",
                    reservedMsg(w.table),
                  ),
                });
                continue;
              }
              // (97) a declared-immutable business resource — model-aware (co-located immutable config).
              const im = immutables.get(w.table);
              if (im?.whole) {
                // whole-immutable: any write (INSERT/UPDATE/DELETE) re-sets/erases a set-once row.
                context.report({
                  node,
                  message: lintMessage(
                    "sql/protected-write",
                    wholeMsg(w.table),
                  ),
                });
                continue;
              }
              if (im !== undefined) {
                // field-immutable: only an UPDATE whose SET clause touches a frozen column is a fault.
                for (const col of w.setCols) {
                  if (im.frozen.has(col)) {
                    context.report({
                      node,
                      message: lintMessage(
                        "sql/protected-write",
                        frozenMsg(w.table, col),
                      ),
                    });
                    break; // one finding per write statement (a multi-frozen-col SET is the same offence).
                  }
                }
              }
              // a `scope`d resource — the write must carry its `scope_key` stamp (INSERT names the column;
              // UPDATE/DELETE constrains it in WHERE). Runs alongside the immutable check (orthogonal faults).
              if (scoped.has(w.table) && !w.scopeStamped) {
                context.report({
                  node,
                  message: lintMessage(
                    "sql/protected-write",
                    scopeMsg(w.table, w.verb),
                  ),
                });
              }
            }
          }
        },
      };
    },
  },
};
