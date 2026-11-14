import { isAnonymous } from "../authz/auth.ts";
import type { ResourceModel } from "../core/app.ts";
import type { Db } from "../data/db.ts";
import type { ReadCtx } from "../data/repo.ts";

interface StageRow {
  id: string;
  object_key: string;
  state: string;
  baseline_key: string | null;
  baseline_version: string | null;
  baseline_incarnation: string | null;
  result: unknown;
  alive: boolean;
}

export function stageIdentity(
  ctx: ReadCtx,
): readonly [string, string, string | null, string | null] | null {
  if (isAnonymous(ctx.actor) || !ctx.actor) return null;
  return [
    ctx.actor.type,
    ctx.actor.id,
    ctx.actor.onBehalfOf ?? null,
    ctx.scope ?? null,
  ];
}

/** Lock only an intent owned by this exact caller, model, row and field; unknown IDs do not disclose state. */
export async function lockFileStage(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  id: string,
  field: string,
  stageId: string,
): Promise<StageRow | undefined> {
  const identity = stageIdentity(ctx);
  if (!identity) return undefined;
  return (await db.query<StageRow>(
    `SELECT id,object_key,state,baseline_key,baseline_version,baseline_incarnation,result,expires_at > now() AS alive
     FROM "_file_stage" WHERE id=$1 AND pg_schema=$2 AND resource=$3 AND row_id=$4 AND field=$5
       AND actor_type=$6 AND actor_id=$7 AND actor_delegate IS NOT DISTINCT FROM $8 AND scope IS NOT DISTINCT FROM $9 FOR UPDATE`,
    [stageId, model.pgSchema, model.name, id, field, ...identity],
  )).rows[0];
}
