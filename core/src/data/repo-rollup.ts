// Rollup aggregate maintenance for a parent's rolled-up children: capture/apply deltas around
// create/update/remove/restore, recompute avg/min/max, and the advisory-lock ordering
// (`lockRollupCascadeEdges`) that keeps concurrent writes to the same parent/child edge deadlock-free.
import { tableOf } from "../core/app-define.ts";
import type { ResourceModel } from "../core/app.ts";
import type { RollupKind } from "../core/faces.ts";
import { type Db, isTransactor } from "./db.ts";
import { lifecycleLiveFrags } from "./repo-read.ts";

/** The SQL aggregate per kind — count(*) ignores the field; the rest aggregate the named column, each
 *  a fixed identifier from the closed RollupKind union so no caller value reaches the SQL keyword position. */
const ROLLUP_SQL: Record<RollupKind, (col: string) => string> = {
  count: () => "count(*)",
  sum: (c) => `coalesce(sum("${c}"), 0)`, // sum of the empty set is 0 (the count-family default)
  avg: (c) => `avg("${c}")`, // avg/min/max of the empty set are NULL (03-api-shape.md §8: `number | null`)
  min: (c) => `min("${c}")`,
  max: (c) => `max("${c}")`,
};

/** Count/sum may ride an atomic ±delta only when every persisted child is live. Expiry and temporal
 *  membership can hide a row the delta still counted (M-19); those children recompute instead. */
export function rollupDeltaSafe(child: ResourceModel): boolean {
  return !child.features.expiry && !child.features.temporal;
}

/**
 * Computes a maintained aggregate over a parent's children via a real SQL aggregate (never a DB
 * trigger — canon §8: triggers split logic into the DB and break single-source/no-codegen). Scoped to
 * `parentId`'s children, excluding soft-deleted ones. Returns `number` for count/sum, `number | null`
 * for avg/min/max (NULL on the empty set); `field` is required for every kind but `count`.
 */
export async function rollupAggregate(
  db: Db,
  child: ResourceModel,
  parentFk: string,
  parentId: string,
  kind: RollupKind,
  field?: string,
): Promise<number | null> {
  if (kind !== "count" && (field === undefined || !(field in child.columns))) {
    throw new Error(
      `rollupAggregate: '${kind}' needs a child column; '${field}' is not a column of '${child.name}'`,
    );
  }
  const agg = ROLLUP_SQL[kind](field ?? "");
  // The rollup must reflect the read-visible child set, so it DERIVES the read stack's lifecycle conjuncts
  // rather than re-stating them: a hand-mirrored copy diverges silently, and this one had — it missed the
  // rectified (superseded) case, so a recompute counted a child that `rectify` had already decremented.
  const where = [
    `"${parentFk}" = $1`,
    ...lifecycleLiveFrags(child.features),
  ].join(" AND ");
  const r = await db.query<{ agg: number | null }>(
    `SELECT ${agg} AS agg FROM ${tableOf(child)} WHERE ${where}`,
    [parentId],
  );
  const v = r.rows[0]?.agg;
  return v === undefined || v === null
    ? (kind === "count" || kind === "sum" ? 0 : null)
    : Number(v);
}

/**
 * Recomputes a parent's rollup column from its children and writes it back, same tx as the triggering
 * write — the authoritative path for avg/min/max (count/sum use a delta fast-path elsewhere). Idempotent:
 * a missed delta self-heals on the next recompute.
 */
export async function recomputeRollup(
  db: Db,
  parentTable: string,
  column: string,
  child: ResourceModel,
  parentFk: string,
  parentId: string,
  kind: RollupKind,
  field?: string,
): Promise<void> {
  // A Transactor root is NOT in a tx — FOR UPDATE would autocommit (L-29). Wrap so the lock holds
  // across the aggregate read + write. An inner tx handle has no `.transaction`, so this does not nest.
  if (isTransactor(db)) {
    await db.transaction((tx) =>
      recomputeRollup(
        tx,
        parentTable,
        column,
        child,
        parentFk,
        parentId,
        kind,
        field,
      )
    );
    return;
  }
  // canon §8 concurrency floor: locks the owner row (FOR UPDATE) before the recompute, serializing
  // concurrent child writes so two interleaved recomputes can't each miss the other's child and diverge.
  await db.query(`SELECT 1 FROM ${parentTable} WHERE id = $1 FOR UPDATE`, [
    parentId,
  ]);
  const value = await rollupAggregate(
    db,
    child,
    parentFk,
    parentId,
    kind,
    field,
  );
  await db.query(`UPDATE ${parentTable} SET "${column}" = $1 WHERE id = $2`, [
    value,
    parentId,
  ]);
}

/** The up-edge key a rolled-up child locks — ONE derivation, so the by-id paths and the create path
 *  (whose row does not exist yet) can never key the same edge differently and stop serializing. */
function upEdgeKeys(model: ResourceModel, pid: unknown): string[] {
  return model.rollupTargets.map((t) => `rce:${t.parentTable}:${String(pid)}`);
}

/** The edge keys one open transaction already holds, keyed on its `Db` handle (a fresh object per
 *  `db.transaction`, so a tx can never inherit another's set). Only tx handles are tracked — see
 *  {@link lockEdgeKeys}. */
const heldEdgeKeys = new WeakMap<
  Db,
  { readonly held: Set<string>; max: string }
>();

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
  let state = heldEdgeKeys.get(db);
  if (state === undefined) {
    state = { held: new Set<string>(), max: "" };
    heldEdgeKeys.set(db, state);
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

/**
 * Every rollup/cascade edge key a by-id write on `ids` will lock — ONE derivation, so the single-row door
 * and a bulk batch's head-of-tx prelude can never key the same edge differently and stop serializing.
 */
export async function rollupEdgeKeysById(
  db: Db,
  model: ResourceModel,
  ids: readonly string[],
  withCascade: boolean,
): Promise<string[]> {
  const keys: string[] = [];
  if (ids.length === 0) return keys;
  // these rows as children that roll up into a parent → the parent edge (read the parent ids, unlocked).
  if (model.rollupTargets.length > 0 && model.parentFk) {
    const ph = ids.map((_, i) => `$${i + 1}`).join(", ");
    const rows = (await db.query<{ pid: unknown }>(
      `SELECT "${model.parentFk}" AS pid FROM ${
        tableOf(model)
      } WHERE id IN (${ph})`,
      [...ids],
    )).rows;
    for (const r of rows) {
      if (r.pid != null) keys.push(...upEdgeKeys(model, r.pid));
    }
  }
  // these rows as parents whose children roll up into them: key the edge on the row's own table+id
  // (symmetric with the up-edge above) — closes an AB-BA deadlock against a DB ON DELETE CASCADE owner.
  if (
    withCascade &&
    (model.onDeleteSweeps.length > 0 || model.rollupOwnCols.length > 0)
  ) { for (const id of ids) keys.push(`rce:${tableOf(model)}:${id}`); }
  return keys;
}

/**
 * The create-side half of {@link rollupEdgeKeysById}: the rows do not exist yet, so the up-edge's parent
 * comes from the pending values instead of a by-id read — same key, so a create serializes against every
 * other write on that edge. Pure: a batch's keys are known before its first row runs.
 */
export function rollupEdgeKeysOnValues(
  model: ResourceModel,
  rows: readonly Record<string, unknown>[],
): string[] {
  if (model.rollupTargets.length === 0 || !model.parentFk) return [];
  const fk = model.parentFk;
  const keys: string[] = [];
  for (const v of rows) {
    const pid = v[fk];
    if (pid != null) keys.push(...upEdgeKeys(model, pid)); // an orphan child (no parent) touches no edge
  }
  return keys;
}

/**
 * Serializes every op that touches a rollup/cascade edge via a `pg_advisory_xact_lock` keyed on the
 * edge's parent, taken before any row lock (`create` takes the same key through
 * {@link lockRollupEdgesOnValues}) — sidesteps a `40P01` deadlock between the mixed row+FK lock
 * orderings that `update(child)`/`remove(child)` and `remove(parent)`'s cascade sweep each take. A node
 * holding both edges locks them in sorted key order. Held to the op tx's commit; a no-op with no edge to lock.
 */
export async function lockRollupCascadeEdges(
  db: Db,
  model: ResourceModel,
  id: string,
  withCascade: boolean,
): Promise<void> {
  await lockEdgeKeys(
    db,
    await rollupEdgeKeysById(db, model, [id], withCascade),
  );
}

/**
 * The create-side half of {@link lockRollupCascadeEdges}. Taken BEFORE any row lock:
 * `create.assertParentsLive` takes FOR SHARE on the parent and `create.maintainParentRollups` then upgrades
 * it, so two concurrent creates under one soft-deletable parent deadlock (40P01) without this.
 */
export async function lockRollupEdgesOnValues(
  db: Db,
  model: ResourceModel,
  values: Record<string, unknown>,
): Promise<void> {
  await lockEdgeKeys(db, rollupEdgeKeysOnValues(model, [values]));
}

/** One captured rollup edge: the parent to maintain + the aggregated field value at capture time. */
export interface CapturedRollupTarget {
  readonly rt: ResourceModel["rollupTargets"][number];
  readonly pid: string;
  readonly delta: number;
}

/** Captures the parent ids + aggregated field values before a row write removes/revives the child
 *  (03-api-shape.md §8), reading through the same WHERE the write will use — a guarded-out row yields
 *  no targets and drives no maintenance. Shared by remove() and restore(). */
export async function captureRollupTargets(
  db: Db,
  model: ResourceModel,
  where: string,
  params: readonly unknown[],
): Promise<CapturedRollupTarget[]> {
  const toMaintain: CapturedRollupTarget[] = [];
  if (model.rollupTargets.length > 0) {
    const cols = [
      ...new Set(
        model.rollupTargets.flatMap((
          rt,
        ) => [rt.parentFk, ...(rt.field ? [rt.field] : [])]),
      ),
    ];
    const row = (await db.query<Record<string, unknown>>(
      `SELECT ${cols.map((f) => `"${f}"`).join(", ")} FROM ${
        tableOf(model)
      } WHERE ${where}`,
      [...params],
    )).rows[0];
    if (row) {
      for (const rt of model.rollupTargets) {
        if (row[rt.parentFk] != null) {
          toMaintain.push({
            rt,
            pid: String(row[rt.parentFk]),
            delta: rt.field ? Number(row[rt.field] ?? 0) : 0,
          });
        }
      }
    }
  }
  return toMaintain;
}

/** Applies captured rollup maintenance after a delete (`decrement`) or restore (`increment`): count/sum
 *  ride atomic deltas; avg/min/max recompute over the surviving/re-joined set (must run after `deleted_at`
 *  is stamped/cleared). Same tx as the row write. */
export async function maintainCapturedRollups(
  db: Db,
  model: ResourceModel,
  toMaintain: readonly CapturedRollupTarget[],
  direction: "decrement" | "increment",
): Promise<void> {
  const sign = direction === "decrement" ? "-" : "+";
  for (const { rt, pid, delta } of toMaintain) {
    if ((rt.kind === "count" || rt.kind === "sum") && rollupDeltaSafe(model)) {
      if (rt.kind === "count") {
        await db.query(
          `UPDATE ${rt.parentTable} SET "${rt.column}" = "${rt.column}" ${sign} 1 WHERE id = $1`,
          [pid],
        );
      } else {
        await db.query(
          `UPDATE ${rt.parentTable} SET "${rt.column}" = "${rt.column}" ${sign} $1 WHERE id = $2`,
          [delta, pid],
        );
      }
    } else {
      await recomputeRollup(
        db,
        rt.parentTable,
        rt.column,
        model,
        rt.parentFk,
        pid,
        rt.kind,
        rt.field,
      );
    }
  }
}

/**
 * Maintains a child's rollups when an update changes an aggregated field (03-api-shape.md §8) — create
 * and delete are already maintained elsewhere. The owns-FK is fixed across an update, so only the `field`
 * value can change: `count` is skipped (field-independent); `sum` rides an atomic delta; `avg`/`min`/`max`
 * recompute (FOR UPDATE-serialized). Only rollups whose `field` appears in `patch` are touched.
 */
export async function maintainRollupsOnUpdate(
  db: Db,
  model: ResourceModel,
  before: Record<string, unknown>,
  patch: Record<string, unknown>,
): Promise<void> {
  for (const rt of model.rollupTargets) {
    if (rt.kind === "count" || rt.field === undefined) continue; // count is field-independent; field-less kinds can't change
    if (!(rt.field in patch)) continue; // the aggregated field wasn't touched — nothing to maintain
    const pid = before[rt.parentFk];
    if (pid == null) continue; // an orphan child (no parent) contributes to no aggregate
    if (rt.kind === "sum" && rollupDeltaSafe(model)) {
      const oldV = Number(before[rt.field] ?? 0);
      const newV = Number(patch[rt.field] ?? 0);
      const delta = newV - oldV;
      if (delta !== 0) {
        await db.query(
          `UPDATE ${rt.parentTable} SET "${rt.column}" = "${rt.column}" + $1 WHERE id = $2`,
          [delta, String(pid)],
        );
      }
    } else {
      // avg/min/max can't ride a delta (the new extreme/mean needs the whole set) → recompute on the parent.
      await recomputeRollup(
        db,
        rt.parentTable,
        rt.column,
        model,
        rt.parentFk,
        String(pid),
        rt.kind,
        rt.field,
      );
    }
  }
}
