// remove()/restore() — the soft/hard delete and undelete doors, run as REMOVE_WEAVE/RESTORE_WEAVE
// (write-plan.ts owns step order): rowPolicy + version-CAS gating, cascade/tree sweeps, rollup
// maintenance, audit, and read-model drop, all inside the caller's op tx.
import {
  captureCascadedPasswordIds,
  captureCascadeMaintenance,
  finishCascadeMaintenance,
  hasMutatingDeleteSweep,
  hasNativeFkMaintenance,
} from "./cascade-maintenance.ts";
import { stampAndEnqueueReembed } from "./repo-topics.ts";
import { casMissIsStale } from "./repo-list.ts";
import { rebuildClosure } from "./repo-tree-a.ts";
import { tableOf } from "../core/app-define.ts";
import { boundInstantText } from "../core/lower-sql.ts";
import type { ResourceModel } from "../core/app.ts";
import { enqueueReadModelMaintain } from "../features/readmodel.ts";
import { revokeRefreshFamilyInTransaction } from "../features/password-sessions.ts";
import { type Db, hasTransactionRootRole, isTransactor } from "./db.ts";
import { inTxSavepoint } from "./tx-locks.ts";
import {
  inRollupProjectionBoundary,
  rollupProjectionMayRun,
} from "./rollup-boundary.ts";
import { tryTreeWriteLock } from "./tree-write-lock.ts";
import { queryPhysicalDelete } from "./pg-error-map.ts";
import {
  inOwnedWriteBoundary,
  isManagedTransactionScope,
  ownsWriteBoundary,
  transactionScopeDb,
} from "./transaction-scope.ts";
import type { BackpressureState } from "../runtime/outbox-emit.ts";
import type { Kms } from "../features/encrypt.ts";
import { z } from "zod";
import { wireOffsetInstant } from "./schema-types.ts";
import {
  auditConfig,
  auditLifecycleChange,
  auditWrite,
  immutableForm,
  onRowGate,
  timestampsGate,
} from "./repo-audit.ts";
import { appendRowPolicyConjunct } from "./repo-read.ts";
import {
  type CapturedRollupTarget,
  captureRollupTargets,
  lockRollupCascadeEdges,
  maintainCapturedRollups,
} from "./repo-rollup.ts";
import {
  sweepOnDelete,
  sweepOnDeleteRepoOwned,
  sweepTreeOnDelete,
} from "./repo-tree-b.ts";
import { deletedAtLivenessOn } from "./schema.ts";
import {
  assertParentsLive,
  assertTreeParentInScope,
  assertTreeParentVisible,
  type RemoveVerb,
  StaleParentReferenceError,
} from "./repo-tree-shared.ts";
import { type ObservedFkSweep, observedFkSweep } from "./repo-fk-sweep.ts";
import {
  assertVersionToken,
  type ExpectedVersion,
  NO_CAS,
} from "./repo-update.ts";
import type { ReadCtx, RowPolicy } from "./repo.ts";
import {
  currentTemporalSql,
  rectifiableOn,
  unexpiredSql,
} from "./schema-normalize.ts";
import { VersionPreconditionError } from "./repo-version-token.ts";
import {
  expiryCallerWritableOf,
  REMOVE_WEAVE,
  RESTORE_WEAVE,
  runWeave,
  type StepFn,
} from "./write-plan.ts";

/** remove()'s result shape — `stale` reports a version-CAS miss. */
export interface RemoveOutcome {
  readonly deleted: boolean;
  readonly stale: boolean;
  readonly version?: number;
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
  readonly directOutboxBackpressure?: BackpressureState;
  readonly kms?: Kms;
  /** Exact FK edge the private repo-owned sweep must still see on this row. */
  readonly observedSweep?: ObservedFkSweep;
  readonly params: unknown[];
  readonly p: (v: unknown) => string;
  where: string;
  versioned: boolean;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  toMaintain: readonly CapturedRollupTarget[];
  affected: number;
  cascadedPasswordIds: readonly string[];
}

const NOT_DELETED: RemoveOutcome = { deleted: false, stale: false };

/** Cascades inherit the initiating app's state while using the named internal CAS exemption. */
const cascadeRemove =
  (backpressure?: BackpressureState, kms?: Kms): RemoveVerb =>
  (db, model, ctx, id, rowPolicy, sweep) =>
    remove(
      db,
      model,
      ctx,
      id,
      rowPolicy,
      NO_CAS,
      undefined,
      backpressure,
      kms,
      sweep,
    );

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
    if (w.observedSweep !== undefined) {
      const fk = w.observedSweep.fk.replaceAll('"', '""');
      w.where += ` AND "${fk}" IS NOT DISTINCT FROM ${
        w.p(w.observedSweep.parentId)
      }`;
    }
  },
  "remove.whereScope": (w) => {
    // Only tree self-FK maintenance may intentionally cross the caller scope.
    if (w.observedSweep?.allowCrossScope) return;
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
        deletedAtLivenessOn(w.model.features) ? " AND deleted_at IS NULL" : ""
      }`;
    }
  },
  // must also match only a live row: without this, a second remove() of an already-tombstoned row
  // re-decrements the rollup and writes a phantom audit row (no concurrency needed) — now matches 0 rows.
  "remove.whereLiveGuard": (w) => {
    // softDelete tombstones and rectifiable supersessions share deleted_at.
    if (!w.purgeGuard && deletedAtLivenessOn(w.model.features)) {
      w.where += ` AND deleted_at IS NULL`;
    }
    // A private FK sweep still has to maintain the exact observed edge after expiry.
    if (!w.purgeGuard && w.observedSweep === undefined) {
      w.where += unexpiredSql(w.model.features);
      w.where += currentTemporalSql(w.model.features);
    }
  },
  // an omitted CAS on a versioning resource is REFUSED here, not tolerated — exactly as on update. A
  // dropped conjunct deletes a version the caller never read, and under softDelete it hides a live state.
  "remove.whereVersionCas": (w) => {
    if (!w.model.features.versioning) return; // no `version` column to compare against
    if (w.expectedVersion === undefined) {
      throw new VersionPreconditionError();
    }
    if (w.expectedVersion === NO_CAS) return; // framework integrity sweep: blind by name, never by omission
    assertVersionToken(w.expectedVersion);
    w.versioned = true;
    w.where += ` AND version = ${w.p(w.expectedVersion)}`; // optimistic-lock CAS
  },
  // locks the target row (FOR UPDATE) before any cascade sweep runs — closes a TOCTOU where a concurrent
  // version bump or child create could orphan children while this delete's CAS silently returns {stale:true}.
  "remove.stalePrecheck": async (w) => {
    const hasSweep = w.model.onDeleteSweeps.length > 0 ||
      Boolean(w.model.features.tree);
    if (!w.versioned && !hasSweep) return; // no CAS + no child-reading sweep → no lock needed (nothing to orphan)
    const tree = w.model.features.tree;
    if (
      typeof tree === "object" &&
      (tree.onParentDelete === "set-null" || tree.onParentDelete === "cascade")
    ) {
      // A scheduler or ancestor delete can already hold a row/edge lock here.
      // Never wait for a forest lock in that order: the current owner may be
      // waiting for that same row. Preserve hidden/missing semantics first.
      const visible = (await w.db.query(
        `SELECT 1 FROM ${tableOf(w.model)} WHERE ${w.where}`,
        w.params,
      )).rows.length;
      if (visible === 0) {
        return {
          halt: w.versioned ? { deleted: false, stale: true } : NOT_DELETED,
        };
      }
      await tryTreeWriteLock(w.db, w.model, w.ctx.scope);
    }
    const present = (await w.db.query(
      `SELECT 1 FROM ${tableOf(w.model)} WHERE ${w.where} FOR UPDATE`,
      w.params,
    )).rows.length;
    if (present === 0) {
      return {
        halt: w.versioned ? { deleted: false, stale: true } : NOT_DELETED,
      };
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
      ? (await w.db.query<Record<string, unknown>>(
        `SELECT * FROM ${tableOf(w.model)} WHERE ${w.where} FOR UPDATE`,
        w.params,
      )).rows[0] ?? null
      : null;
  },
  // rollups: capture the parent ids + aggregated field values before the row is gone (03-api-shape.md §rollups).
  // count/sum apply a delta after; avg/min/max recompute over the surviving set (soft-deleted excluded too).
  "remove.captureRollupTargets": async (w) => {
    w.toMaintain = await captureRollupTargets(w.db, w.model, w.where, w.params);
  },
  // onDelete reverse-ref sweep (03-api-shape.md §onDelete): honors cascade/set-null/restrict before
  // the parent is deleted — restrict aborts on a surviving child; a hard delete sweeps first (FK order).
  "remove.sweepOnDelete": async (w) => {
    if (w.model.onDeleteSweeps.length > 0) {
      await sweepOnDelete(
        w.db,
        w.model,
        w.ctx,
        w.id,
        cascadeRemove(w.directOutboxBackpressure, w.kms),
        w.directOutboxBackpressure,
        w.kms,
      );
    }
  },
  // tree self-FK sweep (04-features.md §tree): honors `onParentDelete` against this node's own children
  // (restrict aborts, cascade falls the subtree, set-null reparents to root) before the parent is deleted.
  "remove.sweepTreeChildren": async (w) => {
    if (w.model.features.tree) {
      await sweepTreeOnDelete(
        w.db,
        w.model,
        w.ctx,
        w.id,
        cascadeRemove(w.directOutboxBackpressure, w.kms),
        w.directOutboxBackpressure,
        w.kms,
      );
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
      const changed = await w.db.query<Record<string, unknown>>(
        `UPDATE ${
          tableOf(w.model)
        } SET deleted_at = now()${bump}${stamp} WHERE ${w.where} RETURNING *`,
        w.params,
      );
      w.affected = changed.rows.length;
      w.after = changed.rows[0] ?? null;
    } else {
      // The generated AFTER DELETE trigger atomically queues current + retired keys, including every
      // database-cascaded descendant. A no-row or rolled-back delete produces no GC intent.
      // Lock the parent before its password descendants so this walk cannot invert lock order with a
      // create that holds the parent and then the child.
      const parentLocked = (await w.db.query(
        `SELECT 1 FROM ${tableOf(w.model)} WHERE ${w.where} FOR UPDATE`,
        w.params,
      )).rows.length;
      w.cascadedPasswordIds = parentLocked === 0 ? [] : [
        ...await captureCascadedPasswordIds(w.db, w.model, w.id),
      ];
      const cascaded = parentLocked === 0
        ? []
        : await captureCascadeMaintenance(w.db, w.model, w.id);
      // A native ON DELETE CASCADE will delete captured descendants without
      // entering their repo remove path. If one of those rows is lifecycle-
      // hidden, the root's visible reverse sweep did not visit it; run its own
      // repo-owned descendant sweeps now, while the captured rows are locked,
      // before the database cascade reaches a restrictive FK below it.
      for (const descendant of cascaded) {
        if (descendant.op !== "delete") continue;
        const tree = descendant.model.features.tree;
        const repoOwnedTreeSweep = typeof tree === "object" &&
          (tree.onParentDelete === "cascade" ||
            tree.onParentDelete === "set-null") &&
          (deletedAtLivenessOn(descendant.model.features) ||
            Boolean(descendant.model.features.audit)) &&
          !("parent_id" in descendant.model.references);
        if (
          descendant.model.onDeleteSweeps.length === 0 &&
          !repoOwnedTreeSweep
        ) continue;
        if (
          descendant.scope !== undefined &&
          descendant.scope !== w.ctx.scope
        ) continue; // cross-scope reference policy remains fail-closed at the FK
        if (
          descendant.model.onDeleteSweeps.length === 0 &&
          !descendant.model.features.tree
        ) continue;
        const present = (await w.db.query(
          `SELECT 1 FROM ${tableOf(descendant.model)} WHERE id = $1`,
          [descendant.id],
        )).rows.length > 0;
        if (!present) continue; // an earlier visible repo sweep already removed it
        const removeDescendant = cascadeRemove(
          w.directOutboxBackpressure,
          w.kms,
        );
        if (descendant.model.onDeleteSweeps.length > 0) {
          await sweepOnDeleteRepoOwned(
            w.db,
            descendant.model,
            w.ctx,
            descendant.id,
            removeDescendant,
            w.directOutboxBackpressure,
            w.kms,
          );
        }
        if (repoOwnedTreeSweep) {
          await sweepTreeOnDelete(
            w.db,
            descendant.model,
            w.ctx,
            descendant.id,
            removeDescendant,
            w.directOutboxBackpressure,
            w.kms,
          );
        }
      }
      const gone = (await queryPhysicalDelete(
        w.db,
        `DELETE FROM ${tableOf(w.model)} WHERE ${w.where} RETURNING id`,
        w.params,
      )).rows;
      w.affected = gone.length;
      if (w.affected > 0) {
        await finishCascadeMaintenance(
          w.db,
          cascaded,
          rebuildClosure,
          w.directOutboxBackpressure,
        );
      }
    }
  },
  // IDENTITY-REMOVE-NO-FAMILY-REVOKE — soft/hard delete of a password() identity must kill live
  // refresh sessions. `passwordRefresh` without `rolesFrom` never ANDs `deleted_at`, so a tombstone
  // alone left omit-rolesFrom renewals live for the refresh TTL. Gate on passwords: apps without
  // `password()` never mint `_password_refresh`, and a bare UPDATE would 42P01 every ordinary delete.
  "remove.revokeRefreshFamily": async (w) => {
    if (w.affected > 0 && w.model.passwords.length > 0) {
      await revokeRefreshFamilyInTransaction(w.db, w.id);
    }
  },
  // A database CASCADE erases an owned password() row without re-entering remove(), so the
  // identity step above never sees that subject. Omit-rolesFrom refresh has no row to re-read.
  "remove.revokeCascadedPasswords": async (w) => {
    if (w.affected === 0) return;
    for (const id of w.cascadedPasswordIds) {
      await revokeRefreshFamilyInTransaction(w.db, id);
    }
  },
  "remove.maintainRollups": async (w) => {
    if (w.affected > 0) {
      await maintainCapturedRollups(
        w.db,
        w.model,
        w.ctx.scope,
        w.toMaintain,
        "decrement",
        w.directOutboxBackpressure,
      );
    }
  },
  "remove.audit": async (w) => {
    // op is normalized to 'delete' for both soft + hard delete: a resource declares softDelete or it does
    // not, so its own declaration says which one happened (04-features.md §audit).
    if (w.affected > 0) {
      await auditWrite(
        w.db,
        w.model,
        w.ctx,
        w.id,
        "delete",
        w.model.features.softDelete
          ? auditLifecycleChange(w.before, w.after)
          : { before: w.before, after: null },
      );
    }
  },
  // read-model maintenance: remove enqueues an outbox-fenced drop of the
  // projection in the same tx — the source row is no longer readable, so its projection must not linger.
  "remove.enqueueReadModelDrop": async (w) => {
    if (w.affected > 0 && w.model.readModelSinks.length > 0) {
      await enqueueReadModelMaintain(
        w.db,
        w.model,
        w.ctx,
        w.id,
        "delete",
        w.directOutboxBackpressure,
      );
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
  directOutboxBackpressure?: BackpressureState,
  kms?: Kms,
  sweep?: object,
): Promise<RemoveOutcome> {
  if (immutableForm(model)?.whole) return NOT_DELETED;
  if (!ownsWriteBoundary(db) && rollupProjectionMayRun(model)) {
    return await inRollupProjectionBoundary(db, true, "remove", (tx) =>
      remove(
        tx,
        model,
        ctx,
        id,
        rowPolicy,
        expectedVersion,
        purgeGuard,
        directOutboxBackpressure,
        kms,
        sweep,
      ));
  }
  if (ownsWriteBoundary(db)) {
    return await removeInner(
      db,
      model,
      ctx,
      id,
      rowPolicy,
      expectedVersion,
      purgeGuard,
      directOutboxBackpressure,
      kms,
      sweep,
    );
  }
  if (
    model.passwords.length > 0 || hasNativeFkMaintenance(model) ||
    hasMutatingDeleteSweep(model)
  ) {
    // A structural port can forward root transaction() on a live callback.
    // Without callback provenance, opening it could commit outside the caller.
    if (
      isTransactor(db) &&
      !hasTransactionRootRole(db) && !isManagedTransactionScope(db)
    ) {
      throw Object.assign(
        new Error(
          `${model.name}: ambiguous transaction handle for delete maintenance`,
        ),
        { kind: "internal" as const },
      );
    }
    const scoped = transactionScopeDb(db);
    const run = (tx: Db) =>
      removeInner(
        tx,
        model,
        ctx,
        id,
        rowPolicy,
        expectedVersion,
        purgeGuard,
        directOutboxBackpressure,
        kms,
        sweep,
      );
    if (isTransactor(scoped)) {
      return await scoped.transaction((tx) => inOwnedWriteBoundary(tx, run));
    }
    if (scoped.savepoint !== undefined) {
      return await inTxSavepoint(scoped, (tx) => inOwnedWriteBoundary(tx, run));
    }
    throw Object.assign(
      new Error(
        `${model.name}: delete maintenance requires a transaction or savepoint`,
      ),
      { kind: "internal" as const },
    );
  }
  return await removeInner(
    db,
    model,
    ctx,
    id,
    rowPolicy,
    expectedVersion,
    purgeGuard,
    directOutboxBackpressure,
    kms,
    sweep,
  );
}

async function removeInner(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  id: string,
  rowPolicy?: RowPolicy<unknown>,
  expectedVersion?: ExpectedVersion,
  purgeGuard?: boolean,
  directOutboxBackpressure?: BackpressureState,
  kms?: Kms,
  sweep?: object,
): Promise<RemoveOutcome> {
  const params: unknown[] = [];
  const observedSweep = sweep === undefined
    ? undefined
    : observedFkSweep(sweep);
  const w: RemoveWeaveCtx = {
    db,
    model,
    ctx,
    id,
    rowPolicy,
    expectedVersion,
    purgeGuard,
    directOutboxBackpressure,
    kms,
    ...(observedSweep !== undefined ? { observedSweep } : {}),
    params,
    p: (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    },
    where: "",
    versioned: false,
    before: null,
    after: null,
    toMaintain: [],
    affected: 0,
    cascadedPasswordIds: [],
  };
  const halted = await runWeave(REMOVE_WEAVE, REMOVE_STEPS, w);
  const outcome = halted !== undefined ? halted.halt : {
    deleted: w.affected > 0,
    stale: w.versioned && w.affected === 0,
    ...(model.features.versioning && w.after?.version !== undefined
      ? { version: Number(w.after.version) }
      : {}),
  };
  return outcome.stale &&
      !await casMissIsStale(db, model, ctx, id, rowPolicy)
    ? { ...outcome, stale: false }
    : outcome;
}

/** restore()'s weave state — the increment mirror of remove (rollup symmetry). */
interface RestoreWeaveCtx {
  readonly db: Db;
  readonly model: ResourceModel;
  readonly ctx: ReadCtx;
  readonly id: string;
  readonly kms?: Kms;
  readonly options: RestoreOptions;
  readonly directOutboxBackpressure?: BackpressureState;
  readonly renewExpiry: boolean;
  expiryPlaceholder?: string;
  readonly params: unknown[];
  readonly p: (v: unknown) => string;
  clear: string;
  where: string;
  /** The still-tombstoned target's parent FKs, read through the complete restore visibility stack before
   *  acquiring any child or rollup lock. Restoring must not make a child live beneath a tombstoned parent. */
  parentValues: Record<string, unknown>;
  toMaintain: readonly CapturedRollupTarget[];
  affected: number;
  /** The exact restored row from the UPDATE RETURNING clause: audit must describe the row re-entering the
   * live set, rather than emit an op='restore' record with an empty business diff. */
  auditAfter: Record<string, unknown> | null;
  auditBefore: Record<string, unknown> | null;
}

/** The step bindings for `RESTORE_WEAVE` (exported for the write-plan conformance self-check). */
export const RESTORE_STEPS: Readonly<
  Record<
    string,
    StepFn<RestoreWeaveCtx, { restored: boolean; version?: number }>
  >
> = {
  "restore.softDeleteOnlyGuard": (w) => {
    if (!w.model.features.softDelete) return { halt: { restored: false } }; // no soft-delete state to undo (by-construction: restore() doesn't exist)
  },
  // onRow: clear the stale delete-attribution pair as the row returns to the live set. This does not
  // erase the restore audit event or the versioning bump, which remain lifecycle history.
  "restore.clearDeletedByColumns": (w) => {
    w.clear = onRowGate(w.model)
      ? `, deleted_by_type = NULL, deleted_by_id = NULL`
      : "";
    if (timestampsGate(w.model)?.updated) w.clear += ", updated_at = now()";
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
    if (rectifiableOn(w.model.features)) {
      w.where += " AND superseded_by IS NULL";
    }
    if (w.renewExpiry) {
      const expiry = w.options.expires_at;
      w.expiryPlaceholder = w.p(
        expiry instanceof Date || typeof expiry === "string"
          ? boundInstantText(expiry)
          : expiry,
      );
      w.where +=
        ` AND (${w.expiryPlaceholder}::timestamptz IS NULL OR ${w.expiryPlaceholder}::timestamptz > now())`;
      w.clear += `, expires_at = ${w.expiryPlaceholder}::timestamptz`;
    } else w.where += unexpiredSql(w.model.features);
  },
  // AND-inject the rowPolicy (write-side authz) so an actor cannot un-delete a row their rowPolicy hides
  // — a hidden row matches 0 rows → {restored:false}, never a cross-owner revive. System writes stay vacuous.
  "restore.whereRowPolicy": (w) => {
    w.where += appendRowPolicyConjunct(w.model, w.ctx, w.p, undefined);
  },
  // First establish that the target is restorable through exactly the same scope/rowPolicy/tombstone stack as
  // the UPDATE. This non-locking read prevents the following parent liveness probe from becoming an oracle for
  // a hidden child, and it stays before any child/rollup lock so the parent FOR SHARE cannot deadlock with
  // remove(parent)'s FOR UPDATE.
  "restore.assertWritableTarget": async (w) => {
    if (w.model.liveParentRefs.length === 0) return;
    const cols = w.model.liveParentRefs.map((r) =>
      `"${r.fk.replaceAll('"', '""')}"`
    ).join(", ");
    const r = await w.db.query<Record<string, unknown>>(
      `SELECT ${cols} FROM ${tableOf(w.model)} WHERE ${w.where} LIMIT 1`,
      w.params,
    );
    if (r.rows.length === 0) return { halt: { restored: false } };
    w.parentValues = r.rows[0]!;
    if (w.model.features.tree) {
      try {
        await assertTreeParentInScope(
          w.db,
          w.model,
          w.ctx,
          w.parentValues.parent_id,
        );
        await assertTreeParentVisible(
          w.db,
          w.model,
          w.ctx,
          w.parentValues.parent_id,
          w.kms,
        );
      } catch (e) {
        if (
          typeof e === "object" && e !== null &&
          (e as { kind?: string }).kind === "notFound"
        ) {
          return { halt: { restored: false } };
        }
        throw e;
      }
    }
  },
  // A soft-deleted child retains its FK values. Before reviving it, share-lock every soft-deleting parent so a
  // concurrent parent remove either finishes first and makes this restore refuse, or waits until this restore
  // completes. Keep the notFound result generic: callers cannot use a restorable child to learn a parent's
  // tombstone state.
  "restore.assertParentsLive": async (w) => {
    if (w.model.liveParentRefs.length === 0) return;
    try {
      await assertParentsLive(w.db, w.model, w.parentValues);
    } catch (e) {
      if (e instanceof StaleParentReferenceError) {
        return { halt: { restored: false } };
      }
      throw e;
    }
  },
  // restore re-stamps the parent's rollups, so it takes the same up-edge advisory lock create/update/remove
  // do, before the parent liveness probe's FOR SHARE (RESTORE_WEAVE orders it).
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
    if (auditConfig(w.model)) {
      // Parent and rollup locks are already held. Lock the exact tombstone before the update so both
      // images describe the winning lifecycle change, without reversing the parent/child lock order.
      w.auditBefore = (await w.db.query<Record<string, unknown>>(
        `SELECT * FROM ${tableOf(w.model)} WHERE ${w.where} FOR UPDATE`,
        w.params,
      )).rows[0] ?? null;
    }
    // Allocate SET-only bind values after every WHERE-only probe has finished. Passing unused parameter
    // positions to an earlier SELECT would leave Postgres unable to infer their types.
    if (onRowGate(w.model)?.updated) {
      w.clear += `, updated_by_type = ${
        w.p(w.ctx.actor?.type ?? null)
      }, updated_by_id = ${w.p(w.ctx.actor?.id ?? null)}`;
    }
    // RETURNING is the post-image from the write that won the tombstone predicate. A separate read would be
    // both weaker under concurrency and unable to make audit's restore event describe this exact re-entry.
    const restored = await w.db.query<Record<string, unknown>>(
      `UPDATE ${
        tableOf(w.model)
      } SET deleted_at = NULL${bump}${w.clear} WHERE ${w.where} RETURNING *`,
      w.params,
    );
    w.affected = restored.rows.length;
    w.auditAfter = restored.rows[0] ?? null;
    if (w.affected > 0 && w.model.vector) {
      await stampAndEnqueueReembed(
        w.db,
        w.model,
        w.ctx,
        w.id,
        w.directOutboxBackpressure,
      );
    }
  },
  // mirror remove() but in the increment direction — the restored child re-enters its parent's aggregate set.
  "restore.maintainRollups": async (w) => {
    if (w.affected > 0) {
      await maintainCapturedRollups(
        w.db,
        w.model,
        w.ctx.scope,
        w.toMaintain,
        "increment",
        w.directOutboxBackpressure,
      );
    }
  },
  "restore.audit": async (w) => {
    if (w.affected > 0) {
      await auditWrite(
        w.db,
        w.model,
        w.ctx,
        w.id,
        "restore",
        auditLifecycleChange(w.auditBefore, w.auditAfter),
      );
    }
  },
  // the mirror of `remove.enqueueReadModelDrop`: the row is readable again, so its projection must come
  // back. Without this the drop stands forever on a live row — nothing pending, nothing dead-lettered.
  "restore.enqueueReadModelUpsert": async (w) => {
    if (w.affected > 0 && w.model.readModelSinks.length > 0) {
      await enqueueReadModelMaintain(
        w.db,
        w.model,
        w.ctx,
        w.id,
        "upsert",
        w.directOutboxBackpressure,
      );
    }
  },
};

/** Undeletes a soft-deleted row by id — exists iff the resource declares `softDelete`. Restoring a
 *  live/missing/cross-scope row affects 0 rows → {restored:false}; restore re-maintains the parent's
 *  rollups symmetrically with `remove`. Step order: `RESTORE_WEAVE` (write-plan.ts). */
export interface RestoreOptions {
  readonly expires_at?: Date | string | null;
}

export async function restore(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  id: string,
  kms?: Kms,
  options: RestoreOptions = {},
  directOutboxBackpressure?: BackpressureState,
): Promise<{ restored: boolean; version?: number }> {
  if (
    !ownsWriteBoundary(db) && model.features.softDelete &&
    rollupProjectionMayRun(model)
  ) {
    return await inRollupProjectionBoundary(
      db,
      true,
      "restore",
      (tx) =>
        restore(tx, model, ctx, id, kms, options, directOutboxBackpressure),
    );
  }
  const parsed = z.object({
    expires_at: z.union([z.date(), wireOffsetInstant]).nullable()
      .optional(),
  }).strict().safeParse(options);
  if (!parsed.success) {
    throw Object.assign(new Error("restore input failed validation"), {
      kind: "validation" as const,
    });
  }
  const renewExpiry = parsed.data.expires_at !== undefined;
  if (renewExpiry && !expiryCallerWritableOf(model)) {
    throw Object.assign(
      new Error("restore: expires_at is not caller-writable on this resource"),
      { kind: "validation" as const },
    );
  }
  if (renewExpiry && parsed.data.expires_at !== null) {
    const expiry = parsed.data.expires_at;
    const past = await db.query<{ past: boolean }>(
      "SELECT $1::timestamptz <= now() AS past",
      [
        expiry instanceof Date || typeof expiry === "string"
          ? boundInstantText(expiry)
          : expiry,
      ],
    );
    if (past.rows[0]?.past) {
      throw Object.assign(
        new Error("restore: expires_at must be in the future or null"),
        { kind: "validation" as const },
      );
    }
  }
  const params: unknown[] = [];
  const w: RestoreWeaveCtx = {
    db,
    model,
    ctx,
    id,
    kms,
    options: parsed.data,
    directOutboxBackpressure,
    renewExpiry,
    params,
    p: (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    },
    clear: "",
    where: "",
    parentValues: {},
    toMaintain: [],
    affected: 0,
    auditAfter: null,
    auditBefore: null,
  };
  const halted = await runWeave(RESTORE_WEAVE, RESTORE_STEPS, w);
  return halted !== undefined ? halted.halt : {
    restored: w.affected > 0,
    ...(w.affected > 0 && model.features.versioning
      ? { version: Number(w.auditAfter?.version) }
      : {}),
  };
}
