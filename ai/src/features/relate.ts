import type { Db } from "../data/db.ts";
import type { App, JunctionModel } from "../core/app.ts";

/**
 * Many-to-many (`relates`) helpers over the derived junction table. The junction has a composite PK,
 * so `link` is idempotent (ON CONFLICT DO NOTHING) and a pair links at most once; a delete on either
 * side cascades the link away. `relatedIds` reads the opposite side's ids for one row.
 */

/** Find the junction model for an unordered pair of resources, or throw if they don't relate. */
export function junctionFor(app: App, a: string, b: string): JunctionModel {
  const [left, right] = [a, b].sort();
  const j = app.junctions.find((x) => x.left === left && x.right === right);
  if (!j) {
    throw new Error(
      `no many-to-many junction between '${a}' and '${b}' (declare \`relates\`)`,
    );
  }
  return j;
}

/** Link two rows (idempotent). `aId` is placed on `aName`'s side; the other id on the opposite side. */
export async function link(
  db: Db,
  j: JunctionModel,
  aName: string,
  aId: string,
  _bName: string,
  bId: string,
): Promise<void> {
  const leftId = aName === j.left ? aId : bId;
  const rightId = aName === j.left ? bId : aId;
  await db.query(
    `INSERT INTO "${j.pgSchema}"."${j.name}" ("${j.leftFk}", "${j.rightFk}") VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [leftId, rightId],
  );
}

/** Unlink two rows. */
export async function unlink(
  db: Db,
  j: JunctionModel,
  aName: string,
  aId: string,
  _bName: string,
  bId: string,
): Promise<void> {
  const leftId = aName === j.left ? aId : bId;
  const rightId = aName === j.left ? bId : aId;
  await db.query(
    `DELETE FROM "${j.pgSchema}"."${j.name}" WHERE "${j.leftFk}" = $1 AND "${j.rightFk}" = $2`,
    [leftId, rightId],
  );
}

/** The ids of the OTHER side related to `fromId` (which belongs to resource `fromName`). */
export async function relatedIds(
  db: Db,
  j: JunctionModel,
  fromName: string,
  fromId: string,
): Promise<string[]> {
  const fromFk = fromName === j.left ? j.leftFk : j.rightFk;
  const toFk = fromName === j.left ? j.rightFk : j.leftFk;
  const r = await db.query<{ id: string }>(
    `SELECT "${toFk}" AS id FROM "${j.pgSchema}"."${j.name}" WHERE "${fromFk}" = $1`,
    [fromId],
  );
  return r.rows.map((x) => x.id);
}
