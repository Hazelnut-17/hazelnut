// Framework outbox topics (`_file_gc`, `_vector_reembed`) and their drain handlers, plus
// `semanticSearch` — the vector KNN read gated through the same buildReadWhere rowPolicy stack
// every other read uses. Drains are topic-scoped, idempotent, and loud (never silent) on a null seam.
import { tableOf } from "../core/app-define.ts";
import type { App, ResourceModel } from "../core/app.ts";
import { drainReadModelMaintain } from "../features/readmodel.ts";
import { all, type Where } from "../core/where.ts";
import {
  type EmbeddingProvider,
  isVectorStale,
  sourceHash,
  vectorLiteral,
} from "../features/embed.ts";
import { enqueue, retryOrDeadLetterFrameworkJob } from "../runtime/outbox.ts";
import type { Db, Transactor } from "./db.ts";
import { buildReadWhere } from "./repo-read.ts";
import type { ReadCtx, RowPolicy } from "./repo.ts";
import type { StorageDriver } from "./storage.ts";

/** The outbox topic a hard delete of a `file()`-bearing row enqueues to, in the same tx as the delete
 *  (never a soft delete — the row stays recoverable). `drainFileGc` is the matching drain handler. */
export const FILE_GC_TOPIC = "_file_gc";

/** The file-GC job payload — the dereferenced storage keys the drain must delete off-box. */
interface FileGcJob {
  readonly keys: readonly string[];
}

/** Claim a pending outbox row for THIS drainer and run the work — under the per-job tx when the handle has
 *  one (claim and work commit or roll back together; the drain SELECT's statement-end lock is long gone), else
 *  as a conditional autocommit claim (atomic against a peer, the pre-tx behavior). Returns whether this
 *  drainer won the claim; the losing peer skips the job. */
async function claimAndRun(
  db: Db,
  id: string,
  work: (h: Db) => Promise<void>,
): Promise<boolean> {
  const tx = (db as Partial<Transactor>).transaction;
  if (tx === undefined) {
    const claim = await db.query(
      `UPDATE "_outbox" SET processed_at = now() WHERE id = $1 AND processed_at IS NULL RETURNING id`,
      [id],
    );
    if (claim.rows.length === 0) return false;
    await work(db);
    return true;
  }
  let claimed = false;
  await (db as Db & Transactor).transaction(async (t) => {
    const claim = await t.query(
      `UPDATE "_outbox" SET processed_at = now() WHERE id = $1 AND processed_at IS NULL RETURNING id`,
      [id],
    );
    if (claim.rows.length === 0) return;
    claimed = true;
    await work(t);
  });
  return claimed;
}

/**
 * Drains pending `_file_gc` jobs — `storage.delete` each dereferenced key, then marks the job processed.
 * Topic-scoped by construction (SELECTs only `_file_gc` rows), so it can never consume a co-pending job of
 * another topic. Idempotent (an already-gone key is a no-op); a throwing driver leaves the job for the next
 * drain. Runs on autocommit `db`. `storage` null ⇒ no-op.
 */
export async function drainFileGc(
  db: Db,
  storage: StorageDriver | null,
): Promise<number> {
  if (!storage) return 0;
  // FOR UPDATE SKIP LOCKED claims each pending job for exactly one drainer — without it two concurrent
  // drains could both read the same row and double-run `storage.delete` + mark it done.
  const { rows } = await db.query<{ id: string; payload: unknown }>(
    `SELECT id, payload FROM "_outbox" WHERE topic = $1 AND processed_at IS NULL AND next_retry_at <= now() ORDER BY seq LIMIT 200 FOR UPDATE SKIP LOCKED`,
    [FILE_GC_TOPIC],
  );
  let deleted = 0;
  for (const r of rows) {
    try {
      // re-claim under the per-job tx (the readmodel drain's fix): the SELECT's lock is gone by now, so
      // without the conditional claim two drainers both run `storage.delete` and both count the retry ladder
      const won = await claimAndRun(db, r.id, async () => {
        const keys = (r.payload as FileGcJob).keys ?? [];
        for (const key of keys) {
          await storage.delete(key); // the off-box bytes-delete — the no-orphan lifecycle hook
        }
      });
      if (won) deleted += ((r.payload as FileGcJob).keys ?? []).length;
    } catch (e) {
      // a failing `storage.delete` retries with backoff then dead-letters — one poison GC job no longer
      // aborts the whole framework drain (which starved the app relay chained behind it).
      await retryOrDeadLetterFrameworkJob(db, r.id, e, "_file_gc");
    }
  }
  return deleted;
}

/** The fixed outbox topic the re-embed jobs ride. `runReEmbed` is the matching drain handler; the payload
 *  carries the module/resource/row id so the handler can re-read the source text and write the vector back. */
export const REEMBED_TOPIC = "_vector_reembed";

/** The re-embed job payload — enough for the drain handler to find the row and the model it must embed with. */
interface ReembedJob {
  readonly module: string;
  readonly resource: string;
  readonly id: string;
}

/**
 * Stamps the intended `_model` shadow column and enqueues a re-embed job in the same tx as the write.
 * `<field>_source_hash` is written only by the drain (never at the write), so right after a source-changing
 * write it still records the old source — `stored_hash != hash(current_text)` reads stale until the
 * re-embed drains and re-stamps it. A fresh create (no vector yet) also reads stale, honestly.
 */
export async function stampAndEnqueueReembed(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  id: string,
): Promise<void> {
  const v = model.vector!;
  await db.query(
    `UPDATE ${tableOf(model)} SET "${v.field}_model" = $1 WHERE id = $2`,
    [v.model, id],
  );
  const job: ReembedJob = { module: model.module, resource: model.name, id };
  await enqueue(db, REEMBED_TOPIC, job, {
    scope: model.features.scope ? ctx.scope : undefined,
  });
}

/**
 * The re-embed drain seam the relay calls for a drained `_vector_reembed` job. `embed` is the configured
 * `EmbeddingProvider` or `null` — a null provider is loud-inert: it throws rather than silently storing a
 * null/garbage vector (the same posture as a null Kms in encrypt.ts). With a provider it delegates to `runReEmbed`.
 */
export async function runReEmbedJob(
  db: Db,
  models: readonly ResourceModel[],
  embed: EmbeddingProvider | null,
  payload: unknown,
): Promise<boolean> {
  const job = payload as ReembedJob;
  if (!embed) {
    throw new Error(
      `resource '${job.resource}' declares a vector field but no embed provider is bound — the embed path is inert (a vector cannot be silently written null)`,
    );
  }
  return await runReEmbed(db, models, embed, payload);
}

/**
 * Given a drained `_vector_reembed` job, re-reads the row's source text, calls the `EmbeddingProvider`,
 * and writes the vector + `embedded_at` + `_source_hash` + `_model`. Runs outside the write tx (a drained
 * outbox job). Returns true when a vector was written, false when the row vanished before the job drained.
 */
export async function runReEmbed(
  db: Db,
  models: readonly ResourceModel[],
  embed: EmbeddingProvider,
  payload: unknown,
): Promise<boolean> {
  const job = payload as ReembedJob;
  const model = models.find((m) =>
    m.name === job.resource && m.module === job.module
  );
  if (!model || !model.vector) {
    throw new Error(
      `runReEmbed: no vector resource '${job.module}.${job.resource}'`,
    );
  }
  const v = model.vector;
  const r = await db.query<Record<string, unknown>>(
    `SELECT "${v.source}" AS src FROM ${tableOf(model)} WHERE id = $1`,
    [job.id],
  );
  if (r.rows.length === 0) return false; // the row was deleted before the job drained — nothing to embed
  const src = r.rows[0]!.src;
  const text = src == null ? "" : String(src);
  const [vec] = await embed.embed([text]); // the external call — outside any write tx
  // writes back only if the source is unchanged since it was read — during the embed call's latency a
  // newer write's own re-embed job may already land a fresher vector, which an unconditional write would clobber.
  const w = await db.query<{ id: string }>(
    `UPDATE ${
      tableOf(model)
    } SET "${v.field}" = $1, "${v.field}_embedded_at" = now(), "${v.field}_source_hash" = $2, "${v.field}_model" = $3 WHERE id = $4 AND "${v.source}" IS NOT DISTINCT FROM $5 RETURNING id`,
    [
      vectorLiteral(vec!),
      await sourceHash(text),
      embed.model,
      job.id,
      src ?? null,
    ],
  );
  return w.rows.length > 0; // false ⇒ the source moved under us; the newer job carries the correct vector
}

/**
 * Drains pending `_vector_reembed` jobs — for each, calls `runReEmbedJob`, then marks it processed. The
 * mirror of `drainFileGc`: topic-scoped by construction, `FOR UPDATE SKIP LOCKED`-claimed (two concurrent
 * drains partition the backlog instead of double-embedding). `embed` null preserves the loud-throw in
 * `runReEmbedJob` rather than marking jobs done without embedding. Runs on autocommit `db`.
 */
export async function drainReEmbed(
  db: Db,
  models: readonly ResourceModel[],
  embed: EmbeddingProvider | null,
): Promise<number> {
  const { rows } = await db.query<{ id: string; payload: unknown }>(
    `SELECT id, payload FROM "_outbox" WHERE topic = $1 AND processed_at IS NULL AND next_retry_at <= now() ORDER BY seq LIMIT 200 FOR UPDATE SKIP LOCKED`,
    [REEMBED_TOPIC],
  );
  let processed = 0;
  for (const r of rows) {
    try {
      // per-job re-claim (the readmodel drain's fix) — the SELECT's lock is gone by now, so the conditional
      // claim is the only thing standing between this loop and a peer drainer double-calling the provider.
      const won = await claimAndRun(db, r.id, async (h) => {
        // the live seam — calls the provider (or loud-throws on a null embed)
        await runReEmbedJob(h, models, embed, r.payload);
      });
      if (won) processed += 1;
    } catch (e) {
      // a poison re-embed (null-embed throw, provider 4xx) retries with backoff then dead-letters — it no
      // longer aborts the drain (which starved every framework topic + the app relay behind it).
      await retryOrDeadLetterFrameworkJob(db, r.id, e, "_vector_reembed");
    }
  }
  return processed;
}

/** The cumulative count of each framework-topic drain a single `drainFrameworkTopics` pass performed —
 *  `files` off-box keys reclaimed, `reembeds` jobs re-embedded, `readModels` projections refreshed. */
export interface FrameworkDrainResult {
  readonly files: number;
  readonly reembeds: number;
  readonly readModels: number;
}

/**
 * Runs every topic-scoped framework drain once — the backstop for rows hard-deleted through a custom-op
 * path that never reaches an inline drain door. Composes only the existing topic-scoped, `FOR UPDATE SKIP
 * LOCKED` drains (never a bare consume of another topic's job); each runs on autocommit `db`. A null seam
 * degrades its own drain (0 / loud-throw) rather than marking jobs done. Idempotent — purely additive.
 */
export async function drainFrameworkTopics(
  db: Db,
  opts: {
    readonly models: readonly ResourceModel[];
    readonly app?: App;
    readonly storage?: StorageDriver | null;
    readonly embed?: EmbeddingProvider | null;
  },
): Promise<FrameworkDrainResult> {
  // the three framework drains run in isolated failure domains — a per-drain catch so an unexpected throw
  // in one can never abort the other two or the app relay chained after this call (per-job failures already retry/DLQ).
  let files = 0, reembeds = 0, readModels = 0;
  try {
    files = await drainFileGc(db, opts.storage ?? null);
  } catch (e) {
    console.error(
      "[hazelnut] _file_gc drain error (isolated; other topics + relay proceed):",
      e,
    );
  }
  try {
    reembeds = await drainReEmbed(db, opts.models, opts.embed ?? null);
  } catch (e) {
    console.error("[hazelnut] _vector_reembed drain error (isolated):", e);
  }
  // read-model maintain needs a Transactor (each job runs its own tx for the source-row FOR UPDATE
  // serialization); a Transactor-less/app-less caller skips it (0, degraded not wrong).
  try {
    readModels =
      opts.app && (db as Partial<Transactor>).transaction !== undefined
        ? await drainReadModelMaintain(db as Db & Transactor, opts.app)
        : 0;
  } catch (e) {
    console.error("[hazelnut] _readmodel_maintain drain error (isolated):", e);
  }
  return { files, reembeds, readModels };
}

/**
 * `vector/possibly-stale`: is a row's stored vector stale relative to its current source text? Compares
 * the stored `<field>_source_hash` against the live source and returns true on disagreement — never a
 * silent stale value. A row with no stored hash yet (vector not embedded) also reads stale.
 */
export async function isRowVectorStale(
  db: Db,
  model: ResourceModel,
  id: string,
): Promise<boolean> {
  const v = model.vector;
  if (!v) {
    throw new Error(
      `isRowVectorStale: resource '${model.name}' has no vector field`,
    );
  }
  const r = await db.query<{ src: unknown; stored: string | null }>(
    `SELECT "${v.source}" AS src, "${v.field}_source_hash" AS stored FROM ${
      tableOf(model)
    } WHERE id = $1`,
    [id],
  );
  if (r.rows.length === 0) {
    throw new Error(`isRowVectorStale: row '${id}' not found`);
  }
  const current = await sourceHash(
    r.rows[0]!.src == null ? null : String(r.rows[0]!.src),
  );
  return isVectorStale(r.rows[0]!.stored, current);
}

/**
 * `semanticSearch` (security-critical): k-nearest-neighbour over the embedding column, AND'd with the
 * full read WHERE-stack at the same `buildReadWhere` site every other read uses — rowPolicy is never a
 * post-query filter. Load-bearing: `SET LOCAL hnsw.iterative_scan = 'relaxed_order'` keeps pgvector
 * scanning until k rows pass the filter; without it a naive HNSW search returns the raw top-K first and
 * then filters, silently dropping authorized rows that weren't in that raw top-K.
 */
export async function semanticSearch<Row>(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  queryVec: Float32Array,
  k: number,
  rowPolicy: RowPolicy<Row> = () => all<Row>(),
  caller: Where<Row> = all<Row>(),
  maxScanTuples = 20000,
): Promise<Row[]> {
  const v = model.vector;
  if (!v) throw new Error(`resource '${model.name}' has no vector field`);
  const { sql, params } = buildReadWhere(model, ctx, rowPolicy, caller);
  const qp = `$${params.length + 1}`;
  const kp = `$${params.length + 2}`;
  const select = `SELECT * FROM ${
    tableOf(model)
  } WHERE ${sql} ORDER BY "${v.field}" <=> ${qp} LIMIT ${kp}`;
  const args = [...params, vectorLiteral(queryVec), Math.max(0, Math.floor(k))];
  // SET LOCAL is tx-scoped (auto-resets at commit, never leaks on a pooled connection) — the scan setting
  // and the ORDER-BY read below MUST share one transaction, or the guard above silently doesn't apply.
  const run = async (tx: Db): Promise<Row[]> => {
    await tx.query(`SET LOCAL hnsw.iterative_scan = 'relaxed_order'`);
    await tx.query(
      `SET LOCAL hnsw.max_scan_tuples = ${
        Math.max(1, Math.floor(maxScanTuples))
      }`,
    );
    const r = await tx.query<Record<string, unknown>>(select, args);
    return r.rows as Row[];
  };
  const t = db as Db & Partial<Transactor>;
  if (typeof t.transaction === "function") return await t.transaction(run); // a Transactor: tx-scoped SET LOCAL
  // a bare Db: drive an explicit BEGIN/COMMIT so SET LOCAL is still tx-scoped (reset on ROLLBACK if the read
  // throws). PGlite serializes on one connection, so this is correct for the in-process substrate.
  await db.query(`BEGIN`);
  try {
    const rows = await run(db);
    await db.query(`COMMIT`);
    return rows;
  } catch (e) {
    await db.query(`ROLLBACK`);
    throw e;
  }
}
