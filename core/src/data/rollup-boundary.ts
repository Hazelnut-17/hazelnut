import type { ResourceModel } from "../core/app.ts";
import { type Db, hasTransactionRootRole, isTransactor } from "./db.ts";
import {
  inOwnedWriteBoundary,
  ownsWriteBoundary,
} from "./transaction-scope.ts";
import { inTxSavepoint } from "./tx-locks.ts";

/** Whether a child write can maintain a parent with read-model projections. */
export function rollupProjectionMayRun(
  model: ResourceModel,
  patch?: Readonly<Record<string, unknown>>,
): boolean {
  return model.rollupTargets.some((target) =>
    target.parentReadModelSource.readModelSinks.length > 0 &&
    (patch === undefined || (target.kind !== "count" &&
      target.field !== undefined && target.field in patch))
  );
}

/** Own the whole public operation, not only the later projection enqueue. */
export async function inRollupProjectionBoundary<T>(
  db: Db,
  needed: boolean,
  operation: string,
  work: (owned: Db) => Promise<T>,
): Promise<T> {
  if (!needed || ownsWriteBoundary(db)) return await work(db);
  if (isTransactor(db)) {
    if (!hasTransactionRootRole(db)) {
      throw Object.assign(
        new Error(`${operation}: ambiguous transaction handle`),
        {
          kind: "internal" as const,
        },
      );
    }
    return await db.transaction((tx) => inOwnedWriteBoundary(tx, work));
  }
  if (db.savepoint !== undefined) {
    return await inTxSavepoint(db, (sp) => inOwnedWriteBoundary(sp, work));
  }
  throw Object.assign(
    new Error(
      `${operation}: rollup projection maintenance requires a transaction-capable root or driver savepoint`,
    ),
    { kind: "internal" as const },
  );
}
