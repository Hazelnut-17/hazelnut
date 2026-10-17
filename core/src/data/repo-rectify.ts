// GDPR Art. 16 rectification for append-only resources (04-features.md §immutable `rectifiable`).
// The original row stays byte-intact; the correction rides the full create weave as a new row, and
// the original is stamped `superseded_by`/`deleted_at` — the one sanctioned write on an immutable row.
import { tableOf } from "../core/app-define.ts";
import type { ResourceModel } from "../core/app.ts";
import { decryptRow, type Kms } from "../features/encrypt.ts";
import { type Db, isFrameworkTransactionHandle, isTransactor } from "./db.ts";
import {
  auditWrite,
  immutableForm,
  onRowGate,
  timestampsGate,
} from "./repo-audit.ts";
import { revokeRefreshFamily } from "../features/password-auth.ts";
import { enqueueReadModelMaintain } from "../features/readmodel.ts";
import { assertOwnedParentRowPolicy, create } from "./repo-create.ts";
import { appendRowPolicyConjunct, lifecycleLiveFrags } from "./repo-read.ts";
import { relinkOwnedChild } from "./repo-update.ts";
import { tamperRectification, verifyHashChain } from "../features/tamper.ts";
import {
  type CapturedRollupTarget,
  lockRollupCascadeEdges,
  maintainCapturedRollups,
  recomputeRollup,
} from "./repo-rollup.ts";
import type { ReadCtx } from "./repo.ts";
import { rectifiableOn, tamperEvidentOn, unexpiredSql } from "./schema.ts";
import { appendTranslation } from "./repo-i18n.ts";

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
  models: readonly ResourceModel[],
  kms?: Kms,
  parentModel?: ResourceModel,
): Promise<RectifyOutcome> {
  if (!rectifiableOn(model.features)) return { rectified: false }; // by-construction: the facade method exists iff rectifiable
  if (isTransactor(db)) {
    return await db.transaction((tx) =>
      rectify(tx, model, ctx, id, corrections, models, kms, parentModel)
    );
  }
  for (const k of Object.keys(corrections)) {
    if (!(k in model.columns) || k === "id") {
      return { rectified: false, unknownField: k }; // a typo'd correction must not silently no-op
    }
    if (k === "status" || k === "parent_id" || k === model.parentFk) {
      throw Object.assign(
        new Error(
          `rectify/frozen-structure: '${k}' is a state or parent link; a correction cannot change it`,
        ),
        { kind: "conflict" },
      );
    }
  }
  // read the original image — scope + write-side rowPolicy applied (a hidden row reads as absent), locked
  // (FOR UPDATE) so a concurrent rectify serializes here and re-checks the CAS below against committed state.
  const params: unknown[] = [id];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  let where = `id = $1${unexpiredSql(model.features)}`;
  if (model.features.scope) where += ` AND scope_key = ${p(ctx.scope)}`;
  where += appendRowPolicyConjunct(model, ctx, p, undefined);
  const readOriginal = async (lock: boolean) =>
    (await db.query<Record<string, unknown>>(
      `SELECT * FROM ${tableOf(model)} WHERE ${where}${
        lock ? " FOR UPDATE" : ""
      }`,
      params,
    )).rows[0];
  // An adapter without a proven transaction can still answer an authorization refusal. Do not
  // acquire maintenance or row locks on this path: an authorized correction still requires the
  // framework's atomic transaction boundary before its first write.
  if (!isFrameworkTransactionHandle(db)) {
    const visible = await readOriginal(false);
    if (!visible) return { rectified: false };
    if (visible.superseded_by != null) {
      return { rectified: false, conflict: true };
    }
    if (model.parentFk) {
      await assertOwnedParentRowPolicy(
        db,
        model,
        ctx,
        parentModel,
        visible[model.parentFk],
        kms,
        { lock: false },
      );
    }
    throw Object.assign(
      new Error(
        "rectify/transaction-required: correction and child maintenance require one transaction",
      ),
      { kind: "internal" },
    );
  }
  // lock-ordering discipline: the rollup-edge advisory before any row lock (the FOR UPDATE below).
  await lockRollupCascadeEdges(db, model, id, false);
  // First read without locking the child, then lock/check its owned parent, then take the child's FOR UPDATE.
  // This avoids holding the child row while waiting for a parent delete/update and ensures a policy refusal
  // happens before any mutation, even if the handler later ignores the returned Result.
  const candidate = await readOriginal(false);
  if (!candidate) return { rectified: false };
  if (candidate.superseded_by != null) {
    return { rectified: false, conflict: true };
  }
  let verifiedParentId: string | null = null;
  if (model.parentFk) {
    verifiedParentId = await assertOwnedParentRowPolicy(
      db,
      model,
      ctx,
      parentModel,
      candidate[model.parentFk],
      kms,
    );
  }
  const original = await readOriginal(true);
  if (!original) return { rectified: false };
  if (original.superseded_by != null) {
    return { rectified: false, conflict: true }; // rectify the chain head, not a superseded ancestor
  }
  if (
    model.parentFk &&
    original[model.parentFk] !== candidate[model.parentFk]
  ) {
    return { rectified: false, conflict: true };
  }
  // A later legitimate correction must not authenticate markers somebody already forged. Validate
  // the existing history before its only sanctioned lifecycle mutation; failures leave the evidence intact.
  if (tamperEvidentOn(model.features)) {
    const integrity = await verifyHashChain(db, model);
    if (integrity.length) {
      throw Object.assign(
        new Error(
          `rectify/${
            integrity[0]!.id
          }: existing ledger verification failed; preserve it for review before correction`,
        ),
        { kind: "conflict" },
      );
    }
  }
  // A tree child is the same whole-immutable resource. Ordinary reparenting cannot rewrite it; refuse
  // before hiding its parent rather than silently bypassing the child's immutable/policy/audit boundary.
  if (
    model.features.tree &&
    (await db.query(
      `SELECT id FROM ${
        tableOf(model)
      } WHERE parent_id = $1 AND deleted_at IS NULL LIMIT 1`,
      [id],
    )).rows.length
  ) {
    throw Object.assign(
      new Error(
        "rectify/child-immutable: live tree children cannot be rewritten onto a replacement immutable parent",
      ),
      { kind: "conflict" },
    );
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
  const auditCorrected = { ...corrected };
  // rollup capture from the original image (it leaves the live set when the hide stamp lands below).
  const toMaintain: CapturedRollupTarget[] = [];
  for (const rt of model.rollupTargets) {
    const pid = original[rt.parentFk];
    if (pid != null) {
      toMaintain.push({
        rt,
        pid: String(pid),
        delta: rt.field ? (original[rt.field] ?? 0) : 0,
      });
    }
  }
  // Hide the original BEFORE the correction create (UNIQUE-RECTIFIABLE-PARTIAL-01): a partial unique
  // index on `deleted_at IS NULL` still refuses two live rows, so the supersede stamp must land first —
  // otherwise a correction that keeps a unique field throws bare 23505. Same tx: a failed create rolls
  // the hide back. CAS: only an unsuperseded head takes the hide.
  const hideParams: unknown[] = [id];
  const hp = (v: unknown) => {
    hideParams.push(v);
    return `$${hideParams.length}`;
  };
  let hideWhere = `id = $1 AND superseded_by IS NULL AND deleted_at IS NULL${
    unexpiredSql(model.features)
  }`;
  if (model.features.scope) hideWhere += ` AND scope_key = ${hp(ctx.scope)}`;
  hideWhere += appendRowPolicyConjunct(model, ctx, hp, undefined);
  const hideSets = ["deleted_at = now()"];
  if (model.features.versioning) hideSets.push("version = version + 1");
  if (timestampsGate(model)?.updated) hideSets.push("updated_at = now()");
  if (onRowGate(model)?.updated) {
    hideSets.push(
      `updated_by_type = ${hp(ctx.actor?.type ?? null)}`,
      `updated_by_id = ${hp(ctx.actor?.id ?? null)}`,
    );
  }
  if (model.features.onRow && "deleted_by_type" in original) {
    hideSets.push(
      `deleted_by_type = ${hp(ctx.actor?.type ?? null)}`,
      `deleted_by_id = ${hp(ctx.actor?.id ?? null)}`,
    );
  }
  const hidden = (await db.query<Record<string, unknown>>(
    `UPDATE ${tableOf(model)} SET ${
      hideSets.join(", ")
    } WHERE ${hideWhere} RETURNING *`,
    hideParams,
  )).rows[0];
  if (!hidden) {
    throw Object.assign(
      new Error(
        `rectify conflict: '${model.name}' ${id} was concurrently superseded — abort before the correction insert`,
      ),
      { kind: "conflict" },
    );
  }
  // RECTIFY-PASSWORD-NO-FAMILY-REVOKE — same class as IDENTITY-REMOVE: omit-rolesFrom refresh never
  // sees deleted_at, so a superseded password() identity must kill live refresh sessions on the old id.
  if (model.passwords.length > 0) await revokeRefreshFamily(db, id);
  // the correction rides the full create weave (tamper append lock + chain stamp, sequence#, parent-scope
  // guard, rollup increment, read-model enqueue, audit op="create") — a correction is an append.
  // Carry forward only file() fields NOT named in `corrections` — those values are the ORIGINAL row's
  // already-minted keys. A corrected file NAME must mint under the NEW row (RECTIFY-FILE-CORRECTION-MINT-01).
  const carryForwardFileKeys = new Set(
    model.files.filter((f) => !(f in corrections)),
  );
  const newId = await create(db, model, ctx, corrected, kms, {
    carryForwardFileKeys,
    suppressAudit: true,
    ...(tamperEvidentOn(model.features)
      ? { rectifies: await tamperRectification(db, model, id) }
      : {}),
    parentModel,
    ...(verifiedParentId !== null
      ? { ownedParentPolicyVerifiedFor: verifiedParentId }
      : {}),
  });
  // I18N-RECTIFY-SIDECAR-DROP — softDelete leaves the sidecar on the tombstone (parent still exists);
  // rectify mints a NEW live id, so translations must be copied or the head resolves without them.
  // A corrected field's translations described the old value, so they are not carried: the new head takes
  // fresh ones, which is how a set-once translation is corrected.
  if (model.i18n.length > 0) {
    const side = `"${model.pgSchema}"."${model.name}_i18n"`;
    const corrected = Object.keys(corrections).filter((f) =>
      model.i18n.includes(f)
    );
    if (tamperEvidentOn(model.features)) {
      const carried = (await db.query<
        { locale: string; field: string; value: string }
      >(
        `SELECT locale, field, value FROM ${side}
          WHERE entity_id = $1 AND NOT (field = ANY($2::text[])) ORDER BY chain_seq`,
        [id, corrected],
      )).rows;
      for (const t of carried) {
        await appendTranslation(db, model, newId, t.locale, t.field, t.value);
      }
    } else {
      await db.query(
        `INSERT INTO ${side} (entity_id, locale, field, value)
         SELECT $1, locale, field, value FROM ${side}
          WHERE entity_id = $2 AND NOT (field = ANY($3::text[]))
         ON CONFLICT (entity_id, locale, field) DO NOTHING`,
        [newId, id, corrected],
      );
    }
  }
  // Point the chain: only the (still-)unsuperseded head takes the pointer. A concurrent winner makes
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
    } SET superseded_by = $1 WHERE ${stampWhere} RETURNING id`,
    stampParams,
  )).rows.length;
  if (stamped === 0) {
    throw Object.assign(
      new Error(
        `rectify conflict: '${model.name}' ${id} was concurrently superseded — the correction insert must roll back with this tx`,
      ),
      { kind: "conflict" },
    );
  }
  // the original left the live set → decrement its rollup contribution (the correction's create already
  // re-contributed the corrected values — the parent aggregate now reflects the correction, never both).
  await maintainCapturedRollups(
    db,
    model,
    ctx.scope,
    toMaintain,
    "decrement",
  );
  // Mutable owned children follow through the ordinary guarded update weave. Its frozen-field, policy,
  // lifecycle, CAS, timestamp and audit behavior is part of the correction's atomic transaction.
  const table = `"${model.pgSchema}"."${model.name}"`;
  const owned = models.filter((c) =>
    c.parent === model.name && c.pgSchema === model.pgSchema &&
    c.parentFk !== null
  );
  for (const child of owned) {
    const live = lifecycleLiveFrags(child.features).map((frag) =>
      ` AND ${frag}`
    ).join("");
    const rows = (await db.query<{ id: string; version?: number }>(
      `SELECT id${child.features.versioning ? ", version" : ""} FROM ${
        tableOf(child)
      } WHERE "${child.parentFk}" = $1${live}`,
      [id],
    )).rows;
    if (
      rows.length &&
      (immutableForm(child)?.whole ||
        immutableForm(child)?.fields.includes(child.parentFk!))
    ) {
      throw Object.assign(
        new Error(
          "rectify/child-immutable: a child's parent link is immutable",
        ),
        { kind: "conflict" },
      );
    }
    for (const row of rows) {
      await assertOwnedParentRowPolicy(db, child, ctx, model, newId, kms);
      const moved = await relinkOwnedChild(
        db,
        child,
        ctx,
        row.id,
        newId,
        child.features.versioning ? Number(row.version) : undefined,
        kms,
      );
      if (!moved.updated) {
        throw Object.assign(
          new Error(
            "rectify/child-reparent-refused: a child is hidden, frozen, or changed concurrently; the entire correction was rolled back",
          ),
          { kind: moved.frozen || moved.stale ? "conflict" : "forbidden" },
        );
      }
    }
  }
  for (const child of owned) {
    for (const rt of child.rollupTargets) {
      if (rt.parentTable !== table) continue;
      await recomputeRollup(
        db,
        rt.parentTable,
        rt.column,
        child,
        rt.parentFk,
        newId,
        rt.kind,
        rt.field,
        rt.parentReadModelSource,
      );
    }
  }
  // the correction event (04-features.md §audit): one attributed record tying original → correction.
  await auditWrite(db, model, ctx, newId, "rectify", {
    before: original,
    after: { ...auditCorrected, id: newId, superseded_by: null },
    links: { originalId: id, correctionId: newId },
  });
  // the original left the live set, so drop its read-model projection too: create() already enqueued
  // the new row's upsert, but without this the read model would keep serving the rectified-away image.
  if (model.readModelSinks.length > 0) {
    await enqueueReadModelMaintain(db, model, ctx, id, "delete");
  }
  return { rectified: true, supersededBy: newId };
}
