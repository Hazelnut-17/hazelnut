// Reading a CREATE TABLE back: the one place that turns emitted DDL into (schema, table, column, type).
// A leaf with no imports — the schema-diff, the wire/response-shape allow-set and the committed-migration
// staleness gate all read the same statements, and a second reader would drift from this one.

/** Column-constraint keywords that end a type: everything before the first of these (at paren depth 0) is
 *  the type, so `double precision NOT NULL` yields `double precision` and `text PRIMARY KEY` yields `text`. */
const TYPE_STOP: ReadonlySet<string> = new Set([
  "not",
  "null",
  "default",
  "primary",
  "references",
  "check",
  "unique",
  "generated",
  "collate",
  "constraint",
]);

/** Leading keywords of a TABLE-level clause — it constrains, it is never a column. An inline
 *  `id text PRIMARY KEY` is still a column: the keyword does not lead. */
const TABLE_CONSTRAINT =
  /^(?:CONSTRAINT|PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE\s*\(|CHECK\s*\(|EXCLUDE)\b/i;

/** Postgres type aliases → one canonical spelling per type. Every reader normalizes, so a type that the
 *  DDL, drizzle-kit and Postgres itself spell three ways still compares equal. The `serial` family resolves
 *  to its underlying integer type: `bigserial` is a macro for `bigint` + a sequence + a default and Postgres
 *  reports the column as `bigint`, so a `bigserial` → `bigint` edit is invisible to a type comparison. That
 *  spelling appears only on framework-owned `_*` columns, which an app cannot redeclare. */
const TYPE_ALIASES: Readonly<Record<string, string>> = {
  "timestamptz": "timestamp with time zone",
  "timestamp": "timestamp without time zone",
  "int": "integer",
  "int4": "integer",
  "int8": "bigint",
  "int2": "smallint",
  "bool": "boolean",
  "float8": "double precision",
  "float4": "real",
  "character varying": "varchar",
  "decimal": "numeric",
  "smallserial": "smallint",
  "serial": "integer",
  "bigserial": "bigint",
};

/** Canonical form of a Postgres type: case-folded, whitespace-collapsed, alias-resolved. A parameterized
 *  type normalizes its base and keeps its modifier (`character varying(80)` → `varchar(80)`). */
export function normalizePgType(raw: string): string {
  const t = raw.trim().toLowerCase().replace(/\s+/g, " ");
  const m = /^([a-z ]+?)\s*(\(.*\))?(\[\])?$/.exec(t);
  if (!m) return t;
  const base = TYPE_ALIASES[m[1]!.trim()] ?? m[1]!.trim();
  return `${base}${m[2] ?? ""}${m[3] ?? ""}`;
}

/** Index just past a SQL string, quoted identifier, or dollar-quote that opens at `i`. `i` when `i` is
 *  not a literal start (`$1` is a placeholder, not `$$`). Doubled quotes (`''` / `""`) stay inside. */
export function endOfSqlLiteral(sql: string, i: number): number {
  const ch = sql[i];
  if (ch === "'" || ch === '"') {
    i++;
    while (i < sql.length) {
      if (sql[i] === ch) {
        if (sql[i + 1] === ch) {
          i += 2;
          continue;
        }
        return i + 1;
      }
      i++;
    }
    return sql.length;
  }
  if (ch === "$") {
    let j = i + 1;
    while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j]!)) j++;
    if (sql[j] !== "$") return i;
    const tag = sql.slice(i, j + 1);
    const close = sql.indexOf(tag, j + 1);
    return close < 0 ? sql.length : close + tag.length;
  }
  return i;
}

/** The index of the `)` matching the `(` at `open`, skipping string / identifier / dollar-quote
 *  literals so a paren inside a literal never moves the depth. `-1` when the statement is unbalanced. */
function matchingParen(sql: string, open: number): number {
  let depth = 0;
  for (let i = open; i < sql.length; i++) {
    const end = endOfSqlLiteral(sql, i);
    if (end > i) {
      i = end - 1;
      continue;
    }
    const ch = sql[i]!;
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
  }
  return -1;
}

/** Split a CREATE TABLE body on its top-level commas (paren- and quote-aware, so a
 *  `CHECK (x IN ('a','b'))` stays one clause instead of inventing two columns). */
function splitTopLevel(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const end = endOfSqlLiteral(body, i);
    if (end > i) {
      i = end - 1;
      continue;
    }
    const ch = body[i]!;
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** `(name, type)` of one column clause, or `null` when the clause is a table-level constraint. */
function parseColumnClause(
  clause: string,
): { name: string; type: string } | null {
  if (TABLE_CONSTRAINT.test(clause)) return null;
  const head = /^(?:"([^"]+)"|([A-Za-z_][\w$]*))\s*([\s\S]*)$/.exec(clause);
  if (!head) return null;
  const name = head[1] ?? head[2]!;
  const words: string[] = [];
  for (const tok of (head[3] ?? "").split(/\s+/)) {
    if (tok.length === 0) continue;
    if (TYPE_STOP.has(tok.replace(/\(.*/, "").toLowerCase())) break;
    words.push(tok);
    if (tok.includes("(") && !tok.includes(")")) break; // a split modifier group — the base is enough
  }
  return { name, type: normalizePgType(words.join(" ")) };
}

/** One CREATE TABLE the DDL materializes, with its columns' normalized types in declaration order. */
export interface ParsedTable {
  readonly schema: string;
  readonly table: string;
  readonly columns: ReadonlyMap<string, string>;
}

/**
 * Every CREATE TABLE in `sql`, with its columns. A statement may bundle a trailing `CREATE INDEX` (the
 * framework emits some that way), so each body is bounded by the paren matching that table's own `(` —
 * never the last `)` in the text, which reads the index's column list as columns of the table.
 */
export function parseCreateTables(sql: string): ParsedTable[] {
  const out: ParsedTable[] = [];
  const re =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"\s*\.\s*)?"([^"]+)"\s*\(/gi;
  for (const m of sql.matchAll(re)) {
    const open = m.index + m[0].length - 1;
    const close = matchingParen(sql, open);
    if (close < 0) continue;
    const columns = new Map<string, string>();
    for (const clause of splitTopLevel(sql.slice(open + 1, close))) {
      const col = parseColumnClause(clause);
      if (col) columns.set(col.name, col.type);
    }
    out.push({ schema: m[1] ?? "public", table: m[2]!, columns });
  }
  return out;
}

/** Column names the CREATE TABLE DDL materializes, parsed from `m.ddl` — not `m.columns`, which omits
 *  framework-minted columns and would mis-flag each as a drop candidate. The wire/response-shape checker
 *  keys its allowed set on this same source. */
export function ddlColumnNames(ddl: string): Set<string> {
  const names = new Set<string>();
  for (const t of parseCreateTables(ddl)) {
    for (const c of t.columns.keys()) names.add(c);
  }
  return names;
}
