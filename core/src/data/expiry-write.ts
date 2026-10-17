import type { ResourceModel } from "../core/app.ts";
import type { Db } from "./db.ts";
import { expiryCallerWritableOf } from "./write-plan.ts";

/** The database clock also owns read liveness. Refuse a caller's already-expired deadline before its
 * INSERT/UPDATE can commit an invisible row; null remains the explicit never-expire value. */
export async function assertFutureCallerExpiry(
  db: Db,
  model: ResourceModel,
  values: Record<string, unknown>,
): Promise<void> {
  const value = values.expires_at;
  if (!expiryCallerWritableOf(model) || value == null) return;
  const expired = (await db.query<{ expired: boolean }>(
    `SELECT $1::timestamptz <= now() AS expired`,
    [value],
  )).rows[0]?.expired;
  if (expired) {
    throw Object.assign(
      new Error(
        `expiry/past-deadline: expires_at for '${model.name}' must be later than the database clock, or null`,
      ),
      { kind: "validation" as const },
    );
  }
}
