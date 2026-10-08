import { wireJson } from "../core/wire-json.ts";
import { uuidv7 } from "../core/id.ts";
import { ok, type Result } from "../core/result.ts";
import type { Db } from "../data/db.ts";
import {
  type BackpressureState,
  capRejection,
  guardReadyBacklog,
  type SchedulingCapOpts,
} from "./outbox.ts";

/**
 * The one-shot scheduling leaf — `cronBucket` + `scheduleOnce`/`scheduleOnceCapped` live here, off the
 * scheduler↔relay↔ctx runtime ring, so `ctx.schedule` never needs a value import back into `scheduler.ts`.
 * Depends only on the outbox cap-check primitive and `result`/`Db`, never on the scheduler/relay it's scheduled from.
 */

/** Quantize a one-shot scheduled instant (05-runtime.md §multi-replica-scheduling) down to its UTC minute bucket. */
export function cronBucket(at: Date): Date {
  return new Date(
    Date.UTC(
      at.getUTCFullYear(),
      at.getUTCMonth(),
      at.getUTCDate(),
      at.getUTCHours(),
      at.getUTCMinutes(),
    ),
  );
}

/**
 * `ctx.schedule(at, job, payload)` — a one-shot scheduled job (05-runtime.md §multi-replica-scheduling), sharing the `_outbox`
 * `scheduled_time` mechanism with recurring cron. Enqueues a `kind:'queue'` row with `next_retry_at` set to
 * the quantized bucket, so the relay drains it only once the time arrives; a `defineWorker` consumes it.
 *
 * Dedups in its scope, keyed `(topic, scheduled_time, md5(payload), scope)`: a repeat
 * `(job, bucket, payload, scope)` returns false after passing the ready-backlog watermark, but the same work in another scope and a distinct
 * payload at the same `(job, bucket)` are scheduled separately. The null-scope cron arbiter stays a
 * separate index, because PostgreSQL unique keys otherwise treat nulls as distinct. Written in the caller's
 * tx. `at` floors to its minute bucket; a backdated `at` runs on the next poll (never dropped). Returns
 * whether this call won the slot. The global watermark runs before dedup: even an identical retry can throw
 * `timeout`, rolling back its caller's write transaction without changing the existing scheduled row.
 */
export async function scheduleOnce(
  db: Db,
  jobName: string,
  at: Date,
  payload: unknown = {},
  opts: {
    readonly scope?: string;
    /** The identity envelope `ctx.queue` stamps (05-runtime.md §relay) — a scheduled row is as durable as
     *  an emitted one, so a dead letter here names its actor and request too. */
    readonly traceContext?: Record<string, unknown>;
  } = {},
  state?: BackpressureState, // per-app backpressure threaded from ctx.schedule; absent ⇒ the app-less default (emit's global)
): Promise<boolean> {
  return (await scheduleOnceInsert(db, jobName, at, payload, opts, state)) !==
    null;
}

/** Insert one scheduled row and return its private id only when this caller won the dedup slot. */
async function scheduleOnceInsert(
  db: Db,
  jobName: string,
  at: Date,
  payload: unknown,
  opts: {
    readonly scope?: string;
    readonly traceContext?: Record<string, unknown>;
  },
  state: BackpressureState | undefined,
): Promise<string | null> {
  // ctx.schedule is a producer door — funnels through the same `guardReadyBacklog` watermark as ctx.emit /
  // ctx.queue.enqueue, throwing kinded `timeout` before any row writes. Cron ticks enqueue via `enqueueCronTick`, exempt.
  await guardReadyBacklog(db, state);
  const bucket = cronBucket(at);
  const scope = opts.scope ?? null;
  const conflict = scope === null
    ? "(topic, scheduled_time, md5(payload::text)) WHERE kind = 'queue' AND scheduled_time IS NOT NULL AND scope IS NULL"
    : "(topic, scheduled_time, md5(payload::text), scope) WHERE kind = 'queue' AND scheduled_time IS NOT NULL AND scope IS NOT NULL";
  const r = await db.query<{ id: string }>(
    `INSERT INTO "_outbox" (id, aggregate_type, aggregate_id, topic, payload, kind, scope, trace_context, scheduled_time, next_retry_at)
       VALUES ($1, '_schedule', $2, $2, $3::text::jsonb, 'queue', $4, $6::text::jsonb, $5, $5)
       ON CONFLICT ${conflict} DO NOTHING
       RETURNING id`,
    [
      uuidv7(),
      jobName,
      JSON.stringify(wireJson(payload)),
      scope,
      bucket.toISOString(),
      opts.traceContext === undefined
        ? null
        : JSON.stringify(opts.traceContext),
    ],
  );
  return r.rows[0]?.id ?? null; // past the watermark: a row means this caller won; a duplicate changed no scheduled row
}

/**
 * `ctx.schedule(at, job, payload)` with the per-agent scheduling-abuse cap enforced (05-runtime.md §multi-replica-scheduling):
 * first passes the ready-backlog watermark, then claims the dedup slot, then charges the cap only to that winner.
 * A duplicate that reaches dedup returns false and does not
 * spend quota; an over-cap winner is removed before the domain `err("business")` returns.
 * Keyed on `schedulingCapKey`: agent id or a system actor's distinct origin bucket. An exempt actor is not capped. Bounds how many
 * DISTINCT one-shots an agent schedules per window (the cron-once dedup index alone doesn't cap volume).
 * A per-source over-cap returns a business `Result`, rolling the op back like any business reject.
 * The ready-backlog watermark may still throw before admission.
 */
export async function scheduleOnceCapped(
  db: Db,
  jobName: string,
  at: Date,
  payload: unknown = {},
  opts: {
    readonly scope?: string;
    readonly traceContext?: Record<string, unknown>;
    readonly capOpts?: SchedulingCapOpts;
  } = {},
  state?: BackpressureState, // per-app backpressure threaded from ctx.schedule; absent ⇒ the app-less default
): Promise<Result<boolean>> {
  const id = await scheduleOnceInsert(db, jobName, at, payload, {
    scope: opts.scope,
    traceContext: opts.traceContext,
  }, state);
  if (id === null) return ok(false);
  const reject = await capRejection(opts.capOpts);
  if (reject) {
    // Delete by the id minted by THIS insert, never by the dedup key: a concurrent winner must survive.
    await db.query(`DELETE FROM "_outbox" WHERE id = $1`, [id]);
    return reject;
  }
  return ok(true);
}
