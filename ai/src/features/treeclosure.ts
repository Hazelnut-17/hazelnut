import type { Db } from "../data/db.ts";
import type { ResourceModel } from "../core/app.ts";

/** `tree` closure-table maintenance (`treeClosure`): one row per ancestor→descendant pair (self-row at depth 0),
 *  so ancestor/descendant reads are a single indexed lookup, not a recursive CTE. `addToTree` seeds at create;
 *  re-parenting rebuilds via `rebuildClosure` (data/repo-tree-a.ts). */
const closureTable = (m: ResourceModel) => `"${m.pgSchema}"."${m.name}_tree"`;

/** Insert a node's closure rows: self (depth 0) + every ancestor of its parent at depth+1. */
export async function addToTree(
  db: Db,
  model: ResourceModel,
  id: string,
  parentId: string | null,
): Promise<void> {
  await db.query(
    `INSERT INTO ${
      closureTable(model)
    } (ancestor, descendant, depth) VALUES ($1, $1, 0) ON CONFLICT DO NOTHING`,
    [id],
  );
  if (parentId != null) {
    await db.query(
      `INSERT INTO ${closureTable(model)} (ancestor, descendant, depth)
         SELECT ancestor, $1, depth + 1 FROM ${
        closureTable(model)
      } WHERE descendant = $2
       ON CONFLICT DO NOTHING`,
      [id, parentId],
    );
  }
}

/** All descendant ids of a node (excluding itself), via the closure table. */
export async function descendants(
  db: Db,
  model: ResourceModel,
  id: string,
): Promise<string[]> {
  const r = await db.query<{ descendant: string }>(
    `SELECT descendant FROM ${
      closureTable(model)
    } WHERE ancestor = $1 AND descendant <> $1`,
    [id],
  );
  return r.rows.map((x) => x.descendant);
}

/** All ancestor ids of a node (excluding itself), via the closure table. */
export async function ancestors(
  db: Db,
  model: ResourceModel,
  id: string,
): Promise<string[]> {
  const r = await db.query<{ ancestor: string }>(
    `SELECT ancestor FROM ${
      closureTable(model)
    } WHERE descendant = $1 AND ancestor <> $1`,
    [id],
  );
  return r.rows.map((x) => x.ancestor);
}
