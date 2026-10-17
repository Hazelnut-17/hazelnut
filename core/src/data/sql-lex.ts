// The one SQL lexer the framework's static readers share: statements split at top-level `;`, and tokens
// read the way Postgres reads them (nested block comments, CR-only line comments, E-strings, dollar
// quotes, quoted identifiers). Two readers that tokenize differently disagree about what a string means.
import { endOfSqlLiteral } from "./ddl-parse.ts";

/** One token: an unquoted word (lower-cased), a quoted identifier (case kept), a literal, or punctuation. */
export type SqlToken =
  | { readonly kind: "word"; readonly text: string }
  | { readonly kind: "ident"; readonly text: string }
  | { readonly kind: "literal" }
  | { readonly kind: "punct"; readonly text: string };

/** One top-level statement: its source text and its tokens. */
export interface SqlStatement {
  readonly text: string;
  readonly tokens: readonly SqlToken[];
}

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-￿]/;

/** Split `sql` into top-level statements and tokenize each; empty statements are dropped. */
export function sqlStatements(sql: string): SqlStatement[] {
  const out: SqlStatement[] = [];
  let start = 0;
  let i = 0;
  let tokens: SqlToken[] = [];
  const finish = (end: number) => {
    if (tokens.length > 0) out.push({ text: sql.slice(start, end), tokens });
    tokens = [];
  };
  while (i < sql.length) {
    const c = sql[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (sql.startsWith("--", i)) {
      i += 2;
      while (i < sql.length && sql[i] !== "\n" && sql[i] !== "\r") i++;
      continue;
    }
    if (sql.startsWith("/*", i)) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else i++;
      }
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let text = "";
      while (j < sql.length) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            text += '"';
            j += 2;
            continue;
          }
          j++;
          break;
        }
        text += sql[j];
        j++;
      }
      tokens.push({ kind: "ident", text });
      i = j;
      continue;
    }
    const literalEnd = endOfSqlLiteral(sql, i);
    if (literalEnd > i) {
      tokens.push({ kind: "literal" });
      i = literalEnd;
      continue;
    }
    if (c === ";") {
      finish(i);
      start = ++i;
      continue;
    }
    if (WORD_START.test(c)) {
      const from = i++;
      // Dollar signs belong to unquoted identifiers too; consume one whole identifier rather than
      // treating an embedded $tag$ as the start of a dollar-quoted literal.
      while (i < sql.length && WORD_PART.test(sql[i]!)) i++;
      tokens.push({ kind: "word", text: sql.slice(from, i).toLowerCase() });
      continue;
    }
    if (/[0-9]/.test(c)) {
      while (i < sql.length && /[0-9.eE_]/.test(sql[i]!)) i++;
      tokens.push({ kind: "literal" });
      continue;
    }
    tokens.push({ kind: "punct", text: c });
    i++;
  }
  finish(sql.length);
  return out;
}

/** The word a token spells, or undefined for a literal, a quoted identifier or punctuation. */
export function wordOf(t: SqlToken | undefined): string | undefined {
  return t?.kind === "word" ? t.text : undefined;
}

/** A column or table name a token spells: a word (lower-cased, as Postgres folds it) or a quoted identifier. */
export function nameOf(t: SqlToken | undefined): string | undefined {
  return t?.kind === "word" || t?.kind === "ident" ? t.text : undefined;
}
