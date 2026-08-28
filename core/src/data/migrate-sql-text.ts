// Text primitives the migration gates and the migration EMITTER both need: comment stripping, statement
// splitting, and the lock_timeout contract (the bound the emitter writes, and the one gate (6) requires).
// Imports only `ddl-parse`'s quote-aware walker — the gate lives under the `migrate.ts` barrel and the
// emitter is re-exported from it, so a direct edge between those two would close a value-import cycle.

import { endOfSqlLiteral } from "./ddl-parse.ts";
import { bareName, QUALIFIED_NAME } from "./migrate-safety-names.ts";

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

/** The base table a `CREATE INDEX … ON <t>` / `ALTER TABLE <t>` targets; null when neither is present.
 *  ALTER is read first: an FK's `… ON DELETE CASCADE` also matches the `ON <t>` form, which belongs to
 *  `CREATE INDEX` and carries no ALTER — so precedence, not a lookahead, disambiguates. */
export function indexTargetTable(stmt: string): string | null {
  const alter = new RegExp(
    String
      .raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QUALIFIED_NAME})`,
    "i",
  ).exec(stmt);
  if (alter) return bareName(alter[1] ?? "");
  const idx = new RegExp(
    String.raw`\bON\s+(?:ONLY\s+)?(${QUALIFIED_NAME})`,
    "i",
  ).exec(stmt);
  return idx ? bareName(idx[1] ?? "") : null;
}

/** Tables CREATEd in this script (`CREATE TABLE [IF NOT EXISTS] <name>`), normalized via `bareName`. A
 *  new-table-aware gate exempts an index/constraint on one of these — a brand-new table has no rows and
 *  no concurrent traffic, so a non-CONCURRENTLY index is instant + safe (Strong-Migrations exemption). */
export function createdTables(stmts: readonly string[]): Set<string> {
  const created = new Set<string>();
  for (const stmt of stmts) {
    const m = new RegExp(
      String
        .raw`\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${QUALIFIED_NAME})`,
      "i",
    ).exec(stmt);
    if (m) {
      const name = bareName(m[1] ?? "");
      if (name) created.add(name);
    }
  }
  return created;
}

/**
 * Rewrite a `CREATE INDEX` on a PRE-EXISTING table to the CONCURRENTLY form — the shape gate (4) demands.
 * The emitter satisfies the gate rather than argues with it: drizzle-kit emits the plain form, and on an
 * incremental script the same run then refused what it had just authored, leaving the consumer a delta on
 * disk under a non-zero exit with nothing naming the way forward.
 *
 * An index on a table THIS script creates keeps the plain form — instant there (gate (4) exempts it), and
 * CONCURRENTLY cannot run inside the transaction a pure-create script is applied in. `null` when nothing
 * needed rewriting, matching `prependLockTimeout`.
 */
export function concurrentIndexes(sql: string): string | null {
  const created = createdTables(splitSqlStatements(stripSqlComments(sql)));
  let changed = false;
  const out = sql.replace(
    /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY\b)[\s\S]*?;/gi,
    (stmt) => {
      const t = indexTargetTable(stmt);
      if (t === null || created.has(t)) return stmt;
      changed = true;
      return stmt.replace(/\bINDEX\b/i, "INDEX CONCURRENTLY");
    },
  );
  return changed ? out : null;
}
