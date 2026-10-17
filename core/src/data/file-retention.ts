import type { Db } from "./db.ts";
import type { ResourceModel } from "../core/app.ts";

/** Same-transaction retention; physical DELETE's generated trigger consumes the ledger into durable GC. */
export async function retainFileKeys(
  db: Db,
  model: ResourceModel,
  rowId: string,
  keys: readonly string[],
): Promise<void> {
  for (const key of new Set(keys)) {
    await db.query(
      `INSERT INTO public."_file_retained" (pg_schema,resource,row_id,object_key) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [model.pgSchema, model.name, rowId, key],
    );
  }
}
