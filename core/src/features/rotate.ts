/**
 * `rotateEncrypted` — the key-rotation re-wrap batch worker (04-features.md §encrypted "Key lifecycle").
 * A DEK re-wrap by version, not a data re-encryption: only `wrapped_dek` + `key_id` change; `iv` and the
 * ciphertext are byte-for-byte untouched, so rotation costs nothing and loses nothing. Rides the `Kms` Port,
 * so the same worker rotates against the local `RotatingAppKeyKms` floor or an external KMS adapter.
 */
import type { Db } from "../data/db.ts";
import type { ResourceModel } from "../core/app.ts";
import { tableOf } from "../core/app-define.ts";
import { type Kms, packEnvelope, unpackEnvelope } from "./encrypt.ts";

/** What one `rotateEncrypted` pass migrated, for the caller to log / verify envelope migration. */
export interface RotateReport {
  /** the encrypted column the pass re-wrapped */
  readonly column: string;
  /** the old master-key version rows were migrated OFF */
  readonly from: string;
  /** the current master-key version rows were re-wrapped TO (read off the Port's wrap) */
  readonly to: string;
  /** how many rows were re-wrapped this pass (rows already on a different/current version are skipped) */
  readonly rewrapped: number;
  /** rows whose envelope failed to unpack, or whose `wrapped_dek` failed to unwrap, under `from` — isolated
   *  per row so ONE corrupted/tampered cell does not abort the scan for every row past it in id order.
   *  These are still sealed under `from` (the row was never touched), so they count toward the envelope
   *  migration check's `remainingOnFrom` — re-running the pass will not fix them; they need manual repair. */
  readonly skipped: ReadonlyArray<
    { readonly id: string; readonly error: string }
  >;
  /** rows whose envelope changed between the scan read and the CAS write-back — a concurrent write won, so
   *  the row was left as that writer committed it. Any still sealed under `from` count toward the envelope
   *  migration check, and a re-run picks them up. */
  readonly casMissed: number;
}

/** A stored encrypted cell as it arrives from the driver — a `bytea` is a Uint8Array, but some drivers hand back
 *  a plain array-like of byte values; a null/absent cell is skipped. */
type ByteaCell = Uint8Array | ArrayLike<number> | null | undefined;

const toBytes = (
  cell: Exclude<ByteaCell, null | undefined>,
): Uint8Array => (cell instanceof Uint8Array ? cell : Uint8Array.from(cell));

/**
 * Re-wrap every row of `model`'s encrypted `column` still sealed under `from` to the `Kms`'s current
 * master-key version. Returns a {@link RotateReport}. `batchSize` bounds rows held in memory per round-trip
 * (default 500). Idempotent: a second pass over a fully-migrated column re-wraps nothing.
 */
export async function rotateEncrypted(
  db: Db,
  model: ResourceModel,
  column: string,
  kms: Kms,
  opts: { readonly from: string; readonly batchSize?: number },
): Promise<RotateReport> {
  if (!model.encrypted.includes(column)) {
    throw new Error(
      `rotate: '${column}' is not an encrypted field of resource '${model.name}'`,
    );
  }
  const from = opts.from;
  const batchSize = opts.batchSize ?? 500;
  if (batchSize <= 0) throw new Error("rotate: batchSize must be positive");

  const table = tableOf(model);
  let rewrapped = 0;
  let casMissed = 0;
  let to: string | null = null;
  const skipped: { id: string; error: string }[] = [];

  // `key_id` is packed inside the bytea envelope, not a column, so this scans + filters in-process. A fixed
  // `LIMIT` window would strand rows past the drained prefix (a false clear-envelope result); the `id` keyset cursor
  // advances past every row exactly once, so the scan stays memory-bounded and complete.
  const pageSize = batchSize * 8;
  let lastId: string | null = null;
  for (;;) {
    const { rows }: { rows: ReadonlyArray<{ id: unknown; cell: ByteaCell }> } =
      await (lastId === null
        ? db.query<{ id: unknown; cell: ByteaCell }>(
          `SELECT id, "${column}" AS cell FROM ${table} ORDER BY id LIMIT $1`,
          [pageSize],
        )
        : db.query<{ id: unknown; cell: ByteaCell }>(
          `SELECT id, "${column}" AS cell FROM ${table} WHERE id > $2 ORDER BY id LIMIT $1`,
          [pageSize, lastId],
        ));
    if (rows.length === 0) break;
    for (const r of rows) {
      lastId = String(r.id); // advance the cursor over every row (sealed or not)
      if (r.cell == null) continue;
      // `unpackEnvelope`/`unwrapKey` depend on THIS row's own bytes — a corrupted or tampered cell must not
      // abort the scan for every row past it in id order (the cursor is deterministic, so an uncaught throw
      // here would re-die on the exact same row every re-run, forever). `wrapKey` below stays UNCAUGHT: it
      // depends only on the Kms's current version, not on row data, so a failure there is systemic and
      // should abort the whole pass immediately rather than silently skip every remaining row one at a time.
      let env: ReturnType<typeof unpackEnvelope>;
      try {
        env = unpackEnvelope(toBytes(r.cell));
      } catch (e) {
        skipped.push({
          id: String(r.id),
          error: e instanceof Error ? e.message : String(e),
        });
        continue;
      }
      if (env.keyId !== from) continue; // already off `from` (or never on it) — nothing to re-wrap
      let dek: Uint8Array;
      try {
        dek = await kms.unwrapKey(env.wrappedDek, env.keyId); // unwrap under the old version
      } catch (e) {
        skipped.push({
          id: String(r.id),
          error: e instanceof Error ? e.message : String(e),
        });
        continue;
      }
      const { wrapped, keyId } = await kms.wrapKey(dek); // re-wrap the same DEK under the current version
      if (keyId === from) {
        throw new Error(
          `rotate: the Kms current version equals the old version '${from}' — nothing to rotate to (point the Kms at the new master-key version first)`,
        );
      }
      to = keyId;
      // iv + ciphertext are carried over untouched — this is a re-wrap, never a re-encryption.
      const repacked = packEnvelope(keyId, env.iv, wrapped, env.cipher);
      // CAS write-back guards the scan-then-write race: the UPDATE lands only if the envelope is still the
      // exact bytes read. A CAS miss skips the row; `countSealedUnder` remains the envelope-presence check.
      const cas = await db.query<{ id: unknown }>(
        `UPDATE ${table} SET "${column}" = $1 WHERE id = $2 AND "${column}" = $3 RETURNING id`,
        [repacked, String(r.id), toBytes(r.cell)],
      );
      if (cas.rows.length === 1) rewrapped++;
      else casMissed++;
    }
    if (rows.length < pageSize) break; // a short page is the last page — the table is fully scanned
  }

  return { column, from, to: to ?? from, rewrapped, skipped, casMissed };
}

/** Count rows whose `column` envelope is still sealed under `keyId` (04-features.md §encrypted, migration
 *  check). Walks the whole table with the same `id` keyset cursor `rotateEncrypted` uses. This is the LAST
 *  LINE OF DEFENSE against premature envelope-key removal, so it must never itself throw and never itself go
 *  quiet on a row it cannot read: an envelope that fails to unpack cannot be VERIFIED as off `keyId`, and
 *  the safe direction to be wrong in is to still count it — an uncounted corrupted row is exactly the
 *  false envelope-clear result this check exists to prevent. */
export async function countSealedUnder(
  db: Db,
  model: ResourceModel,
  column: string,
  keyId: string,
  pageSize = 4000,
): Promise<number> {
  if (!model.encrypted.includes(column)) {
    throw new Error(
      `rotate: '${column}' is not an encrypted field of resource '${model.name}'`,
    );
  }
  const table = tableOf(model);
  let lastId: string | null = null;
  let n = 0;
  for (;;) {
    const { rows }: { rows: ReadonlyArray<{ id: unknown; cell: ByteaCell }> } =
      await (lastId === null
        ? db.query<{ id: unknown; cell: ByteaCell }>(
          `SELECT id, "${column}" AS cell FROM ${table} ORDER BY id LIMIT $1`,
          [pageSize],
        )
        : db.query<{ id: unknown; cell: ByteaCell }>(
          `SELECT id, "${column}" AS cell FROM ${table} WHERE id > $2 ORDER BY id LIMIT $1`,
          [pageSize, lastId],
        ));
    if (rows.length === 0) break;
    for (const r of rows) {
      lastId = String(r.id);
      if (r.cell == null) continue;
      try {
        if (unpackEnvelope(toBytes(r.cell)).keyId === keyId) n++;
      } catch {
        n++; // unreadable — count it as still sealed under EVERY version, fail-safe
      }
    }
    if (rows.length < pageSize) break;
  }
  return n;
}

/** Count rows whose `column` envelope is sealed under ANY key id (null cells skipped). Distinguishes
 *  "already rotated off `from`" from "typo'd `--from` while ciphertext still sits on another version". */
export async function countSealedAny(
  db: Db,
  model: ResourceModel,
  column: string,
  pageSize = 4000,
): Promise<number> {
  if (!model.encrypted.includes(column)) {
    throw new Error(
      `rotate: '${column}' is not an encrypted field of resource '${model.name}'`,
    );
  }
  const table = tableOf(model);
  let lastId: string | null = null;
  let n = 0;
  for (;;) {
    const { rows }: { rows: ReadonlyArray<{ id: unknown; cell: ByteaCell }> } =
      await (lastId === null
        ? db.query<{ id: unknown; cell: ByteaCell }>(
          `SELECT id, "${column}" AS cell FROM ${table} ORDER BY id LIMIT $1`,
          [pageSize],
        )
        : db.query<{ id: unknown; cell: ByteaCell }>(
          `SELECT id, "${column}" AS cell FROM ${table} WHERE id > $2 ORDER BY id LIMIT $1`,
          [pageSize, lastId],
        ));
    if (rows.length === 0) break;
    for (const r of rows) {
      lastId = String(r.id);
      if (r.cell == null) continue;
      n++;
    }
    if (rows.length < pageSize) break;
  }
  return n;
}
