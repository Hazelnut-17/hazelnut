// Framework hard-delete maintenance for rows the database may remove without re-entering repo verbs.
import type { ResourceModel } from "../core/app-types.ts";
import { tableOf } from "../core/app-define.ts";
import { enqueueReadModelMaintainFromSource } from "../features/readmodel.ts";
import { recomputeRollup } from "./repo-rollup.ts";
import { stampAndEnqueueReembed } from "./repo-topics.ts";
import { tryTreeWriteLock } from "./tree-write-lock.ts";
import {
  deletedAtLivenessOn,
  normalizeColumnGate,
} from "./schema-normalize.ts";
import type { Db } from "./db.ts";
import type { BackpressureState } from "../runtime/outbox-emit.ts";

type Edge = {
  child: ResourceModel;
  fk: string;
  onDelete: "cascade" | "set-null";
};
const physicalEdges = new WeakMap<ResourceModel, readonly Edge[]>();
const cascadeEdges = new WeakMap<ResourceModel, readonly Edge[]>();
const nativeMaintenanceParents = new WeakSet<ResourceModel>();
const passwordCascadeParents = new WeakSet<ResourceModel>();

/** Lock each affected forest before waiting for a descendant tree row. */
async function tryTreeEdgeLocks(
  db: Db,
  edge: Edge,
  parentId: string,
): Promise<void> {
  if (!edge.child.features.tree) return;
  const scopes = edge.child.features.scope
    ? (await db.query<{ scope_key: string }>(
      `SELECT DISTINCT scope_key FROM ${
        tableOf(edge.child)
      } WHERE "${edge.fk}"=$1 ORDER BY scope_key`,
      [parentId],
    )).rows.map((row) => row.scope_key)
    : (await db.query(
        `SELECT 1 FROM ${tableOf(edge.child)} WHERE "${edge.fk}"=$1 LIMIT 1`,
        [parentId],
      )).rows.length > 0
    ? [""]
    : [];
  for (const scope of scopes) await tryTreeWriteLock(db, edge.child, scope);
}

/** Hard delete can reach a native FK needing follow-up maintenance or session revocation. */
export function hasNativeFkMaintenance(model: ResourceModel): boolean {
  return !model.features.softDelete &&
    (nativeMaintenanceParents.has(model) || passwordCascadeParents.has(model));
}

/** A mutating repo sweep contains multiple writes even without outbox work. */
export function hasMutatingDeleteSweep(model: ResourceModel): boolean {
  const tree = model.features.tree;
  return model.onDeleteSweeps.some((edge) => edge.onDelete !== "restrict") ||
    (typeof tree === "object" &&
      (tree.onParentDelete === "cascade" ||
        tree.onParentDelete === "set-null"));
}

/** A delete can encounter a nonblocking forest lock directly or through a
 * cascade. Used by the transport description as well as the write path. */
export function deleteMayTryTreeLock(model: ResourceModel): boolean {
  const seen = new Set<ResourceModel>();
  const visit = (m: ResourceModel): boolean => {
    if (seen.has(m)) return false;
    seen.add(m);
    const tree = m.features.tree;
    if (
      typeof tree === "object" &&
      (tree.onParentDelete === "set-null" || tree.onParentDelete === "cascade")
    ) return true;
    return m.onDeleteSweeps.some((edge) =>
      edge.onDelete === "cascade" && visit(edge.child)
    ) ||
      (physicalEdges.get(m) ?? []).some((edge) =>
        edge.onDelete === "cascade" && visit(edge.child)
      );
  };
  return visit(model);
}

function isNativeTreeDetach(parent: ResourceModel, edge: Edge): boolean {
  return edge.onDelete === "set-null" && parent === edge.child &&
    edge.fk === "parent_id" && Boolean(parent.features.tree);
}

function treeStampNeeded(parent: ResourceModel, edge: Edge): boolean {
  return isNativeTreeDetach(parent, edge) &&
    (Boolean(parent.features.versioning) ||
      normalizeColumnGate(parent.features.timestamps, "tree timestamps")
          ?.updated === true);
}

function treeClosureNeeded(parent: ResourceModel, edge: Edge): boolean {
  return isNativeTreeDetach(parent, edge) &&
    Boolean(parent.features.treeClosure);
}

/** Whether an app-bound delete can reach a guarded TS enqueue. The graph is
 * composed at boot; native FK paths include hidden descendants and do not
 * honor their soft-delete setting. SQL-trigger-only file GC is one atomic SQL
 * statement and does not itself enter the TS valve. */
export function deleteMayEnqueueOutbox(model: ResourceModel): boolean {
  const ownDelete = (m: ResourceModel) =>
    m.readModelSinks.length > 0 ||
    m.rollupTargets.some((target) =>
      target.parentReadModelSource.readModelSinks.length > 0
    );
  const detach = (m: ResourceModel, field: string) =>
    m.readModelSinks.length > 0 || m.vector?.source === field ||
    (!m.features.softDelete && m.files.includes(field)) ||
    m.rollupTargets.some((target) =>
      target.kind !== "count" && target.field === field &&
      target.parentReadModelSource.readModelSinks.length > 0
    );
  const physicalSeen = new Set<ResourceModel>();
  const physical = (m: ResourceModel): boolean => {
    if (physicalSeen.has(m)) return false;
    physicalSeen.add(m);
    return (physicalEdges.get(m) ?? []).some((edge) =>
      ownDelete(edge.child) ||
      (edge.onDelete === "set-null" && detach(edge.child, edge.fk)) ||
      (edge.onDelete === "cascade" && physical(edge.child))
    );
  };
  const seen = new Set<ResourceModel>();
  const sweep = (m: ResourceModel): boolean => {
    if (seen.has(m)) return false;
    seen.add(m);
    if (ownDelete(m)) return true;
    const tree = m.features.tree;
    if (
      typeof tree === "object" && tree.onParentDelete === "set-null" &&
      detach(m, "parent_id")
    ) return true;
    if (
      m.onDeleteSweeps.some((edge) =>
        edge.onDelete === "cascade"
          ? sweep(edge.child)
          : edge.onDelete === "set-null"
          ? detach(edge.child, edge.fk)
          : false
      )
    ) return true;
    return !m.features.softDelete && physical(m);
  };
  return sweep(model);
}

/** Derive maintenance-aware ancestor sweeps after rollup targets and read-model sinks are resolved.
 * Keep the actual DB-cascade graph separately: hidden physical descendants still need maintenance. */
export function registerCascadeMaintenance(
  models: readonly ResourceModel[],
): void {
  const edges = new Map<ResourceModel, Edge[]>(),
    native = new Map<ResourceModel, Edge[]>();
  const add = (
    parent: ResourceModel | undefined,
    edge: Edge,
    physical: boolean,
  ) => {
    if (!parent) return;
    const all = edges.get(parent) ?? [];
    if (!all.some((old) => old.child === edge.child && old.fk === edge.fk)) {
      all.push(edge);
    }
    edges.set(parent, all);
    if (physical) {
      const list = native.get(parent) ?? [];
      list.push(edge);
      native.set(parent, list);
    }
  };
  for (const child of models) {
    if (child.parent && child.parentFk) {
      add(
        models.find((m) =>
          m.name === child.parent && m.pgSchema === child.pgSchema
        ),
        { child, fk: child.parentFk, onDelete: "cascade" },
        true,
      );
    }
    for (const [fk, ref] of Object.entries(child.references)) {
      if (
        ref.external ||
        (ref.onDelete !== "cascade" && ref.onDelete !== "set-null")
      ) continue;
      const parent = models.find((m) =>
        m.name === ref.to && m.pgSchema === child.pgSchema
      );
      const swept = parent?.onDeleteSweeps.some((s) =>
        s.child === child && s.fk === fk
      );
      add(parent, { child, fk, onDelete: ref.onDelete }, !swept);
    }
    if (
      typeof child.features.tree === "object" &&
      child.features.tree.onParentDelete === "cascade"
    ) add(child, { child, fk: "parent_id", onDelete: "cascade" }, true);
    // Tree's native self-FK can also detach lifecycle-hidden descendants that
    // the visible repo sweep does not visit. Do not add a second repo sweep.
    if (
      typeof child.features.tree === "object" &&
      child.features.tree.onParentDelete === "set-null" &&
      "parent_id" in child.columns && !("parent_id" in child.references) &&
      !deletedAtLivenessOn(child.features) && !child.features.audit
    ) {
      const list = native.get(child) ?? [];
      list.push({ child, fk: "parent_id", onDelete: "set-null" });
      native.set(child, list);
    }
  }
  const critical = new Set(
    models.filter((m) =>
      m.readModelSinks.length > 0 || m.rollupTargets.length > 0 ||
      m.onDeleteSweeps.length > 0 || Boolean(m.features.tree)
    ),
  );
  for (let changed = true; changed;) {
    changed = false;
    for (const [parent, list] of edges) {
      if (
        !critical.has(parent) &&
        list.some((edge) =>
          edge.onDelete === "cascade" && critical.has(edge.child)
        )
      ) {
        critical.add(parent);
        changed = true;
      }
    }
  }
  // A native SET NULL can change a vector source without running update().
  // Preserve the physical FK path (including other scopes and hidden rows),
  // and capture its native cascade ancestors without widening repo sweeps.
  const maintenanceParents = new Set<ResourceModel>();
  for (const [parent, list] of native) {
    if (
      list.some((edge) =>
        (edge.onDelete === "set-null" &&
          edge.child.vector?.source === edge.fk) ||
        treeStampNeeded(parent, edge) || treeClosureNeeded(parent, edge)
      )
    ) maintenanceParents.add(parent);
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const [parent, list] of native) {
      if (
        !maintenanceParents.has(parent) &&
        list.some((edge) =>
          edge.onDelete === "cascade" && maintenanceParents.has(edge.child)
        )
      ) {
        maintenanceParents.add(parent);
        changed = true;
      }
    }
  }
  // Skip physical row-lock walks that cannot possibly reach a password
  // identity. Reachability includes arbitrary cascade depth and cycles.
  const passwordParents = new Set<ResourceModel>();
  for (let changed = true; changed;) {
    changed = false;
    for (const [parent, list] of native) {
      if (
        !passwordParents.has(parent) &&
        list.some((edge) =>
          edge.onDelete === "cascade" &&
          (edge.child.passwords.length > 0 || passwordParents.has(edge.child))
        )
      ) {
        passwordParents.add(parent);
        changed = true;
      }
    }
  }
  for (const parent of models) {
    if (passwordParents.has(parent)) passwordCascadeParents.add(parent);
    else passwordCascadeParents.delete(parent);
    if (maintenanceParents.has(parent)) nativeMaintenanceParents.add(parent);
    else nativeMaintenanceParents.delete(parent);
    const needed = (edges.get(parent) ?? []).filter((edge) =>
      critical.has(edge.child)
    );
    for (const edge of needed) {
      if (
        !parent.onDeleteSweeps.some((old) =>
          old.child === edge.child && old.fk === edge.fk
        )
      ) {
        (parent.onDeleteSweeps as {
          child: ResourceModel;
          fk: string;
          onDelete: "cascade" | "set-null" | "restrict";
        }[]).push(edge);
      }
    }
    physicalEdges.set(
      parent,
      (native.get(parent) ?? []).filter((edge) =>
        critical.has(edge.child) ||
        (edge.onDelete === "set-null" &&
          edge.child.vector?.source === edge.fk) ||
        treeStampNeeded(parent, edge) ||
        treeClosureNeeded(parent, edge) ||
        (edge.onDelete === "cascade" && maintenanceParents.has(edge.child))
      ),
    );
    cascadeEdges.set(
      parent,
      (native.get(parent) ?? []).filter((edge) => edge.onDelete === "cascade"),
    );
  }
}

type Captured = {
  model: ResourceModel;
  id: string;
  scope?: string;
  op: "delete" | "upsert";
  clearVector: boolean;
  stampTree: boolean;
  rebuildTreeClosure: boolean;
  owners: readonly {
    target: ResourceModel["rollupTargets"][number];
    id: string;
  }[];
};
/** Password identities a database CASCADE will erase with this hard delete, including through an
 * intermediate owned row. Captured before the DELETE; the caller revokes those subjects only if the
 * delete affected a row. */
export async function captureCascadedPasswordIds(
  db: Db,
  model: ResourceModel,
  id: string,
): Promise<readonly string[]> {
  if (!passwordCascadeParents.has(model)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  const visit = async (
    parent: ResourceModel,
    parentId: string,
  ): Promise<void> => {
    const key = JSON.stringify([parent.pgSchema, parent.name, parentId]);
    if (seen.has(key)) return;
    seen.add(key);
    for (const edge of cascadeEdges.get(parent) ?? []) {
      if (
        edge.child.passwords.length === 0 &&
        !passwordCascadeParents.has(edge.child)
      ) continue;
      await tryTreeEdgeLocks(db, edge, parentId);
      const rows = (await db.query<{ id: string }>(
        `SELECT id FROM ${
          tableOf(edge.child)
        } WHERE "${edge.fk}" = $1 ORDER BY id FOR UPDATE`,
        [parentId],
      )).rows;
      for (const row of rows) {
        const childId = String(row.id);
        if (edge.child.passwords.length > 0) ids.push(childId);
        await visit(edge.child, childId);
      }
    }
  };
  await visit(model, id);
  return ids;
}

/** Capture all physical descendants, including lifecycle-hidden rows. Each source carries its own
 * stored scope; a shared unscoped parent's native FK may span several tenants. Root authorization has
 * already locked the exact parent row. Descendant locks close inserts below the captured ancestry. */
export async function captureCascadeMaintenance(
  db: Db,
  model: ResourceModel,
  id: string,
): Promise<readonly Captured[]> {
  const captured: Captured[] = [], seen = new Set<string>();
  const visit = async (
    parent: ResourceModel,
    parentId: string,
  ): Promise<void> => {
    const key = JSON.stringify([parent.pgSchema, parent.name, parentId]);
    if (seen.has(key)) return;
    seen.add(key);
    for (const edge of physicalEdges.get(parent) ?? []) {
      await tryTreeEdgeLocks(db, edge, parentId);
      const rows = (await db.query<Record<string, unknown>>(
        `SELECT * FROM ${
          tableOf(edge.child)
        } WHERE "${edge.fk}"=$1 ORDER BY id FOR UPDATE`,
        [parentId],
      )).rows;
      for (const row of rows) {
        const childId = String(row.id);
        captured.push({
          model: edge.child,
          id: childId,
          scope: edge.child.features.scope ? String(row.scope_key) : undefined,
          op: edge.onDelete === "cascade" ? "delete" : "upsert",
          clearVector: edge.onDelete === "set-null" &&
            edge.child.vector?.source === edge.fk,
          stampTree: treeStampNeeded(parent, edge),
          rebuildTreeClosure: treeClosureNeeded(parent, edge),
          owners: edge.child.rollupTargets.flatMap((target) =>
            row[target.parentFk] == null
              ? []
              : [{ target, id: String(row[target.parentFk]) }]
          ),
        });
        if (edge.onDelete === "cascade") await visit(edge.child, childId);
      }
    }
  };
  await visit(model, id);
  return captured;
}

/** Apply only after the root DELETE affected a row, in the same transaction. Recompute instead of
 * subtracting: lifecycle-hidden children may already be absent from the live aggregate. */
export async function finishCascadeMaintenance(
  db: Db,
  captured: readonly Captured[],
  // Caller supplies the tree rebuild. Importing it here cycles back through the list door.
  rebuildTreeClosure: (
    db: Db,
    model: ResourceModel,
    id: string,
    parentId: string | null,
  ) => Promise<void>,
  backpressure?: BackpressureState,
): Promise<void> {
  const vectors = new Set<string>(),
    stamps = new Set<string>(),
    closures = new Set<string>();
  const owners = new Map<
    string,
    {
      model: ResourceModel;
      target: ResourceModel["rollupTargets"][number];
      id: string;
    }
  >();
  for (const row of captured) {
    if (row.rebuildTreeClosure) {
      const key = JSON.stringify([row.model.pgSchema, row.model.name, row.id]);
      if (!closures.has(key)) {
        closures.add(key);
        const surviving = await db.query(
          `SELECT 1 FROM ${
            tableOf(row.model)
          } WHERE id = $1 AND "parent_id" IS NULL`,
          [row.id],
        );
        if (surviving.rows.length > 0) {
          await rebuildTreeClosure(db, row.model, row.id, null);
        }
      }
    }
    if (row.stampTree) {
      const key = JSON.stringify([row.model.pgSchema, row.model.name, row.id]);
      if (!stamps.has(key)) {
        stamps.add(key);
        const assignments: string[] = [];
        if (row.model.features.versioning) {
          assignments.push("version = version + 1");
        }
        if (
          normalizeColumnGate(row.model.features.timestamps, "tree timestamps")
            ?.updated === true
        ) {
          assignments.push("updated_at = now()");
        }
        if (assignments.length > 0) {
          await db.query(
            `UPDATE ${tableOf(row.model)} SET ${
              assignments.join(", ")
            } WHERE id = $1 AND "parent_id" IS NULL`,
            [row.id],
          );
        }
      }
    }
    if (row.clearVector && row.model.vector) {
      const key = JSON.stringify([row.model.pgSchema, row.model.name, row.id]);
      if (!vectors.has(key)) {
        vectors.add(key);
        // Another cascade may have removed this row. Only a surviving row
        // whose native FK actually cleared its source gets maintenance.
        const surviving = await db.query(
          `SELECT 1 FROM ${
            tableOf(row.model)
          } WHERE id = $1 AND "${row.model.vector.source}" IS NULL`,
          [row.id],
        );
        if (surviving.rows.length > 0) {
          await stampAndEnqueueReembed(
            db,
            row.model,
            { actor: null, scope: row.scope ?? "" },
            row.id,
            backpressure,
          );
        }
      }
    }
    await enqueueReadModelMaintainFromSource(
      db,
      {
        name: row.model.name,
        module: row.model.module,
        readModelSinks: row.model.readModelSinks,
        scoped: Boolean(row.model.features.scope),
      },
      row.scope,
      row.id,
      row.op,
      backpressure,
    );
    for (const owner of row.owners) {
      owners.set(
        JSON.stringify([
          owner.target.parentTable,
          owner.target.column,
          owner.id,
        ]),
        { model: row.model, ...owner },
      );
    }
  }
  for (
    const { model, target, id } of [...owners.values()].sort((a, b) =>
      JSON.stringify([a.target.parentTable, a.id, a.target.column])
        .localeCompare(
          JSON.stringify([b.target.parentTable, b.id, b.target.column]),
        )
    )
  ) {
    await recomputeRollup(
      db,
      target.parentTable,
      target.column,
      model,
      target.parentFk,
      id,
      target.kind,
      target.field,
      target.parentReadModelSource,
      backpressure,
    );
  }
}
