import { wireJson } from "../core/wire-json.ts";
import { uuidv7 } from "../core/id.ts";
import { err, ok, type Result } from "../core/result.ts";
import { isFrameworkTransactionHandle, isTransactor } from "../data/db.ts";
import { type Actor, isAnonymous, isSystem } from "../authz/auth.ts";
import { lockScheduledSource } from "./scheduled-claim.ts";
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

/**
 * UTC-minute cron slot; one-shot scheduling keeps the exact requested instant. Deno.cron supplies no
 * intended-slot timestamp, so floor the observed minute: a 30–59 second delay stays in that minute.
 * Delays crossing a minute skip to latest; clock skew across a boundary remains an adapter limitation.
 */
export function cronBucket(at: Date): Date {
  return new Date(Math.floor(at.getTime() / 60_000) * 60_000);
}

/**
 * `ctx.schedule(at, job, payload)` — a one-shot scheduled job (05-runtime.md §multi-replica-scheduling), sharing the `_outbox`
 * `scheduled_time` mechanism with recurring cron. Enqueues a `kind:'queue'` row with `next_retry_at` set to
 * the exact requested instant, so the relay drains it only once the time arrives; a `defineWorker` consumes it.
 *
 * Dedups in its scope, keyed `(aggregate_type, topic, scheduled_time, md5(payload), scope)`: a repeat
 * `(job, instant, payload, scope)` returns false after passing the ready-backlog watermark. Distinct instants
 * within one minute are separate schedules. `_schedule` cannot collide with a `_cron` claim. Null and non-null
 * scopes use separate indexes because PostgreSQL unique keys otherwise treat nulls as distinct. Written in the caller's
 * tx. A backdated `at` runs on the next poll (never dropped). Returns
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

/** The handle belongs only to the caller that inserted a new slot; dedup never reveals another owner's id. */
export type ScheduledHandle =
  | { readonly scheduled: true; readonly id: string }
  | { readonly scheduled: false; readonly id: null };

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
  // Validate before touching the database, including the ready-backlog query. This common portable
  // SQL/ISO range includes past dates without imposing an application-specific future horizon.
  if (
    !(at instanceof Date) || !Number.isFinite(at.getTime()) ||
    at.getUTCFullYear() < 1 || at.getUTCFullYear() > 9999
  ) {
    throw Object.assign(
      new Error(
        "schedule/at: expected a finite Date within UTC years 0001–9999",
      ),
      { kind: "validation" as const },
    );
  }
  const instant = at.toISOString();
  // ctx.schedule is a producer door — funnels through the same `guardReadyBacklog` watermark as ctx.emit /
  // ctx.queue.enqueue, throwing kinded `timeout` before any row writes. Cron ticks enqueue via `enqueueCronTick`, exempt.
  await guardReadyBacklog(db, state);
  const scope = opts.scope ?? null;
  const conflict = scope === null
    ? "(aggregate_type, topic, scheduled_time, md5(payload::text)) WHERE kind = 'queue' AND scheduled_time IS NOT NULL AND scope IS NULL"
    : "(aggregate_type, topic, scheduled_time, md5(payload::text), scope) WHERE kind = 'queue' AND scheduled_time IS NOT NULL AND scope IS NOT NULL";
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
      instant,
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
  const result = await scheduleOnceWithId(
    db,
    jobName,
    at,
    payload,
    opts,
    state,
  );
  return result.ok ? ok(result.value.scheduled) : result;
}

/** Same admission, quota and dedup contract as the boolean API, with an opaque durable cancellation id. */
export async function scheduleOnceWithId(
  db: Db,
  jobName: string,
  at: Date,
  payload: unknown = {},
  opts: {
    readonly scope?: string;
    readonly traceContext?: Record<string, unknown>;
    readonly capOpts?: SchedulingCapOpts;
  } = {},
  state?: BackpressureState,
): Promise<Result<ScheduledHandle>> {
  const id = await scheduleOnceInsert(db, jobName, at, payload, {
    scope: opts.scope,
    traceContext: opts.traceContext,
  }, state);
  if (id === null) return ok({ scheduled: false, id: null });
  const reject = await capRejection(opts.capOpts);
  if (reject) {
    // Delete by this insert's id, never by the shared dedup identity.
    await db.query(`DELETE FROM "_outbox" WHERE id = $1`, [id]);
    return reject;
  }
  return ok({ scheduled: true, id });
}

/** Cancel only a still-unclaimed one-shot belonging to this principal and scope. Unknown, foreign,
 * completed and actively claimed ids have the same false result. No shared anonymous owner exists. */
export async function cancelScheduled(
  db: Db,
  id: string,
  origin: { readonly actor: Actor | null; readonly scope: string },
  /** Framework surface factories set this for an already-owned BYO transaction callback. */
  transactionBound = false,
): Promise<Result<{ readonly cancelled: boolean }>> {
  if (isAnonymous(origin.actor) && !isSystem(origin.actor)) {
    return err(
      "forbidden",
      "schedule/cancel-owner: cancellation requires an identified owner or a trusted service context",
    );
  }
  const cancel = async (
    tx: Db,
  ): Promise<Result<{ readonly cancelled: boolean }>> => {
    // One common source lock covers every framework drain, including external consumer names. A
    // committed fallback lease remains a refusal even after expiry: its handler outcome is ambiguous.
    await lockScheduledSource(tx, id, "_schedule");
    const removed = await tx.query<{ id: string }>(
      `DELETE FROM "_outbox" o WHERE o.id = $1 AND o.aggregate_type = '_schedule'
       AND o.kind = 'queue' AND o.processed_at IS NULL AND o.claim_token IS NULL
       AND COALESCE(o.scope, '') = $2
       AND ($3 OR (o.trace_context->'originator'->>'id' = $4 AND o.trace_context->'originator'->>'type' = $5))
       AND NOT EXISTS (SELECT 1 FROM "_processed" p WHERE p.msg_id = o.id)
       AND NOT EXISTS (SELECT 1 FROM "_outbox_retry" r WHERE r.msg_id = o.id AND r.claim_token IS NOT NULL)
       RETURNING o.id`,
      [
        id,
        origin.scope,
        isSystem(origin.actor),
        origin.actor?.id ?? "",
        origin.actor?.type ?? "",
      ],
    );
    if (removed.rows.length !== 0) {
      await tx.query(`DELETE FROM "_outbox_retry" WHERE msg_id = $1`, [id]);
    }
    return ok({ cancelled: removed.rows.length !== 0 });
  };
  if (transactionBound || isFrameworkTransactionHandle(db)) {
    return await cancel(db);
  }
  if (isTransactor(db)) return await db.transaction(cancel);
  return err(
    "internal",
    "schedule/cancel-transaction: cancellation requires a framework transaction handle or a database transaction adapter",
  );
}
