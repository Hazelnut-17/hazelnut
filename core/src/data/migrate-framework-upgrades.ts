// One-time, framework-owned migration transitions. These are deliberately narrower than the general
// migrate gates: a framework table remains additive-only unless a transition below proves that its old
// index is replaced by the complete new invariant before the old arbiter disappears.
import { splitSqlStatements, stripSqlComments } from "./migrate-sql-text.ts";

const LEGACY_CRON_DROP =
  `drop index concurrently if exists "_outbox_cron_once"`;
const UPGRADE_CRON =
  `create unique index concurrently if not exists "_outbox_cron_once_upgrade" on "_outbox" ("topic","scheduled_time",md5(payload::text)) where kind = 'queue' and scheduled_time is not null and scope is null`;
const SCOPED_SCHEDULE =
  `create unique index concurrently if not exists "_outbox_schedule_once" on "_outbox" ("topic","scheduled_time",md5(payload::text),"scope") where kind = 'queue' and scheduled_time is not null and scope is not null`;
const FINAL_CRON =
  `create unique index concurrently if not exists "_outbox_cron_once" on "_outbox" ("topic","scheduled_time",md5(payload::text)) where kind = 'queue' and scheduled_time is not null and scope is null`;
const UPGRADE_CRON_DROP =
  `drop index concurrently if exists "_outbox_cron_once_upgrade"`;

const UPGRADE_STATEMENTS = [
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "_outbox_cron_once_upgrade" ON "_outbox" ("topic","scheduled_time",md5(payload::text)) WHERE kind = 'queue' AND scheduled_time IS NOT NULL AND scope IS NULL`,
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "_outbox_schedule_once" ON "_outbox" ("topic","scheduled_time",md5(payload::text),"scope") WHERE kind = 'queue' AND scheduled_time IS NOT NULL AND scope IS NOT NULL`,
  `DROP INDEX CONCURRENTLY IF EXISTS "_outbox_cron_once"`,
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "_outbox_cron_once" ON "_outbox" ("topic","scheduled_time",md5(payload::text)) WHERE kind = 'queue' AND scheduled_time IS NOT NULL AND scope IS NULL`,
  `DROP INDEX CONCURRENTLY IF EXISTS "_outbox_cron_once_upgrade"`,
] as const;

function normalized(stmt: string): string {
  return stmt.trim().replace(/\s+/g, " ").toLowerCase();
}

function count(stmts: readonly string[], target: string): number {
  return stmts.filter((stmt) => normalized(stmt) === target).length;
}

function at(stmts: readonly string[], target: string): number {
  return stmts.findIndex((stmt) => normalized(stmt) === target);
}

/** The sole sanctioned non-additive framework transition: it keeps a replacement global arbiter and the
 * new scoped arbiter live before it removes the 0.35.7 index whose predicate covered every scope. */
export function isOutboxScopeIndexUpgrade(sql: string): boolean {
  const stmts = splitSqlStatements(stripSqlComments(sql));
  if (
    !(count(stmts, LEGACY_CRON_DROP) === 1 &&
      count(stmts, UPGRADE_CRON) === 1 &&
      count(stmts, SCOPED_SCHEDULE) === 1 &&
      count(stmts, FINAL_CRON) === 1 &&
      count(stmts, UPGRADE_CRON_DROP) === 1)
  ) return false;
  const legacy = at(stmts, LEGACY_CRON_DROP);
  const temp = at(stmts, UPGRADE_CRON);
  const scoped = at(stmts, SCOPED_SCHEDULE);
  const final = at(stmts, FINAL_CRON);
  const tempDrop = at(stmts, UPGRADE_CRON_DROP);
  return temp < legacy && scoped < legacy && legacy < final && final < tempDrop;
}

const DRIZZLE_LEGACY_DROP = `drop index "_outbox_cron_once"`;
const DRIZZLE_SCOPED_CRON =
  `create unique index "_outbox_cron_once" on "_outbox" ("topic","scheduled_time",md5(payload::text)) where kind = 'queue' and scheduled_time is not null and scope is null`;
const DRIZZLE_SCOPED_SCHEDULE =
  `create unique index "_outbox_schedule_once" on "_outbox" ("topic","scheduled_time",md5(payload::text),"scope") where kind = 'queue' and scheduled_time is not null and scope is not null`;

/** Rewrites drizzle-kit's exact 0.35.7 → scoped-outbox diff into a restart-safe, continuously protected
 * five-statement upgrade. `null` means this is not that exact framework transition. */
export function rewriteOutboxScopeIndexUpgrade(sql: string): string | null {
  const stmts = splitSqlStatements(stripSqlComments(sql));
  if (
    count(stmts, DRIZZLE_LEGACY_DROP) !== 1 ||
    count(stmts, DRIZZLE_SCOPED_CRON) !== 1 ||
    count(stmts, DRIZZLE_SCOPED_SCHEDULE) !== 1
  ) return null;
  const old = new Set([
    DRIZZLE_LEGACY_DROP,
    DRIZZLE_SCOPED_CRON,
    DRIZZLE_SCOPED_SCHEDULE,
  ]);
  const kept = stmts.filter((stmt) => !old.has(normalized(stmt)));
  return [...kept, ...UPGRADE_STATEMENTS].join(
    ";\n--> statement-breakpoint\n",
  ) + ";\n";
}
