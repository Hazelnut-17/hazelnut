// The two tree helpers BOTH halves of the tree runtime read — the closure-table reference and the
// cross-scope parent check. A leaf: each half used to import the other's helper, which is the whole
// reason `repo-tree-a` and `repo-tree-b` were a cycle.
import type { ResourceModel } from "../core/app.ts";
import type { Db } from "./db.ts";
import type { ReadCtx, RowPolicy } from "./repo.ts";
import { tableOf } from "../core/app-define.ts";

/** Thrown when a scoped child's `create` references a `parent:` row outside the caller's scope: the bare
 *  `<parent>_id` FK keys on `id` alone and would otherwise accept it, leaving a child the scope-bound onDelete
 *  sweep can't find. `create` validates `ctx.scope` before insert instead. `kind:"notFound"`. */
export class CrossScopeReferenceError extends Error {
  readonly kind = "notFound" as const;
  constructor(child: string, parent: string, fk: string) {
    super(
      `create of '${child}' refused: '${fk}' references a '${parent}' outside the caller's scope (parent-scoped)`,
    );
    this.name = "CrossScopeReferenceError";
  }
}

/** The closure table reference for a treeClosure resource (mirrors `treeclosure.ts`'s schema-qualified form). */
export const closureTableOf = (m: ResourceModel) =>
  `"${m.pgSchema}"."${m.name}_tree"`;

/** The tree self-FK (`parent_id`) analogue of `assertParentInScope` — the bare self-FK keys on `id` alone
 *  and accepts a cross-scope parent, which `assertParentInScope` never covers (it only guards `parent:`-children).
 *  Validates on create and every re-parent; no-op for an unscoped/non-tree resource or a root. */
export async function assertTreeParentInScope(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  parentId: unknown,
): Promise<void> {
  if (!model.features.tree || !model.features.scope) return;
  if (parentId == null) return; // a root has no parent → not a cross-scope reference
  const r = await db.query<{ one: number }>(
    `SELECT 1 AS one FROM ${
      tableOf(model)
    } WHERE id = $1 AND scope_key = $2 LIMIT 1`,
    [String(parentId), ctx.scope],
  );
  if (r.rows.length === 0) {
    throw new CrossScopeReferenceError(model.name, model.name, "parent_id");
  }
}

/**
 * The delete verb a cascade sweep re-enters with. A cascade is genuinely recursive — deleting a parent
 * deletes its children, whose own delete sweeps their children — so the sweep needs `remove`, and `remove`
 * needs the sweep. Passing it in is what keeps that a recursion rather than an import cycle; the caller
 * that OWNS the verb supplies it, so there is still exactly one delete path.
 */
export type RemoveVerb = (
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  id: string,
  rowPolicy?: RowPolicy<unknown>,
) => Promise<unknown>;

/** Thrown when a child's `create` (or re-parent) references a soft-deleted parent. The bare DB FK checks only
 *  row existence, which soft-delete preserves — this closes the gap so a child cannot attach to a logically-gone
 *  parent. `kind:"notFound"` (03-api-shape.md §onDelete). */
export class StaleParentReferenceError extends Error {
  readonly kind = "notFound" as const;
  constructor(child: string, parent: string, fk: string) {
    super(
      `create of '${child}' refused: '${fk}' references a soft-deleted (tombstoned) '${parent}' — a child cannot be attached to a logically-deleted parent`,
    );
    this.name = "StaleParentReferenceError";
  }
}

/** Refuses a create/re-parent whose FK targets an already soft-deleted parent — checked via a `FOR SHARE` probe
 *  inside the write's tx, serialized against the remover's `FOR UPDATE` (repo-remove.ts) so neither side races. */
export async function assertParentsLive(
  db: Db,
  model: ResourceModel,
  values: Record<string, unknown>,
): Promise<void> {
  for (const r of model.softDeleteParentRefs) {
    const fkVal = values[r.fk];
    if (fkVal == null) continue; // a null fk (nullable/set-null ref, or a tree root) references no parent
    const row = (await db.query<{ deleted_at: unknown }>(
      `SELECT deleted_at FROM ${r.parentTable} WHERE id = $1 FOR SHARE`,
      [String(fkVal)],
    )).rows[0];
    if (row && row.deleted_at != null) {
      throw new StaleParentReferenceError(model.name, r.parentName, r.fk);
    }
  }
}
