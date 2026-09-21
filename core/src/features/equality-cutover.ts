/**
 * Durable authority for an encrypted equality-token cutover.  An envelope can
 * continue to require historical KMS keys for unwrap, while the blind index
 * must use exactly one canonical MAC once a resource is cut over.  This file
 * owns that distinction; `rotateEncrypted()` remains envelope-only.
 */
import type { ResourceModel } from "../core/app.ts";
import { tableOf } from "../core/app-define.ts";
import { lowerStatic } from "../core/lower.ts";
import type { Db, Transactor } from "../data/db.ts";
import {
  blindIndexCol,
  blindIndexMacs,
  decryptRows,
  type Kms,
} from "./encrypt-envelope.ts";
import { deletedAtLivenessOn } from "../data/schema.ts";

export interface EqualityCutoverMarker {
  readonly field: string;
  readonly canonicalKeyId: string;
}

/** A resource-level xact key excludes every equality-index writer from its cutover. */
export async function lockEqualityCutover(
  db: Db,
  model: Pick<ResourceModel, "pgSchema" | "name">,
): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
    `encrypted-equality:${model.pgSchema}.${model.name}`,
  ]);
}

/**
 * Reads the field markers in one query.  A marker is only written at the end
 * of the cutover transaction, so a reader either sees the historical
 * multi-MAC policy or a fully canonical corpus, never a published halfway
 * state.
 */
export async function equalityCutoverMarkers(
  db: Db,
  at: { readonly schema: string; readonly table: string },
): Promise<ReadonlyMap<string, string>> {
  const r = await db.query<{ field: string; canonical_key_id: string }>(
    `SELECT field, canonical_key_id FROM "_encrypted_cutover"
     WHERE pg_schema = $1 AND resource = $2`,
    [at.schema, at.table],
  );
  return new Map(r.rows.map((x) => [x.field, x.canonical_key_id]));
}

/** The cutover is relevant only to a resource with a unique equality token. */
export function hasUniqueEquality(model: ResourceModel): boolean {
  return model.encryptedConfig.equality.some((field) =>
    model.unique.some((cols) => cols.includes(field))
  );
}

/**
 * The normal create/update doors must hold the same xact lock as the migration.
 * A root adapter opens the transaction here; an op pipeline hands us the
 * transaction-scoped handle it already owns.  A bare handle cannot honestly
 * hold `pg_advisory_xact_lock` across a write, so it is refused rather than
 * pretending that an autocommit lock protects the cutover.
 */
export async function withEqualityWriteLock<T>(
  db: Db,
  model: ResourceModel,
  fn: (tx: Db) => Promise<T>,
): Promise<T> {
  if ((db as Db).transactionScoped) {
    await lockEqualityCutover(db, model);
    return await fn(db);
  }
  const transaction = (db as Partial<Transactor>).transaction;
  if (typeof transaction !== "function") {
    throw new Error(
      `encrypted/equality-cutover-transaction: resource '${model.name}' needs a transaction-capable Db for equality-index writes so its cutover lock spans the write`,
    );
  }
  const transactor = db as Db & Transactor;
  return await transactor.transaction(async (tx) => {
    await lockEqualityCutover(tx, model);
    return await fn(tx);
  });
}

/** Writes all field markers atomically with the completed corpus. */
export async function markEqualityCutover(
  db: Db,
  model: ResourceModel,
  canonicalKeyId: string,
): Promise<void> {
  for (const field of model.encryptedConfig.equality) {
    await db.query(
      `INSERT INTO "_encrypted_cutover" (pg_schema, resource, field, canonical_key_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (pg_schema, resource, field)
       DO UPDATE SET canonical_key_id = EXCLUDED.canonical_key_id, completed_at = now()`,
      [model.pgSchema, model.name, field, canonicalKeyId],
    );
  }
}

export interface EqualityCutoverReport {
  readonly resource: string;
  readonly fields: readonly string[];
  readonly rows: number;
  readonly canonicalKeyId: string;
}

type ByteaCell = Uint8Array | ArrayLike<number> | null | undefined;

const bytes = (cell: Exclude<ByteaCell, null | undefined>): Uint8Array =>
  cell instanceof Uint8Array ? cell : Uint8Array.from(cell);

/**
 * Recompute every equality sidecar in ONE transaction. It scans in id-keyset
 * pages (bounded memory) while retaining the transaction and advisory lock for
 * the whole corpus. A malformed envelope, missing KMS key, CAS miss, or index
 * collision throws, rolling back every sidecar and leaving markers absent.
 */
export async function cutoverEqualityTokens(
  db: Db & Transactor,
  model: ResourceModel,
  kms: Kms,
  opts: { readonly pageSize?: number } = {},
): Promise<EqualityCutoverReport> {
  if (!hasUniqueEquality(model)) {
    throw new Error(
      `encrypted/equality-cutover: resource '${model.name}' has no unique equality field to cut over`,
    );
  }
  const canonicalKeyId = kms.equalityKeyId?.();
  if (canonicalKeyId === undefined) {
    throw new Error(
      `encrypted/equality-cutover-kms: resource '${model.name}' needs a KMS that reports its canonical equality key identity so the durable canonical token can be identified`,
    );
  }
  const pageSize = opts.pageSize ?? 500;
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
    throw new Error(
      "encrypted/equality-cutover: pageSize must be a positive safe integer",
    );
  }
  const fields = model.encryptedConfig.equality;
  const table = tableOf(model);
  return await db.transaction(async (tx) => {
    await lockEqualityCutover(tx, model);
    let lastId: string | null = null;
    let rows = 0;
    for (;;) {
      const selected = ["id", ...fields.map((f) => `\"${f}\"`)].join(", ");
      const page: { rows: Record<string, unknown>[] } = await tx.query<
        Record<string, unknown>
      >(
        lastId === null
          ? `SELECT ${selected} FROM ${table} ORDER BY id LIMIT $1`
          : `SELECT ${selected} FROM ${table} WHERE id > $2 ORDER BY id LIMIT $1`,
        lastId === null ? [pageSize] : [pageSize, lastId],
      );
      if (page.rows.length === 0) break;
      for (const stored of page.rows) {
        const id = String(stored.id);
        lastId = id;
        const original = new Map<string, ByteaCell>(
          fields.map((f) => [f, stored[f] as ByteaCell]),
        );
        await decryptRows(kms, fields, [stored], {
          schema: model.pgSchema,
          table: model.name,
        });
        const set: string[] = [];
        const params: unknown[] = [];
        for (const field of fields) {
          const value = stored[field];
          const token = value == null ? null : (await blindIndexMacs(
            kms,
            {
              schema: model.pgSchema,
              table: model.name,
            },
            field,
            value,
          ))[0];
          if (value != null && token === undefined) {
            throw new Error(
              `encrypted/equality-macs-empty: resource '${model.name}' equality field '${field}' received no equality MAC from its KMS adapter`,
            );
          }
          params.push(token ?? null);
          set.push(`\"${blindIndexCol(field)}\" = $${params.length}`);
        }
        params.push(id);
        const where = [`id = $${params.length}`];
        for (const field of fields) {
          const before = original.get(field);
          params.push(before == null ? null : bytes(before));
          where.push(`\"${field}\" IS NOT DISTINCT FROM $${params.length}`);
        }
        const updated = await tx.query<{ id: unknown }>(
          `UPDATE ${table} SET ${set.join(", ")} WHERE ${
            where.join(" AND ")
          } RETURNING id`,
          params,
        );
        if (updated.rows.length !== 1) {
          throw new Error(
            `encrypted/equality-cutover-cas: resource '${model.name}' row '${id}' changed during the cutover`,
          );
        }
        rows++;
      }
      if (page.rows.length < pageSize) break;
    }
    await assertCanonicalUniqueTuples(tx, model);
    await markEqualityCutover(tx, model, canonicalKeyId);
    return { resource: model.name, fields, rows, canonicalKeyId };
  });
}

/** Mirrors the physical unique-index shape, including scope and partial/soft-delete predicates. */
async function assertCanonicalUniqueTuples(
  db: Db,
  model: ResourceModel,
): Promise<void> {
  const equality = new Set(model.encryptedConfig.equality);
  const partialByCols = new Map(
    model.uniquePartial.map((x) => [x.cols.join("\u0000"), x.where]),
  );
  for (const cols of model.unique) {
    if (!cols.some((c) => equality.has(c))) continue;
    const physical = [
      ...(model.features.scope ? ["scope_key"] : []),
      ...cols.map((c) => equality.has(c) ? blindIndexCol(c) : c),
    ];
    const terms = [
      ...physical.map((c) => `\"${c}\" IS NOT NULL`),
      // mirrors unique DDL partial: softDelete and rectifiable share deleted_at (deletedAtLivenessOn).
      ...(deletedAtLivenessOn(model.features) ? ["deleted_at IS NULL"] : []),
    ];
    const partial = partialByCols.get(cols.join("\u0000"));
    if (partial) terms.push(lowerStatic(partial));
    const hit = await db.query(
      `SELECT 1 FROM ${tableOf(model)} WHERE ${terms.join(" AND ")}
       GROUP BY ${physical.map((c) => `\"${c}\"`).join(", ")}
       HAVING count(*) > 1 LIMIT 1`,
    );
    if (hit.rows.length > 0) {
      throw new Error(
        `encrypted/equality-cutover-duplicate: resource '${model.name}' still has a duplicate canonical unique tuple (${
          cols.join(", ")
        })`,
      );
    }
  }
}
