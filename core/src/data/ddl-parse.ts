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
/**
 * Whether an `E'…'` string literal opens at `i`. The `E` must START a token: `note_e'a\'` is the identifier
 * `note_e` followed by a PLAIN string, where `\` is an ordinary character and the quote after it closes.
 * Read as an E-string, the walker runs past that close and swallows every following statement into one
 * literal — which blanking then erases, taking a `DROP TABLE` out of every gate's view.
 *
 * `U&'…'` needs no branch of its own: a backslash there introduces a UNICODE escape, never a quote escape,
 * so the plain scanner already ends it in the right place.
 *
 * `$` counts as an identifier character, so `$$q$$E'…'` reads as a plain string and over-SPLITS. Unreachable
 * in an emitted migration, and the direction is safe — more statements reach the gates, never fewer.
 */
export function opensEString(sql: string, i: number): boolean {
  const ch = sql[i];
  if ((ch !== "E" && ch !== "e") || sql[i + 1] !== "'") return false;
  const prev = sql[i - 1];
  return prev === undefined || !/[A-Za-z0-9_$]/.test(prev);
}

/**
 * Where a literal opening at `i` ends, AND whether it actually closed. Running to EOF is not the same fact
 * as closing at EOF: an unterminated literal makes every statement after its opener invisible to every
 * gate, so a caller that can refuse needs to tell the two apart. `endOfSqlLiteral` keeps the offset-only
 * contract its callers walk with.
 */
export function scanSqlLiteral(
  sql: string,
  i: number,
): { readonly end: number; readonly closed: boolean } {
  const end = endOfSqlLiteral(sql, i);
  // Only a literal that consumed to EOF can be unterminated; anything ending earlier met its closer. The
  // opener's own closer is then re-checked, because "ran out of input" and "ended on the last byte" are
  // the same number.
  if (end !== sql.length || end === i) return { end, closed: true };
  return { end, closed: literalClosedAtEof(sql, i) };
}

/** Did the literal opening at `i` — which consumed to EOF — actually meet its closer there? */
function literalClosedAtEof(sql: string, i: number): boolean {
  const ch = sql[i];
  if (opensEString(sql, i)) return closesQuote(sql, i + 2, "'", true);
  if (ch === "'" || ch === '"') return closesQuote(sql, i + 1, ch, false);
  if (ch === "$") {
    let j = i + 1;
    while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j]!)) j++;
    if (sql[j] !== "$") return true; // not an opener at all
    return sql.indexOf(sql.slice(i, j + 1), j + 1) >= 0;
  }
  return true;
}

function closesQuote(
  sql: string,
  from: number,
  q: string,
  backslash: boolean,
): boolean {
  for (let j = from; j < sql.length;) {
    if (backslash && sql[j] === "\\") {
      j += 2;
      continue;
    }
    if (sql[j] === q) {
      if (sql[j + 1] === q) {
        j += 2;
        continue;
      }
      return true;
    }
    j++;
  }
  return false;
}

/** Does any literal in `sql` open without closing? Such a file cannot be read by the statement model:
 *  everything after the opener collapses into one literal the gates never see, so a gate that scans it
 *  reports on a PREFIX while claiming to report on the file. */
export function hasUnterminatedLiteral(sql: string): boolean {
  for (let i = 0; i < sql.length;) {
    const { end, closed } = scanSqlLiteral(sql, i);
    if (end > i) {
      if (!closed) return true;
      i = end;
      continue;
    }
    i++;
  }
  return false;
}

export function endOfSqlLiteral(sql: string, i: number): number {
  const ch = sql[i];
  // `E'…'` escapes with a BACKSLASH, where a plain literal only doubles the quote. Read at the `E`, because
  // reading at the quote would take `\'` as the close and hand every following `;` back to the splitter as a
  // statement boundary inside the string.
  if (opensEString(sql, i)) {
    let j = i + 2;
    while (j < sql.length) {
      if (sql[j] === "\\") {
        j += 2;
        continue;
      }
      if (sql[j] === "'") {
        if (sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        return j + 1;
      }
      j++;
    }
    return sql.length;
  }
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
    // A dollar quote opens only where a TOKEN can start, exactly as `E'` does above. `$` is an identifier
    // character, so `amount$x$total` is one legal column name — read as an opener it takes `$x$` for a tag,
    // finds no close, and swallows the rest of the FILE into one literal, taking every following
    // `DROP TABLE` out of every gate's view.
    const prev = sql[i - 1];
    if (prev !== undefined && /[A-Za-z0-9_$]/.test(prev)) return i;
    let j = i + 1;
    while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j]!)) j++;
    if (sql[j] !== "$") return i;
    // A tag is an IDENTIFIER, so it cannot begin with a digit: `$1$` is the positional parameter `$1`
    // followed by another `$`, never a quote opener. `$$` (the empty tag) stays legal.
    if (/^[0-9]/.test(sql.slice(i + 1, j))) return i;
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
