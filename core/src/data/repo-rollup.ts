// Rollup aggregate maintenance for a parent's rolled-up children: capture/apply deltas around
// create/update/remove/restore, recompute avg/min/max, and the advisory-lock ordering
// (`lockRollupCascadeEdges`) that keeps concurrent writes to the same parent/child edge deadlock-free.
import { tableOf } from "../core/app-define.ts";
import type { ResourceModel } from "../core/app.ts";
import type { RollupKind } from "../core/faces.ts";
import { type Db, isTransactor } from "./db.ts";
import { lockEdgeKeys } from "./tx-locks.ts";
import { lifecycleSql } from "./read-sql.ts";
import { querySql, readMetadata } from "./read-compiler.ts";
import { type SQL, sql } from "drizzle-orm/sql";
import { enqueueReadModelMaintainFromSource } from "../features/readmodel.ts";

/** The SQL aggregate per kind — count(*) ignores the field; the rest aggregate the named column, each
 *  a fixed identifier from the closed RollupKind union so no caller value reaches the SQL keyword position. */
const ROLLUP_SQL: Record<RollupKind, (col: string) => SQL> = {
  count: () => sql`count(*)`,
  sum: (c) => sql`coalesce(sum(${sql.identifier(c)}), 0)`, // sum of the empty set is 0 (the count-family default)
  avg: (c) => sql`avg(${sql.identifier(c)})`, // avg/min/max of the empty set are NULL (03-api-shape.md §rollups: `number | null`)
  min: (c) => sql`min(${sql.identifier(c)})`,
  max: (c) => sql`max(${sql.identifier(c)})`,
};

/** Count/sum may ride an atomic ±delta only when every persisted child is live. Expiry and temporal
 *  membership can hide a row the delta still counted (M-19); those children recompute instead. */
export function rollupDeltaSafe(child: ResourceModel): boolean {
  return !child.features.expiry && !child.features.temporal;
}

/**
 * Computes a maintained aggregate over a parent's children via a real SQL aggregate (never a DB
 * trigger — canon §8: triggers split logic into the DB and break single-source/no-codegen). Scoped to
 * `parentId`'s visible children. Count/sum of the empty set is 0, avg/min/max NULL; any other value is the
 * driver's own, so a `numeric` or `bigint` total stays exact when it is written back.
 */
export async function rollupAggregate(
  db: Db,
  child: ResourceModel,
  parentFk: string,
  parentId: string,
  kind: RollupKind,
  field?: string,
): Promise<unknown> {
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
    sql`${sql.identifier(parentFk)} = ${parentId}`,
    ...lifecycleSql(child.features),
  ];
  const r = await querySql<{ agg: unknown }>(
    db,
    sql`SELECT ${agg} AS agg FROM ${readMetadata(child).table} WHERE ${
      sql.join(where, sql` AND `)
    }`,
  );
  const v = r.rows[0]?.agg;
  return v === undefined || v === null
    ? (kind === "count" || kind === "sum" ? 0 : null)
    : v;
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
  parentReadModelSource?:
    ResourceModel["rollupTargets"][number]["parentReadModelSource"],
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
        parentReadModelSource,
      )
    );
    return;
  }
  // canon §8 concurrency floor: locks the owner row (FOR UPDATE) before the recompute, serializing
  // concurrent child writes so two interleaved recomputes can't each miss the other's child and diverge.
  const parent = (await querySql<{ scope_key?: string }>(
    db,
    sql`SELECT ${
      parentReadModelSource?.scoped ? sql.identifier("scope_key") : sql`1`
    } AS scope_key FROM ${
      sql.raw(parentTable)
    } WHERE id = ${parentId} FOR UPDATE`,
  )).rows[0];
  if (!parent) return;
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
  if (parentReadModelSource) {
    await enqueueReadModelMaintainFromSource(
      db,
      parentReadModelSource,
      parentReadModelSource.scoped ? parent.scope_key : undefined,
      parentId,
      "upsert",
    );
  }
}

/** The up-edge key a rolled-up child locks — ONE derivation, so the by-id paths and the create path
 *  (whose row does not exist yet) can never key the same edge differently and stop serializing. */
function upEdgeKeys(model: ResourceModel, pid: unknown): string[] {
  return model.rollupTargets.map((t) => `rce:${t.parentTable}:${String(pid)}`);
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
    const rows = (await querySql<{ pid: unknown }>(
      db,
      sql`SELECT ${sql.identifier(model.parentFk)} AS pid FROM ${
        readMetadata(model).table
      } WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`,
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
  readonly delta: unknown; // the stored child value, bound as-is so the column's own type does the arithmetic
}

/** Captures the parent ids + aggregated field values before a row write removes/revives the child
 *  (03-api-shape.md §rollups), reading through the same WHERE the write will use — a guarded-out row yields
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
    const row = (await querySql<Record<string, unknown>>(
      db,
      sql`SELECT ${
        sql.join(cols.map((f) => sql.identifier(f)), sql`, `)
      } FROM ${readMetadata(model).table} WHERE ${sql.raw(where)}`,
      params,
    )).rows[0];
    if (row) {
      for (const rt of model.rollupTargets) {
        if (row[rt.parentFk] != null) {
          toMaintain.push({
            rt,
            pid: String(row[rt.parentFk]),
            delta: rt.field ? (row[rt.field] ?? 0) : 0,
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
  scope: string,
  toMaintain: readonly CapturedRollupTarget[],
  direction: "decrement" | "increment",
): Promise<void> {
  const sign = direction === "decrement" ? "-" : "+";
  for (const { rt, pid, delta } of toMaintain) {
    if ((rt.kind === "count" || rt.kind === "sum") && rollupDeltaSafe(model)) {
      if (rt.kind === "count") {
        const updated = await db.query<{ id: unknown }>(
          `UPDATE ${rt.parentTable} SET "${rt.column}" = "${rt.column}" ${sign} 1 WHERE id = $1 RETURNING id`,
          [pid],
        );
        if (updated.rows.length > 0) {
          await enqueueReadModelMaintainFromSource(
            db,
            rt.parentReadModelSource,
            rt.parentReadModelSource.scoped ? scope : undefined,
            pid,
            "upsert",
          );
        }
      } else {
        const updated = await db.query<{ id: unknown }>(
          `UPDATE ${rt.parentTable} SET "${rt.column}" = "${rt.column}" ${sign} $1 WHERE id = $2 RETURNING id`,
          [delta, pid],
        );
        if (updated.rows.length > 0) {
          await enqueueReadModelMaintainFromSource(
            db,
            rt.parentReadModelSource,
            rt.parentReadModelSource.scoped ? scope : undefined,
            pid,
            "upsert",
          );
        }
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
        rt.parentReadModelSource,
      );
    }
  }
}

/**
 * Maintains a child's rollups when an update changes an aggregated field (03-api-shape.md §rollups) — create
 * and delete are already maintained elsewhere. The owns-FK is fixed across an update, so only the `field`
 * value can change: `count` is skipped (field-independent); `sum` rides an atomic delta; `avg`/`min`/`max`
 * recompute (FOR UPDATE-serialized). Only rollups whose `field` appears in `patch` are touched.
 */
export async function maintainRollupsOnUpdate(
  db: Db,
  model: ResourceModel,
  scope: string,
  before: Record<string, unknown>,
  patch: Record<string, unknown>,
): Promise<void> {
  for (const rt of model.rollupTargets) {
    if (rt.kind === "count" || rt.field === undefined) continue; // count is field-independent; field-less kinds can't change
    if (!(rt.field in patch)) continue; // the aggregated field wasn't touched — nothing to maintain
    const pid = before[rt.parentFk];
    if (pid == null) continue; // an orphan child (no parent) contributes to no aggregate
    if (rt.kind === "sum" && rollupDeltaSafe(model)) {
      const oldV = before[rt.field] ?? 0;
      const newV = patch[rt.field] ?? 0;
      if (String(newV) !== String(oldV)) {
        // both values bound, so Postgres subtracts in the column's type — a JS `newV - oldV` adds float noise
        const updated = await db.query<{ id: unknown }>(
          `UPDATE ${rt.parentTable} SET "${rt.column}" = "${rt.column}" + $1 - $2 WHERE id = $3 RETURNING id`,
          [newV, oldV, String(pid)],
        );
        if (updated.rows.length > 0) {
          await enqueueReadModelMaintainFromSource(
            db,
            rt.parentReadModelSource,
            rt.parentReadModelSource.scoped ? scope : undefined,
            String(pid),
            "upsert",
          );
        }
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
        rt.parentReadModelSource,
      );
    }
  }
}
