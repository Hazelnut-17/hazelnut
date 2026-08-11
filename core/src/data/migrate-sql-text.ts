// Text primitives the migration gates and the migration EMITTER both need: comment stripping, and the
// lock_timeout contract (the bound the emitter writes, and the one gate (6) requires).
// A LEAF — it imports nothing. The gate lives under the `migrate.ts` barrel and the emitter is re-exported
// from it, so a direct edge between the two would close a value-import cycle through that barrel.

/** Strip `--` line comments and block comments so a commented-out `CONCURRENTLY` or a `lock_timeout`
 *  mentioned only in a comment never satisfies (or trips) a gate. */
export function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments
    .replace(/--[^\n]*/g, " "); // line comments
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
