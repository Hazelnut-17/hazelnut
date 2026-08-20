import {
  closureTableOf,
  CrossScopeReferenceError,
  type RemoveVerb,
} from "./repo-tree-shared.ts";
// Barrel re-exports keep import sites stable.
import { tableOf } from "../core/app-define.ts";
import type { ResourceModel } from "../core/app.ts";
import { all, type Where } from "../core/where.ts";
import { decryptRows, type Kms } from "../features/encrypt.ts";
import type { Db } from "./db.ts";
import { list } from "./repo-list.ts";
import { buildReadWhere } from "./repo-read.ts";
import { NO_CAS, update } from "./repo-update.ts";
import type { ReadCtx, RowPolicy } from "./repo.ts";

// The tree read-filter: the same read WHERE-stack list/find apply, built by the same buildReadWhere
// conjunct site, so ancestors/descendants walks never leak a hidden row; seed id binds at $n+1 after the stack params.
function treeReadWhereFor<Row>(
  model: ResourceModel,
  ctx: ReadCtx | undefined,
  rowPolicy: RowPolicy<Row>,
): { where: string; seedPlaceholder: string; params: unknown[] } {
  // a scoped resource's tree walk MUST bind ctx — fail closed against a cross-scope leak. `ctx.data` and
  // `treeDepth` always thread one, so only a direct ctx-less call reaches here.
  if (!ctx && model.features.scope) {
    throw new Error(
      `tree walk on scoped resource '${model.name}' requires a ctx — refusing to drop the scope conjunct (cross-scope leak)`,
    );
  }
  // An unscoped model has no scope conjunct, so a ctx-less walk stays valid; every other conjunct
  // (softDelete/expiry/temporal/rowPolicy/caller) is unaffected either way.
  const stackModel = ctx
    ? model
    : { ...model, features: { ...model.features, scope: false } };
  const { sql, params } = buildReadWhere<Row>(
    stackModel,
    ctx ?? { actor: null, scope: "" },
    rowPolicy,
    all<Row>(),
  );
  return { where: sql, seedPlaceholder: `$${params.length + 1}`, params };
}

/** Optional bounds on a tree walk — omit both for the unbounded walk (the default, additive). */
export interface TreeWalkBounds {
  readonly limit?: number;
  readonly maxDepth?: number;
}

function bindTreeBounds(
  args: unknown[],
  bounds: TreeWalkBounds | undefined,
  recAlias: string,
): { depthPred: string; recPred: string; limitSql: string } {
  let depthPred = "";
  let recPred = "";
  if (bounds?.maxDepth !== undefined) {
    args.push(bounds.maxDepth);
    const ph = `$${args.length}`;
    depthPred = ` AND c.depth <= ${ph}`;
    recPred = ` WHERE ${recAlias}._d + 1 < ${ph}`;
  }
  let limitSql = "";
  if (bounds?.limit !== undefined) {
    args.push(bounds.limit);
    limitSql = ` LIMIT $${args.length}`;
  }
  return { depthPred, recPred, limitSql };
}

async function decryptTreeRows(
  model: ResourceModel,
  kms: Kms | undefined,
  rows: Record<string, unknown>[],
): Promise<void> {
  if (model.encrypted.length === 0) return;
  if (!kms) {
    throw new Error(
      `resource '${model.name}' declares encrypted fields but no KMS is bound`,
    );
  }
  await decryptRows(kms, model.encrypted, rows, {
    schema: model.pgSchema,
    table: model.name,
  });
}

/** `treeAncestors(id)` — parents from the node up to the root (excluding it), root-first (04-features.md §tree).
 *  Filtered through the same read WHERE-stack list/find use, so a hidden ancestor can never leak. */
export async function treeAncestors<Row>(
  db: Db,
  model: ResourceModel,
  id: string,
  ctx?: ReadCtx,
  rowPolicy: RowPolicy<Row> = () => all<Row>(),
  kms?: Kms,
  bounds?: TreeWalkBounds,
): Promise<Row[]> {
  const { where, seedPlaceholder: s, params } = treeReadWhereFor(
    model,
    ctx,
    rowPolicy,
  );
  const tbl = `"${model.name}"`; // the bare resource-table alias the read-stack qualifies the walked row by
  const args: unknown[] = [...params, id];
  const { depthPred, recPred, limitSql } = bindTreeBounds(args, bounds, "up");
  const r = model.features.treeClosure
    ? await db.query<Record<string, unknown>>(
      `SELECT ${tbl}.* FROM ${tableOf(model)} ${tbl} JOIN ${
        closureTableOf(model)
      } c ON ${tbl}.id = c.ancestor
         WHERE c.descendant = ${s} AND c.ancestor <> ${s} AND (${where})${depthPred} ORDER BY c.depth DESC, ${tbl}.id${limitSql}`,
      args,
    )
    // adjacency: the recursive CTE is a pure structural walk; the read WHERE-stack AND-injects at the final
    // JOIN, so every walked ancestor is filtered, not just the seed.
    : await db.query<Record<string, unknown>>(
      `WITH RECURSIVE up AS (
         SELECT id, parent_id, 0 AS _d FROM ${
        tableOf(model)
      } WHERE id = (SELECT parent_id FROM ${tableOf(model)} WHERE id = ${s})
         UNION ALL
         SELECT t.id, t.parent_id, up._d + 1 FROM ${
        tableOf(model)
      } t JOIN up ON t.id = up.parent_id${recPred})
       SELECT ${tbl}.* FROM ${
        tableOf(model)
      } ${tbl} JOIN up ON ${tbl}.id = up.id
        WHERE (${where}) ORDER BY up._d DESC, ${tbl}.id${limitSql}`,
      args,
    );
  await decryptTreeRows(model, kms, r.rows);
  return r.rows as Row[];
}

/** `treeDescendants(id)` — every node in the subtree below `id` (excluding it); filtered through the
 *  same read WHERE-stack list/find use, so a hidden descendant can never leak. */
export async function treeDescendants<Row>(
  db: Db,
  model: ResourceModel,
  id: string,
  ctx?: ReadCtx,
  rowPolicy: RowPolicy<Row> = () => all<Row>(),
  kms?: Kms,
  bounds?: TreeWalkBounds,
): Promise<Row[]> {
  const { where, seedPlaceholder: s, params } = treeReadWhereFor(
    model,
    ctx,
    rowPolicy,
  );
  const tbl = `"${model.name}"`;
  const args: unknown[] = [...params, id];
  const { depthPred, recPred, limitSql } = bindTreeBounds(args, bounds, "down");
  const r = model.features.treeClosure
    ? await db.query<Record<string, unknown>>(
      `SELECT ${tbl}.* FROM ${tableOf(model)} ${tbl} JOIN ${
        closureTableOf(model)
      } c ON ${tbl}.id = c.descendant
         WHERE c.ancestor = ${s} AND c.descendant <> ${s} AND (${where})${depthPred} ORDER BY c.depth, ${tbl}.id${limitSql}`,
      args,
    )
    // the recursive CTE walks down by adjacency (pure structure); the read-stack AND-injects at the final
    // JOIN so every walked descendant is filtered — a hidden mid-subtree node drops out, the rest returns.
    : await db.query<Record<string, unknown>>(
      `WITH RECURSIVE down AS (
         SELECT id, parent_id, 0 AS _d FROM ${
        tableOf(model)
      } WHERE parent_id = ${s}
         UNION ALL
         SELECT t.id, t.parent_id, down._d + 1 FROM ${
        tableOf(model)
      } t JOIN down ON t.parent_id = down.id${recPred})
       SELECT ${tbl}.* FROM ${
        tableOf(model)
      } ${tbl} JOIN down ON ${tbl}.id = down.id
        WHERE (${where}) ORDER BY down._d, ${tbl}.id${limitSql}`,
      args,
    );
  await decryptTreeRows(model, kms, r.rows);
  return r.rows as Row[];
}

/** `treeDepth(id)` — edges from the node up to its root (root = 0), derived from `treeAncestors` so depth
 *  counts only visible ancestors — it can NEVER over-count a hidden one (that would leak its existence). */
export async function treeDepth<Row>(
  db: Db,
  model: ResourceModel,
  id: string,
  ctx?: ReadCtx,
  rowPolicy: RowPolicy<Row> = () => all<Row>(),
): Promise<number> {
  return (await treeAncestors<Row>(db, model, id, ctx, rowPolicy)).length;
}

/** A restrict-FK pre-check tripped (03-api-shape.md §onDelete): a live child still references the parent via
 *  an `onDelete:'restrict'` FK. Thrown inside the delete tx — `kind:"conflict"` maps to 409. Guards the
 *  soft-delete path a hard-delete restrict clause can't reach (soft-delete leaves the parent row in place). */
export class RestrictedDeleteError extends Error {
  readonly kind = "conflict" as const;
  constructor(parent: string, child: string, fk: string) {
    super(
      `delete of '${parent}' refused: '${child}.${fk}' still references it (onDelete:'restrict')`,
    );
    this.name = "RestrictedDeleteError";
  }
}

export {
  assertParentsLive,
  StaleParentReferenceError,
} from "./repo-tree-shared.ts";

/** Enforces the parent-scoped invariant at create-time for a scoped `parent:`-child: the bare `<parent>_id` FK
 *  cannot express "same scope", so a cross-scope parent id would insert silently without this scoped existence
 *  check, run in the same tx as the insert. No-op for an unscoped child. */
export async function assertParentInScope(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  parentId: unknown,
): Promise<void> {
  if (!model.parentFk || !model.parent || !model.features.scope) return; // not a scoped parent:-child
  if (parentId == null) return; // a NULL FK is not a cross-scope reference (the NOT NULL DDL handles a missing one)
  const parentTable = `"${model.pgSchema}"."${model.parent}"`;
  const r = await db.query<{ one: number }>(
    `SELECT 1 AS one FROM ${parentTable} WHERE id = $1 AND scope_key = $2 LIMIT 1`,
    [String(parentId), ctx.scope],
  );
  if (r.rows.length === 0) {
    throw new CrossScopeReferenceError(
      model.name,
      model.parent,
      model.parentFk,
    );
  }
}

/** Honors a parent's reverse-ref `onDelete` sweeps inside the delete tx (03-api-shape.md §onDelete) — the repo
 *  replacement for a DB clause the substrate can't honestly emit on soft-delete/audited paths. `restrict` aborts
 *  before any mutation; `cascade` removes each child; `set-null` clears its FK. Same tx; scope-narrowed reads. */
export async function sweepOnDelete(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  parentId: string,
  remove: RemoveVerb,
): Promise<void> {
  // restrict runs first: a refused delete must abort before any cascade/set-null mutation, else a partial sweep
  // would mutate children in a tx that then rolls back.
  for (const sweep of model.onDeleteSweeps) {
    if (sweep.onDelete !== "restrict") continue;
    const kids = await list<Record<string, unknown>>(
      db,
      sweep.child,
      ctx,
      () => all(),
      { [sweep.fk]: parentId } as Where<Record<string, unknown>>,
    );
    if (kids.length > 0) {
      throw new RestrictedDeleteError(model.name, sweep.child.name, sweep.fk);
    }
  }
  for (const sweep of model.onDeleteSweeps) {
    if (sweep.onDelete === "restrict") continue; // pre-checked above
    const kids = await list<Record<string, unknown>>(
      db,
      sweep.child,
      ctx,
      () => all(),
      { [sweep.fk]: parentId } as Where<Record<string, unknown>>,
    );
    for (const kid of kids) {
      const kidId = String(kid.id);
      if (sweep.onDelete === "cascade") {
        // framework-mediated cascade: writes with `all()` so a child the actor's rowPolicy would hide is not left
        // behind — rowPolicy gates the public API path, not this integrity sweep.
        await remove(db, sweep.child, ctx, kidId, () => all()); // child follows its own soft/hard + audit semantics
      } else {
        await update(
          db,
          sweep.child,
          ctx,
          kidId,
          { [sweep.fk]: null },
          NO_CAS, // integrity sweep: a CAS miss would leave the FK dangling, so the blind write is named
          undefined,
          () => all(),
        ); // set-null: a stamped/audited FK clear
      }
    }
  }
}

/** The self-reference (parent) column of a tree resource — the card's `parentField`, else the default
 *  `parent_id` (04-features.md §tree). Returns null on a non-tree resource. */
function treeParentField(model: ResourceModel): string | null {
  const t = model.features.tree;
  if (!t) return null;
  return typeof t === "object" ? t.parentField ?? "parent_id" : "parent_id";
}

/** The tree card's `onParentDelete` routing — `restrict` (default / the bare `tree:true` semantic),
 *  `cascade`, or `set-null` (04-features.md §tree). */
function treeOnParentDelete(
  model: ResourceModel,
): "cascade" | "set-null" | "restrict" {
  const t = model.features.tree;
  return typeof t === "object" ? t.onParentDelete ?? "restrict" : "restrict";
}

/** Honors a tree resource's `onParentDelete` against its own children inside the delete tx (04-features.md §tree,
 *  the self-FK analogue of `sweepOnDelete`) — the self-FK's `ON DELETE` clause only fires on a hard delete, so
 *  a soft-delete tree needs this sweep. `restrict` aborts; `cascade` recurses; `set-null` reparents to root. */
export async function sweepTreeOnDelete(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  parentId: string,
  remove: RemoveVerb,
): Promise<void> {
  const pf = treeParentField(model);
  if (!pf) return;
  const mode = treeOnParentDelete(model);
  const kids = await list<Record<string, unknown>>(
    db,
    model,
    ctx,
    () => all(),
    { [pf]: parentId } as Where<Record<string, unknown>>,
  );
  if (mode === "restrict") {
    if (kids.length > 0) {
      throw new RestrictedDeleteError(model.name, model.name, pf);
    }
    return;
  }
  for (const kid of kids) {
    const kidId = String(kid.id);
    if (mode === "cascade") {
      // framework-mediated subtree cascade: writes with `all()` so a node the actor's rowPolicy hides is not
      // spared — rowPolicy gates the public API path, not this integrity sweep.
      await remove(db, model, ctx, kidId, () => all()); // recurse: the child's own remove sweeps its subtree
    } else {
      await update(
        db,
        model,
        ctx,
        kidId,
        { [pf]: null },
        NO_CAS, // integrity sweep: a CAS miss would strand the child under a deleted parent
        undefined,
        () => all(),
      ); // set-null: a stamped/audited reparent-to-root
    }
  }
}
