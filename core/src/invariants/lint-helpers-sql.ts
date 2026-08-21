import { isI18nSidecarName, propKeyName } from "./lint-helpers-node.ts";
import { withoutComments, withoutCommentsOrStrings } from "./source-view.ts";

/** A raw-SQL WRITE-position keyword + its target table (capture 1), quote-stripped. `INSERT INTO <t>` /
 *  `UPDATE <t> SET` / `DELETE FROM <t>` — a SELECT never matches, so a legitimate read stays clean. The
 *  optional leading `<schema>.` is consumed and DISCARDED: under schema-per-module the qualified form is the
 *  norm, and capturing its first segment names the schema, not the table — every consumer arm then no-ops. The
 *  `g` flag walks every write statement in a multi-statement string. */
const SQL_WRITE_TARGET =
  /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:"?[a-z_][a-z0-9_]*"?\s*\.\s*)?"?([a-z_][a-z0-9_]*)"?/gi;
/** The `SET` clause assignment columns of an `UPDATE … SET <col> = …, "<col2>" = …` — capture-1 over the
 *  comma list up to the first `WHERE`/`RETURNING`/`;`/end. Each `<col> =` left-hand side is a written column
 *  (the frozen-field target). */
const SQL_SET_CLAUSE = /\bSET\b([\s\S]*?)(?:\bWHERE\b|\bRETURNING\b|;|$)/i;
const SQL_SET_COL = /"?([a-z_][a-z0-9_]*)"?\s*=/gi;

/** True iff a table name is a FRAMEWORK-RESERVED table: a `_`-prefixed framework-owned table (`_audit`,
 *  `_outbox`, `_idempotency`, …) OR an `<r>_i18n` translation sidecar, reserved by suffix rather than prefix. */
export function isReservedFrameworkTable(name: string): boolean {
  return /^_/.test(name) || isI18nSidecarName(name);
}

/** Read the `immutable` config of a `defineResource` ObjectExpression as `{ table, whole, frozen }` —
 *  `whole:true` for `immutable:true` (entire row set-once), `frozen:Set` for `immutable:{fields:[…]}`. A
 *  resource with no `immutable` feature contributes nothing. */
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
  // field-level: `immutable: { fields: ["ref", "total"] }`.
  if (imProp.value.type === "ObjectExpression") {
    const fieldsProp = imProp.value.properties.find((p) =>
      propKeyName(p) === "fields"
    );
    if (
      fieldsProp?.type === "Property" &&
      fieldsProp.value.type === "ArrayExpression"
    ) {
      const frozen = new Set(
        fieldsProp.value.elements.flatMap((e) =>
          e?.type === "Literal" && typeof e.value === "string" ? [e.value] : []
        ),
      );
      if (frozen.size > 0) return { table, whole: false, frozen };
    }
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

/** The fixed framework scope column (`faces.ts` mints `scope_key` on every scoped table). A scope-stamped write
 *  carries this exact column — INSERT names it in the column list, UPDATE/DELETE constrains it in the WHERE. */
const SCOPE_KEY_COL = /(?:^|[^a-z0-9_])"?scope_key"?(?:[^a-z0-9_]|$)/i;
/** The named column list of an `INSERT INTO <t> ( … ) VALUES` — capture-1 is the parenthesised list, or null
 *  for a positional `INSERT … VALUES` (no column names → `scope_key` cannot be confirmed → treated as unstamped). */
const SQL_INSERT_COLS =
  /\(([\s\S]*?)\)\s*(?:VALUES|SELECT|OVERRIDING|DEFAULT)/i;
/** The `WHERE` clause of an UPDATE/DELETE — capture-1 is everything from `WHERE` to `RETURNING`/`;`/end. A write
 *  with no WHERE matches nothing → unconstrained (and therefore not scope-constrained). */
const SQL_WHERE_CLAUSE = /\bWHERE\b([\s\S]*?)(?:\bRETURNING\b|;|$)/i;

/** A raw-SQL string's WRITE-position hits as `{ verb, table, setCols, scopeStamped }` — one entry per
 *  INSERT/UPDATE/DELETE target. `setCols` is the SET-clause column set (the frozen-field probe for UPDATE).
 *  `scopeStamped` is false when `scope_key` is absent from the INSERT column list / UPDATE-DELETE WHERE
 *  (cross-scope write risk). Each statement's span runs to the next write keyword. */
export function sqlWriteTargets(
  sql: string,
): Array<
  {
    verb: "insert" | "update" | "delete";
    table: string;
    setCols: Set<string>;
    scopeStamped: boolean;
  }
> {
  const out: Array<
    {
      verb: "insert" | "update" | "delete";
      table: string;
      setCols: Set<string>;
      scopeStamped: boolean;
    }
  > = [];
  const hits = [...sql.matchAll(SQL_WRITE_TARGET)];
  for (let i = 0; i < hits.length; i++) {
    const m = hits[i]!;
    const table = m[1]!.toLowerCase();
    const verb = /^insert/i.test(m[0]!)
      ? "insert" as const
      : /^update/i.test(m[0]!)
      ? "update" as const
      : "delete" as const;
    // the span of THIS statement: from just after its table to the start of the next write keyword (or end).
    const start = m.index! + m[0]!.length;
    const end = i + 1 < hits.length ? hits[i + 1]!.index! : sql.length;
    const span = sql.slice(start, end);
    const setCols = new Set<string>();
    // an UPDATE carries a SET clause whose left-hand columns are the written (potentially-frozen) fields.
    if (verb === "update") {
      const setMatch = SQL_SET_CLAUSE.exec(span);
      if (setMatch) {
        for (const c of setMatch[1]!.matchAll(SQL_SET_COL)) {
          setCols.add(c[1]!.toLowerCase());
        }
      }
    }
    // the scope-stamp probe: INSERT names `scope_key` in its column list; UPDATE/DELETE constrains it
    // in the WHERE. A positional INSERT (no column list) or a WHERE-less write is treated as unstamped → fires.
    let scopeStamped: boolean;
    if (verb === "insert") {
      const cols = SQL_INSERT_COLS.exec(span);
      scopeStamped = cols !== null && SCOPE_KEY_COL.test(cols[1]!);
    } else {
      const where = SQL_WHERE_CLAUSE.exec(span);
      scopeStamped = where !== null && SCOPE_KEY_COL.test(where[1]!);
    }
    out.push({ verb, table, setCols, scopeStamped });
  }
  return out;
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
// out of the handler — this static rule has the AST and the import graph, and resolves that one hop into a
// same-file helper OR an imported one (arbitrary deeper indirection stays a review residual).

/** A raw-read DOOR — `ctx.db…` / `ctx.query` / a bare `.query(` — the bypass of the single buildReadWhere site.
 *  Mirrors the structural rung's `RAW_READ` regex so the static rung fires on exactly the door it names. */
const CUSTOM_READ_RAW_DOOR = /\.\s*db\b|\.\s*query\s*\(/;
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

/** True iff a source slice is a raw protected read that DROPS the rowPolicy — a raw-read door + a `FROM <table>`
 *  with NO fragment re-application. The single predicate the inline-handler, same-file-helper and imported-helper
 *  paths use. The ACCUSING probes read comment-free source (the SQL survives — it is a string literal); the
 *  EXCUSING one reads code only, so `// re-apply rowPolicy( actor )` cannot stand in for the call. */
export function isUnguardedRawRead(src: string): boolean {
  const code = withoutComments(src);
  if (!CUSTOM_READ_RAW_DOOR.test(code)) return false;
  if (CUSTOM_READ_REAPPLIES.test(withoutCommentsOrStrings(src))) return false;
  return CUSTOM_READ_FROM_TABLE.test(code);
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
