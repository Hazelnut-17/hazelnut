// The raw-SQL doors run on a transaction the framework owns, so they refuse the statements that would end,
// nest or redefine it. `ctx.savepoint(fn)` is the door for a recoverable sub-step.
import type { Db } from "./db.ts";
import { endOfSqlLiteral } from "./ddl-parse.ts";

interface StatementHead {
  readonly text: string;
  /** Unquoted words; null marks a literal, quoted identifier, number or punctuation. */
  readonly tokens: readonly (string | null)[];
}

/** Comments are whitespace, including nested block comments and CR-only line endings. Walk the same
 * tokens for statement boundaries and heads: stripping one spelling but splitting another lets a comment
 * hide a real COMMIT, or makes a harmless literal look like transaction control. */
function statementHeads(sql: string): StatementHead[] {
  const out: StatementHead[] = [];
  let start = 0;
  let i = 0;
  let tokens: (string | null)[] = [];
  const pushToken = (token: string | null) => {
    // SET SESSION CHARACTERISTICS AS TRANSACTION is the longest head we inspect.
    if (tokens.length < 5) tokens.push(token);
  };
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
    const literalEnd = endOfSqlLiteral(sql, i);
    if (literalEnd > i) {
      pushToken(null);
      i = literalEnd;
      continue;
    }
    if (c === ";") {
      finish(i);
      start = ++i;
      continue;
    }
    if (/[A-Za-z_\u0080-\uFFFF]/.test(c)) {
      const from = i++;
      // Dollar signs belong to unquoted identifiers too; consume one whole identifier rather than
      // treating an embedded $tag$ as the start of a dollar-quoted literal.
      while (i < sql.length && /[A-Za-z0-9_$\u0080-\uFFFF]/.test(sql[i]!)) i++;
      pushToken(sql.slice(from, i).toLowerCase());
    } else {
      pushToken(null);
      i++;
    }
  }
  finish(sql.length);
  return out;
}

const CONTROL: ReadonlySet<string> = new Set([
  "begin",
  "start",
  "commit",
  "end",
  "rollback",
  "abort",
  "savepoint",
  "release",
]);

/** The first statement of `sql` that controls the transaction (`BEGIN`, `COMMIT`, `ROLLBACK [TO]`,
 *  `SAVEPOINT`, `RELEASE`, `PREPARE TRANSACTION`, `SET TRANSACTION`, …), or null. */
export function transactionControlIn(sql: string): string | null {
  for (const { text, tokens } of statementHeads(sql)) {
    const head = tokens[0];
    if (head !== null && head !== undefined && CONTROL.has(head)) {
      return text.trim();
    }
    if (head === "prepare" && tokens[1] === "transaction") return text.trim();
    if (
      head === "set" &&
      (tokens[1] === "transaction" ||
        ((tokens[1] === "session" || tokens[1] === "local") &&
          tokens[2] === "transaction") ||
        (tokens[1] === "session" && tokens[2] === "characteristics" &&
          tokens[3] === "as" && tokens[4] === "transaction"))
    ) return text.trim();
  }
  return null;
}

/** `db.query` behind the transaction-control refusal — the `ctx.query` door on every ctx composition. */
export function guardedQuery(
  db: Db,
): <T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
) => Promise<{ rows: T[] }> {
  return <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
    try {
      refuseTransactionControl(sql, "ctx.query");
    } catch (e) {
      return Promise.reject(e);
    }
    return db.query<T>(sql, params);
  };
}

/** Throws when `sql` would end, nest or redefine the transaction the framework owns. */
export function refuseTransactionControl(sql: string, door: string): void {
  const found = transactionControlIn(sql);
  if (found === null) return;
  throw Object.assign(
    new Error(
      `query/transaction-control: ${door} refuses '${
        found.slice(0, 60)
      }' — the operation's transaction belongs to the framework, which commits it on ok and rolls it back on err. For a step that may fail and be recovered from, run it inside ctx.savepoint(async (sp) => …) and catch its error.`,
    ),
    { kind: "internal" as const },
  );
}
