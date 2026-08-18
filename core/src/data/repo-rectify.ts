// GDPR Art. 16 rectification for append-only resources (04-features.md §immutable `rectifiable`).
// The original row stays byte-intact; the correction rides the full create weave as a new row, and
// the original is stamped `superseded_by`/`deleted_at` — the one sanctioned write on an immutable row.
import { tableOf } from "../core/app-define.ts";
import type { ResourceModel } from "../core/app.ts";
import { decryptRow, type Kms } from "../features/encrypt.ts";
import type { Db } from "./db.ts";
import { auditWrite } from "./repo-audit.ts";
import { enqueueReadModelMaintain } from "../features/readmodel.ts";
import { create } from "./repo-create.ts";
import { appendRowPolicyConjunct } from "./repo-read.ts";
import {
  type CapturedRollupTarget,
  lockRollupCascadeEdges,
  maintainCapturedRollups,
} from "./repo-rollup.ts";
import type { ReadCtx } from "./repo.ts";
import { rectifiableOn } from "./schema.ts";

/** rectify()'s result — `conflict` = the row is already superseded (rectify the chain head) or was
 *  concurrently rectified (the CAS lost); `unknownField` names a correction key outside the schema. */
export interface RectifyOutcome {
  readonly rectified: boolean;
  readonly supersededBy?: string; // the correcting row's id (present iff rectified)
  readonly conflict?: boolean;
  readonly unknownField?: string;
}

/**
 * Rectifies one row of a `rectifiable` resource: inserts the corrected image as a new row through the
 * create weave, then CAS-stamps the original `superseded_by`/`deleted_at` — one winner among concurrent
 * rectifies of the same head. Decrements the original's rollup contribution; the correction's create re-contributes.
 */
export async function rectify(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  id: string,
  corrections: Record<string, unknown>,
  kms?: Kms,
): Promise<RectifyOutcome> {
  if (!rectifiableOn(model.features)) return { rectified: false }; // by-construction: the facade method exists iff rectifiable
  for (const k of Object.keys(corrections)) {
    if (!(k in model.columns) || k === "id") {
      return { rectified: false, unknownField: k }; // a typo'd correction must not silently no-op
    }
  }
  // lock-ordering discipline: the rollup-edge advisory before any row lock (the FOR UPDATE below).
  await lockRollupCascadeEdges(db, model, id, false);
  // read the original image — scope + write-side rowPolicy applied (a hidden row reads as absent), locked
  // (FOR UPDATE) so a concurrent rectify serializes here and re-checks the CAS below against committed state.
  const params: unknown[] = [id];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  let where = `id = $1`;
  if (model.features.scope) where += ` AND scope_key = ${p(ctx.scope)}`;
  where += appendRowPolicyConjunct(model, ctx, p, undefined);
  const original = (await db.query<Record<string, unknown>>(
    `SELECT * FROM ${tableOf(model)} WHERE ${where} FOR UPDATE`,
    params,
  )).rows[0];
  if (!original) return { rectified: false };
  if (original.superseded_by != null) {
    return { rectified: false, conflict: true }; // rectify the chain head, not a superseded ancestor
  }
  // create() re-seals its input, so the rebuild must start from PLAINTEXT — the guarded read the list
  // paths perform. Feeding the stored envelope would double-encrypt: the row never decrypts again.
  if (model.encrypted.length > 0) {
    if (!kms) {
      throw new Error(
        `resource '${model.name}' declares encrypted fields but no KMS is bound`,
      );
    }
    await decryptRow(kms, model.encrypted, original, {
      schema: model.pgSchema,
      table: model.name,
    });
  }
  // the corrected image overlays corrections on the original's authored columns (status stays verbatim —
  // a correction is a data fix, never a state transition); the parent FK carries over unchanged.
  const corrected: Record<string, unknown> = {};
  for (const c of Object.keys(model.columns)) {
    if (c !== "id" && original[c] !== undefined) corrected[c] = original[c];
  }
  if (model.parentFk && original[model.parentFk] !== undefined) {
    corrected[model.parentFk] = original[model.parentFk];
  }
  Object.assign(corrected, corrections);
  // rollup capture from the original image (it leaves the live set when the stamp lands below).
  const toMaintain: CapturedRollupTarget[] = [];
  for (const rt of model.rollupTargets) {
    const pid = original[rt.parentFk];
    if (pid != null) {
      toMaintain.push({
        rt,
        pid: String(pid),
        delta: rt.field ? Number(original[rt.field] ?? 0) : 0,
      });
    }
  }
  // the correction rides the full create weave (tamper append lock + chain stamp, sequence#, parent-scope
  // guard, rollup increment, read-model enqueue, audit op="create") — a correction is an append.
  const newId = await create(db, model, ctx, corrected, kms);
  // CAS-stamp the original: only the (still-)unsuperseded head takes the pointer. A concurrent winner makes
  // this match 0 rows → conflict → the caller's tx rolls the inserted correction back (atomicity).
  const stampParams: unknown[] = [newId, id];
  const sp = (v: unknown) => {
    stampParams.push(v);
    return `$${stampParams.length}`;
  };
  let stampWhere = `id = $2 AND superseded_by IS NULL`;
  if (model.features.scope) stampWhere += ` AND scope_key = ${sp(ctx.scope)}`;
  stampWhere += appendRowPolicyConjunct(model, ctx, sp, undefined);
  const stamped = (await db.query(
    `UPDATE ${
      tableOf(model)
    } SET superseded_by = $1, deleted_at = now() WHERE ${stampWhere} RETURNING id`,
    stampParams,
  )).rows.length;
  if (stamped === 0) {
    throw new Error(
      `rectify conflict: '${model.name}' ${id} was concurrently superseded — the correction insert must roll back with this tx`,
    );
  }
  // the original left the live set → decrement its rollup contribution (the correction's create already
  // re-contributed the corrected values — the parent aggregate now reflects the correction, never both).
  await maintainCapturedRollups(db, model, toMaintain, "decrement");
  // the correction event (04-features.md §audit): one attributed record tying original → correction.
  await auditWrite(db, model, ctx, id, "rectify", {
    before: original,
    after: { ...corrected, id: newId, superseded_by: null },
  });
  // the original left the live set, so drop its read-model projection too: create() already enqueued
  // the new row's upsert, but without this the read model would keep serving the rectified-away image.
  if (model.readModelSinks.length > 0) {
    await enqueueReadModelMaintain(db, model, ctx, id, "delete");
  }
  return { rectified: true, supersededBy: newId };
}
