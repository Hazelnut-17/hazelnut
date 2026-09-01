// remove()/restore() — the soft/hard delete and undelete doors, run as REMOVE_WEAVE/RESTORE_WEAVE
// (write-plan.ts owns step order): rowPolicy + version-CAS gating, cascade/tree sweeps, rollup
// maintenance, audit, and read-model drop, all inside the caller's op tx.
import { tableOf } from "../core/app-define.ts";
import type { ResourceModel } from "../core/app.ts";
import { enqueueReadModelMaintain } from "../features/readmodel.ts";
import { enqueue } from "../runtime/outbox.ts";
import type { Db } from "./db.ts";
import {
  auditConfig,
  auditWrite,
  immutableForm,
  onRowGate,
} from "./repo-audit.ts";
import { appendRowPolicyConjunct } from "./repo-read.ts";
import {
  type CapturedRollupTarget,
  captureRollupTargets,
  lockRollupCascadeEdges,
  maintainCapturedRollups,
} from "./repo-rollup.ts";
import { FILE_GC_TOPIC } from "./repo-topics.ts";
import { readRow } from "./repo-tree-a.ts";
import { sweepOnDelete, sweepTreeOnDelete } from "./repo-tree-b.ts";
import type { RemoveVerb } from "./repo-tree-shared.ts";
import { type ExpectedVersion, NO_CAS } from "./repo-update.ts";
import type { ReadCtx, RowPolicy } from "./repo.ts";
import {
  REMOVE_WEAVE,
  RESTORE_WEAVE,
  runWeave,
  type StepFn,
} from "./write-plan.ts";

/** remove()'s result shape — `stale` reports a version-CAS miss. */
export interface RemoveOutcome {
  readonly deleted: boolean;
  readonly stale: boolean;
}

/** The mutable weave state `remove` threads through REMOVE_WEAVE's steps (order-dependent: `p`
 *  allocates placeholders in weave order, so steps MUST run in the declared sequence). */
interface RemoveWeaveCtx {
  readonly db: Db;
  readonly model: ResourceModel;
  readonly ctx: ReadCtx;
  readonly id: string;
  readonly rowPolicy?: RowPolicy<unknown>;
  readonly expectedVersion?: ExpectedVersion;
  readonly purgeGuard?: boolean;
  readonly params: unknown[];
  readonly p: (v: unknown) => string;
  where: string;
  versioned: boolean;
  before: Record<string, unknown> | null;
  toMaintain: readonly CapturedRollupTarget[];
  affected: number;
}

const NOT_DELETED: RemoveOutcome = { deleted: false, stale: false };

/** The verb a cascade/subtree sweep re-enters `remove` with. A cascade holds no caller version — the
 *  request's CAS already gated the parent — so it is blind BY NAME here, at the one injection site. */
const cascadeRemove: RemoveVerb = (db, model, ctx, id, rowPolicy) =>
  remove(db, model, ctx, id, rowPolicy, NO_CAS);

/** The step bindings for `REMOVE_WEAVE` (exported for the write-plan conformance self-check). Each
 *  body is the verbatim hand-woven block it replaces — conditions inside the step, order in the plan. */
export const REMOVE_STEPS: Readonly<
  Record<string, StepFn<RemoveWeaveCtx, RemoveOutcome>>
> = {
  // whole-resource immutable disables delete (append-only); field-level immutable freezes only the
  // named fields — delete stays available (04-features.md §immutable: update/delete stay for `immutable:{fields}`).
  "remove.wholeImmutableGuard": (w) => {
    if (immutableForm(w.model)?.whole) return { halt: NOT_DELETED };
  },
  "remove.whereId": (w) => {
    w.where = `id = ${w.p(w.id)}`;
  },
  "remove.whereScope": (w) => {
    if (w.model.features.scope) {
      w.where += ` AND scope_key = ${w.p(w.ctx.scope)}`;
    }
  },
  // AND-inject the rowPolicy: a hidden row matches 0 rows → {deleted:false}, never a cross-owner
  // delete. Runs before the soft-delete stamps (placeholder order) — the rollup pre-read reuses this where.
  "remove.whereRowPolicy": (w) => {
    w.where += appendRowPolicyConjunct(w.model, w.ctx, w.p, w.rowPolicy);
  },
  // auto-purge scans candidates outside the reap tx; re-assert the predicate inside the delete so a
  // revived or already-deleted row matches 0 rows, never a silent tombstone or double rollup-decrement.
  "remove.wherePurgeGuard": (w) => {
    if (w.purgeGuard) {
      w.where += ` AND expires_at IS NOT NULL AND expires_at <= now()${
        w.model.features.softDelete ? " AND deleted_at IS NULL" : ""
      }`;
    }
  },
  // must also match only a live row: without this, a second remove() of an already-tombstoned row
  // re-decrements the rollup and writes a phantom audit row (no concurrency needed) — now matches 0 rows.
  "remove.whereLiveGuard": (w) => {
    if (!w.purgeGuard && w.model.features.softDelete) {
      w.where += ` AND deleted_at IS NULL`;
    }
  },
  // an omitted CAS on a versioning resource is REFUSED here, not tolerated — exactly as on update. A
  // dropped conjunct deletes a version the caller never read, and under softDelete it hides a live state.
  "remove.whereVersionCas": (w) => {
    if (!w.model.features.versioning) return; // no `version` column to compare against
    if (w.expectedVersion === undefined) {
      throw Object.assign(
        new Error(
          `resource '${w.model.name}' declares versioning: delete requires the expected version — read the row (findForUpdate) and pass \`row.version\``,
        ),
        { kind: "validation" },
      );
    }
    if (w.expectedVersion === NO_CAS) return; // framework integrity sweep: blind by name, never by omission
    w.versioned = true;
    w.where += ` AND version = ${w.p(w.expectedVersion)}`; // optimistic-lock CAS
  },
  // locks the target row (FOR UPDATE) before any cascade sweep runs — closes a TOCTOU where a concurrent
  // version bump or child create could orphan children while this delete's CAS silently returns {stale:true}.
  "remove.stalePrecheck": async (w) => {
    const hasSweep = w.model.onDeleteSweeps.length > 0 ||
      Boolean(w.model.features.tree);
    if (!w.versioned && !hasSweep) return; // no CAS + no child-reading sweep → no lock needed (nothing to orphan)
    const present = (await w.db.query(
      `SELECT 1 FROM ${tableOf(w.model)} WHERE ${w.where} FOR UPDATE`,
      w.params,
    )).rows.length;
    if (w.versioned && present === 0) {
      return { halt: { deleted: false, stale: true } };
    }
  },
  // take the rollup/cascade-edge advisory lock before any row lock, so a concurrent update(child)/
  // remove(child) can't interleave row locks with this remove's cascade sweep into a deadlock.
  "remove.lockRollupEdges": async (w) => {
    await lockRollupCascadeEdges(w.db, w.model, w.id, true);
  },
  // for the audit diff, capture the full prior row image before the delete (only when audited).
  "remove.captureBeforeImage": async (w) => {
    w.before = auditConfig(w.model)
      ? await readRow(w.db, w.model, w.ctx, w.id)
      : null;
  },
  // rollups: capture the parent ids + aggregated field values before the row is gone (03-api-shape.md §8).
  // count/sum apply a delta after; avg/min/max recompute over the surviving set (soft-deleted excluded too).
  "remove.captureRollupTargets": async (w) => {
    w.toMaintain = await captureRollupTargets(w.db, w.model, w.where, w.params);
  },
  // onDelete reverse-ref sweep (03-api-shape.md §onDelete): honors cascade/set-null/restrict before
  // the parent is deleted — restrict aborts on a surviving child; a hard delete sweeps first (FK order).
  "remove.sweepOnDelete": async (w) => {
    if (w.model.onDeleteSweeps.length > 0) {
      await sweepOnDelete(w.db, w.model, w.ctx, w.id, cascadeRemove);
    }
  },
  // tree self-FK sweep (04-features.md §tree): honors `onParentDelete` against this node's own children
  // (restrict aborts, cascade falls the subtree, set-null reparents to root) before the parent is deleted.
  "remove.sweepTreeChildren": async (w) => {
    if (w.model.features.tree) {
      await sweepTreeOnDelete(w.db, w.model, w.ctx, w.id, cascadeRemove);
    }
  },
  // RETURNING id lets us report whether a row was actually affected — a delete of a missing/out-of-scope
  // id affects 0 rows (notFound), not a silent success. Rollup-decrement + audit only fire on a real delete.
  "remove.execDelete": async (w) => {
    if (w.model.features.softDelete) {
      // deleted_by is its own lifecycle marker, gated purely on softDelete + onRow-on (independent of the
      // created/updated gate) — its columns are minted "iff softDelete" (04-features.md §audit onRow).
      const stamp = onRowGate(w.model)
        ? `, deleted_by_type = ${
          w.p(w.ctx.actor?.type ?? null)
        }, deleted_by_id = ${w.p(w.ctx.actor?.id ?? null)}`
        : "";
      // a soft delete is a write, so it bumps the optimistic-lock version — else a CAS token read before
      // the delete still wins an update after a restore, and `version` stops being a change token.
      const bump = w.model.features.versioning ? ", version = version + 1" : "";
      w.affected = (await w.db.query(
        `UPDATE ${
          tableOf(w.model)
        } SET deleted_at = now()${bump}${stamp} WHERE ${w.where} RETURNING id`,
        w.params,
      )).rows.length;
    } else {
      // hard delete: RETURNING the file() key columns too, so we can enqueue off-box bytes-GC for the row
      // that actually went (a 0-row delete enqueues nothing — no phantom GC).
      const fileCols = w.model.files.length > 0
        ? `, ${w.model.files.map((f) => `"${f}"`).join(", ")}`
        : "";
      const gone = (await w.db.query<Record<string, unknown>>(
        `DELETE FROM ${
          tableOf(w.model)
        } WHERE ${w.where} RETURNING id${fileCols}`,
        w.params,
      )).rows;
      w.affected = gone.length;
      if (w.model.files.length > 0 && gone[0]) {
        const keys = w.model.files.map((f) => gone[0]![f]).filter((
          k,
        ): k is string => typeof k === "string" && k.length > 0);
        // enqueue the GC in this tx (the no-orphan chokepoint) — commits iff the delete commits; drained by drainFileGc.
        if (keys.length > 0) {
          await enqueue(w.db, FILE_GC_TOPIC, { keys }, {
            scope: w.model.features.scope ? w.ctx.scope : undefined,
          });
        }
      }
    }
  },
  "remove.maintainRollups": async (w) => {
    if (w.affected > 0) {
      await maintainCapturedRollups(w.db, w.model, w.toMaintain, "decrement");
    }
  },
  "remove.audit": async (w) => {
    // op is normalized to 'delete' for both soft + hard delete (04-features.md §audit: op ∈ create|update|delete|restore|rectify).
    // The delete is a from:<value>→to:null transition, so the prior image is `before`, the post-state null.
    if (w.affected > 0) {
      await auditWrite(w.db, w.model, w.ctx, w.id, "delete", {
        before: w.before,
        after: null,
      });
    }
  },
  // read-model maintenance: remove enqueues an outbox-fenced drop of the
  // projection in the same tx — the source row is no longer readable, so its projection must not linger.
  "remove.enqueueReadModelDrop": async (w) => {
    if (w.affected > 0 && w.model.readModelSinks.length > 0) {
      await enqueueReadModelMaintain(w.db, w.model, w.ctx, w.id, "delete");
    }
  },
};

/** Deletes a row by id, scoped — soft (sets `deleted_at`) if the resource declares softDelete, else
 *  hard. `rowPolicy` defaults to the resource's declared gate; internal cascade sweeps pass `() => all()`
 *  so a cascade never silently skips a rowPolicy-hidden child. Step order: `REMOVE_WEAVE` (write-plan.ts).
 *  On a `versioning` resource `expectedVersion` is mandatory — omit it and this throws `validation`
 *  rather than blind-deleting; `NO_CAS` is the framework's own named exemption. */
export async function remove(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  id: string,
  rowPolicy?: RowPolicy<unknown>,
  expectedVersion?: ExpectedVersion,
  purgeGuard?: boolean,
): Promise<RemoveOutcome> {
  const params: unknown[] = [];
  const w: RemoveWeaveCtx = {
    db,
    model,
    ctx,
    id,
    rowPolicy,
    expectedVersion,
    purgeGuard,
    params,
    p: (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    },
    where: "",
    versioned: false,
    before: null,
    toMaintain: [],
    affected: 0,
  };
  const halted = await runWeave(REMOVE_WEAVE, REMOVE_STEPS, w);
  return halted !== undefined
    ? halted.halt
    : { deleted: w.affected > 0, stale: w.versioned && w.affected === 0 };
}

/** restore()'s weave state — the increment mirror of remove (rollup symmetry). */
interface RestoreWeaveCtx {
  readonly db: Db;
  readonly model: ResourceModel;
  readonly ctx: ReadCtx;
  readonly id: string;
  readonly params: unknown[];
  readonly p: (v: unknown) => string;
  clear: string;
  where: string;
  toMaintain: readonly CapturedRollupTarget[];
  affected: number;
}

/** The step bindings for `RESTORE_WEAVE` (exported for the write-plan conformance self-check). */
export const RESTORE_STEPS: Readonly<
  Record<string, StepFn<RestoreWeaveCtx, { restored: boolean }>>
> = {
  "restore.softDeleteOnlyGuard": (w) => {
    if (!w.model.features.softDelete) return { halt: { restored: false } }; // no soft-delete state to undo (by-construction: restore() doesn't exist)
  },
  // onRow: clear the delete-attribution pair so a restored row is indistinguishable from a never-deleted one
  "restore.clearDeletedByColumns": (w) => {
    w.clear = onRowGate(w.model)
      ? `, deleted_by_type = NULL, deleted_by_id = NULL`
      : "";
  },
  "restore.whereId": (w) => {
    w.where = `id = ${w.p(w.id)}`;
  },
  "restore.whereScope": (w) => {
    if (w.model.features.scope) {
      w.where += ` AND scope_key = ${w.p(w.ctx.scope)}`;
    }
  },
  "restore.whereTombstoned": (w) => {
    w.where += ` AND deleted_at IS NOT NULL`; // only a soft-deleted row can be restored — live/missing/cross-scope → 0 rows
  },
  // AND-inject the rowPolicy (write-side authz) so an actor cannot un-delete a row their rowPolicy hides
  // — a hidden row matches 0 rows → {restored:false}, never a cross-owner revive. System writes stay vacuous.
  "restore.whereRowPolicy": (w) => {
    w.where += appendRowPolicyConjunct(w.model, w.ctx, w.p, undefined);
  },
  // restore re-stamps the parent's rollups, so it takes the same up-edge advisory lock update/remove do,
  // before the pre-read — a concurrent restore ∥ update/remove on the rolled-up parent can't deadlock.
  "restore.lockRollupEdges": async (w) => {
    await lockRollupCascadeEdges(w.db, w.model, w.id, false);
  },
  // rollups: capture parent ids + field values from the still-soft-deleted row before the restore.
  // count/sum apply a delta after; avg/min/max recompute once `deleted_at` clears, rejoining the set.
  "restore.captureRollupTargets": async (w) => {
    w.toMaintain = await captureRollupTargets(w.db, w.model, w.where, w.params);
  },
  // the revive half of the same rule: bump the optimistic-lock version so a token read before the delete
  // cannot win an update after the restore. The tombstone conjunct is the precondition — a second restore
  // matches 0 rows — so restore takes no caller CAS (a tombstoned row is unreadable, hence unversionable).
  "restore.execRestore": async (w) => {
    const bump = w.model.features.versioning ? ", version = version + 1" : "";
    w.affected = (await w.db.query(
      `UPDATE ${
        tableOf(w.model)
      } SET deleted_at = NULL${bump}${w.clear} WHERE ${w.where} RETURNING id`,
      w.params,
    )).rows.length;
  },
  // mirror remove() but in the increment direction — the restored child re-enters its parent's aggregate set.
  "restore.maintainRollups": async (w) => {
    if (w.affected > 0) {
      await maintainCapturedRollups(w.db, w.model, w.toMaintain, "increment");
    }
  },
  "restore.audit": async (w) => {
    if (w.affected > 0) await auditWrite(w.db, w.model, w.ctx, w.id, "restore"); // one audit row per applied restore
  },
  // the mirror of `remove.enqueueReadModelDrop`: the row is readable again, so its projection must come
  // back. Without this the drop stands forever on a live row — nothing pending, nothing dead-lettered.
  "restore.enqueueReadModelUpsert": async (w) => {
    if (w.affected > 0 && w.model.readModelSinks.length > 0) {
      await enqueueReadModelMaintain(w.db, w.model, w.ctx, w.id, "upsert");
    }
  },
};

/** Undeletes a soft-deleted row by id — exists iff the resource declares `softDelete`. Restoring a
 *  live/missing/cross-scope row affects 0 rows → {restored:false}; restore re-maintains the parent's
 *  rollups symmetrically with `remove`. Step order: `RESTORE_WEAVE` (write-plan.ts). */
export async function restore(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  id: string,
): Promise<{ restored: boolean }> {
  const params: unknown[] = [];
  const w: RestoreWeaveCtx = {
    db,
    model,
    ctx,
    id,
    params,
    p: (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    },
    clear: "",
    where: "",
    toMaintain: [],
    affected: 0,
  };
  const halted = await runWeave(RESTORE_WEAVE, RESTORE_STEPS, w);
  return halted !== undefined ? halted.halt : { restored: w.affected > 0 };
}
