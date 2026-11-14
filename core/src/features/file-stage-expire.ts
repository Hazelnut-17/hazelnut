import { type Db, isTransactor } from "../data/db.ts";
import type { StorageDriver } from "../data/storage.ts";

/** Fence and retire expired uploads under the same intent lock used by upload and finalize. */
export async function expireFileStages(
  db: Db,
  storage?: StorageDriver | null,
): Promise<number> {
  if (!storage?.staged || !isTransactor(db)) return 0;
  return await db.transaction(async (tx) => {
    const expired = await tx.query<{ id: string; object_key: string }>(
      `SELECT id,object_key FROM "_file_stage" WHERE state IN ('pending','uploaded','cleanup')
       AND expires_at <= now() ORDER BY expires_at LIMIT 50 FOR UPDATE SKIP LOCKED`,
    );
    for (const row of expired.rows) {
      await storage.staged!.retire(row.object_key);
      await tx.query(`DELETE FROM "_file_stage" WHERE id=$1`, [row.id]);
    }
    await tx.query(
      `DELETE FROM "_file_stage" WHERE state='finalized' AND completed_at < now() - interval '7 days'`,
    );
    return expired.rows.length;
  });
}
