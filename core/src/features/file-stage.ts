/** Durable, actor-bound staged file uploads. This module's doors require an atomic storage retirement fence. */
import type { ResourceModel } from "../core/app.ts";
import { uuidv7 } from "../core/id.ts";
import { all } from "../core/where.ts";
import { err, ok, type Result } from "../core/result.ts";
import { crudWriteDenied } from "../authz/auth.ts";
import { type Db, isTransactor } from "../data/db.ts";
import { list, type ReadCtx, type RowPolicy } from "../data/repo.ts";
import { fileKeyPrefix, type StorageDriver } from "../data/storage.ts";
import { globalSingletonIncarnationOn } from "../data/schema-normalize.ts";
import type { Kms } from "./encrypt.ts";
import { fileGrantTtl } from "./file-grant.ts";
import { grantedFileFields } from "./redact.ts";
import { lockFileStage, stageIdentity } from "./file-stage-lock.ts";
import {
  checkFileMetadata,
  FILE_STAGE_MAX_BYTES,
  fileConstraints,
  inspectFile,
} from "./file-constraints.ts";

// JSON/base64 transport remains below the default one-MiB request body floor.
export { FILE_STAGE_MAX_BYTES } from "./file-constraints.ts";

export function decodeFileStageBytes(value: unknown): Uint8Array | undefined {
  if (
    typeof value !== "string" ||
    value.length > Math.ceil(FILE_STAGE_MAX_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) return undefined;
  try {
    const raw = atob(value);
    if (raw.length > FILE_STAGE_MAX_BYTES) return undefined;
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}

async function visibleRow(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  id: string,
  kms?: Kms,
) {
  const policy =
    (model.rowPolicy as RowPolicy<Record<string, unknown>> | null) ??
      (() => all());
  return (await list<Record<string, unknown>>(
    db,
    model,
    ctx,
    policy,
    { id },
    kms,
  ))[0];
}

/** Mint an intent only after the same write-permission and projected-read gates as a file upload grant. */
export async function issueFileStage(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  id: string,
  field: string,
  storage?: StorageDriver | null,
  kms?: Kms,
  ttl?: unknown,
  fields = grantedFileFields(model),
): Promise<Result<{ id: string; ttl: number; maxBytes: number }>> {
  const identity = stageIdentity(ctx);
  if (!identity || crudWriteDenied(ctx.actor, model.name, "update", true)) {
    return err("forbidden", "policy denied");
  }
  if (!fields.includes(field)) return err("notFound", "file not found");
  if (!storage?.staged) {
    return err(
      "business",
      "file/stage-unsupported: storage must fence late staged writes",
    );
  }
  const row = await visibleRow(db, model, ctx, id, kms);
  if (!row) return err("notFound", "file not found");
  if (
    globalSingletonIncarnationOn(model.features) &&
    typeof row.cas_incarnation !== "string"
  ) {
    return err(
      "internal",
      "file/stage-identity: singleton incarnation unavailable",
    );
  }
  const stageId = uuidv7();
  const key = `${
    fileKeyPrefix(model.pgSchema, model.name, field, id)
  }${uuidv7()}`;
  const seconds = fileGrantTtl(ttl);
  await db.query(
    `INSERT INTO "_file_stage" (id,pg_schema,resource,row_id,field,object_key,actor_type,actor_id,actor_delegate,scope,baseline_key,baseline_version,baseline_incarnation,expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now()+$14 * interval '1 second')`,
    [
      stageId,
      model.pgSchema,
      model.name,
      id,
      field,
      key,
      ...identity,
      typeof row[field] === "string" ? row[field] : null,
      row.version === undefined || row.version === null
        ? null
        : String(row.version),
      globalSingletonIncarnationOn(model.features) ? row.cas_incarnation : null,
      seconds,
    ],
  );
  return ok({
    id: stageId,
    ttl: seconds,
    maxBytes: Math.min(
      FILE_STAGE_MAX_BYTES,
      fileConstraints(model, field)?.maxBytes ?? FILE_STAGE_MAX_BYTES,
    ),
  });
}

/** Upload bounded bytes under the intent lock. A fenced driver prevents cleanup races after session loss. */
export async function uploadFileStage(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  id: string,
  field: string,
  stageId: string,
  bytes: Uint8Array,
  contentType: string | undefined,
  storage?: StorageDriver | null,
  kms?: Kms,
  fields = grantedFileFields(model),
): Promise<Result<{ uploaded: true }>> {
  if (
    !stageIdentity(ctx) ||
    crudWriteDenied(ctx.actor, model.name, "update", true)
  ) return err("forbidden", "policy denied");
  if (!fields.includes(field)) return err("notFound", "file not found");
  if (!storage?.staged) {
    return err(
      "business",
      "file/stage-unsupported: storage must fence late staged writes",
    );
  }
  if (!isTransactor(db)) {
    return err(
      "business",
      "file/stage-transaction: upload requires a transaction root",
    );
  }
  if (bytes.byteLength > FILE_STAGE_MAX_BYTES) {
    return err(
      "validation",
      "file/stage-size: upload exceeds the staged byte limit",
    );
  }
  const snapshot = bytes.slice();
  const constraints = fileConstraints(model, field);
  return await db.transaction(async (tx) => {
    const stage = await lockFileStage(tx, model, ctx, id, field, stageId);
    if (!stage || !stage.alive || !await visibleRow(tx, model, ctx, id, kms)) {
      return err("notFound", "file stage not found");
    }
    if (stage.state !== "pending") {
      return err("conflict", "file stage is not awaiting upload");
    }
    const metadata = checkFileMetadata(
      constraints,
      snapshot.byteLength,
      contentType,
    );
    if (!metadata.ok) return metadata;
    const inspected = await inspectFile(constraints, snapshot, contentType);
    if (!inspected.ok) return inspected;
    await storage.staged!.put(stage.object_key, snapshot, contentType);
    await tx.query(`UPDATE "_file_stage" SET state='uploaded' WHERE id=$1`, [
      stage.id,
    ]);
    return ok({ uploaded: true as const });
  });
}

export { expireFileStages } from "./file-stage-expire.ts";
