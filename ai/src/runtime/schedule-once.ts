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

/** Quantize an instant to its cron fire-bucket (05-runtime.md §4.1), floored to the UTC minute — cron's
 *  finest granularity — so replicas a few hundred ms apart still collide on the same partial-unique-index bucket. */
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
 * `ctx.schedule(at, job, payload)` — a one-shot scheduled job (05-runtime.md §4.1), sharing the `_outbox`
 * `scheduled_time` mechanism with recurring cron. Enqueues a `kind:'queue'` row with `next_retry_at` set to
 * the quantized bucket, so the relay drains it only once the time arrives; a `defineWorker` consumes it.
 *
 * Dedups on the same partial unique index cron-once uses, keyed `(topic, scheduled_time, md5(payload))`: a
 * repeat `(job, bucket, payload)` is a silent no-op, but a distinct payload at the same `(job, bucket)` is
 * scheduled separately. Written in the caller's tx. `at` floors to its minute bucket; a backdated `at` runs
 * on the next poll (never dropped). Returns whether this call won the slot.
 */
export async function scheduleOnce(
  db: Db,
  jobName: string,
  at: Date,
  payload: unknown = {},
  opts: {
    readonly scope?: string;
    /** The identity envelope `ctx.queue` stamps (05-runtime.md §5.1) — a scheduled row is as durable as
     *  an emitted one, so a dead letter here names its actor and request too. */
    readonly traceContext?: Record<string, unknown>;
  } = {},
  state?: BackpressureState, // per-app backpressure threaded from ctx.schedule; absent ⇒ the app-less default (emit's global)
): Promise<boolean> {
  // ctx.schedule is a producer door — funnels through the same `guardReadyBacklog` watermark as ctx.emit /
  // ctx.queue.enqueue, throwing kinded `timeout` before any row writes. Cron ticks enqueue via `enqueueCronTick`, exempt.
  await guardReadyBacklog(db, state);
  const bucket = cronBucket(at);
  const r = await db.query<{ id: string }>(
    `INSERT INTO "_outbox" (id, aggregate_type, aggregate_id, topic, payload, kind, scope, trace_context, scheduled_time, next_retry_at)
       VALUES ($1, '_schedule', $2, $2, $3::text::jsonb, 'queue', $4, $6::text::jsonb, $5, $5)
       ON CONFLICT (topic, scheduled_time, md5(payload::text)) WHERE kind = 'queue' AND scheduled_time IS NOT NULL DO NOTHING
       RETURNING id`,
    [
      uuidv7(),
      jobName,
      JSON.stringify(payload),
      opts.scope ?? null,
      bucket.toISOString(),
      opts.traceContext === undefined
        ? null
        : JSON.stringify(opts.traceContext),
    ],
  );
  return r.rows.length > 0; // a row came back ⇒ this call won the (job, bucket) slot (a duplicate is a no-op)
}

/**
 * `ctx.schedule(at, job, payload)` with the per-agent scheduling-abuse cap enforced (05-runtime.md §4.1):
 * checks the cap BEFORE the insert, rejecting over-cap with a domain `err("business")` and no row written.
 * Keyed on the agent origin (`schedulingCapKey`); a non-agent caller is never capped. Bounds how many
 * DISTINCT one-shots an agent schedules per window (the cron-once dedup index alone doesn't cap volume).
 * Returns a `Result` (not a throw) so a mid-op over-cap rolls the op back like any business reject.
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
  const reject = await capRejection(opts.capOpts);
  if (reject) return reject;
  return ok(
    await scheduleOnce(db, jobName, at, payload, {
      scope: opts.scope,
      traceContext: opts.traceContext,
    }, state),
  );
}
