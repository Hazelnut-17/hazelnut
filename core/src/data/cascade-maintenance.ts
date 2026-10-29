// Framework hard-delete maintenance for rows the database may remove without re-entering repo verbs.
import type { ResourceModel } from "../core/app-types.ts";
import { tableOf } from "../core/app-define.ts";
import { enqueueReadModelMaintainFromSource } from "../features/readmodel.ts";
import { recomputeRollup } from "./repo-rollup.ts";
import type { Db } from "./db.ts";

type Edge = {
  child: ResourceModel;
  fk: string;
  onDelete: "cascade" | "set-null";
};
const physicalEdges = new WeakMap<ResourceModel, readonly Edge[]>();
const cascadeEdges = new WeakMap<ResourceModel, readonly Edge[]>();

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
  }
  const critical = new Set(
    models.filter((m) =>
      m.readModelSinks.length > 0 || m.rollupTargets.length > 0
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
  for (const parent of models) {
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
      (native.get(parent) ?? []).filter((edge) => critical.has(edge.child)),
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
): Promise<void> {
  const owners = new Map<
    string,
    {
      model: ResourceModel;
      target: ResourceModel["rollupTargets"][number];
      id: string;
    }
  >();
  for (const row of captured) {
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
    );
  }
}
