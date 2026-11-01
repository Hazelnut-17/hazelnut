import { tableOf } from "../core/app-define.ts";
import type { ResourceModel } from "../core/app-types.ts";
import type { Db } from "./db.ts";

/** Deletion may already hold an ancestor or rollup lock. Do not wait for a
 * forest owner that can itself be waiting for one of those locks. */
export async function tryTreeWriteLock(
  db: Db,
  model: ResourceModel,
  scope: string,
): Promise<void> {
  const forest = model.features.scope
    ? `${tableOf(model)}:${scope}`
    : tableOf(model);
  const locked = (await db.query<{ locked: boolean | string }>(
    `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked`,
    [forest],
  )).rows[0]?.locked;
  if (locked !== true && locked !== "t") {
    throw Object.assign(
      new Error(
        "tree delete conflicts with another tree write; retry the operation",
      ),
      { kind: "timeout" as const },
    );
  }
}
