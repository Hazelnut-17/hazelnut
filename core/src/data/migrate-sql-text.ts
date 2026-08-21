// Text primitives the migration gates and the migration EMITTER both need: comment stripping, statement
// splitting, and the lock_timeout contract (the bound the emitter writes, and the one gate (6) requires).
// Imports only `ddl-parse`'s quote-aware walker — the gate lives under the `migrate.ts` barrel and the
// emitter is re-exported from it, so a direct edge between those two would close a value-import cycle.

import { endOfSqlLiteral } from "./ddl-parse.ts";

function blankedKeepingNewlines(s: string): string {
  return s.replace(/[^\n]/g, " ");
}

/** Strip `--` line comments and block comments so a commented-out `CONCURRENTLY` or a `lock_timeout`
 *  mentioned only in a comment never satisfies (or trips) a gate. Quote-aware: a `--` or `/*` inside a
 *  string / identifier / dollar-quote is data, not a comment. */
export function stripSqlComments(sql: string): string {
  let out = "";
  for (let i = 0; i < sql.length;) {
    const end = endOfSqlLiteral(sql, i);
    if (end > i) {
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    if (sql[i] === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      const stop = nl < 0 ? sql.length : nl;
      out += blankedKeepingNewlines(sql.slice(i, stop));
      i = stop;
      continue;
    }
    if (sql[i] === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      const stop = close < 0 ? sql.length : close + 2;
      out += blankedKeepingNewlines(sql.slice(i, stop));
      i = stop;
      continue;
    }
    out += sql[i]!;
    i++;
  }
  return out;
}

/** Split on top-level `;` after comments are already stripped. A `;` inside a string, quoted identifier,
 *  or dollar-quote does not end a statement. */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < sql.length;) {
    const end = endOfSqlLiteral(sql, i);
    if (end > i) {
      i = end;
      continue;
    }
    if (sql[i] === ";") {
      const stmt = sql.slice(start, i).trim();
      if (stmt.length > 0) out.push(stmt);
      start = i + 1;
    }
    i++;
  }
  const tail = sql.slice(start).trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

/** The wait every emitted migration bounds itself by (`cli/migrate.md §safe-ddl`): a contended DDL fails
 *  fast instead of queueing every following query behind it. */
export const MIGRATION_LOCK_TIMEOUT = "5s";

/** Whether a script bounds its own lock waits (`SET`/`SET LOCAL lock_timeout`) outside a comment. Gate (6)
 *  and `prependLockTimeout` read THIS, so the SQL the framework authors can never be refused by the gate
 *  that reads it. */
export function hasLockTimeout(sql: string): boolean {
  return /\bSET\b[\s\S]*\block_timeout\b/i.test(stripSqlComments(sql));
}

/**
 * Lock-timeout prepend (`cli/migrate.md §safe-ddl`): drizzle-kit emits none, and gate (6) waives the
 * requirement only for a script that touches nothing pre-existing — so an incremental script (an FK to a
 * live parent, any ALTER) was authored and then refused by the same run. The session form, not `SET LOCAL`:
 * `migrate apply` also runs the `CONCURRENTLY`/`VACUUM` carve-out outside a transaction, where `SET LOCAL`
 * is inert. Pure over (sql); `null` means the script already bounds itself.
 */
export function prependLockTimeout(sql: string): string | null {
  if (hasLockTimeout(sql)) return null;
  return `SET lock_timeout = '${MIGRATION_LOCK_TIMEOUT}';\n--> statement-breakpoint\n${sql}`;
}
