import type { ResourceModel } from "../core/app.ts";
import { all } from "../core/where.ts";
import { err, ok, type Result } from "../core/result.ts";
import { list, type ReadCtx, type RowPolicy } from "../data/repo.ts";
import type { Db } from "../data/db.ts";
import type { StorageDriver } from "../data/storage.ts";
import { fileKeyPrefix, isSafeStorageKey } from "../data/storage.ts";
import type { Kms } from "./encrypt.ts";
import { grantedFileFields } from "./redact.ts";
import { crudWriteDenied } from "../authz/auth.ts";

export const FILE_URL_TTL_MAX = 3600;
export const FILE_URL_TTL_DEFAULT = 300;
export function fileGrantTtl(raw: unknown): number {
  const n = raw === undefined || raw === null
    ? FILE_URL_TTL_DEFAULT
    : Number(raw);
  return !Number.isFinite(n) || n <= 0
    ? FILE_URL_TTL_DEFAULT
    : Math.min(3600, Math.max(1, Math.floor(n)));
}
export function mcpGrantedFileFields(model: ResourceModel): readonly string[] {
  if (!model.mcp.find) return [];
  const shape = model.mcp.find.shape;
  return grantedFileFields(model).filter((field) =>
    !shape || shape.includes(field)
  );
}
export async function fileUploadGrant(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  id: string,
  field: string,
  storage?: StorageDriver | null,
  kms?: Kms,
  ttl?: unknown,
  fields = grantedFileFields(model),
): Promise<Result<{ url: string; ttl: number; method: "PUT" }>> {
  if (crudWriteDenied(ctx.actor, model.name, "update", true)) {
    return err("forbidden", "policy denied");
  }
  if (!fields.includes(field)) return err("notFound", "file not found");
  if (!storage || storage.conditionalPut !== true) {
    return err(
      "business",
      "file/upload-conditional: storage must support atomic if-absent upload grants",
    );
  }
  const policy =
    (model.rowPolicy as RowPolicy<Record<string, unknown>> | null) ??
      (() => all());
  const row =
    (await list<Record<string, unknown>>(db, model, ctx, policy, { id }, kms))[
      0
    ];
  const key = row?.[field];
  if (typeof key !== "string" || key.length === 0) {
    return err("notFound", "file not found");
  }
  if (
    !isSafeStorageKey(key) ||
    !key.startsWith(fileKeyPrefix(model.pgSchema, model.name, field, id))
  ) {
    return err(
      "conflict",
      "file/upload-key: replace the file field to mint a row-owned key before upload",
    );
  }
  if (storage.head && await storage.head(key)) {
    return err(
      "conflict",
      "file/upload-exists: replace the file field to mint a new key before upload",
    );
  }
  const seconds = fileGrantTtl(ttl);
  return ok({
    url: await storage.presignedPut(key, seconds, { ifAbsent: true }),
    ttl: seconds,
    method: "PUT",
  });
}
export async function fileGrant(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  id: string,
  field: string,
  storage?: StorageDriver | null,
  kms?: Kms,
  ttl?: unknown,
  fields = grantedFileFields(model),
): Promise<
  Result<
    {
      url: string;
      ttl: number;
      exists?: boolean;
      metadata?: { readonly size: number; readonly contentType?: string };
    }
  >
> {
  if (!fields.includes(field)) return err("notFound", "file not found");
  if (!storage) {
    return err("internal", "file grant requires configured storage");
  }
  const policy =
    (model.rowPolicy as RowPolicy<Record<string, unknown>> | null) ??
      (() => all());
  const row =
    (await list<Record<string, unknown>>(db, model, ctx, policy, { id }, kms))[
      0
    ];
  const key = row?.[field];
  if (typeof key !== "string" || key.length === 0) {
    return err("notFound", "file not found");
  }
  const seconds = fileGrantTtl(ttl);
  const metadata = storage.head ? await storage.head(key) : undefined;
  return ok({
    url: await storage.presignedGet(key, seconds),
    ttl: seconds,
    ...(metadata === undefined
      ? {}
      : { exists: metadata !== null, ...(metadata ? { metadata } : {}) }),
  });
}
