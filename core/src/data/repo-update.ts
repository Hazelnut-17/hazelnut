import { casMissIsStale } from "./repo-list.ts";
import {
  assertParentsLive,
  assertTreeParentInScope,
  assertTreeParentVisible,
  StaleParentReferenceError,
} from "./repo-tree-shared.ts";
import {
  assertNativeTextValues,
  assertSupportedInstantValues,
  castPlaceholder,
  spellSupportedInstantInputs,
  storedColumnTypes,
  textInputCasts,
} from "./native-cast.ts";
import { assertFutureCallerExpiry } from "./expiry-write.ts";
// Barrel re-exports keep import sites stable.
import { tableOf } from "../core/app-define.ts";
import type { ResourceModel } from "../core/app.ts";
import { hashPasswordValues, verifyCodeHash } from "../core/code-helpers.ts";
import { wireJson } from "../core/wire-json.ts";
import { revokeRefreshFamilyInTransaction } from "../features/password-sessions.ts";
import {
  blindIndexCol,
  decryptRow,
  encryptValues,
  equalityCutoverMarkers,
  type Kms,
  lockEqualityCutover,
  stampBlindIndexes,
  withEqualityWriteLock,
} from "../features/encrypt.ts";
import { enqueueReadModelMaintain } from "../features/readmodel.ts";
import { type Db, hasTransactionRootRole, isTransactor } from "./db.ts";
import { inTxSavepoint } from "./tx-locks.ts";
import {
  inRollupProjectionBoundary,
  rollupProjectionMayRun,
} from "./rollup-boundary.ts";
import {
  isManagedTransactionScope,
  ownsWriteBoundary,
  transactionScopeDb,
} from "./transaction-scope.ts";
import type { BackpressureState } from "../runtime/outbox-emit.ts";
import {
  auditConfig,
  auditWrite,
  immutableForm,
  onRowGate,
  overlayStoredNativeText,
  timestampsGate,
} from "./repo-audit.ts";
import { appendRowPolicyConjunct } from "./repo-read.ts";
import {
  lockRollupCascadeEdges,
  maintainRollupsOnUpdate,
} from "./repo-rollup.ts";
import { enqueue } from "../runtime/outbox.ts";
import { uuidv7 } from "../core/id.ts";
import {
  fileKeyPrefix,
  keepOrMintFileKey,
  remintStaleKeptFileKey,
} from "./storage.ts";
import { retainFileKeys } from "./file-retention.ts";
import { FILE_GC_TOPIC, stampAndEnqueueReembed } from "./repo-topics.ts";
import {
  lockTreeForReparent,
  readRow,
  rebuildClosure,
  wouldCycle,
} from "./repo-tree-a.ts";
import type { ReadCtx, RowPolicy } from "./repo.ts";
export { assertVersionToken } from "./repo-version-token.ts";
import {
  assertVersionToken,
  VersionPreconditionError,
} from "./repo-version-token.ts";
import {
  currentTemporalSql,
  deletedAtLivenessOn,
  unexpiredSql,
} from "./schema.ts";
import { type ObservedFkSweep, observedFkSweep } from "./repo-fk-sweep.ts";
import {
  expiryCallerWritableOf,
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
  readonly updated_at?: unknown;
  readonly updated_by_type?: unknown;
  readonly updated_by_id?: unknown;
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
  readonly auditPlaintextPatch: Record<string, unknown>;
  readonly expectedVersion?: ExpectedVersion;
  readonly kms?: Kms;
  readonly rowPolicy?: RowPolicy<unknown>;
  readonly ownedRelink: boolean;
  readonly directOutboxBackpressure?: BackpressureState;
  /** Whether a password-changing write has its own rollback boundary. */
  readonly passwordWriteBoundary: boolean;
  /** The parent observed when removing an unchanged parent from the SET. */
  sameTreeParent?: { value: unknown };
  /** Exact FK edge the private repo-owned sweep must still see on this row. */
  observedSweep?: ObservedFkSweep;
  /** Original unforgeable marker, retained for the audit before-image read. */
  readonly sweepToken?: object;
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
  stamps: Record<string, unknown>;
  /** File key observed by the unlocked mint read, keyed by field. */
  fileSeen?: Record<string, string>;
  /** SET-parameter index for a file column, so a lock-time remint can replace it. */
  fileSetAt?: Record<string, number>;
}

const NO_WRITE: UpdateOutcome = { updated: false, stale: false };

/** The keep decision used an unlocked read. Under the row lock, a different
 *  stored key means that keep would resurrect a key already queued for GC. */
function restampStaleKeptFiles(w: UpdateWeaveCtx): void {
  if (w.model.features.softDelete || w.before === null) return;
  for (const field of w.model.files) {
    const decided = w.patch[field];
    const seen = w.fileSeen?.[field];
    if (typeof decided !== "string" || typeof seen !== "string") continue;
    const locked = w.before[field];
    const next = remintStaleKeptFileKey(
      decided,
      seen,
      typeof locked === "string" ? locked : "",
      fileKeyPrefix(w.model.pgSchema, w.model.name, field, w.id),
      uuidv7(),
    );
    if (next === undefined) continue;
    w.patch[field] = next;
    const at = w.fileSetAt?.[field];
    if (at !== undefined) w.setParams[at] = next;
  }
}

/** The final UPDATE combines SET then WHERE arguments, so shift the independently-built WHERE placeholders
 *  by the number of SET arguments. Keeping the two domains separate lets `assertWritableTarget` execute the
 *  exact write stack without inventing a second policy/scope lowering. */
function offsetWhereParams(where: string, setCount: number): string {
  return where.replace(
    /\$(\d+)/g,
    (_whole, raw: string) => `$${Number(raw) + setCount}`,
  );
}

/** Keys in `keys` that no other row of this resource still stores in a file column. */
async function fileKeysNoOtherRowStores(
  db: Db,
  model: ResourceModel,
  id: string,
  keys: readonly string[],
): Promise<string[]> {
  if (keys.length === 0) return [];
  const match = model.files.map((field) =>
    `"${field.replaceAll('"', '""')}" = k`
  ).join(" OR ");
  const held = await db.query<{ key: string }>(
    `SELECT k AS key FROM unnest($2::text[]) AS k
      WHERE EXISTS (
        SELECT 1 FROM ${tableOf(model)} WHERE id::text <> $1 AND (${match})
      )`,
    [id, keys],
  );
  const skip = new Set(held.rows.map((row) => row.key));
  return keys.filter((key) => !skip.has(key));
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
    const partition =
      w.model.features.sequence && typeof w.model.features.sequence === "object"
        ? w.model.features.sequence.scope
        : undefined;
    if (partition !== undefined && Object.hasOwn(w.patch, partition)) {
      return { halt: { ...NO_WRITE, frozen: true } };
    }
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
      // An unchanged parent skips reparent checks, but the write must still
      // predicate on the observed value: a concurrent delete can detach it.
      const stored = (await w.db.query<{ parent_id: unknown }>(
        `SELECT parent_id FROM ${tableOf(w.model)} WHERE id = $1`,
        [w.id],
      )).rows[0];
      const sent = w.patch.parent_id;
      if (
        stored !== undefined &&
        (stored.parent_id == null
          ? sent == null
          : sent != null && String(stored.parent_id) === String(sent))
      ) {
        w.sameTreeParent = { value: stored.parent_id };
        delete w.patch.parent_id;
        return;
      }
      await lockTreeForReparent(w.db, w.model, w.ctx);
    }
  },
  "update.assertReparentInScope": async (w) => {
    if (w.model.features.tree && "parent_id" in w.patch) {
      await assertTreeParentInScope(w.db, w.model, w.ctx, w.patch.parent_id); // a re-parent via update must stay in-scope
      await assertTreeParentVisible(
        w.db,
        w.model,
        w.ctx,
        w.patch.parent_id,
        w.kms,
      );
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
        if (c in w.patch) {
          w.sets.push(
            `"${c}" = ${castPlaceholder(w.model, c, w.p(w.patch[c]))}`,
          );
        }
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
    }
  },
  // The update half of the minted key (05-runtime.md §file). A value already carrying this
  // row+field's prefix is the caller handing back what they read, so it is KEPT — re-minting there would
  // point the column at an object no upload ever filled. Anything else names a NEW file, including
  // another row's key: adopting one is the cross-reference the mint exists to make unauthorable.
  "update.mintFileKeys": async (w) => {
    const sentFields = w.model.files.filter((f) => {
      const sent = w.patch[f];
      return typeof sent === "string" && sent !== "";
    });
    if (sentFields.length === 0) return;
    // A soft-deletable row retains a replaced key until purge, so handing that key back is still
    // a live object. Every other row has already queued the replaced key for deletion.
    let stored: Record<string, unknown> | undefined;
    if (!w.model.features.softDelete) {
      const columns = sentFields.map((f) => `"${f}"`).join(", ");
      const row = await w.db.query<Record<string, unknown>>(
        `SELECT ${columns} FROM ${tableOf(w.model)} WHERE id = $1`,
        [w.id],
      );
      stored = row.rows[0];
    }
    for (const f of sentFields) {
      const sent = w.patch[f] as string;
      const current = stored === undefined
        ? undefined
        : typeof stored[f] === "string"
        ? stored[f]
        : "";
      w.patch[f] = keepOrMintFileKey(
        sent,
        fileKeyPrefix(w.model.pgSchema, w.model.name, f, w.id),
        uuidv7(),
        current,
      );
      if (current !== undefined) {
        w.fileSeen ??= {};
        w.fileSeen[f] = current;
      }
    }
  },
  // the writable surface is card data (write-plan.ts `updateWritableOf`): `allow` adds framework lifecycle
  // columns; `denyStatus` removes `status` on an FSM resource so `ctx.transition` stays its only writer.
  "update.userSets": async (w) => {
    await assertFutureCallerExpiry(w.db, w.model, w.patch);
    const writable = updateWritableOf(w.model);
    // equality-encrypted `<f>_bidx` sidecars are stamped onto the patch by update.encrypt, then SET
    // there — they are not card columns and must not trip the unknown-key refuse (L-23).
    const sidecars = new Set(
      w.model.encryptedConfig.equality.map(blindIndexCol),
    );
    for (const [k, v] of Object.entries(w.patch)) {
      if (
        k === "expires_at" && w.model.features.expiry &&
        !expiryCallerWritableOf(w.model)
      ) {
        throw Object.assign(
          new Error(
            `update: expires_at is framework-computed by expiry.after on '${w.model.name}'`,
          ),
          { kind: "validation" },
        );
      }
      if (k === "status" && writable.denyStatus) continue; // status is transition-only
      if (sidecars.has(k)) continue;
      if (
        k in w.model.columns || writable.allow.has(k) ||
        (w.ownedRelink && k === w.model.parentFk)
      ) {
        w.sets.push(`"${k}" = ${castPlaceholder(w.model, k, w.p(v))}`);
        if (w.model.files.includes(k)) {
          w.fileSetAt ??= {};
          w.fileSetAt[k] = w.setParams.length - 1;
        }
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
    // A parent-only resend still needs the locked no-op comparison below, with
    // the same scope, policy, liveness, CAS and observed-parent predicate as a write.
    if (
      w.sets.length === 0 &&
      !(w.sameTreeParent && Object.keys(w.patch).length === 0)
    ) return { halt: NO_WRITE };
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
    if (w.model.liveParentRefs.some((r) => r.fk in w.patch)) {
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
      ? await readRow(w.db, w.model, w.ctx, w.id, w.sweepToken)
      : null;
    restampStaleKeptFiles(w);
  },
  "update.whereId": (w) => {
    w.where = `id = ${w.whereP(w.id)}`;
    if (w.sameTreeParent) {
      w.where += ` AND parent_id IS NOT DISTINCT FROM ${
        w.whereP(w.sameTreeParent.value)
      }`;
    }
    if (w.observedSweep !== undefined) {
      const fk = w.observedSweep.fk.replaceAll('"', '""');
      w.where += ` AND "${fk}" IS NOT DISTINCT FROM ${
        w.whereP(w.observedSweep.parentId)
      }`;
    }
  },
  "update.whereScope": (w) => {
    // Only tree self-FK maintenance may intentionally cross the caller scope.
    if (w.observedSweep?.allowCrossScope) return;
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
    // Ordinary writes keep the expiry conjunct. A private FK sweep is bound to
    // its exact observed edge and may maintain a lifecycle-hidden row. Rectify's
    // owned-child relink must also reach a window that is not current yet: the
    // public update of that same row still does not.
    if (w.observedSweep === undefined) {
      w.where += unexpiredSql(w.model.features);
      if (!w.ownedRelink) w.where += currentTemporalSql(w.model.features);
    }
  },
  // an omitted CAS on a versioning resource is REFUSED here, not tolerated: dropping the conjunct would
  // turn a compare-and-swap into a blind write with no throw, no err and no invariant to catch it.
  "update.whereVersionCas": (w) => {
    if (!w.model.features.versioning) return; // no `version` column to compare against
    if (w.expectedVersion === undefined) {
      throw new VersionPreconditionError();
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
    const sent = Object.entries(w.auditPlaintextPatch);
    if (sent.length > 0) {
      const compareParams = [...w.whereParams];
      const plain = sent.filter(([field]) =>
        !w.model.encrypted.includes(field) && !w.model.passwords.includes(field)
      );
      const native = textInputCasts(w.model);
      const stored = storedColumnTypes(w.model);
      const equalSql = plain.map(([field, value]) => {
        compareParams.push(value);
        const column = `"${field.replaceAll('"', '""')}"`;
        const input = castPlaceholder(
          w.model,
          field,
          `$${compareParams.length}`,
        );
        // The authored input cast is followed by the column's actual storage coercion (including
        // structural shorthand defaults such as bare numeric -> numeric(19,4)). Arrays pass through DDL.
        const physical = native.has(field) ? stored.get(field) : undefined;
        const bound = physical !== undefined && physical !== native.get(field)
          ? `(${input})::${physical}`
          : input;
        // Compare what PostgreSQL would store, not an absent or size-only native equality operator.
        return native.has(field)
          ? `${column}::text COLLATE "C" IS NOT DISTINCT FROM (${bound})::text COLLATE "C"`
          : `${column} IS NOT DISTINCT FROM ${bound}`;
      }).join(" AND ") || "true";
      let equalKey = "__hazelnut_patch_equal";
      while (equalKey in w.model.columns) equalKey += "_";
      const current = (await w.db.query<Record<string, unknown>>(
        `SELECT *, (${equalSql}) AS "${equalKey}" FROM ${
          tableOf(w.model)
        } WHERE ${w.where} FOR UPDATE`,
        compareParams,
      )).rows[0];
      if (!current) return { halt: { ...NO_WRITE, stale: w.versioned } };
      const compared = { ...current };
      const encrypted = w.model.encrypted.filter((field) =>
        field in w.auditPlaintextPatch
      );
      if (encrypted.length > 0) {
        if (!w.kms) {
          throw new Error(
            "update/encrypted: comparing a patch requires the bound KMS",
          );
        }
        await decryptRow(w.kms, encrypted, compared, {
          schema: w.model.pgSchema,
          table: w.model.name,
        });
      }
      let same = current[equalKey] === true;
      for (const [field, value] of sent) {
        if (!same) break;
        const stored = compared[field];
        if (w.model.passwords.includes(field)) {
          same = typeof value === "string" && typeof stored === "string" &&
            await verifyCodeHash(value, stored);
        } else if (w.model.encrypted.includes(field)) {
          same = canonicalPatchValue(wireJson(value)) ===
            canonicalPatchValue(wireJson(stored));
        }
        if (!same) break;
      }
      if (same) {
        return {
          halt: {
            updated: true,
            stale: false,
            ...(w.model.features.versioning
              ? { version: Number(current.version) }
              : {}),
            ...updateStamps(w.model, current),
          },
        };
      }
    }
    if (
      !w.passwordWriteBoundary &&
      w.model.passwords.some((f) => f in w.auditPlaintextPatch)
    ) {
      throw Object.assign(
        new Error(
          `${w.model.name}: password update requires a transaction or savepoint`,
        ),
        { kind: "internal" as const },
      );
    }
    const stampColumns = Object.keys(updateStamps(w.model, {}));
    const r = await w.db.query<Record<string, unknown> & { version?: number }>(
      `UPDATE ${tableOf(w.model)} SET ${w.sets.join(", ")} WHERE ${
        offsetWhereParams(w.where, w.setParams.length)
      } RETURNING id${w.model.features.versioning ? `, "version"` : ""}${
        stampColumns.map((key) => `, "${key}"`).join("")
      }`,
      [...w.setParams, ...w.whereParams],
    );
    w.updated = r.rows.length > 0;
    // the post-write version IS the next CAS token, so a caller can chain writes without a re-read. Read
    // off the row, not the CAS path: a `NO_CAS` sweep bumps the version too, and its caller needs it just as much.
    if (w.model.features.versioning) w.version = r.rows[0]?.version;
    if (r.rows[0]) w.stamps = updateStamps(w.model, r.rows[0]);
  },
  "update.revokeRefreshFamily": async (w) => {
    if (w.updated && w.model.passwords.some((f) => f in w.patch)) {
      // Revoke only after the password UPDATE has taken its identity-row lock. If revocation
      // ran during hashing, a concurrent login could insert a fresh session after the revoke.
      await revokeRefreshFamilyInTransaction(w.db, w.id);
    }
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
      await maintainRollupsOnUpdate(
        w.db,
        w.model,
        w.ctx.scope,
        w.before,
        w.patch,
        w.directOutboxBackpressure,
      );
    }
  },
  "update.audit": async (w) => {
    if (w.updated && auditConfig(w.model)) {
      const before = w.before ? { ...w.before } : null;
      if (before && w.model.encrypted.length > 0) {
        if (!w.kms) {
          throw new Error(
            "audit/encrypted: encrypted audit images require the bound KMS",
          );
        }
        await decryptRow(w.kms, w.model.encrypted, before, {
          schema: w.model.pgSchema,
          table: w.model.name,
        });
      }
      // `after` starts as the prior image overlaid with the patch. String-backed
      // dbType columns then take the stored text, so an equivalent spelling is not a change.
      const after: Record<string, unknown> = before
        ? { ...before, ...w.patch }
        : { ...w.patch, id: w.id };
      for (const field of w.model.encrypted) {
        if (field in w.auditPlaintextPatch) {
          after[field] = w.auditPlaintextPatch[field];
        }
      }
      await overlayStoredNativeText(
        w.db,
        w.model,
        w.id,
        after,
        Object.keys(w.patch),
      );
      await auditWrite(w.db, w.model, w.ctx, w.id, "update", {
        before,
        after,
      }); // one audit row per applied write
    }
  },
  // The object this write dereferenced. A rectify chain copies a minted key onto the
  // correction head, so the key is not exclusively this row's. GC only keys no other
  // row still stores. Soft-deletable rows retain the rest until physical purge.
  "update.gcReplacedFiles": async (w) => {
    if (!w.updated || !w.before || w.model.files.length === 0) return;
    const dropped = await fileKeysNoOtherRowStores(
      w.db,
      w.model,
      w.id,
      w.model.files
        .filter((f) => f in w.patch && w.patch[f] !== w.before![f])
        .map((f) => w.before![f])
        .filter((k): k is string => typeof k === "string" && k.length > 0),
    );
    if (dropped.length === 0) return;
    if (w.model.features.softDelete) {
      await retainFileKeys(w.db, w.model, w.id, dropped);
      return;
    }
    await enqueue(w.db, FILE_GC_TOPIC, { keys: dropped }, {
      scope: w.model.features.scope ? w.ctx.scope : undefined,
    }, w.directOutboxBackpressure);
  },
  // vector re-embed on a source-text change: re-stamp `source_hash` and enqueue a re-embed in the same tx
  // (the old vector stays stale until it catches up); the embed itself is NEVER computed inline (external call).
  "update.restampVectorOnSourceChange": async (w) => {
    if (w.updated && w.model.vector && w.model.vector.source in w.patch) {
      await stampAndEnqueueReembed(
        w.db,
        w.model,
        w.ctx,
        w.id,
        w.directOutboxBackpressure,
      );
    }
  },
  // read-model maintenance: a source-resource update enqueues an outbox-fenced
  // re-projection in the same tx, so the materialized read-model catches up to the new row image on drain.
  "update.enqueueReadModelUpsert": async (w) => {
    if (w.updated && w.model.readModelSinks.length > 0) {
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

/** JSON object key order does not change a stored jsonb value; array order does. */
function canonicalPatchValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return JSON.stringify(value.map((v) => canonicalPatchValue(v)));
  }
  if (value !== null && typeof value === "object") {
    return JSON.stringify(
      Object.keys(value).sort().map((
        key,
      ) => [key, canonicalPatchValue((value as Record<string, unknown>)[key])]),
    );
  }
  return JSON.stringify(value);
}

function updateStamps(
  model: ResourceModel,
  row: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...(timestampsGate(model)?.updated ? { updated_at: row.updated_at } : {}),
    ...(onRowGate(model)?.updated
      ? {
        updated_by_type: row.updated_by_type,
        updated_by_id: row.updated_by_id,
      }
      : {}),
  };
}

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
  directOutboxBackpressure?: BackpressureState,
): Promise<UpdateOutcome> {
  return await updateRow(
    db,
    model,
    ctx,
    id,
    patch,
    expectedVersion,
    kms,
    rowPolicy,
    false,
    directOutboxBackpressure,
  );
}

/** Rectification's private relocation capability. Public raw patches cannot change an owned parent. */
export async function relinkOwnedChild(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  id: string,
  parentId: string,
  expectedVersion?: ExpectedVersion,
  kms?: Kms,
  directOutboxBackpressure?: BackpressureState,
): Promise<UpdateOutcome> {
  if (!model.parentFk) {
    throw new Error("rectify/relink: resource is not an owned child");
  }
  return await updateRow(
    db,
    model,
    ctx,
    id,
    { [model.parentFk]: parentId },
    expectedVersion,
    kms,
    undefined,
    true,
    directOutboxBackpressure,
  );
}

async function updateRow(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  id: string,
  patch: Record<string, unknown>,
  expectedVersion: ExpectedVersion | undefined,
  kms: Kms | undefined,
  rowPolicy: RowPolicy<unknown> | undefined,
  ownedRelink: boolean,
  directOutboxBackpressure?: BackpressureState,
): Promise<UpdateOutcome> {
  // Read the sweep mark before the copy: the copy is a different object.
  const observedSweep = observedFkSweep(patch);
  const sweepToken = observedSweep === undefined ? undefined : patch;
  // The boundary decision and the weave must see the same authored keys even
  // if a caller mutates its object after starting this asynchronous update.
  patch = { ...patch };
  const run = async (
    writeDb: Db,
    passwordWriteBoundary: boolean,
  ): Promise<UpdateOutcome> => {
    assertSupportedInstantValues(model, Object.entries(patch));
    // Spelling drops the leading `+`. Date.parse only accepts that signed form,
    // so the range check has to see the caller's text.
    spellSupportedInstantInputs(model, patch);
    await assertNativeTextValues(writeDb, model, Object.entries(patch));
    const setParams: unknown[] = [];
    const whereParams: unknown[] = [];
    const w: UpdateWeaveCtx = {
      db: writeDb,
      model,
      ctx,
      id,
      patch,
      auditPlaintextPatch: { ...patch },
      expectedVersion,
      kms,
      rowPolicy,
      ownedRelink,
      directOutboxBackpressure,
      passwordWriteBoundary,
      ...(observedSweep !== undefined ? { observedSweep } : {}),
      ...(sweepToken !== undefined ? { sweepToken } : {}),
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
      stamps: {},
    };
    const halted = await runWeave(UPDATE_WEAVE, UPDATE_STEPS, w);
    const outcome = halted !== undefined ? halted.halt : {
      updated: w.updated,
      stale: w.versioned && !w.updated,
      ...(w.version !== undefined ? { version: w.version } : {}),
      ...w.stamps,
    };
    return outcome.stale &&
        !await casMissIsStale(writeDb, model, ctx, id, rowPolicy, kms)
      ? { ...outcome, stale: false }
      : outcome;
  };
  const changesEquality = model.encryptedConfig.equality.some((f) =>
    f in patch
  );
  const changesPassword = model.passwords.some((f) => f in patch);
  const apply = async (h: Db, boundary: boolean): Promise<UpdateOutcome> => {
    if (!changesEquality) return await run(h, boundary);
    if (!changesPassword) {
      return await withEqualityWriteLock(h, model, (tx) => run(tx, boundary));
    }
    if (!boundary) {
      throw Object.assign(
        new Error(
          `${model.name}: password update requires a transaction or savepoint`,
        ),
        { kind: "internal" as const },
      );
    }
    // This handle is inside the password boundary we just opened. Do not
    // require an optional driver marker or open a second transaction for the
    // equality lock: it must cover the same write and revocation.
    await lockEqualityCutover(h, model);
    return await run(h, true);
  };
  const execute = async (handle: Db): Promise<UpdateOutcome> => {
    if (!changesPassword) return await apply(handle, true);
    if (ownsWriteBoundary(handle)) return await apply(handle, true);
    // A structural callback can forward a root transaction method. As with
    // delete maintenance, never open that ambiguous method as a nested root.
    // An unprotected handle can still complete an unchanged/no-write patch;
    // the guard at the write step refuses an actual password change.
    if (
      isTransactor(handle) &&
      !hasTransactionRootRole(handle) && !isManagedTransactionScope(handle)
    ) return await apply(handle, false);
    const scoped = transactionScopeDb(handle);
    if (isTransactor(scoped)) {
      return await scoped.transaction((tx) => apply(tx, true));
    }
    if (scoped.savepoint !== undefined) {
      return await inTxSavepoint(scoped, (tx) => apply(tx, true));
    }
    return await apply(handle, false);
  };
  return await inRollupProjectionBoundary(
    db,
    rollupProjectionMayRun(model, patch),
    "update",
    execute,
  );
}
