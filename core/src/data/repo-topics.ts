// Framework outbox topics (`_file_gc`, `_vector_reembed`) and their drain handlers. Drains are
// topic-scoped, idempotent, and loud (never silent) on a null seam.
import { tableOf } from "../core/app-define.ts";
import type { App, ResourceModel } from "../core/app.ts";
import { drainReadModelMaintain } from "../features/readmodel.ts";
import {
  assertEmbeddingBatch,
  type EmbeddingProvider,
  isVectorStale,
  sourceHash,
  vectorLiteral,
} from "../features/embed.ts";
import {
  DEFAULT_HANDLER_TIMEOUT_MS,
  enqueue,
  retryOrDeadLetterFrameworkJob,
  withTimeout,
} from "../runtime/outbox.ts";
import type { Db, Transactor } from "./db.ts";
import { lifecycleLiveFrags } from "./repo-read.ts";
import { querySql, readMetadata } from "./read-compiler.ts";
import { sql } from "drizzle-orm/sql";
import type { ReadCtx } from "./repo.ts";
import type { StorageDriver } from "./storage.ts";
import { loggableError } from "../core/loggable-error.ts";

/** Generated row DELETE triggers enqueue current + retained keys atomically, including FK cascades.
 * Non-soft updates also enqueue dereferenced keys. Soft lifecycle updates retain bytes until physical purge. */
export const FILE_GC_TOPIC = "_file_gc";

/** The file-GC job payload — the dereferenced storage keys the drain must delete off-box. */
interface FileGcJob {
  readonly keys: readonly string[];
}

const FILE_GC_LEASE_MS = 30_000;

// Storage and embedding Ports currently accept no AbortSignal. Bound the wait just as the ordinary
// relay bounds a consumer: a late external effect remains at-least-once, but it cannot renew this
// framework job's lease forever or hold the relay pass hostage. Keep the production ceiling aligned
// with the documented relay handler ceiling; the optional per-call override exists for direct-drain
// harnesses and does not alter the configured runtime default.
const FRAMEWORK_EFFECT_TIMEOUT_MS = DEFAULT_HANDLER_TIMEOUT_MS;

interface FrameworkDrainOptions {
  readonly effectTimeoutMs?: number;
}

/** Inline create drains address only the row just committed; the standing relay drains global batches. */
interface ReembedDrainOptions extends FrameworkDrainOptions {
  readonly only?: {
    readonly module: string;
    readonly resource: string;
    readonly id: string;
    readonly scope?: string;
  };
  readonly signal?: AbortSignal;
}
export const INLINE_REEMBED_TIMEOUT_MS = 5_000;

function reembedLeaseMs(opts: FrameworkDrainOptions | undefined): number {
  // Without an independent heartbeat connection a 30s lease must not expire during a permitted 10min
  // provider call. One bounded effect owns its lease through its full deadline plus finalization margin.
  return Math.max(
    FILE_GC_LEASE_MS,
    opts?.effectTimeoutMs ?? FRAMEWORK_EFFECT_TIMEOUT_MS,
  ) + 60_000;
}

async function withReembedDeadline<T>(
  work: Promise<T>,
  opts?: ReembedDrainOptions,
): Promise<T> {
  const signal = opts?.signal;
  let abort: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    const fail = (message: string) =>
      reject(Object.assign(new Error(message), { kind: "timeout" }));
    timer = setTimeout(
      () => fail("reembed/effect-timeout: provider wait exceeded its deadline"),
      opts?.effectTimeoutMs ?? FRAMEWORK_EFFECT_TIMEOUT_MS,
    );
    if (signal) {
      abort = () =>
        fail(
          "reembed/request-aborted: provider wait ended; the durable job remains retryable",
        );
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (signal && abort) signal.removeEventListener("abort", abort);
  }
}

function withFrameworkEffectDeadline<T>(
  work: Promise<T>,
  opts: FrameworkDrainOptions | undefined,
): Promise<T> {
  return withTimeout(
    work,
    opts?.effectTimeoutMs ?? FRAMEWORK_EFFECT_TIMEOUT_MS,
  );
}

function startLeaseHeartbeat(
  db: Db,
  id: string,
  token: string,
  leaseMs = FILE_GC_LEASE_MS,
): () => void {
  if (db.concurrent !== true) return () => {};
  const timer = setInterval(() => {
    void db.query(
      `UPDATE "_outbox" SET claim_until = now() + ($3 || ' milliseconds')::interval
        WHERE id = $1 AND processed_at IS NULL AND claim_token = $2 AND claim_until > now()`,
      [id, token, String(leaseMs)],
    ).catch(() => {});
  }, Math.floor(FILE_GC_LEASE_MS / 3));
  return () => clearInterval(timer);
}

async function claimFileGc(db: Db, id: string): Promise<string | null> {
  const token = crypto.randomUUID();
  const r = await db.query<{ claim_token: string }>(
    `UPDATE "_outbox"
        SET claim_token = $2, claim_until = now() + ($3 || ' milliseconds')::interval
      WHERE id = $1 AND processed_at IS NULL
        AND (claim_until IS NULL OR claim_until <= now())
      RETURNING claim_token`,
    [id, token, String(FILE_GC_LEASE_MS)],
  );
  return r.rows[0]?.claim_token ?? null;
}

async function claimReEmbed(
  db: Db,
  id: string,
  opts?: FrameworkDrainOptions,
): Promise<string | null> {
  const token = crypto.randomUUID();
  const result = await db.query<{ claim_token: string }>(
    `UPDATE "_outbox" SET claim_token = $2, claim_until = now() + ($3 || ' milliseconds')::interval
     WHERE id = $1 AND processed_at IS NULL AND (claim_until IS NULL OR claim_until <= now()) RETURNING claim_token`,
    [id, token, String(reembedLeaseMs(opts))],
  );
  return result.rows[0]?.claim_token ?? null;
}

async function finalizeFileGc(
  db: Db,
  id: string,
  token: string,
): Promise<boolean> {
  const r = await db.query(
    `UPDATE "_outbox" SET processed_at = now(), claim_token = NULL, claim_until = NULL
      WHERE id = $1 AND processed_at IS NULL AND claim_token = $2 AND claim_until > now()
      RETURNING id`,
    [id, token],
  );
  return r.rows.length > 0;
}

/**
 * Drains pending `_file_gc` jobs — claims a short token lease, performs `storage.delete` outside any DB
 * transaction, then finalizes only while that token lease is still valid.
 * Topic-scoped by construction (SELECTs only `_file_gc` rows), so it can never consume a co-pending job of
 * another topic. Idempotent (an already-gone key is a no-op); a throwing driver leaves the job for the next
 * drain. Runs on autocommit `db`. `storage` null ⇒ no-op.
 */
export async function drainFileGc(
  db: Db,
  storage: StorageDriver | null,
  opts?: FrameworkDrainOptions,
): Promise<number> {
  if (!storage) return 0;
  // FOR UPDATE SKIP LOCKED partitions the poll across concurrent drainers (statement-scoped —
  // the row lock ends with the SELECT). Cross-drainer exclusivity is the claim_token lease below
  // (`claimFileGc`), not SKIP LOCKED alone — same shape as the read-model drain's re-claim.
  const { rows } = await db.query<{ id: string; payload: unknown }>(
    `SELECT id, payload FROM "_outbox" WHERE topic = $1 AND processed_at IS NULL AND next_retry_at <= now()
       AND (claim_until IS NULL OR claim_until <= now()) ORDER BY seq LIMIT 200 FOR UPDATE SKIP LOCKED`,
    [FILE_GC_TOPIC],
  );
  let deleted = 0;
  for (const r of rows) {
    let token: string | null = null;
    try {
      token = await claimFileGc(db, r.id);
      if (!token) continue;
      const stopHeartbeat = startLeaseHeartbeat(db, r.id, token);
      try {
        const keys = (r.payload as FileGcJob).keys ?? [];
        for (const key of keys) {
          await withFrameworkEffectDeadline(storage.delete(key), opts);
        }
        if (await finalizeFileGc(db, r.id, token)) deleted += keys.length;
      } finally {
        stopHeartbeat();
      }
    } catch (e) {
      // a failing `storage.delete` retries with backoff then dead-letters — one poison GC job no longer
      // aborts the whole framework drain (which starved the app relay chained behind it).
      // A stale owner cannot release or dead-letter a lease now held by a newer drainer.
      await retryOrDeadLetterFrameworkJob(db, r.id, e, "_file_gc", 10, token);
    }
  }
  return deleted;
}

/** The fixed outbox topic the re-embed jobs ride. `drainReEmbed` is the matching drain handler; the payload
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
    `UPDATE ${
      tableOf(model)
    } SET "${v.field}" = CASE WHEN "${v.source}" IS NULL THEN NULL ELSE "${v.field}" END,
      "${v.field}_embedded_at" = CASE WHEN "${v.source}" IS NULL THEN NULL ELSE "${v.field}_embedded_at" END,
      "${v.field}_source_hash" = CASE WHEN "${v.source}" IS NULL THEN NULL ELSE "${v.field}_source_hash" END,
      "${v.field}_model" = CASE WHEN "${v.source}" IS NULL THEN NULL ELSE $1 END WHERE id = $2`,
    [v.model, id],
  );
  const job: ReembedJob = { module: model.module, resource: model.name, id };
  await enqueue(db, REEMBED_TOPIC, job, {
    scope: model.features.scope ? ctx.scope : undefined,
  });
}

interface PreparedReembed {
  readonly src: unknown;
  readonly hash: string;
  readonly vec: Float32Array;
  readonly model: string;
}

async function prepareReEmbed(
  db: Db,
  model: ResourceModel,
  embed: EmbeddingProvider | null,
  job: ReembedJob,
  opts?: ReembedDrainOptions,
): Promise<PreparedReembed | null> {
  const v = model.vector!;
  const live = lifecycleLiveFrags(model.features);
  const r = await db.query<Record<string, unknown>>(
    `SELECT "${v.source}" AS src FROM ${tableOf(model)} WHERE id = $1${
      live.map((part) => ` AND (${part})`).join("")
    }`,
    [job.id],
  );
  if (r.rows.length === 0 || r.rows[0]!.src == null) return null;
  const src = r.rows[0]!.src;
  if (!embed) {
    throw new Error(
      `resource '${job.resource}' declares a vector field but no embed provider is bound — the embed path is inert`,
    );
  }
  if (opts?.signal?.aborted) {
    throw Object.assign(new Error("reembed/request-aborted"), {
      kind: "timeout",
    });
  }
  // Capture the provider identity once before egress, then use that same value when stamping the result.
  // An omitted declaration model is provider-authoritative; an explicit model is an equality contract.
  const providerModel = embed.model;
  const providerDims = embed.dims;
  if (typeof providerModel !== "string" || providerModel.length === 0) {
    throw new Error(
      `runReEmbed: provider model id is missing for '${job.resource}'`,
    );
  }
  if (providerDims !== v.dims) {
    throw new Error(
      `runReEmbed: provider width ${providerDims} does not match declared width ${v.dims} for '${job.resource}'`,
    );
  }
  if (v.modelDeclared && providerModel !== v.model) {
    throw new Error(
      `runReEmbed: provider model '${providerModel}' does not match declared model '${v.model}' for '${job.resource}'`,
    );
  }
  const text = String(src);
  const batch = await withReembedDeadline(
    embed.embed([text]),
    opts,
  ); // the external call — outside any write tx
  const vectors = assertEmbeddingBatch(
    batch,
    1,
    v.dims,
    `runReEmbed '${job.resource}'`,
  );
  const vec = vectors[0]!;
  return { src, hash: await sourceHash(text), vec, model: providerModel };
}

/**
 * Direct helper for a consumer-owned re-embed loop. It preserves the source CAS used by the lease drain,
 * but has no outbox finalization: callers that consume framework jobs must use `drainReEmbed`.
 */
export async function runReEmbed(
  db: Db,
  models: readonly ResourceModel[],
  embed: EmbeddingProvider,
  payload: unknown,
  opts?: FrameworkDrainOptions,
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
  const prepared = await prepareReEmbed(db, model, embed, job, opts);
  if (!prepared) return false;
  const v = model.vector;
  return (await db.query<{ id: string }>(
    `UPDATE ${
      tableOf(model)
    } SET "${v.field}" = $1, "${v.field}_embedded_at" = now(), "${v.field}_source_hash" = $2, "${v.field}_model" = $3 WHERE id = $4 AND "${v.source}" IS NOT DISTINCT FROM $5${
      lifecycleLiveFrags(model.features).map((part) => ` AND (${part})`).join(
        "",
      )
    } RETURNING id`,
    [
      vectorLiteral(prepared.vec),
      prepared.hash,
      prepared.model,
      job.id,
      prepared.src,
    ],
  )).rows.length > 0;
}

/**
 * Drains pending `_vector_reembed` jobs. The provider runs outside the finalization transaction; the
 * token lease covers its full bounded deadline even without a heartbeat connection. Missing/inactive
 * rows and NULL sources finalize without provider access. An active source with no provider retries.
 * The standing relay polls a topic-scoped batch; inline create optionally addresses one exact target.
 * `FOR UPDATE SKIP LOCKED` partitions only the poll, while the token fences cross-drainer effects.
 */
export async function drainReEmbed(
  db: Db,
  models: readonly ResourceModel[],
  embed: EmbeddingProvider | null,
  opts?: ReembedDrainOptions,
): Promise<number> {
  if (opts?.signal?.aborted) return 0;
  const { rows } = await db.query<{ id: string; payload: unknown }>(
    `SELECT id, payload FROM "_outbox" WHERE topic = $1 AND processed_at IS NULL AND next_retry_at <= now()
       AND (claim_until IS NULL OR claim_until <= now())${
      opts?.only
        ? " AND payload->>'module' = $2 AND payload->>'resource' = $3 AND payload->>'id' = $4 AND COALESCE(scope, '') = $5"
        : ""
    } ORDER BY seq LIMIT ${opts?.only ? 1 : 200} FOR UPDATE SKIP LOCKED`,
    [
      REEMBED_TOPIC,
      ...(opts?.only
        ? [
          opts.only.module,
          opts.only.resource,
          opts.only.id,
          opts.only.scope ?? "",
        ]
        : []),
    ],
  );
  let processed = 0;
  for (const r of rows) {
    let token: string | null = null;
    try {
      token = await claimReEmbed(db, r.id, opts);
      if (!token) continue;
      // The lease covers the full deadline even when this adapter cannot heartbeat independently.
      const stopHeartbeat = startLeaseHeartbeat(
        db,
        r.id,
        token,
        reembedLeaseMs(opts),
      );
      try {
        const job = r.payload as ReembedJob;
        const model = models.find((m) =>
          m.name === job.resource && m.module === job.module
        );
        if (!model || !model.vector) {
          throw new Error(
            `runReEmbed: no vector resource '${job.module}.${job.resource}'`,
          );
        }
        const prepared = await prepareReEmbed(db, model, embed, job, opts);
        const finalize = async (h: Db): Promise<boolean> => {
          if (!prepared) return await finalizeFileGc(h, r.id, token!);
          const vectorCte = `wrote AS (
                 UPDATE ${tableOf(model)} SET "${model.vector!.field}" = $1,
                   "${model.vector!.field}_embedded_at" = now(),
                   "${model.vector!.field}_source_hash" = $2,
                   "${model.vector!.field}_model" = $3
                  WHERE id = $4 AND "${
            model.vector!.source
          }" IS NOT DISTINCT FROM $5
                    AND EXISTS (SELECT 1 FROM lease)${
            lifecycleLiveFrags(model.features).map((part) => ` AND (${part})`)
              .join("")
          }
                 RETURNING id
               ),`;
          const done = await h.query(
            `WITH lease AS (
               SELECT id FROM "_outbox"
                WHERE id = $6 AND processed_at IS NULL AND claim_token = $7 AND claim_until > now()
                FOR UPDATE
             ), ${vectorCte} finalized AS (
               UPDATE "_outbox" SET processed_at = now(), claim_token = NULL, claim_until = NULL
                WHERE id = $6 AND EXISTS (SELECT 1 FROM lease)
                RETURNING id
             ) SELECT id FROM finalized`,
            [
              vectorLiteral(prepared.vec),
              prepared.hash,
              prepared.model,
              job.id,
              prepared.src,
              r.id,
              token,
            ],
          );
          return done.rows.length > 0;
        };
        const done = (db as Partial<Transactor>).transaction
          ? await (db as Db & Transactor).transaction(finalize)
          : await finalize(db);
        if (done) processed += 1;
      } finally {
        stopHeartbeat();
      }
    } catch (e) {
      // a poison re-embed (null-embed throw, provider 4xx) retries with backoff then dead-letters — it no
      // longer aborts the drain (which starved every framework topic + the app relay behind it).
      await retryOrDeadLetterFrameworkJob(
        db,
        r.id,
        e,
        "_vector_reembed",
        10,
        token,
      );
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
      loggableError(e),
    );
  }
  try {
    reembeds = await drainReEmbed(db, opts.models, opts.embed ?? null);
  } catch (e) {
    console.error(
      "[hazelnut] _vector_reembed drain error (isolated):",
      loggableError(e),
    );
  }
  // read-model maintain needs a Transactor (each job runs its own tx for the source-row FOR UPDATE
  // serialization); a Transactor-less/app-less caller skips it (0, degraded not wrong).
  try {
    readModels =
      opts.app && (db as Partial<Transactor>).transaction !== undefined
        ? await drainReadModelMaintain(db as Db & Transactor, opts.app)
        : 0;
  } catch (e) {
    console.error(
      "[hazelnut] _readmodel_maintain drain error (isolated):",
      loggableError(e),
    );
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
  const r = await querySql<{ src: unknown; stored: string | null }>(
    db,
    sql`SELECT ${sql.identifier(v.source)} AS src, ${
      sql.identifier(`${v.field}_source_hash`)
    } AS stored FROM ${readMetadata(model).table} WHERE id = ${id}`,
  );
  if (r.rows.length === 0) {
    throw new Error(`isRowVectorStale: row '${id}' not found`);
  }
  const current = await sourceHash(
    r.rows[0]!.src == null ? null : String(r.rows[0]!.src),
  );
  return isVectorStale(r.rows[0]!.stored, current);
}
