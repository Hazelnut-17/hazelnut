/** The per-transaction rollup/cascade edge-lock order, and the one savepoint door that keeps it. A leaf:
 *  it imports only the `Db` seam, so every writer (data verbs, workflow steps, jobs) can reach it. */
import { type Db, isTransactor } from "./db.ts";

/** The edge keys one open transaction already holds, keyed on its `Db` handle (a fresh object per
 *  `db.transaction`, so a tx can never inherit another's set). Only tx handles are tracked — see
 *  {@link lockEdgeKeys}. */
const heldEdgeKeys = new WeakMap<
  Db,
  { readonly held: Set<string>; max: string }
>();

/** A savepoint handle → the handle of the transaction it nests in, so the held set belongs to the tx. */
const enclosingTx = new WeakMap<Db, Db>();
const txOf = (db: Db): Db => {
  for (let d = db;;) {
    const up = enclosingTx.get(d);
    if (up === undefined) return d;
    d = up;
  }
};

/**
 * Runs `fn` in a driver savepoint of the open transaction `tx` — the one savepoint door the framework uses.
 * The savepoint's handle shares `tx`'s held edge keys; a rolled-back savepoint rewinds them, because
 * Postgres releases the advisory locks taken inside it.
 */
export async function inTxSavepoint<T>(
  tx: Db,
  fn: (sp: Db) => Promise<T>,
): Promise<T> {
  const root = txOf(tx);
  const before = heldEdgeKeys.get(root);
  const mark = before && { held: new Set(before.held), max: before.max };
  try {
    return await tx.savepoint!((sp) => {
      // PGlite nests on the transaction's own handle; linking it to itself would make `txOf` spin
      if (sp !== tx) enclosingTx.set(sp, tx);
      return fn(sp);
    });
  } catch (e) {
    if (mark === undefined) heldEdgeKeys.delete(root);
    else heldEdgeKeys.set(root, mark);
    throw e;
  }
}

/** How long an out-of-order acquisition polls before refusing. Under Postgres's 1s `deadlock_timeout` on
 *  purpose: past it the engine's detector fires first and the refusal degrades back to a raw `40P01`. */
const OUT_OF_ORDER_TRIES = 12;
const OUT_OF_ORDER_BACKOFF_MS = 20;

/** Takes `key` without ever blocking indefinitely, for the case where this tx already holds a HIGHER key —
 *  the one acquisition that could close an AB-BA cycle. Refuses as a retryable `conflict` instead. */
async function takeOutOfOrder(db: Db, key: string): Promise<void> {
  for (let attempt = 1;; attempt++) {
    const got = (await db.query<{ got: unknown }>(
      `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS got`,
      [key],
    )).rows[0]?.got;
    if (got === true || got === "t") return;
    if (attempt >= OUT_OF_ORDER_TRIES) {
      throw Object.assign(
        new Error(
          `rollup edge '${key}' is held by another transaction while this one already holds a higher edge ` +
            `key — waiting would be one half of an AB-BA deadlock on the edge locks, so it is refused ` +
            `instead. Retry the whole operation, or take both edges in one sorted prelude by batching the ` +
            `writes into a single createMany/updateMany/deleteMany call.`,
        ),
        { kind: "conflict" as const },
      );
    }
    await new Promise((r) => setTimeout(r, OUT_OF_ORDER_BACKOFF_MS));
  }
}

/**
 * Takes an edge-key set in the ONE ordering every door shares — deduped, sorted — and holds the ordering
 * ACROSS calls too: a tx blocks on an edge key only while that key is greater than every key it already
 * holds. A wait-for cycle would need the held-maxima to increase strictly all the way around it, so no
 * cycle on the edge advisories can form — however many separate writes one transaction composes. The
 * out-of-order acquisition (a second write naming a smaller parent) polls {@link takeOutOfOrder} and
 * refuses as `conflict` rather than waiting into the deadlock. Every lock door routes through here.
 *
 * A ROOT handle is exempt: outside a transaction each statement autocommits, so an xact advisory lock is
 * already released when the next one is taken and ordering cannot decide anything.
 */
export async function lockEdgeKeys(
  db: Db,
  keys: readonly string[],
): Promise<void> {
  const sorted = [...new Set(keys)].sort();
  if (sorted.length === 0) return;
  if (isTransactor(db)) {
    for (const k of sorted) {
      await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [k]);
    }
    return;
  }
  let state = heldEdgeKeys.get(txOf(db));
  if (state === undefined) {
    state = { held: new Set<string>(), max: "" };
    heldEdgeKeys.set(txOf(db), state);
  }
  for (const k of sorted) {
    if (state.held.has(k)) continue; // xact-scoped: once taken, held to commit
    if (k > state.max) {
      await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [k]);
      state.max = k;
    } else {
      await takeOutOfOrder(db, k);
    }
    state.held.add(k);
  }
}
