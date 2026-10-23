import { DATA_ROW_READ_VERBS } from "../data/data-verb-names.ts";
import { isI18nSidecarName, propKeyName } from "./lint-helpers-node.ts";
import { readString } from "./module-specifiers.ts";
import {
  nameOf,
  sqlStatements,
  type SqlToken,
  wordOf,
} from "../data/sql-lex.ts";
import {
  withoutComments,
  withoutCommentsOrStrings,
  withoutCommentsStringsAndRegex,
} from "./source-view.ts";

/** True iff a table name is a FRAMEWORK-RESERVED table: a `_`-prefixed framework-owned table (`_audit`,
 *  `_outbox`, `_idempotency`, …) OR an `<r>_i18n` translation sidecar, reserved by suffix rather than prefix. */
export function isReservedFrameworkTable(name: string): boolean {
  return /^_/.test(name) || isI18nSidecarName(name);
}

/** Read the `immutable` config of a `defineResource` ObjectExpression as `{ table, whole, frozen }` —
 *  mirrors `wholeImmutable` (schema-normalize.ts): `true`, or an object form with no `fields` (e.g.
 *  `{ tamperEvident: true }`), is whole; `{ fields:[…] }` freezes just those. A resource with no
 *  `immutable` feature contributes nothing. */
export function immutableConfigOf(
  obj: Deno.lint.Node,
): { table: string; whole: boolean; frozen: Set<string> } | null {
  if (obj.type !== "ObjectExpression") return null;
  const nameProp = obj.properties.find((p) => propKeyName(p) === "name");
  if (
    nameProp?.type !== "Property" || nameProp.value.type !== "Literal" ||
    typeof nameProp.value.value !== "string"
  ) {
    return null;
  }
  const table = nameProp.value.value;
  const featuresProp = obj.properties.find((p) =>
    propKeyName(p) === "features"
  );
  if (
    featuresProp?.type !== "Property" ||
    featuresProp.value.type !== "ObjectExpression"
  ) return null;
  const imProp = featuresProp.value.properties.find((p) =>
    propKeyName(p) === "immutable"
  );
  if (imProp?.type !== "Property") return null;
  // whole-resource: `immutable: true`.
  if (imProp.value.type === "Literal" && imProp.value.value === true) {
    return { table, whole: true, frozen: new Set() };
  }
  // object form: `{ fields }` freezes those columns; `{ tamperEvident: true }` (fields
  // empty or absent, same rule `wholeImmutable` / `schema-normalize.ts` use) is WHOLE —
  // an append-only hash-chained ledger, not a partial freeze.
  if (imProp.value.type === "ObjectExpression") {
    const fieldsProp = imProp.value.properties.find((p) =>
      propKeyName(p) === "fields"
    );
    const frozen = new Set<string>();
    if (
      fieldsProp?.type === "Property" &&
      fieldsProp.value.type === "ArrayExpression"
    ) {
      for (const e of fieldsProp.value.elements) {
        if (e?.type === "Literal" && typeof e.value === "string") {
          frozen.add(e.value);
        }
      }
    }
    const tamperProp = imProp.value.properties.find((p) =>
      propKeyName(p) === "tamperEvident"
    );
    const tamperEvident = tamperProp?.type === "Property" &&
      tamperProp.value.type === "Literal" && tamperProp.value.value === true;
    if (tamperEvident || frozen.size === 0) {
      return { table, whole: true, frozen: new Set() };
    }
    return { table, whole: false, frozen };
  }
  return null;
}

/** Read the `scope` config of a `defineResource` ObjectExpression — true iff `features: { scope: true }` opts
 *  the table into row-scoping (`04-features.md §scope`). A resource with no `scope` feature contributes nothing. */
export function scopeConfigOf(obj: Deno.lint.Node): { table: string } | null {
  if (obj.type !== "ObjectExpression") return null;
  const nameProp = obj.properties.find((p) => propKeyName(p) === "name");
  if (
    nameProp?.type !== "Property" || nameProp.value.type !== "Literal" ||
    typeof nameProp.value.value !== "string"
  ) {
    return null;
  }
  const table = nameProp.value.value;
  const featuresProp = obj.properties.find((p) =>
    propKeyName(p) === "features"
  );
  if (
    featuresProp?.type !== "Property" ||
    featuresProp.value.type !== "ObjectExpression"
  ) return null;
  const scopeProp = featuresProp.value.properties.find((p) =>
    propKeyName(p) === "scope"
  );
  if (
    scopeProp?.type === "Property" && scopeProp.value.type === "Literal" &&
    scopeProp.value.value === true
  ) {
    return { table };
  }
  return null;
}

/** One raw-SQL write: its verb, target table, the columns a SET writes (the frozen-field probe), and
 *  whether it carries the `scope_key` stamp — named in an INSERT column list, constrained in an
 *  UPDATE/DELETE WHERE or a MERGE ON (on the target, never a joined table). */
export interface SqlWriteTarget {
  readonly verb: "insert" | "update" | "delete";
  readonly table: string;
  readonly setCols: Set<string>;
  readonly scopeStamped: boolean;
}

const SCOPE_KEY = "scope_key";
/** Words that end a table reference — none of them can be an alias. */
const NOT_ALIAS = new Set([
  "set",
  "where",
  "returning",
  "from",
  "using",
  "on",
  "when",
  "values",
  "select",
  "default",
  "overriding",
  "limit",
  "order",
  "group",
  "only",
  "with",
  "to",
  "and",
  "or",
]);

const isPunct = (t: SqlToken | undefined, text: string) =>
  t?.kind === "punct" && t.text === text;

/** `[schema.]table` at `i`: the table name (last segment) and the index after it. */
function qualifiedName(
  tokens: readonly SqlToken[],
  i: number,
): { table: string; next: number } | undefined {
  let table = nameOf(tokens[i]);
  if (table === undefined) return undefined;
  let j = i + 1;
  while (isPunct(tokens[j], ".") && nameOf(tokens[j + 1]) !== undefined) {
    table = nameOf(tokens[j + 1])!;
    j += 2;
  }
  if (isPunct(tokens[j], "*")) j++;
  return { table, next: j };
}

/** An optional `[AS] alias` at `j`. */
function aliasAt(
  tokens: readonly SqlToken[],
  j: number,
): { alias?: string; next: number } {
  if (wordOf(tokens[j]) === "as") {
    return { alias: nameOf(tokens[j + 1]), next: j + 2 };
  }
  const t = tokens[j];
  if (t?.kind === "ident" || (t?.kind === "word" && !NOT_ALIAS.has(t.text))) {
    return { alias: t.text, next: j + 1 };
  }
  return { next: j };
}

/** The index where the clause opened at `from` ends: a top-level stop word or a `)` closing its depth. */
function clauseEnd(
  tokens: readonly SqlToken[],
  from: number,
  stops: ReadonlySet<string>,
): number {
  let depth = 0;
  for (let k = from; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (isPunct(t, "(")) depth++;
    else if (isPunct(t, ")")) {
      if (depth === 0) return k;
      depth--;
    } else if (depth === 0 && t.kind === "word" && stops.has(t.text)) return k;
  }
  return tokens.length;
}

/** Does `tokens[from, to)` name `scope_key` unqualified or qualified by the target's name or alias? */
function namesScopeKey(
  tokens: readonly SqlToken[],
  from: number,
  to: number,
  target: string,
  alias: string | undefined,
): boolean {
  for (let k = from; k < to; k++) {
    if (nameOf(tokens[k]) !== SCOPE_KEY) continue;
    if (!isPunct(tokens[k - 1], ".")) return true;
    const q = nameOf(tokens[k - 2]);
    if (q === target || (alias !== undefined && q === alias)) return true;
  }
  return false;
}

/** The names in a parenthesised column list opening at `i`, and the index after its `)`. */
function columnList(
  tokens: readonly SqlToken[],
  i: number,
): { cols: string[]; next: number } | undefined {
  if (!isPunct(tokens[i], "(")) return undefined;
  const end = clauseEnd(tokens, i + 1, new Set());
  const cols: string[] = [];
  for (let k = i + 1; k < end; k++) {
    const n = nameOf(tokens[k]);
    if (n !== undefined) cols.push(n);
  }
  return { cols, next: end + 1 };
}

/** The columns a `SET` list starting at `i` assigns — `col = …`, `col[1] = …`, `(a, b) = (…)`. */
function setColumns(
  tokens: readonly SqlToken[],
  i: number,
  end: number,
): Set<string> {
  const cols = new Set<string>();
  let k = i;
  while (k < end) {
    if (isPunct(tokens[k], "(")) {
      const list = columnList(tokens, k);
      if (list !== undefined) {
        for (const c of list.cols) cols.add(c);
        k = list.next;
      }
    } else {
      const n = nameOf(tokens[k]);
      if (n !== undefined) cols.add(n);
      k++;
    }
    // skip the assigned expression up to the next top-level comma
    let depth = 0;
    while (k < end) {
      const t = tokens[k]!;
      if (isPunct(t, "(")) depth++;
      else if (isPunct(t, ")")) depth--;
      else if (depth === 0 && isPunct(t, ",")) {
        k++;
        break;
      }
      k++;
    }
  }
  return cols;
}

const UPDATE_STOPS = new Set(["where", "from", "returning"]);
const WHERE_STOPS = new Set(["returning"]);

/** Every write one statement's tokens perform, wherever it sits (a CTE body included). */
function statementWrites(tokens: readonly SqlToken[]): SqlWriteTarget[] {
  const out: SqlWriteTarget[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const w = wordOf(tokens[i]);
    const prev = wordOf(tokens[i - 1]);
    if (w === "insert" && wordOf(tokens[i + 1]) === "into") {
      const name = qualifiedName(tokens, i + 2);
      if (name === undefined) continue;
      const { alias, next } = aliasAt(tokens, name.next);
      const list = columnList(tokens, next);
      const stamped = list?.cols.includes(SCOPE_KEY) ?? false;
      out.push({
        verb: "insert",
        table: name.table,
        setCols: new Set(),
        scopeStamped: stamped,
      });
      // `ON CONFLICT … DO UPDATE SET` rewrites the conflicting row of the same table
      const end = clauseEnd(tokens, next, new Set());
      for (let k = next; k < end; k++) {
        if (wordOf(tokens[k]) === "do" && wordOf(tokens[k + 1]) === "update") {
          const setAt = k + 2;
          if (wordOf(tokens[setAt]) !== "set") break;
          const setEnd = clauseEnd(tokens, setAt + 1, UPDATE_STOPS);
          const whereEnd = clauseEnd(tokens, setEnd, WHERE_STOPS);
          out.push({
            verb: "update",
            table: name.table,
            setCols: setColumns(tokens, setAt + 1, setEnd),
            scopeStamped: stamped ||
              namesScopeKey(tokens, setEnd, whereEnd, name.table, alias),
          });
          break;
        }
      }
      continue;
    }
    if (
      w === "update" && prev !== "do" && prev !== "for" && prev !== "key"
    ) {
      let at = i + 1;
      if (wordOf(tokens[at]) === "only") at++;
      const name = qualifiedName(tokens, at);
      if (name === undefined) continue;
      const { alias, next } = aliasAt(tokens, name.next);
      if (wordOf(tokens[next]) !== "set") continue;
      const setEnd = clauseEnd(tokens, next + 1, UPDATE_STOPS);
      const whereEnd = clauseEnd(tokens, setEnd, WHERE_STOPS);
      out.push({
        verb: "update",
        table: name.table,
        setCols: setColumns(tokens, next + 1, setEnd),
        scopeStamped: namesScopeKey(
          tokens,
          setEnd,
          whereEnd,
          name.table,
          alias,
        ),
      });
      continue;
    }
    if (w === "delete" && wordOf(tokens[i + 1]) === "from") {
      let at = i + 2;
      if (wordOf(tokens[at]) === "only") at++;
      const name = qualifiedName(tokens, at);
      if (name === undefined) continue;
      const { alias, next } = aliasAt(tokens, name.next);
      const whereEnd = clauseEnd(tokens, next, WHERE_STOPS);
      out.push({
        verb: "delete",
        table: name.table,
        setCols: new Set(),
        scopeStamped: namesScopeKey(tokens, next, whereEnd, name.table, alias),
      });
      continue;
    }
    if (w === "truncate") {
      let at = i + 1;
      if (wordOf(tokens[at]) === "table") at++;
      for (;;) {
        if (wordOf(tokens[at]) === "only") at++;
        const name = qualifiedName(tokens, at);
        if (name === undefined) break;
        out.push({
          verb: "delete",
          table: name.table,
          setCols: new Set(),
          scopeStamped: false,
        });
        if (!isPunct(tokens[name.next], ",")) break;
        at = name.next + 1;
      }
      continue;
    }
    if (w === "copy") {
      const name = qualifiedName(tokens, i + 1);
      if (name === undefined) continue;
      const list = columnList(tokens, name.next);
      if (wordOf(tokens[list?.next ?? name.next]) !== "from") continue;
      out.push({
        verb: "insert",
        table: name.table,
        setCols: new Set(),
        scopeStamped: list?.cols.includes(SCOPE_KEY) ?? false,
      });
      continue;
    }
    if (w === "merge" && wordOf(tokens[i + 1]) === "into") {
      let at = i + 2;
      if (wordOf(tokens[at]) === "only") at++;
      const name = qualifiedName(tokens, at);
      if (name === undefined) continue;
      const { alias, next } = aliasAt(tokens, name.next);
      const onAt = clauseEnd(tokens, next, new Set(["on"]));
      const onEnd = clauseEnd(tokens, onAt + 1, new Set(["when"]));
      const onStamped = namesScopeKey(
        tokens,
        onAt + 1,
        onEnd,
        name.table,
        alias,
      );
      const end = clauseEnd(tokens, onEnd, new Set());
      for (let k = onEnd; k < end; k++) {
        if (wordOf(tokens[k]) !== "then") continue;
        const action = wordOf(tokens[k + 1]);
        if (action === "update" && wordOf(tokens[k + 2]) === "set") {
          const setEnd = clauseEnd(tokens, k + 3, new Set(["when"]));
          out.push({
            verb: "update",
            table: name.table,
            setCols: setColumns(tokens, k + 3, setEnd),
            scopeStamped: onStamped,
          });
        } else if (action === "delete") {
          out.push({
            verb: "delete",
            table: name.table,
            setCols: new Set(),
            scopeStamped: onStamped,
          });
        } else if (action === "insert") {
          const list = columnList(tokens, k + 2);
          out.push({
            verb: "insert",
            table: name.table,
            setCols: new Set(),
            scopeStamped: list?.cols.includes(SCOPE_KEY) ?? false,
          });
        }
      }
    }
  }
  return out;
}

/** A raw-SQL string's writes — one entry per INSERT/UPDATE/DELETE/MERGE action, TRUNCATE target, `COPY …
 *  FROM` and `ON CONFLICT DO UPDATE`, read through the shared lexer so comments, literals and quoted
 *  identifiers mean what they mean to Postgres (`"issuedAt"` keeps its case; a word folds to lower). */
export function sqlWriteTargets(sql: string): SqlWriteTarget[] {
  return sqlStatements(sql).flatMap((s) => statementWrites(s.tokens));
}

/** True iff `callee` is `ctx.modules.<dep>.<member>` — the cross-module SYNC door (`05-runtime.md §ctx.modules`).
 *  Returns the `<dep>` and `<member>` segments, or null when the shape does not match. The chain is
 *  `((ctx.modules).<dep>).<member>` — a 3-deep MemberExpression rooted at `ctx.modules`. */
export function ctxModulesCall(
  callee: Deno.lint.Node,
): { dep: string; member: string } | null {
  if (
    callee.type !== "MemberExpression" || callee.property.type !== "Identifier"
  ) return null;
  const member = callee.property.name;
  const depMember = callee.object; // ctx.modules.<dep>
  if (
    depMember.type !== "MemberExpression" ||
    depMember.property.type !== "Identifier"
  ) return null;
  const dep = depMember.property.name;
  const modulesMember = depMember.object; // ctx.modules
  if (modulesMember.type !== "MemberExpression") return null;
  if (
    modulesMember.object.type !== "Identifier"
  ) return null;
  if (
    modulesMember.property.type !== "Identifier" ||
    modulesMember.property.name !== "modules"
  ) return null;
  return { dep, member };
}

/** The read-shaped members that, called on `ctx.modules.<dep>.<member>`, pull a producer's RAW Row across the
 *  module boundary (`boundary/cross-read-narrowed`): the CRUD reads + a bare `.row`/`.rows` raw-row pull. A
 *  cross-module read MUST go through a declared `exposesRead` narrowing view, never one of these raw-row doors. */
export const RAW_ROW_READ_MEMBERS = new Set([
  "list",
  "find",
  "get",
  "row",
  "rows",
  "all",
]);

// `policy/custom-read-applies-rowpolicy`: the structural rung's `handler.toString()` check misses a raw read factored
// out of the handler — this static rule follows named local bindings and relative-import helpers/SQL
// constants. Dynamic dispatch and computed binding graphs remain review residuals.

/** A raw `SELECT … FROM <table>` — qualified or bare — or the drizzle builder door. BOTH alternatives are
 *  anchored to the `select` that roots the read: a bare `from(` also matches `Array.from(`, and a bare
 *  `FROM <table>` also matches the `DELETE FROM` of an ordinary write, so an unrelated idiom would turn the
 *  whole op into a reported leak. The lint rung has no model to know which tables declare a rowPolicy, so
 *  any raw READ without a re-applied fragment fires. */
const CUSTOM_READ_FROM_TABLE =
  /\bselect\b[\s\S]*?\bfrom\s+"?[a-z_][a-z0-9_]*"?(?:\s*\.\s*"?[a-z_][a-z0-9_]*"?)?|\bselect\s*\([\s\S]*?\)\s*\.\s*from\s*\(/i;
/** A rowPolicy fragment RE-APPLICATION — `buildReadWhere(` or a `rowPolicy`/`rowPolicies` CALL/member. Mirrors the
 *  the structural rung's `REAPPLIES` regex: a re-call of the same fragment is the sanctioned escalation path (never a drop). */
const CUSTOM_READ_REAPPLIES =
  /\bbuildReadWhere\s*\(|\browPolic(?:y|ies)\b\s*[.(]/;

/** Fold string literals, templates and concatenation. Unknown operands remain a visible token, never evaluated. */
export function sqlExpressionText(
  node: unknown,
): { readonly text: string; readonly dynamic: boolean } | null {
  if (node === null || typeof node !== "object" || !("type" in node)) {
    return null;
  }
  const value = node as {
    readonly type: string;
    readonly [key: string]: unknown;
  };
  if (
    (value.type === "Literal" || value.type === "StringLiteral") &&
    typeof value.value === "string"
  ) return { text: value.value, dynamic: false };
  if (
    value.type === "TemplateLiteral" && Array.isArray(value.quasis) &&
    Array.isArray(value.expressions)
  ) {
    let text = "", dynamic = false;
    for (const [index, quasi] of value.quasis.entries()) {
      if (quasi === null || typeof quasi !== "object") return null;
      const contents = quasi.value;
      const cooked = typeof quasi.cooked === "string"
        ? quasi.cooked
        : contents !== null && typeof contents === "object" &&
            "cooked" in contents &&
            typeof contents.cooked === "string"
        ? contents.cooked
        : null;
      if (cooked === null) return null;
      text += cooked;
      if (index < value.expressions.length) {
        const expression = sqlExpressionText(value.expressions[index]);
        text += expression?.text ?? "__dynamic__";
        dynamic ||= expression === null || expression.dynamic;
      }
    }
    return { text, dynamic };
  }
  if (value.type !== "BinaryExpression" || value.operator !== "+") return null;
  const left = sqlExpressionText(value.left),
    right = sqlExpressionText(value.right);
  if (left === null && right === null) return null;
  return {
    text: (left?.text ?? "__dynamic__") + (right?.text ?? "__dynamic__"),
    dynamic: left === null || right === null || left.dynamic || right.dynamic,
  };
}

/** Literal runs in source-reader rungs, without a parser/runtime dependency in the published lint plugin. */
function sqlLiteralRuns(source: string): string[] {
  const code = withoutComments(source), out: string[] = [];
  for (let i = 0; i < code.length; i++) {
    const quote = code[i];
    if (quote !== "'" && quote !== '"' && quote !== "`") continue;
    let literal = readString(code, i, quote), text = literal.value;
    if (quote === "`") {
      // A literal interpolation contributes fixed text, just like adjacent literal operands.
      text = text.replace(
        /\$\{\s*((?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'))\s*\}/g,
        (_, expression: string) =>
          readString(expression, 0, expression[0] as "'" | '"').value,
      );
    }
    i = literal.end - 1;
    while (true) {
      const after = /^\s*\+\s*/.exec(code.slice(literal.end));
      if (after === null) break;
      const next = literal.end + after[0].length, delimiter = code[next];
      if (delimiter !== "'" && delimiter !== '"' && delimiter !== "`") {
        text += "__dynamic__";
        break;
      }
      literal = readString(code, next, delimiter);
      text += literal.value;
      i = literal.end - 1;
    }
    out.push(text);
  }
  return out;
}

/** First arguments of actual raw query calls, using code-only offsets so comments/strings are not calls. */
export function rawQueryArguments(
  source: string,
  methods: readonly string[] = ["query", "execute", "unsafe"],
): string[] {
  const code = withoutCommentsStringsAndRegex(source), out: string[] = [];
  for (const match of code.matchAll(/\.\s*(query|execute|unsafe)\b/g)) {
    if (!methods.includes(match[1]!)) continue;
    let open = match.index! + match[0].length;
    while (/\s/.test(code[open] ?? "")) open++;
    if (code[open] === "<") {
      let angle = 0, braces = 0, parens = 0;
      let closed = false;
      for (; open < code.length; open++) {
        const c = code[open];
        if (
          code.slice(open, open + 2) === "&&" ||
          code.slice(open, open + 2) === "||" || (c === ";" && braces === 0)
        ) break;
        if (c === "{") braces++;
        else if (c === "}") { if (--braces < 0) break; }
        else if (c === "(") parens++;
        else if (c === ")") { if (--parens < 0) break; }
        if (c === "<") angle++;
        else if (c === ">" && code[open - 1] !== "=") {
          if (--angle === 0) {
            open++;
            closed = true;
            break;
          }
        }
      }
      if (!closed) continue;
      while (/\s/.test(code[open] ?? "")) open++;
    }
    if (code[open] !== "(") continue;
    const start = open + 1;
    let paren = 0, bracket = 0, brace = 0;
    for (let end = start; end < code.length; end++) {
      const c = code[end];
      if (
        (c === "," || c === ")") && paren === 0 && bracket === 0 && brace === 0
      ) {
        out.push(source.slice(start, end));
        break;
      }
      if (c === "(") paren++;
      else if (c === ")") paren--;
      else if (c === "[") bracket++;
      else if (c === "]") bracket--;
      else if (c === "{") brace++;
      else if (c === "}") brace--;
    }
  }
  return out;
}

/** A reached immutable SQL value may carry the SELECT while its caller carries the query door. */
export function sqlConstantEvidence(source: string): string | null {
  const expression = source.replace(
    /^\s*(?:export\s+)?const\s+[A-Za-z_$][\w$]*(?:\s*:[^=]+)?\s*=\s*/,
    "",
  );
  if (!/^\s*["'`]/.test(expression)) return null;
  return sqlLiteralRuns(expression)[0] ?? null;
}

/** True iff a source slice is a raw protected read that DROPS the rowPolicy — a raw-read door + a `FROM <table>`
 *  with NO fragment re-application. The single predicate the inline-handler, same-file-helper and imported-helper
 *  paths use. The ACCUSING probes read comment-free source (the SQL survives — it is a string literal); the
 *  EXCUSING one reads code only, so `// re-apply rowPolicy( actor )` cannot stand in for the call. */
export function isUnguardedRawRead(src: string): boolean {
  const code = withoutComments(src);
  if (
    !/\.\s*db\b/.test(withoutCommentsStringsAndRegex(src)) &&
    rawQueryArguments(src, ["query"]).length === 0
  ) return false;
  if (CUSTOM_READ_REAPPLIES.test(withoutCommentsOrStrings(src))) return false;
  if (CUSTOM_READ_FROM_TABLE.test(code)) return true;
  // A keyword split over literal operands is the same SQL. Preserve an unknown table operand as a token.
  return sqlLiteralRuns(src).some((sql) => CUSTOM_READ_FROM_TABLE.test(sql));
}

/** Every row-carrying read except the explicit locking read. The full facade roster is the source of truth:
 *  collection reads (`list`, `byIds`, tree reads, and search) can feed the same blind update as `find*`. */
const UNLOCKED_ROW_READ_VERBS: ReadonlySet<string> = new Set(
  DATA_ROW_READ_VERBS.filter((v: string) => v !== "findForUpdate"),
);

/** `<receiver>.<verb>(` — the identifier immediately before the verb. */
const RECEIVER_CALL = /([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;

const LOCAL_ALIAS = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\b/g;
const VARIABLE_BINDING =
  /\b(?:const|let|var)\s+(\{[^}]*\}|\[[^\]]*\]|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?\s*=/g;
const ADDITIONAL_BINDING =
  /,\s*(\{[^}]*\}|\[[^\]]*\]|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?\s*=/g;
const FUNCTION_PARAMETERS =
  /\bfunction(?:\s+[A-Za-z_$][\w$]*)?\s*\(([^)]*)\)|\bcatch\s*\(([^)]*)\)/g;
const ARROW_PARAMETERS = /\(([^()]*)\)\s*=>|\b([A-Za-z_$][\w$]*)\s*=>/g;

const esc = (name: string): string =>
  name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Names that ARE the data facade within one source slice: a parameter the caller handed `ctx.data`,
 *  `const { data } = ctx` (or `{ data: d }`), and `const d = ctx.data`. Each makes `<name>.<resource>.<verb>()`
 *  a direct facade call, exactly as `ctx.data.<resource>.<verb>()` is. */
export function dataFacadeNames(
  code: string,
  contextParam: string | null,
  dataParam: string | null,
): string[] {
  const out = new Set<string>();
  if (dataParam !== null) out.add(dataParam);
  if (contextParam === null) return [...out];
  const ctx = esc(contextParam);
  for (
    const m of code.matchAll(
      new RegExp(`\\bconst\\s*\\{([^}]*)\\}\\s*=\\s*${ctx}\\b(?!\\s*\\.)`, "g"),
    )
  ) {
    for (const part of m[1]!.split(",")) {
      const [property, local = property] = part.split(":").map((s) => s.trim());
      if (property === "data" && /^[A-Za-z_$][\w$]*$/.test(local ?? "")) {
        out.add(local!);
      }
    }
  }
  for (
    const m of code.matchAll(
      new RegExp(
        `\\bconst\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${ctx}\\s*\\.\\s*data(?![\\w$])(?!\\s*\\.)`,
        "g",
      ),
    )
  ) out.add(m[1]!);
  return [...out];
}

/** Local receiver alias → canonical data-facade resource name, within ONE source slice. Keeping this map
 *  per function prevents a helper's local `repo` from being confused with an unrelated `repo` in its caller.
 *  Only unique `const` bindings are followed: reassignment and shadowed or multiply-declared names are too
 *  ambiguous for this source-only pass, so they are deliberately left unpaired. */
function ctxDataReceiverAliases(
  code: string,
  contextParam: string | null,
  facades: readonly string[] = [],
): Map<string, string> {
  const declarationCounts = new Map<string, number>();
  const countBindings = (pattern: string) => {
    for (const name of pattern.match(/[A-Za-z_$][\w$]*/g) ?? []) {
      declarationCounts.set(name, (declarationCounts.get(name) ?? 0) + 1);
    }
  };
  const declarations = new Map<number, string>();
  for (const re of [VARIABLE_BINDING, ADDITIONAL_BINDING]) {
    for (const m of code.matchAll(re)) declarations.set(m.index!, m[1]!);
  }
  for (const pattern of declarations.values()) countBindings(pattern);
  for (const re of [FUNCTION_PARAMETERS, ARROW_PARAMETERS]) {
    for (const m of code.matchAll(re)) {
      countBindings(m[1] ?? m[2] ?? "");
    }
  }

  const roots = new Map<string, string>();
  const escapedContext = contextParam?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const facadeExpr = [
    ...(escapedContext !== undefined
      ? [`\\b${escapedContext}\\s*\\.\\s*data`]
      : []),
    ...facades.map((f) => `(?<![\\w$.])${esc(f)}`),
  ];
  const facade = facadeExpr.length > 0 ? `(?:${facadeExpr.join("|")})` : null;
  if (facade !== null) {
    const alias = new RegExp(
      `\\bconst\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:await\\s+)?${facade}\\s*\\.\\s*([A-Za-z_$][\\w$]*)(?![\\w$])(?!\\s*\\.)`,
      "g",
    );
    for (const m of code.matchAll(alias)) roots.set(m[1]!, m[2]!);
  }
  const aliasRefs: Array<readonly [string, string]> = [];
  if (facade !== null) {
    const destructure = new RegExp(
      `\\bconst\\s*\\{([^}]*)\\}\\s*=\\s*${facade}\\b`,
      "g",
    );
    for (const m of code.matchAll(destructure)) {
      for (const part of m[1]!.split(",")) {
        const [property, local = property] = part.split(":").map((s) =>
          s.trim()
        );
        if (
          property !== undefined && local !== undefined &&
          /^[A-Za-z_$][\w$]*$/.test(property) &&
          /^[A-Za-z_$][\w$]*$/.test(local)
        ) roots.set(local, property);
      }
    }
  }
  // Resolve ordinary local alias chains (`const current = repo`) to their originating resource. The bounded
  // pass is enough for the finite declaration graph and avoids treating a vendor/local object as a repo.
  for (const m of code.matchAll(LOCAL_ALIAS)) {
    if (m[1] !== m[2]) aliasRefs.push([m[1]!, m[2]!]);
  }
  const aliases = new Map<string, string>();
  for (let pass = 0; pass <= aliasRefs.length; pass++) {
    let changed = false;
    for (const [local, resource] of roots) {
      if (declarationCounts.get(local) !== 1 || aliases.has(local)) continue;
      aliases.set(local, resource);
      changed = true;
    }
    for (const [local, source] of aliasRefs) {
      if (
        declarationCounts.get(local) !== 1 ||
        declarationCounts.get(source) !== 1 || aliases.has(local)
      ) continue;
      const resource = aliases.get(source);
      if (resource === undefined) continue;
      aliases.set(local, resource);
      changed = true;
    }
    if (!changed) break;
  }
  return aliases;
}

/** A source slice with a shadowed context identifier cannot prove which `.data` binding it reads. */
function splitTopLevel(source: string, separator: string): string[] {
  const parts: string[] = [];
  let start = 0;
  const stack: string[] = [];
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (pairs[char] !== undefined) stack.push(pairs[char]!);
    else if (stack.at(-1) === char) stack.pop();
    else if (char === separator && stack.length === 0) {
      parts.push(source.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(source.slice(start));
  return parts;
}

function topLevelIndex(source: string, token: string): number {
  const stack: string[] = [];
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (pairs[char] !== undefined) stack.push(pairs[char]!);
    else if (stack.at(-1) === char) stack.pop();
    else if (char === token && stack.length === 0) return i;
  }
  return -1;
}

function bindingPatternContains(pattern: string, identifier: string): boolean {
  let binding = pattern.trim().replace(/^\.\.\./, "");
  binding = binding.replace(
    /^(?:(?:public|private|protected|readonly|override|declare)\s+)+/,
    "",
  );
  const defaultIndex = topLevelIndex(binding, "=");
  if (defaultIndex >= 0) binding = binding.slice(0, defaultIndex).trim();
  const typeIndex = topLevelIndex(binding, ":");
  if (typeIndex >= 0) binding = binding.slice(0, typeIndex).trim();

  if (binding.startsWith("{") && binding.endsWith("}")) {
    return splitTopLevel(binding.slice(1, -1), ",").some((property) => {
      const colonIndex = topLevelIndex(property, ":");
      return bindingPatternContains(
        colonIndex >= 0 ? property.slice(colonIndex + 1) : property,
        identifier,
      );
    });
  }
  if (binding.startsWith("[") && binding.endsWith("]")) {
    return splitTopLevel(binding.slice(1, -1), ",").some((element) =>
      bindingPatternContains(element, identifier)
    );
  }
  return binding === identifier;
}

function parameterBindsIdentifier(
  parameters: string,
  identifier: string,
): boolean {
  return splitTopLevel(parameters, ",").some((parameter) =>
    bindingPatternContains(parameter, identifier)
  );
}

function balancedParenthesizedContents(
  source: string,
  openIndex: number,
): { readonly contents: string; readonly closeIndex: number } | null {
  let depth = 0;
  for (let index = openIndex; index < source.length; index++) {
    if (source[index] === "(") depth++;
    else if (source[index] === ")" && --depth === 0) {
      return {
        contents: source.slice(openIndex + 1, index),
        closeIndex: index,
      };
    }
  }
  return null;
}

function nestedParameterLists(source: string): string[] {
  const signatures = new Map<number, string>();
  const add = (openIndex: number) => {
    const group = balancedParenthesizedContents(source, openIndex);
    if (group !== null) signatures.set(openIndex, group.contents);
  };
  for (
    const match of source.matchAll(
      /\bfunction(?:\s+[A-Za-z_$][\w$]*)?\s*\(/g,
    )
  ) {
    add(match.index! + match[0].lastIndexOf("("));
  }
  for (
    const match of source.matchAll(
      /(?:^|[,{;]\s*|}\s*)(?!(?:if|for|while|switch|catch|with)\b)(?:(?:async|static|public|private|protected|readonly|override|get|set)\s+)*\*?#?[A-Za-z_$][\w$]*\s*\(/g,
    )
  ) {
    add(match.index! + match[0].lastIndexOf("("));
  }
  for (const match of source.matchAll(/\(/g)) {
    const openIndex = match.index!;
    const group = balancedParenthesizedContents(source, openIndex);
    if (group === null) continue;
    if (/^\s*=>/.test(source.slice(group.closeIndex + 1))) add(openIndex);
  }
  for (const match of source.matchAll(/\b([A-Za-z_$][\w$]*)\s*=>/g)) {
    signatures.set(match.index!, match[1]!);
  }
  return [...signatures].sort(([a], [b]) => a - b).map(([, parameters]) =>
    parameters
  );
}

function contextIdentifierIsShadowed(
  source: string,
  contextParam: string,
): boolean {
  const code = withoutCommentsStringsAndRegex(source);
  const escaped = contextParam.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (
    new RegExp(
      `\\b(?:const|let|var|class|function)\\s+(?:${escaped}\\b|\\{[^}]*\\b${escaped}\\b|\\[[^\\]]*\\b${escaped}\\b)`,
    ).test(code)
  ) return true;
  if (
    new RegExp(
      `\\bcatch\\s*\\(\\s*(?:${escaped}\\b|\\{[^}]*\\b${escaped}\\b|\\[[^\\]]*\\b${escaped}\\b)`,
    ).test(code)
  ) return true;

  const parameterLists = nestedParameterLists(code);
  // The first signature is this source slice's own function. A later occurrence is a nested lexical binding.
  return parameterLists.slice(1).some((params) =>
    parameterBindsIdentifier(params, contextParam)
  );
}

/** True iff reachable source slices read a row unlocked and update THAT SAME data-facade resource. Resource
 *  identity, not a local variable's spelling, is paired across the handler/helper boundary. The scope stays
 *  intentionally narrow: a foreign mongo/cache/vendor receiver has no repo remedies and must not be accused. */
export function isUnlockedReadModifyWriteSources(
  sources: readonly {
    readonly source: string;
    readonly contextParam: string | null;
    readonly dataParam?: string | null;
  }[],
): boolean {
  const called = new Map<string, Set<string>>();
  for (const { source, contextParam, dataParam = null } of sources) {
    if (
      contextParam !== null &&
      contextIdentifierIsShadowed(source, contextParam)
    ) continue;
    const code = withoutCommentsOrStrings(source);
    const facades = dataFacadeNames(code, contextParam, dataParam);
    const facadeTail = facades.length > 0
      ? new RegExp(`(?<![\\w$.])(?:${facades.map(esc).join("|")})\\s*\\.$`)
      : null;
    const aliases = ctxDataReceiverAliases(code, contextParam, facades);
    for (const m of code.matchAll(RECEIVER_CALL)) {
      const receiverStart = m.index!;
      const prefix = code.slice(0, receiverStart);
      // `<context>.data.widget.find()` is a direct resource call. A bare `repo.find()` must be rooted through a local
      // alias in this same function slice; names are never carried across caller/helper scopes.
      const escapedContext = contextParam?.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&",
      );
      const direct = (escapedContext !== undefined &&
        new RegExp(`\\b${escapedContext}\\s*\\.\\s*data\\s*\\.$`).test(
          prefix,
        )) || (facadeTail !== null && facadeTail.test(prefix));
      const resource = direct ? m[1]! : aliases.get(m[1]!);
      if (resource === undefined) continue;
      const verbs = called.get(resource) ?? new Set<string>();
      verbs.add(m[2]!);
      called.set(resource, verbs);
    }
  }
  for (const verbs of called.values()) {
    if (!verbs.has("update")) continue;
    if ([...verbs].some((v) => UNLOCKED_ROW_READ_VERBS.has(v))) return true;
  }
  return false;
}

/** Single-slice adapter retained for the focused helper and foreign-receiver tests. */
export function isUnlockedReadModifyWrite(src: string): boolean {
  return isUnlockedReadModifyWriteSources([{
    source: src,
    contextParam: "ctx",
  }]);
}

/** The property keys the op-decl TYPE forces an author to write (`TxDecisionSlot`, core/pipeline-defs.ts):
 *  `policy` is required on BOTH tx branches, and `tx` is the branch selector. Either one, on an object that
 *  also carries a function `handler`, identifies an op declaration written outside `operations:`/`defineOp`.
 *  Keying on the DECLARATION rather than on `tx:"read"` is what puts a default-tx (write) op in scope — the
 *  handler returns the same rows whichever transaction it runs in. */
const OP_DECISION_KEYS = new Set(["policy", "tx"]);

/** True iff an op-object property is one of the tx-decision keys the op type requires. */
export function isOpDecisionProperty(p: Deno.lint.Node): boolean {
  return p.type === "Property" && p.key.type === "Identifier" &&
    OP_DECISION_KEYS.has(p.key.name);
}
