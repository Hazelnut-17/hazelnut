import { assertTreeParentInScope, closureTableOf } from "./repo-tree-shared.ts";
// Tree writes, part A: the no-cycle guard (`wouldCycle`, serialized by `lockTreeForReparent`),
// `setParent`/`move`, and closure-table (`<r>_tree`) maintenance on re-parent. `readRow` here is the
// shared FOR-UPDATE before-image read used for audit diffs and CAS serialization.
import { tableOf } from "../core/app-define.ts";
import type { ResourceModel } from "../core/app.ts";
import type { Db } from "./db.ts";
import {
  auditConfig,
  auditWrite,
  onRowGate,
  timestampsGate,
} from "./repo-audit.ts";
import { enqueueReadModelMaintain } from "../features/readmodel.ts";
import { appendRowPolicyConjunct } from "./repo-read.ts";
import type { ReadCtx } from "./repo.ts";

/** Read one row by id within the caller's scope (NOT softDelete-filtered — a soft-deleted row is still a
 *  real prior/after state for the audit diff). Used to capture the before-image for the `{from,to}` delta. */
export async function readRow(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  id: string,
): Promise<Record<string, unknown> | null> {
  const params: unknown[] = [id];
  let where = `id = $1`;
  if (model.features.scope) {
    params.push(ctx.scope);
    where += ` AND scope_key = $${params.length}`;
  }
  // FOR UPDATE locks the row so the before-read + ensuing UPDATE/DELETE serialize against a concurrent
  // writer, else two updates read the same stale image and double-count the rollup / fabricate the audit diff.
  const r = await db.query<Record<string, unknown>>(
    `SELECT * FROM ${tableOf(model)} WHERE ${where} FOR UPDATE`,
    params,
  );
  return r.rows[0] ?? null;
}

/**
 * Serializes concurrent re-parents on the same tree (the `tree/no-cycle` check-then-act fix): without it,
 * two concurrent re-parents that together form a cycle (`A.parent:=B` ∥ `B.parent:=A`) can each read a
 * cycle-free pre-state under READ COMMITTED and both commit, corrupting the tree permanently. An xact-scoped
 * advisory lock on the tree (table + scope), taken before `wouldCycle`, blocks the second until the first
 * commits, so it re-checks against committed state. Pins: (real-PG).
 */
export async function lockTreeForReparent(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
): Promise<void> {
  // key on the tree forest: the resource table + scope (cross-scope re-parents can't interact — the FK is
  // scope-bound — so two scopes need not serialize); different resources/scopes hash apart, never blocking.
  const key = model.features.scope
    ? `${tableOf(model)}:${ctx.scope}`
    : tableOf(model);
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [key]);
}

/**
 * The `tree/no-cycle` pre-write ancestry guard (04-features.md §tree): a recursive CTE walks the ancestor
 * chain up from the proposed parent; reaching the node itself means the edge would close a loop. Setting
 * `parent_id = null` is always safe. The one cycle check shared by `setParent`/`move` and the `update`
 * write-auto, so a re-parent through any repo path is guarded identically. Callers take
 * `lockTreeForReparent` first so the check-then-act serializes per tree.
 */
export async function wouldCycle(
  db: Db,
  model: ResourceModel,
  id: string,
  parentId: string | null,
): Promise<boolean> {
  if (parentId === null) return false; // becoming a root never cycles
  const cyc = await db.query(
    `WITH RECURSIVE anc AS (
       SELECT id, parent_id FROM ${tableOf(model)} WHERE id = $1
       UNION ALL
       SELECT t.id, t.parent_id FROM ${
      tableOf(model)
    } t JOIN anc a ON t.id = a.parent_id)
     SELECT 1 FROM anc WHERE id = $2 LIMIT 1`,
    [parentId, id],
  );
  return cyc.rows.length > 0;
}

/**
 * `tree/no-cycle` — re-parents a node, rejecting any move that would create a cycle (the shared
 * `wouldCycle` guard). `parent_id = null` (making a root) is always safe; the `update` write-auto carries
 * the same guard, so a re-parent via `ctx.data.update` is refused identically.
 */
export async function setParent(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  id: string,
  parentId: string | null,
): Promise<{ updated: boolean; cycle: boolean }> {
  // serialize the check-then-act before wouldCycle (held to commit) so two concurrent re-parents that
  // would together close a cycle cannot both pass — the loser re-evaluates against the winner's committed state.
  await lockTreeForReparent(db, model, ctx);
  await assertTreeParentInScope(db, model, ctx, parentId); // setParent/move must not re-parent across scope
  if (await wouldCycle(db, model, id, parentId)) {
    return { updated: false, cycle: true };
  }
  const params: unknown[] = [parentId, id];
  let set = `parent_id = $1`;
  if (timestampsGate(model)?.updated) set += `, updated_at = now()`; // a re-parent is an update — stamp updated_at iff the `updated` half is gated on
  // a re-parent is a write: bump the optimistic-lock version (else a concurrent CAS update() is blinded)
  // and stamp the onRow `updated_by` provenance, the same column cards update() leaves.
  if (model.features.versioning) set += `, version = version + 1`;
  if (onRowGate(model)?.updated) {
    set += `, updated_by_type = $${
      params.push(ctx.actor?.type ?? null)
    }, updated_by_id = $${params.push(ctx.actor?.id ?? null)}`;
  }
  let where = `id = $2`;
  if (model.features.scope) {
    params.push(ctx.scope);
    where += ` AND scope_key = $${params.length}`;
  }
  // AND-inject the rowPolicy so an actor cannot re-parent a row their rowPolicy hides — a hidden row
  // matches 0 rows → {updated:false}, never a cross-owner move. System writes (tree cascades) stay vacuous.
  const p = (v: unknown) => `$${params.push(v)}`;
  where += appendRowPolicyConjunct(model, ctx, p, undefined);
  // capture the prior parent before the update (only when audited) so the audit row carries the exact
  // `parent_id {from,to}` diff — a re-parent is an update and must leave the same audit trail update() does.
  const audited = auditConfig(model) !== null;
  let beforeParent: unknown;
  if (audited) {
    beforeParent = (await db.query<{ parent_id: unknown }>(
      `SELECT parent_id FROM ${tableOf(model)} WHERE id = $1`,
      [id],
    )).rows[0]?.parent_id ?? null;
  }
  const r = await db.query(
    `UPDATE ${tableOf(model)} SET ${set} WHERE ${where} RETURNING id`,
    params,
  );
  const updated = r.rows.length > 0;
  if (updated) {
    // same tx as the re-parent: write the audit row and re-project into any read model that sinks this
    // resource (a moved row's projected parent/path is now stale).
    if (audited) {
      await auditWrite(db, model, ctx, id, "update", {
        before: { parent_id: beforeParent },
        after: { parent_id: parentId },
      });
    }
    if (model.readModelSinks.length > 0) {
      await enqueueReadModelMaintain(db, model, ctx, id, "upsert");
    }
  }
  return { updated, cycle: false };
}

/**
 * Rebuilds a moved subtree's `<r>_tree` closure rows inside the current tx — the INSERT-only `addToTree`
 * (run at create) leaves a re-parented subtree's links to its old ancestors stale. (1) Deletes every
 * closure row whose descendant is in the subtree and whose ancestor is outside it. (2) Inserts (every
 * ancestor of the new parent, incl. its self-row) × (every subtree node), with `depth = anc.depth + 1 +
 * sub.depth`. Re-rooting needs only the delete. Shared by `move` and the `update` parent-change path.
 */
export async function rebuildClosure(
  db: Db,
  model: ResourceModel,
  id: string,
  parentId: string | null,
): Promise<void> {
  const ct = closureTableOf(model);
  await db.query(
    `DELETE FROM ${ct}
       WHERE descendant IN (SELECT descendant FROM ${ct} WHERE ancestor = $1)
         AND ancestor   NOT IN (SELECT descendant FROM ${ct} WHERE ancestor = $1)`,
    [id],
  );
  if (parentId !== null) {
    await db.query(
      `INSERT INTO ${ct} (ancestor, descendant, depth)
         SELECT up.ancestor, sub.descendant, up.depth + 1 + sub.depth
           FROM ${ct} up CROSS JOIN ${ct} sub
          WHERE up.descendant = $2 AND sub.ancestor = $1
       ON CONFLICT DO NOTHING`,
      [id, parentId],
    );
  }
}

/**
 * `move(id, parentId)` (04-features.md §tree type-propagation): re-parents through the no-cycle-guarded
 * `setParent`, then — when the resource stores a `treeClosure` table — rebuilds the moved subtree's
 * closure rows in the same tx (see `rebuildClosure` for the algorithm). Never called from `logic/`.
 */
export async function move(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  id: string,
  parentId: string | null,
): Promise<{ updated: boolean; cycle: boolean }> {
  const r = await setParent(db, model, ctx, id, parentId); // the no-cycle-guarded adjacency write
  if (!r.updated || !model.features.treeClosure) return r; // adjacency-only (or refused/no-op): nothing more to do
  await rebuildClosure(db, model, id, parentId); // rewrite the subtree's closure rows in the same tx
  return r;
}
