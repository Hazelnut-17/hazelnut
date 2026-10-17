// The raw-SQL doors run on a transaction the framework owns, so they refuse the statements that would end,
// nest or redefine it. `ctx.savepoint(fn)` is the door for a recoverable sub-step.
import type { Db } from "./db.ts";
import { sqlStatements, wordOf } from "./sql-lex.ts";

/** One top-level statement of a SQL string: its text and its first few head tokens. */
export interface StatementHead {
  readonly text: string;
  /** Unquoted words; null marks a literal, quoted identifier, number or punctuation. */
  readonly tokens: readonly (string | null)[];
}

/** Each statement's text and its first five tokens — `SET SESSION CHARACTERISTICS AS TRANSACTION` is the
 *  longest head this reads. One lexer (`sqlStatements`) decides both boundaries and heads, so a comment
 *  can never hide a real COMMIT, nor a literal look like transaction control. */
export function statementHeads(sql: string): StatementHead[] {
  return sqlStatements(sql).map(({ text, tokens }) => ({
    text,
    tokens: tokens.slice(0, 5).map((t) => wordOf(t) ?? null),
  }));
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
