import { assertTreeParentInScope } from "./repo-tree-shared.ts";
// Barrel re-exports keep import sites stable.
import { tableOf } from "../core/app-define.ts";
import type { ResourceModel } from "../core/app.ts";
import { hashPasswordValues } from "../core/code-helpers.ts";
import { createSuppliableOf } from "./write-plan.ts";
import { uuidv7 } from "../core/id.ts";
import {
  blindIndexCol,
  encryptValues,
  type Kms,
  stampBlindIndexes,
} from "../features/encrypt.ts";
import { enqueueReadModelMaintain } from "../features/readmodel.ts";
import { stampTamperRow } from "../features/tamper.ts";
import { addToTree } from "../features/treeclosure.ts";
import type { Db } from "./db.ts";
import { auditWrite, onRowGate } from "./repo-audit.ts";
import { lockRollupEdgesOnValues, recomputeRollup } from "./repo-rollup.ts";
import { stampAndEnqueueReembed } from "./repo-topics.ts";
import { lockTreeForReparent } from "./repo-tree-a.ts";
import { assertParentInScope, assertParentsLive } from "./repo-tree-b.ts";
import type { ReadCtx } from "./repo.ts";
import {
  idIsDbAllocated,
  normalizeSequence,
  SINGLETON_SENTINEL_ID,
  tamperEvidentOn,
} from "./schema.ts";
import { allocateSeq } from "./sequence.ts";
import { CREATE_WEAVE, runWeave, type StepFn } from "./write-plan.ts";

/** The mutable weave state one `create` threads through its steps (write-plan.ts `CREATE_WEAVE` owns the
 *  order); `entries` accumulates the INSERT column list, `id` is settled by the mint step or by INSERT RETURNING. */
interface CreateWeaveCtx {
  readonly db: Db;
  readonly model: ResourceModel;
  readonly ctx: ReadCtx;
  readonly values: Record<string, unknown>;
  readonly kms?: Kms;
  readonly opts?: { onConflictDoNothing?: boolean };
  readonly entries: Array<[string, unknown]>;
  dbAllocatesId: boolean;
  id: string;
}

/** The step bindings for `CREATE_WEAVE` (exported for the write-plan conformance self-check). Each
 *  body is the verbatim hand-woven block it replaces — conditions inside the step, order in the plan. */
export const CREATE_STEPS: Readonly<
  Record<string, StepFn<CreateWeaveCtx, string>>
> = {
  "create.encrypt": async (w) => {
    if (w.model.encrypted.length > 0) {
      if (!w.kms) {
        throw new Error(
          `resource '${w.model.name}' declares encrypted fields but no KMS is bound`,
        );
      }
      // blind-index stamp before the seal (it reads the plaintext the seal consumes) — the `<f>_bidx`
      // sidecar per equality field, a minted column absent from model.columns (04-features.md §encrypted equality).
      await stampBlindIndexes(
        w.kms,
        w.model.encryptedConfig.equality,
        w.values,
        { schema: w.model.pgSchema, table: w.model.name },
      );
      for (const f of w.model.encryptedConfig.equality) {
        const c = blindIndexCol(f);
        if (c in w.values) w.entries.push([c, w.values[c]]);
      }
      // ciphertext-at-rest before the INSERT, sealed to this cell's position — `w.id` is already settled
      // (`create.mintId` precedes this step; encrypted requires an app-minted id strategy, boot-guarded)
      await encryptValues(w.kms, w.model.encrypted, w.values, {
        schema: w.model.pgSchema,
        table: w.model.name,
        rowId: w.id,
      });
    }
  },
  "create.hashPasswords": async (w) => {
    if (w.model.passwords.length > 0) {
      await hashPasswordValues(w.model.passwords, w.values); // salted slow-KDF hash-at-rest before the INSERT (never plaintext)
    }
  },
  // tamper-evidence: rows form one per-table hash chain in id order. This advisory lock (held to commit)
  // serializes inserts so order matches stamp order — unguarded, concurrent appends could interleave and break the chain.
  "create.tamperAppendLock": async (w) => {
    if (tamperEvidentOn(w.model.features)) {
      await w.db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `tamper:${tableOf(w.model)}`,
      ]);
    }
  },
  // A global singleton mints the fixed sentinel id (`CHECK(id=sentinel)` rejects any other value); a scoped
  // singleton mints a per-scope uuidv7 riding `UNIQUE(scope_key)`. Either form overrides a DB-allocated id strategy.
  "create.mintId": (w) => {
    const singletonId = Boolean(w.model.features.singleton);
    const sentinelId = singletonId && !w.model.features.scope; // only a global singleton uses the shared sentinel id
    w.dbAllocatesId = idIsDbAllocated(w.model.idStrategy) && !singletonId; // uuidv4 (gen_random_uuid) / serial (identity); a singleton overrides DB allocation
    // uuidv7 (a scoped singleton too); a global singleton writes the sentinel; DB-allocated strategies omit it.
    // Settled before `create.encrypt` so it can seal the position AAD (encrypted requires an app-minted id).
    if (!w.dbAllocatesId) {
      w.id = sentinelId ? SINGLETON_SENTINEL_ID : uuidv7();
      w.entries.push(["id", w.id]);
    }
  },
  // An absent value on a column with a declared `.default(<static>)` is omitted so the DDL DEFAULT mints it
  // (03-api-shape.md §4); an explicit `null` is still written verbatim. The native-sequence column below rides this same mechanism.
  "create.userColumns": (w) => {
    for (const c of Object.keys(w.model.columns)) {
      if (
        w.values[c] === undefined && w.model.columns[c]?.default !== undefined
      ) continue;
      // an absent optional column (no declared default) binds NULL, never `undefined`: postgres.js refuses an
      // undefined bind while PGlite silently coerces it ( pins the split).
      w.entries.push([c, w.values[c] === undefined ? null : w.values[c]]);
    }
  },
  // the caller-suppliable lifecycle columns (`createSuppliableOf`, write-plan.ts): temporal's valid_from/
  // valid_to + expiry's expires_at — threaded only when supplied so an absent value rides the DDL default.
  "create.lifecycleColumns": (w) => {
    for (const c of createSuppliableOf(w.model)) {
      if (w.values[c] !== undefined) w.entries.push([c, w.values[c]]);
    }
  },
  "create.parentFkColumn": (w) => {
    if (w.model.parentFk) {
      w.entries.push([w.model.parentFk, w.values[w.model.parentFk]]); // child: the FK to its parent (NOT NULL)
    }
  },
  // parent-scoped enforcement: the bare `<parent>_id` FK checks only the parent id, so a scoped child could
  // reference a cross-scope parent. Validate the parent's scope before insert (also protects the onDelete sweep).
  "create.assertParentInScope": async (w) => {
    if (w.model.parentFk) {
      await assertParentInScope(
        w.db,
        w.model,
        w.ctx,
        w.values[w.model.parentFk],
      );
    }
  },
  "create.assertTreeParentInScope": async (w) => {
    await assertTreeParentInScope(w.db, w.model, w.ctx, w.values["parent_id"]); // the tree self-FK cross-scope guard
  },
  // refuse a child whose FK points at a soft-deleted (tombstoned) parent — a bare FK only checks existence,
  // so without this the child orphans. `FOR SHARE` serializes against the remover's `FOR UPDATE` (two-sided with repo-remove.ts stalePrecheck).
  "create.assertParentsLive": async (w) => {
    if (w.model.softDeleteParentRefs.length > 0) {
      await assertParentsLive(w.db, w.model, w.values);
    }
  },
  "create.createdByColumns": (w) => {
    if (onRowGate(w.model)?.created) {
      w.entries.push(["created_by_type", w.ctx.actor?.type ?? null], [
        "created_by_id",
        w.ctx.actor?.id ?? null,
      ]); // onRow: who created (gated on the `created` half)
    }
  },
  "create.scopeKeyColumn": (w) => {
    if (w.model.features.scope) w.entries.push(["scope_key", w.ctx.scope]);
  },
  // sequence# write-auto (04-features.md §sequence#): locked-row allocates gap-free via `_seq_counters`
  // (allocateSeq); native-sequence is skipped here since the column DEFAULTs to `nextval`, so omitting it auto-allocates.
  "create.allocateSequence": async (w) => {
    const seqCfg = normalizeSequence(
      w.model.features.sequence as Parameters<typeof normalizeSequence>[0],
    );
    if (seqCfg && seqCfg.strategy === "locked-row") {
      const part = seqCfg.scope !== undefined && w.values[seqCfg.scope] != null
        ? String(w.values[seqCfg.scope])
        : w.ctx.scope;
      w.entries.push([
        seqCfg.field,
        await allocateSeq(w.db, w.model.name, seqCfg, part),
      ]);
    }
  },
  // a DB-allocated id (uuidv4/serial) reads the minted PK back via RETURNING; a zero-column INSERT (bare
  // PK + no features) uses DEFAULT VALUES so the DB still allocates the id.
  "create.insert": async (w) => {
    if (w.dbAllocatesId) {
      const body = w.entries.length > 0
        ? `(${w.entries.map((e) => `"${e[0]}"`).join(", ")}) VALUES (${
          w.entries.map((_, i) => `$${i + 1}`).join(", ")
        })`
        : "DEFAULT VALUES";
      const r = await w.db.query<{ id: unknown }>(
        `INSERT INTO ${tableOf(w.model)} ${body} RETURNING id`,
        w.entries.map((e) => e[1]),
      );
      w.id = String(r.rows[0]!.id); // serial integer / uuid → opaque string at the boundary (IdField is string)
      return;
    }
    w.id = w.entries[0]![1] as string; // uuidv7 / singleton sentinel: the app-minted value pushed first
    const names = w.entries.map((e) => `"${e[0]}"`).join(", ");
    const ph = w.entries.map((_, i) => `$${i + 1}`).join(", ");
    // getOrSeedConfig passes `onConflictDoNothing` so a concurrent first-seed is conflict-tolerant in-tx too
    // (`ON CONFLICT DO NOTHING` never raises). A conflict means a peer already seeded the row; return its id, skip side effects.
    if (w.opts?.onConflictDoNothing) {
      // the conflict target must match the resource's uniqueness key: `(scope_key)` scoped, `(id)` global.
      // A partial softDelete index (`WHERE deleted_at IS NULL`) requires ON CONFLICT to repeat the predicate too.
      const scopedSingletonConflict = w.model.features.singleton &&
        w.model.features.scope;
      const conflictTarget = scopedSingletonConflict
        ? `("scope_key")${
          w.model.features.softDelete ? " WHERE deleted_at IS NULL" : ""
        }`
        : `(id)`;
      const r = await w.db.query<{ id: unknown }>(
        `INSERT INTO ${
          tableOf(w.model)
        } (${names}) VALUES (${ph}) ON CONFLICT ${conflictTarget} DO NOTHING RETURNING id`,
        w.entries.map((e) => e[1]),
      );
      if (r.rows.length === 0) return { halt: w.id }; // a concurrent peer seeded it first — the row exists; skip the side effects
    } else {
      await w.db.query(
        `INSERT INTO ${tableOf(w.model)} (${names}) VALUES (${ph})`,
        w.entries.map((e) => e[1]),
      );
    }
  },
  // the rollup edge lock, keyed on the pending parent id — before `create.assertParentsLive`'s FOR SHARE,
  // which `create.maintainParentRollups` below would otherwise upgrade under a concurrent sibling create.
  "create.lockRollupEdges": (w) =>
    lockRollupEdgesOnValues(w.db, w.model, w.values),
  "create.maintainParentRollups": async (w) => {
    for (const rt of w.model.rollupTargets) { // maintain the parent's rollups (same tx, 03-api-shape.md §8)
      const pid = w.values[rt.parentFk];
      if (pid == null) continue;
      if (rt.kind === "count") {
        await w.db.query(
          `UPDATE ${rt.parentTable} SET "${rt.column}" = "${rt.column}" + 1 WHERE id = $1`,
          [String(pid)],
        );
      } else if (rt.kind === "sum") {
        // sum rides an atomic delta — the inserted child's field value added to the running total (default 0).
        await w.db.query(
          `UPDATE ${rt.parentTable} SET "${rt.column}" = "${rt.column}" + $1 WHERE id = $2`,
          [Number(w.values[rt.field!] ?? 0), String(pid)],
        );
      } else {
        // avg/min/max cannot be reconstructed from a delta → recompute over the surviving child set (NULL on empty).
        await recomputeRollup(
          w.db,
          rt.parentTable,
          rt.column,
          w.model,
          rt.parentFk,
          String(pid),
          rt.kind,
          rt.field,
        );
      }
    }
  },
  // serializes the closure write against a concurrent re-parent on the same tree+scope (move/setParent hold
  // the same lock) — else a create-under-P can read stale ancestry mid-move and never reconcile (rebuildClosure keys the moved node, not the new child).
  "create.lockTreeForCreate": async (w) => {
    if (w.model.features.tree && w.model.features.treeClosure) {
      await lockTreeForReparent(w.db, w.model, w.ctx);
    }
  },
  "create.addToClosure": async (w) => {
    if (w.model.features.tree && w.model.features.treeClosure) {
      await addToTree(
        w.db,
        w.model,
        w.id,
        (w.values["parent_id"] as string | null) ?? null,
      ); // maintain the closure on insert
    }
  },
  // an embed is an external API call, never an in-tx compute: create stamps source_hash + shadow columns
  // and enqueues a re-embed job in the same tx (the outbox, enqueued iff the insert commits) — until the drain runs, staleness reads honestly "stale".
  "create.stampVectorAndEnqueue": async (w) => {
    if (w.model.vector) {
      await stampAndEnqueueReembed(w.db, w.model, w.ctx, w.id);
    }
  },
 // read-model maintenance: if this resource sources a materialized read-model,
  // enqueue an outbox-fenced re-projection in the same tx — the drain re-projects the row into the read-model table.
  "create.enqueueReadModelUpsert": async (w) => {
    if (w.model.readModelSinks.length > 0) {
      await enqueueReadModelMaintain(w.db, w.model, w.ctx, w.id, "upsert");
    }
  },
  // stamps the hash-chain link (`row_hash = H(canonical_row_bytes || prev_hash)`) in the same tx, last among
  // this row's writes, so it hashes the settled bytes `verifyHashChain` re-reads (ciphertext for an encrypted field).
  "create.stampTamperRow": async (w) => {
    await stampTamperRow(w.db, w.model, w.id);
  },
  "create.audit": async (w) => {
    // create has no prior state: every set column is a from:null→to:value change (the inserted image is `after`).
    await auditWrite(w.db, w.model, w.ctx, w.id, "create", {
      before: null,
      after: { ...w.values, id: w.id },
    });
  },
};

/** Create — mints (or, for a DB-allocated id, omits) the PK, stamps the scope key; feature columns take
 *  DDL defaults. The id strategy (02-dsl.md §id) drives PK handling: uuidv7 is app-minted and inserted
 *  (the default); uuidv4/serial are DB-allocated, read back via RETURNING. Step order is `CREATE_WEAVE`. */
export async function create(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  values: Record<string, unknown>,
  kms?: Kms,
  opts?: { onConflictDoNothing?: boolean },
): Promise<string> {
  const w: CreateWeaveCtx = {
    db,
    model,
    ctx,
    values,
    kms,
    opts,
    entries: [],
    dbAllocatesId: false,
    id: "",
  };
  const halted = await runWeave(CREATE_WEAVE, CREATE_STEPS, w);
  return halted !== undefined ? halted.halt : w.id;
}

// ── vector / semantic embeddings (04-features.md §vector; the data.embed Port) ────────────────────
// The framework owns the embedding lifecycle (async re-embed via the outbox, honest staleness, filtered
// read) but not the model call — that's the `EmbeddingProvider` seam; a write enqueues the job, the drain calls the provider and writes the vector.
