// The two tree helpers BOTH halves of the tree runtime read — the closure-table reference and the
// cross-scope parent check. A leaf: each half used to import the other's helper, which is the whole
// reason `repo-tree-a` and `repo-tree-b` were a cycle.
import type { ResourceModel } from "../core/app.ts";
import { isSystem } from "../authz/auth-core.ts";
import { all } from "../core/where.ts";
import type { Kms } from "../features/encrypt.ts";
import type { Db } from "./db.ts";
import type { ReadCtx, RowPolicy } from "./repo.ts";
import { existsForShare } from "./repo-list.ts";
import { sql } from "drizzle-orm/sql";
import { querySql, readMetadata } from "./read-compiler.ts";

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
  const r = await querySql<{ one: number }>(
    db,
    sql`SELECT 1 AS one FROM ${readMetadata(model).table} WHERE id = ${
      String(parentId)
    } AND scope_key = ${ctx.scope} LIMIT 1`,
  );
  if (r.rows.length === 0) {
    throw new CrossScopeReferenceError(model.name, model.name, "parent_id");
  }
}

/** The target or retained tree parent must be visible through this resource's rowPolicy.
 *  A hidden parent is `notFound` and is not distinguished from a missing one. A root
 *  (`null`) and a resource with no rowPolicy have nothing to test. System writes keep
 *  the explicit bypass. */
export async function assertTreeParentVisible(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  parentId: unknown,
  kms?: Kms,
): Promise<void> {
  if (!model.features.tree || !model.hasRowPolicy || parentId == null) return;
  const id = typeof parentId === "string"
    ? parentId
    : typeof parentId === "bigint"
    ? parentId.toString()
    : typeof parentId === "number" && Number.isSafeInteger(parentId)
    ? String(parentId)
    : null;
  if (id === null || id.length === 0) {
    throw Object.assign(new Error("tree parent is not visible"), {
      kind: "notFound" as const,
    });
  }
  const policy: RowPolicy<unknown> = isSystem(ctx.actor)
    ? () => all()
    : (model.rowPolicy as RowPolicy<unknown> | null) ?? (() => all());
  if (!(await existsForShare(db, model, ctx, policy, id, kms))) {
    throw Object.assign(new Error("tree parent is not visible"), {
      kind: "notFound" as const,
    });
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

/** Thrown when a child's write references a soft-deleted parent. The bare DB FK checks only
 *  row existence, which soft-delete preserves — this closes the gap so a child cannot attach to a logically-gone
 *  parent. `kind:"notFound"` (03-api-shape.md §onDelete). */
export class StaleParentReferenceError extends Error {
  readonly kind = "notFound" as const;
  constructor(child: string, parent: string, fk: string) {
    super(
      `write to '${child}' refused: '${fk}' references a '${parent}' that is no longer live (soft-deleted, superseded or expired) — a child cannot be attached to it`,
    );
    this.name = "StaleParentReferenceError";
  }
}

/** Refuses a create/re-parent whose FK targets an already soft-deleted or superseded parent — checked
 *  via a `FOR SHARE` probe inside the write's tx, serialized against the remover/rectify's `FOR UPDATE`
 *  (repo-remove.ts / rectify) so neither side races. */
export async function assertParentsLive(
  db: Db,
  model: ResourceModel,
  values: Record<string, unknown>,
): Promise<void> {
  for (const r of model.liveParentRefs) {
    const fkVal = values[r.fk];
    if (fkVal == null) continue; // a null fk (nullable/set-null ref, or a tree root) references no parent
    const row = (await querySql<{ live: boolean }>(
      db,
      sql`SELECT (${sql.raw(r.live)}) AS live FROM ${
        sql.raw(r.parentTable)
      } WHERE id = ${String(fkVal)} FOR SHARE`,
    )).rows[0];
    if (row && !row.live) {
      throw new StaleParentReferenceError(model.name, r.parentName, r.fk);
    }
  }
}
