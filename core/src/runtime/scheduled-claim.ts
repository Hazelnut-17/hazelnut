import type { Db } from "../data/db.ts";

/** The same source identity is used by cancellation and every framework one-shot claim path. */
export function scheduledSourceKey(id: string): string {
  return `hazelnut:scheduled-source:${id}`;
}

/** Must run inside the caller's transaction, before any per-consumer retry lock. */
export async function lockScheduledSource(
  db: Db,
  id: string,
  aggregateType: string,
): Promise<void> {
  if (aggregateType !== "_schedule") return;
  await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    scheduledSourceKey(id),
  ]);
}
