import { isTransactor } from "../data/db.ts";
import { uuidv7 } from "../core/id.ts";
import { errorKind } from "../core/result.ts";
import type { App } from "../core/app.ts";
import type { OnlyKnownKeys } from "../core/config.ts";
import type { Db } from "../data/db.ts";
import type { Kms } from "../features/encrypt.ts";
import type { ConsumerCtx, ConsumerCtxOf } from "./events.ts";
import { consumerCtxFactory } from "./relay.ts";
import { cronBucket } from "./schedule-once.ts";

// cronBucket + the one-shot scheduling verbs live in the `schedule-once.ts` LEAF (off this ring) so `ctx`
// routes `ctx.schedule` without importing back into the scheduler — re-exported here for the stable surface.
export {
  cronBucket,
  scheduleOnce,
  scheduleOnceCapped,
} from "./schedule-once.ts";

/**
 * The `scheduler` seam (05-runtime.md §seams) — Deno.cron behind a Port/Adapter, trigger-only: it fires a
 * job on a cron tick, all durability lives in the job's own handler tx (every job body must be idempotent
 * against a missed or double tick). The framework registers feature-auto jobs with zero author code
 * (06-generators.md §6d); apps add their own via `register`. A job's `handler` gets the same system-ctx
 * the relay builds for a consumer, bound to one tx by `runCronTick` (commit-or-roll-back atomically).
 */
export interface Job<M = undefined> {
  readonly name: string;
  readonly cron: string; // standard 5-field cron expression
  /** ctx optional on the ERASED face only — the framework's own feature-auto sweeps carry no app and run
   *  ctx-less. `defineJob` narrows it to REQUIRED for any job that declares `resources`, because the
   *  optional there put an `if (!ctx) return;` at the top of every consumer handler: a scheduled job that
   *  silently does nothing, which is the failure a scheduled job can least afford to report as success. */
  handler(ctx?: ConsumerCtxOf<M>): Promise<void>;
}

/** The decl-ERASED job face for registry positions (see events.ts `AnySubscriber`) — a typed or bare Job fits. */
export type AnyJob = Job<never>;

export interface Scheduler {
  register(job: AnyJob): void;
  readonly jobs: ReadonlyArray<AnyJob>;
}

/** Builds the per-tick job ctx bound to the job's tx db, so a handler write joins the dispatch tx. Absent
 *  (feature-auto jobs build their own system ctx), a job is invoked with `undefined`. */
export type JobCtxFactory = (txDb: Db) => ConsumerCtx;

/** Build a `JobCtxFactory` from the composed `App`, reusing the relay's `consumerCtxFactory` (same
 *  system-actor + tx-bound `makeCtx` a consumer gets) with a synthesized `_cron`-aggregate `DeliveredMsg`,
 *  system-scoped (a cron tick has no originating tenant) — a scheduled handler gets the identical ctx surface. */
export function jobCtxFactory(
  app: App,
  jobName: string,
  kms?: Kms,
): JobCtxFactory {
  const make = consumerCtxFactory(app, kms);
  return (txDb: Db) =>
    make({
      id: jobName,
      attempts: 0,
      aggregateType: "_cron",
      aggregateId: jobName,
      topic: jobName,
      payload: {},
      kind: "queue",
    }, txDb);
}

/** Declare a scheduled job (the verb over the Scheduler seam); register it with `scheduler.register`. */
/** `defineJob({ resources: [doc], handler })` types the handler's `ctx.data` faces from the `resources`
 *  value witness — uniform with defineSubscriber/defineWorker; omit it for the untyped ctx. */
export function defineJob<const M = undefined, D = unknown>(
  decl:
    // A job that names `resources` is asking for `ctx.data.<r>` — it cannot run without a ctx, so the slot
    // is REQUIRED there and the handler needs no null branch. `Omit`, not an intersection: two call
    // signatures read as overloads and the optional one still satisfies, so the narrowing has to REPLACE it.
    & ([M] extends [undefined] ? Job<M>
      : Omit<Job<M>, "handler"> & {
        handler(ctx: ConsumerCtxOf<M>): Promise<void>;
      })
    & { readonly resources?: M }
    & OnlyKnownKeys<D, Job<M> & { readonly resources?: M }>,
): Job<M> {
  return decl;
}

/**
 * Enqueue this replica's claim on a cron tick (05-runtime.md §4.1 leaderless enqueue-and-claim). Inserts a
 * `kind='queue'` row on the quantized `scheduled_time` bucket; the partial unique index
 * `(topic, scheduled_time, md5(payload))` admits exactly one row per (job, bucket) — every replica past the
 * first no-ops via ON CONFLICT DO NOTHING, so `RETURNING id` is non-empty only for the winning replica.
 *
 * The row is born `processed_at = now()`: a pure dedup-arbiter/trace record, fenced from the relay's own
 * drain (`runCronTick` runs the handler inline, never as a relay work-item) — unfenced, the live relay would
 * find no worker for the cron name and DLQ every tick's arbiter row.
 */
export async function enqueueCronTick(
  db: Db,
  jobName: string,
  bucket: Date,
): Promise<boolean> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO "_outbox" (id, aggregate_type, aggregate_id, topic, payload, kind, scheduled_time, processed_at)
       VALUES ($1, '_cron', $2, $2, '{}'::jsonb, 'queue', $3, now())
       ON CONFLICT (topic, scheduled_time, md5(payload::text)) WHERE kind = 'queue' AND scheduled_time IS NOT NULL DO NOTHING
       RETURNING id`,
    [uuidv7(), jobName, bucket.toISOString()],
  );
  return r.rows.length > 0; // a row came back ⇒ this replica's INSERT won the bucket
}

/** The marker payload a failed-tick record carries. It differs from the arbiter row's `{}`, so the two never
 *  share the `_outbox_cron_once` key — a peer can still claim the bucket the failed replica rolled back. */
const CRON_FAILURE_PAYLOAD = JSON.stringify({ cronTickFailed: true });

/**
 * Record a failed cron tick durably (05-runtime.md §4.1 — scheduled work leaves a queryable row). The claim
 * tx rolls back WITH the handler, taking the arbiter row with it, so without this a failed tick leaves nothing
 * at all. Written on the bare db, born `processed_at = now()` (an observation, never relay work); a fleet
 * failing one bucket accumulates onto the single row. Returns why it could not be written, else `undefined`.
 */
export async function recordCronTickFailure(
  db: Db,
  jobName: string,
  at: Date,
  e: unknown,
): Promise<string | undefined> {
  try {
    await db.query(
      `INSERT INTO "_outbox" (id, aggregate_type, aggregate_id, topic, payload, kind, scheduled_time, processed_at, attempts, last_error, last_error_kind)
         VALUES ($1, '_cron', $2, $2, $3::text::jsonb, 'queue', $4, now(), 1, $5, $6)
         ON CONFLICT (topic, scheduled_time, md5(payload::text)) WHERE kind = 'queue' AND scheduled_time IS NOT NULL
         DO UPDATE SET attempts = "_outbox".attempts + 1, last_error = EXCLUDED.last_error, last_error_kind = EXCLUDED.last_error_kind`,
      [
        uuidv7(),
        jobName,
        CRON_FAILURE_PAYLOAD,
        cronBucket(at).toISOString(),
        String(e),
        errorKind(e),
      ],
    );
    return undefined;
  } catch (writeErr) {
    return String(writeErr); // handed to the caller's alarm — recording a failure must never swallow it
  }
}

/**
 * Run a claimed job's `handler` with a tx-bound system ctx. When `ctxBuild` is given and the db is a
 * Transactor, the handler runs inside ONE tx bound to that db, so its `ctx.data` writes commit-or-roll-back
 * atomically with no partial row on throw. Absent `ctxBuild`, the handler runs with `undefined` on the bare db.
 */
export async function runJobHandler(
  db: Db,
  job: AnyJob,
  ctxBuild?: JobCtxFactory,
): Promise<void> {
  if (ctxBuild && isTransactor(db)) {
    await db.transaction((tx) => job.handler(ctxBuild(tx)));
    return;
  }
  if (
    ctxBuild === undefined &&
    (job as { readonly resources?: unknown }).resources !== undefined
  ) {
    // A typed job's handler dereferences `ctx.data` on its first line. Reaching here means the scheduler was
    // built without an app, so the ctx it would need does not exist — say so instead of handing it
    // `undefined` and letting the job read as a TypeError, or (before the type narrowed) as a silent no-op.
    throw new Error(
      `scheduler/job-ctx-required: job '${job.name}' declares resources, so its handler needs the db-bound ctx — this scheduler was built without an app and has none to give it`,
    );
  }
  await job.handler(ctxBuild ? ctxBuild(db) : undefined);
}

/**
 * The cron-exactly-once tick: enqueues the quantized bucket and runs the handler only if this replica
 * claimed it, returning whether it ran. The durable `_outbox` row is the arbiter (an advisory lock would
 * leave no trace). `ctxBuild` makes the claimed handler react-and-write through the framework inside one tx.
 */
export async function runCronTick(
  db: Db,
  job: AnyJob,
  at: Date = new Date(),
  ctxBuild?: JobCtxFactory,
): Promise<boolean> {
  const bucket = cronBucket(at);
  // folds claim + handler into ONE tx so a thrown/crashed handler rolls back the claim — a peer blocked on
  // the uncommitted unique key then takes over, instead of the bucket staying claimed-but-unexecuted forever.
  if (ctxBuild && isTransactor(db)) {
    return db.transaction(async (tx) => {
      const claimed = await enqueueCronTick(tx, job.name, bucket);
      if (claimed) await job.handler(ctxBuild(tx));
      return claimed;
    });
  }
  // bare db / no ctx (a feature-auto job self-provisions its ctx; a non-Transactor db) — the two-step floor.
  const claimed = await enqueueCronTick(db, job.name, bucket);
  if (claimed) await runJobHandler(db, job, ctxBuild);
  return claimed;
}

// roster/engine extracted into cohesive submodules, re-exported so importers stay stable.
