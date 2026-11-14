import { isAnonymous } from "../authz/auth.ts";
import { err, ok, type Result } from "../core/result.ts";
import { stableStringify } from "../core/version.ts";
import { type Db, isFrameworkTransactionHandle } from "./db.ts";
import type { ReadCtx } from "./repo.ts";
import { isManagedTransactionScope } from "./transaction-scope.ts";
import type { ResourceModel } from "../core/app.ts";
import { tableOf } from "../core/app-define.ts";
import { appendRowPolicyConjunct } from "./repo-read.ts";

// The secret belongs to a composed resource identity, not its public metadata. Each app gets fresh
// model objects; keeping the bytes outside the model prevents accidental config/metadata exposure.
const crudSecrets = new WeakMap<object, Uint8Array>();

/** A continue batch stopped between item transactions; the current item's commit may be unknown. */
export class KeyedBulkInterrupted extends Error {
  constructor(
    readonly completed: number,
    readonly failed: number,
    cause: unknown,
  ) {
    super("keyed bulk interrupted; retry with the same key", { cause });
  }
}

/** A resource opts in; an individual transport door can explicitly opt out. */
export function crudIdempotencyEnabled(
  model: ResourceModel,
  channel: "http" | "mcp",
  verb: "create" | "update" | "delete" | "restore",
): boolean {
  const features = model.features as { readonly idempotency?: boolean };
  if (features.idempotency !== true) return false;
  const door = channel === "http" ? model.http[verb] : model.mcp[verb];
  return !(door && typeof door === "object" &&
    (door as { readonly idempotent?: boolean }).idempotent === false);
}

/** Recheck the current row policy on a soft-deleted row without making it a public read. A hard
 *  delete leaves no row against which to re-evaluate policy and therefore cannot authorize replay. */
export async function authorizeDeletedCrudReplay(
  tx: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  id: string,
  incarnation?: string,
): Promise<boolean> {
  if (!model.features.softDelete) return false;
  const params: unknown[] = [id];
  const p = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  let where = "id = $1 AND deleted_at IS NOT NULL";
  if (model.features.scope) where += ` AND scope_key = ${p(ctx.scope)}`;
  if (incarnation !== undefined) {
    where += ` AND cas_incarnation = ${p(incarnation)}`;
  }
  where += appendRowPolicyConjunct(model, ctx, p);
  return (await tx.query(
    `SELECT id FROM ${tableOf(model)} WHERE ${where} LIMIT 1`,
    params,
  )).rows.length === 1;
}

/** Decode a dedicated, operator-held key. Unlike a generated process key, this must be shared by
 *  replicas and retained until every claim made with it expires. */
export function bindCrudIdempotencySecret(
  models: readonly object[],
  secret: unknown,
): void {
  if (secret === undefined) return;
  if (typeof secret !== "string") {
    throw new TypeError(
      "crud-idempotency/secret: expected a base64-encoded 32-byte random secret",
    );
  }
  let raw: Uint8Array;
  try {
    raw = Uint8Array.from(atob(secret.trim()), (c) => c.charCodeAt(0));
  } catch {
    throw new TypeError(
      "crud-idempotency/secret: expected a base64-encoded 32-byte random secret",
    );
  }
  if (raw.length !== 32) {
    throw new TypeError(
      "crud-idempotency/secret: expected a base64-encoded 32-byte random secret",
    );
  }
  for (const model of models) crudSecrets.set(model, raw);
}

/** Never returns key bytes. A missing key is a fail-closed configuration error. */
export async function fingerprintCrudRequest(
  model: object,
  request: unknown,
): Promise<string> {
  const raw = crudSecrets.get(model);
  if (!raw) {
    throw new Error(
      "crud-idempotency/secret: no secret is bound for this resource",
    );
  }
  const key = await crypto.subtle.importKey(
    "raw",
    raw as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return await crudRequestFingerprint(key, request);
}

/** The transport has already validated the request and checked its write permission. The effect and
 *  replay check both execute on the same owned transaction handle. Only a safe receipt is persisted. */
export async function runCrudClaim<T>(
  tx: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  verb: "create" | "update" | "delete" | "restore",
  key: string | undefined,
  request: unknown,
  authorizeReplay: (receipt: T) => Promise<boolean>,
  execute: () => Promise<T>,
): Promise<T> {
  if (key === undefined) return await execute();
  const result = await crudClaim(tx, {
    ctx,
    module: model.module,
    resource: model.name,
    verb,
    key,
    fingerprint: await fingerprintCrudRequest(model, request),
    // Batch request markers share the same verb/key namespace. Their receipt is not a
    // single-row receipt, so the single-row callback cannot safely authorize it.
    authorizeReplay: (receipt: T) =>
      receipt && typeof receipt === "object" && "mode" in receipt
        ? Promise.resolve(false)
        : authorizeReplay(receipt),
    execute,
    shouldRetain: (receipt) => {
      if (verb === "create") return true;
      if (!receipt || typeof receipt !== "object") return false;
      const value = receipt as Record<string, unknown>;
      return verb === "update"
        ? value.updated === true
        : verb === "delete"
        ? value.deleted === true
        : value.restored === true;
    },
  });
  if (!result.ok) {
    throw Object.assign(new Error(result.error.message), result.error);
  }
  return result.value.receipt;
}

/** A CRUD claim is committed in the same transaction as its write. The caller validates input and
 *  runs its door permission before entering; on replay it must also reauthorize the stored receipt.
 *  Only a caller-supplied, safe receipt is persisted, never the raw request or a resource row. */
export async function crudClaim<T>(
  tx: Db,
  opts: {
    readonly ctx: ReadCtx;
    readonly module: string;
    readonly resource: string;
    readonly verb: string;
    readonly key: string;
    readonly fingerprint: string;
    readonly authorizeReplay: (receipt: T) => Promise<boolean>;
    readonly execute: () => Promise<T>;
    readonly shouldRetain?: (receipt: T) => boolean;
  },
): Promise<Result<{ receipt: T; replayed: boolean }>> {
  if (!isFrameworkTransactionHandle(tx) && !isManagedTransactionScope(tx)) {
    throw new TypeError(
      "CRUD idempotency requires a live transaction callback",
    );
  }
  const actor = opts.ctx.actor;
  if (isAnonymous(actor) || actor === null) {
    return err(
      "forbidden",
      "a keyed CRUD request requires an authenticated actor",
    );
  }
  if (opts.key.trim() === "" || opts.key !== opts.key.trim()) {
    return err(
      "validation",
      "the idempotency key must be nonblank and trimmed",
    );
  }
  if (!/^[0-9a-f]{64}$/.test(opts.fingerprint)) {
    return err("internal", "invalid CRUD idempotency fingerprint");
  }
  const claimKey = JSON.stringify([
    "crud-v1",
    opts.module,
    opts.resource,
    opts.verb,
    actor.type,
    actor.id,
    actor.onBehalfOf ?? null,
    opts.ctx.scope,
    opts.key,
  ]);
  if (new TextEncoder().encode(claimKey).length > 2692) {
    return err("validation", "the idempotency claim is too long to store");
  }
  const inserted = await tx.query<{ key: string }>(
    `INSERT INTO "_idempotency" (key) VALUES ($1::text) ON CONFLICT DO NOTHING RETURNING key`,
    [claimKey],
  );
  if (inserted.rows.length === 0) {
    const existing = await tx.query<{ result_json: string | null }>(
      `SELECT result::text AS result_json FROM "_idempotency" WHERE key = $1::text FOR UPDATE`,
      [claimKey],
    );
    const raw = existing.rows[0]?.result_json;
    if (typeof raw !== "string") {
      return err("stale", "the claim changed; retry the request");
    }
    let stored: unknown;
    try {
      stored = JSON.parse(raw);
    } catch {
      return err("internal", "invalid CRUD idempotency claim");
    }
    if (
      !stored || typeof stored !== "object" ||
      (stored as Record<string, unknown>).kind !== "crud-v1" ||
      typeof (stored as Record<string, unknown>).fingerprint !== "string" ||
      !("receipt" in stored)
    ) {
      return err("internal", "invalid CRUD idempotency claim");
    }
    const data = stored as { fingerprint: string; receipt: T };
    if (!await opts.authorizeReplay(data.receipt)) {
      return err("notFound", "resource not found");
    }
    if (data.fingerprint !== opts.fingerprint) {
      return err(
        "conflict",
        "the idempotency key was used with a different request",
      );
    }
    return ok({ receipt: data.receipt, replayed: true });
  }
  const receipt = await opts.execute();
  if (opts.shouldRetain && !opts.shouldRetain(receipt)) {
    await tx.query(`DELETE FROM "_idempotency" WHERE key = $1::text`, [
      claimKey,
    ]);
    return ok({ receipt, replayed: false });
  }
  if (JSON.stringify(receipt) === undefined) {
    throw new TypeError("CRUD idempotency receipt is not JSON");
  }
  await tx.query(
    `UPDATE "_idempotency" SET result = $2::text::jsonb WHERE key = $1::text`,
    [
      claimKey,
      JSON.stringify({
        kind: "crud-v1",
        fingerprint: opts.fingerprint,
        receipt,
      }),
    ],
  );
  return ok({ receipt, replayed: false });
}

/** MAC the canonical JSON request with a deployment-held key, not the client key. This avoids
 *  placing raw inputs or an unkeyed, offline-guessable digest of password fields in the claim table. */
export async function crudRequestFingerprint(
  key: CryptoKey,
  request: unknown,
): Promise<string> {
  const json = JSON.stringify(request);
  if (json === undefined) {
    throw new TypeError("CRUD idempotency request is not JSON");
  }
  const canonical = stableStringify(JSON.parse(json));
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(canonical),
  );
  return Array.from(
    new Uint8Array(signature),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
