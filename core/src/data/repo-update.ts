import {
  assertParentsLive,
  assertTreeParentInScope,
  StaleParentReferenceError,
} from "./repo-tree-shared.ts";
// Barrel re-exports keep import sites stable.
import { tableOf } from "../core/app-define.ts";
import type { ResourceModel } from "../core/app.ts";
import { hashPasswordValues } from "../core/code-helpers.ts";
import { revokeRefreshFamily } from "../features/password-auth.ts";
import {
  blindIndexCol,
  encryptValues,
  equalityCutoverMarkers,
  type Kms,
  stampBlindIndexes,
  withEqualityWriteLock,
} from "../features/encrypt.ts";
import { enqueueReadModelMaintain } from "../features/readmodel.ts";
import type { Db } from "./db.ts";
import {
  auditConfig,
  auditWrite,
  immutableForm,
  onRowGate,
  timestampsGate,
} from "./repo-audit.ts";
import { appendRowPolicyConjunct } from "./repo-read.ts";
import {
  lockRollupCascadeEdges,
  maintainRollupsOnUpdate,
} from "./repo-rollup.ts";
import { enqueue } from "../runtime/outbox.ts";
import { uuidv7 } from "../core/id.ts";
import { fileKeyPrefix, keepOrMintFileKey } from "./storage.ts";
import { FILE_GC_TOPIC, stampAndEnqueueReembed } from "./repo-topics.ts";
import {
  lockTreeForReparent,
  readRow,
  rebuildClosure,
  wouldCycle,
} from "./repo-tree-a.ts";
import type { ReadCtx, RowPolicy } from "./repo.ts";
export { assertVersionToken } from "./repo-version-token.ts";
import { assertVersionToken } from "./repo-version-token.ts";
import { deletedAtLivenessOn } from "./schema.ts";
import {
  rollupNeedsBeforeImage,
  runWeave,
  type StepFn,
  UPDATE_WEAVE,
  updateWritableOf,
} from "./write-plan.ts";

/** The framework's named blind-write door on a `versioning` resource. An integrity sweep (a cascade
 *  set-null, a singleton full-replace) holds no caller version and must still land, so it says so here;
 *  an omitted version throws instead, because a dropped CAS is indistinguishable from a lost update. */
export const NO_CAS: unique symbol = Symbol("hazelnut.no-cas");

/** update()'s CAS argument: the caller's expected `version`, or the named framework blind-write door. */
export type ExpectedVersion = number | typeof NO_CAS;

/** update()'s result shape — `frozen`/`cycle` are conflicts the boundary maps to `err({kind:'conflict'})`. */
export interface UpdateOutcome {
  readonly updated: boolean;
  /** The row's version after this write, on a `versioning` resource — the next `expectedVersion`/`ETag`. */
  readonly version?: number;
  readonly stale: boolean;
  readonly frozen?: boolean;
  readonly cycle?: boolean;
}

/** The mutable weave state one `update` threads through its steps (`UPDATE_WEAVE` owns the order). SET and
 *  WHERE bind independently so a visibility preflight can reuse the complete write WHERE before the final
 *  UPDATE offsets its placeholders. Steps MUST still run in weave order. */
interface UpdateWeaveCtx {
  readonly db: Db;
  readonly model: ResourceModel;
  readonly ctx: ReadCtx;
  readonly id: string;
  readonly patch: Record<string, unknown>;
  readonly expectedVersion?: ExpectedVersion;
  readonly kms?: Kms;
  readonly rowPolicy?: RowPolicy<unknown>;
  readonly setParams: unknown[];
  readonly whereParams: unknown[];
  /** Allocates a placeholder in the SET parameter domain. */
  readonly p: (v: unknown) => string;
  /** Allocates a placeholder in the independent WHERE parameter domain. */
  readonly whereP: (v: unknown) => string;
  readonly sets: string[];
  where: string;
  before: Record<string, unknown> | null;
  rollupNeedsBefore: boolean;
  versioned: boolean;
  updated: boolean;
  version?: number;
}

const NO_WRITE: UpdateOutcome = { updated: false, stale: false };

/** The final UPDATE combines SET then WHERE arguments, so shift the independently-built WHERE placeholders
 *  by the number of SET arguments. Keeping the two domains separate lets `assertWritableTarget` execute the
 *  exact write stack without inventing a second policy/scope lowering. */
function offsetWhereParams(where: string, setCount: number): string {
  return where.replace(
    /\$(\d+)/g,
    (_whole, raw: string) => `$${Number(raw) + setCount}`,
  );
}

/** The step bindings for `UPDATE_WEAVE` (exported for the write-plan conformance self-check). Each
 *  body is the verbatim hand-woven block it replaces — conditions live inside the step, order in the plan. */
export const UPDATE_STEPS: Readonly<
  Record<string, StepFn<UpdateWeaveCtx, UpdateOutcome>>
> = {
  "update.wholeImmutableGuard": (w) => {
    if (immutableForm(w.model)?.whole) return { halt: NO_WRITE }; // whole-resource immutable: update is removed (by-construction)
  },
  "update.frozenFieldsGuard": (w) => {
    const im = immutableForm(w.model);
    if (im && im.fields.length > 0) {
      // field-level immutable: a patch touching any frozen field is a conflict — set-once, never re-set.
      // Reject before any write (and before encrypting), so the row is untouched and no _audit row is appended.
      const touchesFrozen = im.fields.some((f) => f in w.patch);
      if (touchesFrozen) return { halt: { ...NO_WRITE, frozen: true } };
    }
  },
  // tree/no-cycle (04-features.md §tree): `parent_id` is a real column, so the SET loop below would write it
  // directly without this guard — running the same ancestry check `move`/`setParent` use closes that cycle hole.
  "update.lockTreeForReparent": async (w) => {
    // serialize this check-then-act on the tree before wouldCycle, held to commit, so a concurrent re-parent
    // that would together form a cycle cannot also pass — the loser re-checks the winner's commit.
    if (w.model.features.tree && "parent_id" in w.patch) {
      await lockTreeForReparent(w.db, w.model, w.ctx);
    }
  },
  "update.assertReparentInScope": async (w) => {
    if (w.model.features.tree && "parent_id" in w.patch) {
      await assertTreeParentInScope(w.db, w.model, w.ctx, w.patch.parent_id); // a re-parent via update must stay in-scope
    }
  },
  "update.cycleGuard": async (w) => {
    if (w.model.features.tree && "parent_id" in w.patch) {
      if (
        await wouldCycle(
          w.db,
          w.model,
          w.id,
          (w.patch.parent_id as string | null) ?? null,
        )
      ) return { halt: { ...NO_WRITE, cycle: true } };
    }
  },
  // encrypt any patched encrypted field before it reaches the SET clause — else a plaintext value
  // would be written into the ciphertext column and decrypt to garbage on the next read (mirrors create).
  "update.encrypt": async (w) => {
    if (w.model.encrypted.some((f) => f in w.patch)) {
      if (!w.kms) {
        throw new Error(
          `resource '${w.model.name}' declares encrypted fields but no KMS is bound`,
        );
      }
      // blind-index re-stamp before the seal: a patched equality field re-MACs its `<f>_bidx` sidecar in the
      // same statement (04-features.md §encrypted equality) — minted here since it's absent from model.columns.
      await stampBlindIndexes(
        w.kms,
        w.model.encryptedConfig.equality,
        w.model.unique,
        w.patch,
        { schema: w.model.pgSchema, table: w.model.name },
        await equalityCutoverMarkers(w.db, {
          schema: w.model.pgSchema,
          table: w.model.name,
        }),
      );
      for (const f of w.model.encryptedConfig.equality) {
        const c = blindIndexCol(f);
        if (c in w.patch) w.sets.push(`"${c}" = ${w.p(w.patch[c])}`);
      }
      await encryptValues(w.kms, w.model.encrypted, w.patch, {
        schema: w.model.pgSchema,
        table: w.model.name,
        rowId: w.id,
      });
    }
  },
  "update.hashPasswords": async (w) => {
    if (w.model.passwords.some((f) => f in w.patch)) {
      await hashPasswordValues(w.model.passwords, w.patch); // hash a changed password before the update (an absent field is untouched)
      // a password change must kill every live refresh session for this row — otherwise a stolen
      // refresh token (or another device) keeps minting access JWTs under the old credential.
      await revokeRefreshFamily(w.db, w.id);
    }
  },
  // The update half of the minted key (05-runtime.md §file). A value already carrying this
  // row+field's prefix is the caller handing back what they read, so it is KEPT — re-minting there would
  // point the column at an object no upload ever filled. Anything else names a NEW file, including
  // another row's key: adopting one is the cross-reference the mint exists to make unauthorable.
  "update.mintFileKeys": (w) => {
    for (const f of w.model.files) {
      const sent = w.patch[f];
      if (typeof sent !== "string" || sent === "") continue;
      w.patch[f] = keepOrMintFileKey(
        sent,
        fileKeyPrefix(w.model.pgSchema, w.model.name, f, w.id),
        uuidv7(),
      );
    }
  },
  // the writable surface is card data (write-plan.ts `updateWritableOf`): `allow` adds framework lifecycle
  // columns; `denyStatus` removes `status` on an FSM resource so `ctx.transition` stays its only writer.
  "update.userSets": (w) => {
    const writable = updateWritableOf(w.model);
    // equality-encrypted `<f>_bidx` sidecars are stamped onto the patch by update.encrypt, then SET
    // there — they are not card columns and must not trip the unknown-key refuse (L-23).
    const sidecars = new Set(
      w.model.encryptedConfig.equality.map(blindIndexCol),
    );
    for (const [k, v] of Object.entries(w.patch)) {
      if (k === "status" && writable.denyStatus) continue; // status is transition-only
      if (sidecars.has(k)) continue;
      if (k in w.model.columns || writable.allow.has(k)) {
        w.sets.push(`"${k}" = ${w.p(v)}`);
      } else {
        throw Object.assign(
          new Error(
            `update: unknown patch key '${k}' on '${w.model.name}'`,
          ),
          { kind: "validation" },
        );
      }
    }
  },
  "update.stampUpdatedAt": (w) => {
    if (timestampsGate(w.model)?.updated) w.sets.push(`updated_at = now()`); // gated on the `updated` half (a write-once `{created:true}` fact has no updated_at)
  },
  "update.updatedByColumns": (w) => {
    if (onRowGate(w.model)?.updated) {
      w.sets.push(
        `updated_by_type = ${w.p(w.ctx.actor?.type ?? null)}`,
        `updated_by_id = ${w.p(w.ctx.actor?.id ?? null)}`,
      ); // onRow: who updated (gated on the `updated` half)
    }
  },
  "update.bumpVersion": (w) => {
    if (w.model.features.versioning) w.sets.push(`version = version + 1`); // bump on every write
  },
  "update.emptyPatchGuard": (w) => {
    // Stamp/bump/onRow-updated already pushed SETs above. `emptyPatchWouldWrite` is the
    // wire twin of this halt — keep them in lockstep if a SET step moves.
    if (w.sets.length === 0) return { halt: NO_WRITE };
  },
  // take the rollup-edge advisory lock before the first row lock (the `before` readRow FOR UPDATE), so
  // a concurrent `remove(parent)` cascade can't interleave row locks with this child write into a deadlock.
  "update.lockRollupEdges": async (w) => {
    await lockRollupCascadeEdges(w.db, w.model, w.id, false);
  },
  // A mutable ordinary `references` FK can re-parent just as a tree's `parent_id` can. Probe only FKs
  // this patch changes, before any child-row lock/write: FOR SHARE serializes against remove(parent)'s
  // FOR UPDATE, so the update either lands while its parent remains live or observes the tombstone and refuses.
  "update.assertParentsLive": async (w) => {
    if (w.model.softDeleteParentRefs.some((r) => r.fk in w.patch)) {
      try {
        await assertParentsLive(w.db, w.model, w.patch);
      } catch (e) {
        // The target was stack-visible when assertWritableTarget ran, but another writer can still hide it
        // before this non-child-locking parent probe. Preserve indistinguishable notFound semantics instead
        // of exposing the parent's tombstone through a diagnostic that only a writable child would reveal.
        if (e instanceof StaleParentReferenceError) return { halt: NO_WRITE };
        throw e;
      }
    }
  },
  // capture the prior row image before the write when the audit diff or a rollup-on-update needs it
  // (03-api-shape.md §rollups) — a count rollup or an untouched field never needs it, so the read is skipped otherwise.
  "update.captureBeforeImage": async (w) => {
    w.rollupNeedsBefore = rollupNeedsBeforeImage(w.model, w.patch);
    // a patched file() field needs it too: the key this write REPLACES is dereferenced by the write, and
    // the row is the only place that key still exists once the SET lands.
    w.before = (auditConfig(w.model) || w.rollupNeedsBefore ||
        w.model.files.some((f) => f in w.patch))
      ? await readRow(w.db, w.model, w.ctx, w.id)
      : null;
  },
  "update.whereId": (w) => {
    w.where = `id = ${w.whereP(w.id)}`;
  },
  "update.whereScope": (w) => {
    if (w.model.features.scope) {
      if (
        (w.ctx.scope === undefined || w.ctx.scope === "") &&
        typeof w.ctx.actor?.onBehalfOf === "string" &&
        w.ctx.actor.onBehalfOf.startsWith("system:workflow:")
      ) {
        throw new Error(
          `workflow/scope-required: resource '${w.model.name}' is scoped — a workflow write with an empty scope would land in the empty partition. Name the scope on the starting op's ctx.`,
        );
      }
      w.where += ` AND scope_key = ${w.whereP(w.ctx.scope)}`;
    }
  },
  "update.whereLive": (w) => {
    // softDelete tombstones and rectifiable supersessions share deleted_at (deletedAtLivenessOn).
    if (deletedAtLivenessOn(w.model.features)) {
      w.where += ` AND deleted_at IS NULL`;
    }
  },
  // an omitted CAS on a versioning resource is REFUSED here, not tolerated: dropping the conjunct would
  // turn a compare-and-swap into a blind write with no throw, no err and no invariant to catch it.
  "update.whereVersionCas": (w) => {
    if (!w.model.features.versioning) return; // no `version` column to compare against
    if (w.expectedVersion === undefined) {
      throw Object.assign(
        new Error(
          `resource '${w.model.name}' declares versioning: update requires the expected version — read the row (findForUpdate) and pass \`row.version\``,
        ),
        { kind: "validation" },
      );
    }
    if (w.expectedVersion === NO_CAS) return; // framework integrity sweep: blind by name, never by omission
    assertVersionToken(w.expectedVersion);
    w.versioned = true;
    w.where += ` AND version = ${w.whereP(w.expectedVersion)}`; // optimistic-lock CAS
  },
  // AND-inject the rowPolicy (write-side authz/where-stack-complete) — a row this actor's rowPolicy
  // hides matches 0 rows → {updated:false} (the not-found path), never a cross-owner mutation.
  "update.whereRowPolicy": (w) => {
    w.where += appendRowPolicyConjunct(
      w.model,
      w.ctx,
      w.whereP,
      w.rowPolicy,
    );
  },
  // Do the complete write-stack read WITHOUT a row lock before probing the proposed parent. A child hidden by
  // scope/soft-delete/rowPolicy (or a stale CAS) must look like the ordinary failed update and must not turn
  // into an oracle for a parent it points at. This stays before `lockRollupEdges`: it is a non-locking read;
  // the later FOR SHARE(parent) must remain before any child-row lock to avoid the remove(parent) lock cycle.
  "update.assertWritableTarget": async (w) => {
    const r = await w.db.query<{ one: number }>(
      `SELECT 1 AS one FROM ${tableOf(w.model)} WHERE ${w.where} LIMIT 1`,
      w.whereParams,
    );
    if (r.rows.length === 0) {
      return { halt: { ...NO_WRITE, stale: w.versioned } };
    }
  },
  "update.execUpdate": async (w) => {
    const r = await w.db.query<{ version?: number }>(
      `UPDATE ${tableOf(w.model)} SET ${w.sets.join(", ")} WHERE ${
        offsetWhereParams(w.where, w.setParams.length)
      } RETURNING id${w.model.features.versioning ? `, "version"` : ""}`,
      [...w.setParams, ...w.whereParams],
    );
    w.updated = r.rows.length > 0;
    // the post-write version IS the next CAS token, so a caller can chain writes without a re-read. Read
    // off the row, not the CAS path: a `NO_CAS` sweep bumps the version too, and its caller needs it just as much.
    if (w.model.features.versioning) w.version = r.rows[0]?.version;
  },
  // a re-parent via update on a treeClosure resource must rewrite the subtree's closure rows (same tx) — the
  // SET wrote the new `parent_id` but the `<r>_tree` links to the old ancestors are now stale.
  "update.rebuildClosure": async (w) => {
    if (
      w.updated && w.model.features.tree && w.model.features.treeClosure &&
      "parent_id" in w.patch
    ) {
      await rebuildClosure(
        w.db,
        w.model,
        w.id,
        (w.patch.parent_id as string | null) ?? null,
      );
    }
  },
  // maintain any rollup whose aggregated field this patch changed (same tx, 03-api-shape.md §rollups). `before`
  // is present here whenever a field-bearing rollup was touched (rollupNeedsBefore forced the read above).
  "update.maintainRollups": async (w) => {
    if (w.updated && w.before && w.rollupNeedsBefore) {
      await maintainRollupsOnUpdate(w.db, w.model, w.before, w.patch);
    }
  },
  "update.audit": async (w) => {
    if (w.updated) {
      // `after` = prior image overlaid with the patched user columns — exact for the diff's scalar columns.
      const after = w.before
        ? { ...w.before, ...w.patch }
        : { ...w.patch, id: w.id };
      await auditWrite(w.db, w.model, w.ctx, w.id, "update", {
        before: w.before,
        after,
      }); // one audit row per applied write
    }
  },
  // The object this write DEREFERENCED. Only reachable now that the key is framework-minted: a
  // client-chosen key could be shared by another row, so deleting its bytes here would destroy a live
  // row's file. A minted key is row-scoped, so nothing else can point at it and the GC is unconditional.
  // Rides the same tx as the write (the no-orphan chokepoint `remove` uses) — the intent commits iff the
  // write does. A detach (`null`) dereferences too; an unchanged key is not a replacement.
  "update.gcReplacedFiles": async (w) => {
    if (!w.updated || !w.before || w.model.files.length === 0) return;
    const dropped = w.model.files
      .filter((f) => f in w.patch && w.patch[f] !== w.before![f])
      .map((f) => w.before![f])
      .filter((k): k is string => typeof k === "string" && k.length > 0);
    if (dropped.length === 0) return;
    await enqueue(w.db, FILE_GC_TOPIC, { keys: dropped }, {
      scope: w.model.features.scope ? w.ctx.scope : undefined,
    });
  },
  // vector re-embed on a source-text change: re-stamp `source_hash` and enqueue a re-embed in the same tx
  // (the old vector stays stale until it catches up); the embed itself is NEVER computed inline (external call).
  "update.restampVectorOnSourceChange": async (w) => {
    if (w.updated && w.model.vector && w.model.vector.source in w.patch) {
      await stampAndEnqueueReembed(w.db, w.model, w.ctx, w.id);
    }
  },
  // read-model maintenance: a source-resource update enqueues an outbox-fenced
  // re-projection in the same tx, so the materialized read-model catches up to the new row image on drain.
  "update.enqueueReadModelUpsert": async (w) => {
    if (w.updated && w.model.readModelSinks.length > 0) {
      await enqueueReadModelMaintain(w.db, w.model, w.ctx, w.id, "upsert");
    }
  },
};

/** Update a row by id, scoped — only user columns are patchable; scope + softDelete conjuncts keep a
 *  cross-scope or deleted row untouched. `frozen:true`/`cycle:true` are conflicts like `stale` (immutable
 *  field touched / tree loop, 04-features.md §immutable, §tree). Step order is `UPDATE_WEAVE`.
 *  On a `versioning` resource `expectedVersion` is mandatory — omit it and this throws `validation`
 *  rather than blind-writing; `NO_CAS` is the framework's own named exemption. */
export async function update(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  id: string,
  patch: Record<string, unknown>,
  expectedVersion?: ExpectedVersion,
  kms?: Kms,
  // write-side rowPolicy: defaults to the resource's declared `m.rowPolicy` (the public-API gate);
  // the framework-internal set-null sweeps pass `() => all()` so a cascade detach is never silently skipped.
  rowPolicy?: RowPolicy<unknown>,
): Promise<UpdateOutcome> {
  const run = async (writeDb: Db): Promise<UpdateOutcome> => {
    const setParams: unknown[] = [];
    const whereParams: unknown[] = [];
    const w: UpdateWeaveCtx = {
      db: writeDb,
      model,
      ctx,
      id,
      patch,
      expectedVersion,
      kms,
      rowPolicy,
      setParams,
      whereParams,
      p: (v: unknown) => {
        setParams.push(v);
        return `$${setParams.length}`;
      },
      whereP: (v: unknown) => {
        whereParams.push(v);
        return `$${whereParams.length}`;
      },
      sets: [],
      where: "",
      before: null,
      rollupNeedsBefore: false,
      versioned: false,
      updated: false,
    };
    const halted = await runWeave(UPDATE_WEAVE, UPDATE_STEPS, w);
    return halted !== undefined ? halted.halt : {
      updated: w.updated,
      stale: w.versioned && !w.updated,
      ...(w.version !== undefined ? { version: w.version } : {}),
    };
  };
  const changesEquality = model.encryptedConfig.equality.some((f) =>
    f in patch
  );
  return changesEquality
    ? await withEqualityWriteLock(db, model, run)
    : await run(db);
}
