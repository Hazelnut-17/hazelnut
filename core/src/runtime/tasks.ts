import type { z } from "zod";
import type { App } from "../core/app.ts";
import type { OnlyKnownKeys } from "../core/config.ts";
import { uuidv7 } from "../core/id.ts";
import { err, errorKind, ok, type Result } from "../core/result.ts";
import type { Db } from "../data/db.ts";
import { strictify } from "../data/schema.ts";
import type { StorageDriver } from "../data/storage.ts";
import { loudNameDoor } from "../core/ctx-core.ts";
import { FILE_GC_TOPIC } from "../data/repo-topics.ts";
import {
  type BackpressureState,
  type DeliveredMsg,
  enqueue,
} from "./outbox.ts";
import { type EmitOrigin, emitStamped } from "../core/ctx-core.ts";
import type { ConsumerCtx, Worker } from "./events.ts";

/**
 * `defineTask` (05-runtime.md §task) — typed async-operation primitive: submit `input` → get a `taskId` →
 * poll `{status, result?, error?}`. Thin derivation over the outbox/relay substrate: submit writes a `_tasks`
 * row and enqueues the drain message in the caller's tx (exists iff the op commits); the run is a
 * `_task:<name>` worker (re-runs on crash, at-least-once) whose throw propagates to the outbox's retry/DLQ
 * (`failed` derives from `_outbox_dead`); write atomicity within the run is its own concern, so it must be idempotent.
 */
export interface TaskDecl<I = unknown, R = unknown> {
  readonly name: string;
  /** Owning module for `ctx.data` (05-runtime.md §ctx). Absent → the flat `"app"` module. */
  readonly module?: string;
  readonly input: z.ZodType<I>;
  run(input: I, ctx: TaskCtx): Promise<R>;
  /** Result contract, if declared — strict-parsed before it is stored as the poll `result` jsonb. */
  readonly result?: z.ZodType<R>;
  /** Per-task relay retry budget (05-runtime.md §relay-mode) — overrides the relay global `maxAttempts`. */
  readonly maxAttempts?: number;
}

/** The ctx a task's `run` receives — the same surface a worker gets, plus `taskId`, `idempotencyKey` (pass to
 *  an external effect so a retry dedups at the provider), `progress()` (out-of-band write so a poller sees it
 *  mid-run), and `cancelled()` — poll it in a long loop and stop cooperatively when it turns true. */
export type TaskCtx = ConsumerCtx & {
  taskId: string;
  idempotencyKey: string;
  progress(fraction: number, message?: string): Promise<void>;
  cancelled(): Promise<boolean>;
};

// ── large-result → storage (05-runtime.md §task) ─────────────────────────────────────────────────────────
// A `succeeded` result whose serialized bytes exceed the threshold offloads to the boot-bound `StorageDriver`
// (the driver `file()` rides, threaded as `ctx.storage`); `_tasks.result` then keeps only the single-key marker
// `{"$hzStorage": <key>}` and the poll answers a presigned `resultUrl` instead of the inline `result`. No driver
// bound ⇒ results stay inline at any size (storage is optional, never a boot obligation).

/** The reserved single-key marker `_tasks.result` carries for an offloaded result. A genuine result carrying
 *  this key is refused at store time (the poll could not disambiguate it from the marker). */
export const TASK_RESULT_STORAGE_KEY = "$hzStorage";
/** Offload threshold default, bytes of serialized result JSON. Override via
 *  `createApp({ taskResults: { storageThreshold } })`. */
export const DEFAULT_TASK_RESULT_STORAGE_THRESHOLD = 256 * 1024;
/** TTL of the presigned `resultUrl` the poll mints (matches the file-grant default, serve-helpers.ts). */
export const TASK_RESULT_URL_TTL_SEC = 300;

/** The storage key an offloaded result lives under — deterministic per task, so a retry re-puts the same key
 *  (at most one object per task regardless of attempts; taskId is a uuid so this is traversal-safe). */
export function taskResultStorageKey(taskId: string): string {
  return `_tasks/${taskId}/result.json`;
}

/** Read the offload marker off a stored `_tasks.result` value — the storage key when it is exactly the
 *  single-key `{"$hzStorage": <key>}` object, else `null` (an inline result). */
export function taskResultOffloadKey(result: unknown): string | null {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return null;
  }
  const rec = result as Record<string, unknown>;
  const v = rec[TASK_RESULT_STORAGE_KEY];
  return typeof v === "string" && Object.keys(rec).length === 1 ? v : null;
}

/** Offload keys from a batch of raw `_tasks.result` column values — each is driver-normalized first (postgres.js
 *  `sql.unsafe` returns jsonb as a string; PGlite as a parsed value) then marker-extracted. */
export function taskResultOffloadKeys(results: readonly unknown[]): string[] {
  return results.map((v) => taskResultOffloadKey(jsonCol(v))).filter((
    k,
  ): k is string => k !== null);
}

/** Write task progress out-of-band, on the relay's base connection (`ctx.baseDb`) not the worker tx, so it
 *  autocommits and a poller sees it before the run's tx commits. Writes the separate `_task_progress` row —
 *  never the locked `_tasks` row, which would block. No base connection ⇒ no-op rather than deadlock. */
async function writeProgress(
  baseDb: Db | undefined,
  taskId: string,
  fraction: number,
  message?: string,
): Promise<void> {
  if (!baseDb) return;
  const clamped = Math.max(0, Math.min(1, fraction));
  await baseDb.query(
    `INSERT INTO "_task_progress" (task_id, progress, message, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (task_id) DO UPDATE SET progress = $2, message = $3, updated_at = now()`,
    [taskId, clamped, message ?? null],
  );
}

/** Record a run's final failure out-of-band (`_task_progress`, on the base connection) so the `failed` status +
 *  reason survive the worker-tx rollback the re-throw triggers. No base connection ⇒ the poll falls back to the
 *  DLQ-derived `failed`. */
async function writeFailure(
  baseDb: Db | undefined,
  taskId: string,
  e: unknown,
): Promise<void> {
  if (!baseDb) return;
  await baseDb.query(
    `INSERT INTO "_task_progress" (task_id, error, error_kind, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (task_id) DO UPDATE SET error = $2, error_kind = $3, updated_at = now()`,
    [taskId, e instanceof Error ? e.message : String(e), errorKind(e)],
  );
}

/** Request cooperative cancellation — set `cancel_requested` on the task's `_task_progress` row, never the
 *  locked `_tasks` row, so this never blocks on a running task's claim; the run polls it via `taskCtx.cancelled`. */
export async function cancelTask(
  db: Db,
  taskId: string,
  scope: string,
): Promise<Result<{ cancelling: boolean }>> {
  const found = await db.query(
    `SELECT 1 FROM "_tasks" WHERE id = $1 AND scope_key = $2`,
    [taskId, scope],
  );
  if (found.rows.length === 0) {
    return err("notFound", `task '${taskId}' not found`);
  }
  await db.query(
    `INSERT INTO "_task_progress" (task_id, cancel_requested, updated_at) VALUES ($1, true, now())
       ON CONFLICT (task_id) DO UPDATE SET cancel_requested = true, updated_at = now()`,
    [taskId],
  );
  return ok({ cancelling: true });
}

/** The declaration verb (returns the decl; `createApp({ tasks })` collects it). */
export function defineTask<I, R, D = unknown>(
  decl: TaskDecl<I, R> & OnlyKnownKeys<D, TaskDecl<I, R>>,
): TaskDecl<I, R> {
  return decl;
}

/** The relay topic a task's run drains — the `_` prefix marks a framework topic, never a business event. */
export function taskTopic(name: string): string {
  return `_task:${name}`;
}

/** Read a jsonb column value uniformly across drivers: PGlite parses jsonb to a JS value, postgres.js's
 *  `sql.unsafe` returns it as a raw JSON string. */
function jsonCol(v: unknown): unknown {
  return typeof v === "string" ? JSON.parse(v) : v;
}

/** Read a boolean column uniformly: PGlite gives a JS boolean, postgres.js's `sql.unsafe` may give text `"t"`. */
function boolCol(v: unknown): boolean {
  return v === true || v === "t" || v === "true";
}

/** Build the `Worker` that drains this task's queue — `createApp` appends it to `app.relay.workers`; a
 *  declared task with no worker would fill `_tasks` and never run. */
export function taskWorkerFor(
  task: TaskDecl,
  resultStorageThreshold?: number,
): Worker {
  return {
    topic: taskTopic(task.name),
    name: `task:${task.name}`,
    module: task.module,
    // default no retry — a task is user-submitted; a silent re-run of an import is rarely wanted. Retry is an
    // explicit opt-in with the idempotency contract, so a throw here is a terminal `failed`.
    maxAttempts: task.maxAttempts ?? 1,
    handler: (msg, ctx) =>
      runTask(task, msg, ctx as TaskCtx, resultStorageThreshold),
  };
}

/**
 * Submit a task (05-runtime.md §task) — validate `input`, write the `_tasks` row (`queued`) and enqueue the
 * drain message, both on `db` (the caller's tx) so the task is submitted iff the op commits. The enqueue's
 * `aggregateId` is the `taskId`, so a later DLQ row links back to the task — the seam `pollTask` reads.
 */
export async function submitTask(
  db: Db,
  task: TaskDecl,
  rawInput: unknown,
  origin: EmitOrigin, // the WHOLE origin, never a picked `scope` — the drain row must name who submitted it
  backpressure?: BackpressureState,
): Promise<Result<{ taskId: string }>> {
  const { scope } = origin;
  const parsed = strictify(task.input).safeParse(rawInput);
  if (!parsed.success) {
    return err(
      "validation",
      `task '${task.name}': input failed its declared schema`,
    );
  }
  const taskId = uuidv7();
  // bind pre-stringified JSON as text and parse server-side — a by-OID-serializing driver double-encodes a
  // string bound straight to a jsonb param (outbox-emit.ts `emit` has the full rationale).
  await db.query(
    `INSERT INTO "_tasks" (id, name, status, input, scope_key) VALUES ($1, $2, 'queued', $3::text::jsonb, $4)`,
    [taskId, task.name, JSON.stringify(parsed.data), scope],
  );
  // thread the app's backpressure watermark so a task submit gates on the same
  // `defineConfig({ outbox: { maxReadyBacklog } })`, not the module-global default. `emitStamped`, never the
  // bare `emit`: a dead-lettered task drain that cannot name its actor or its request is unjoinable.
  await emitStamped(db, origin, {
    aggregateType: "_task",
    aggregateId: taskId,
    topic: taskTopic(task.name),
    payload: { taskId },
    kind: "queue",
    scope,
  }, backpressure);
  return ok({ taskId });
}

/**
 * The task-runner (the worker handler). Claim the row `queued`→`running` (a 0-row claim means the task is
 * already running/terminal — a redelivered message is an idempotent skip), re-validate the stored input, run
 * the task, then record the terminal status — all in the worker tx, so it commits with the run's business
 * writes. A return with a cancel requested records `cancelled`; a normal return records `succeeded` + result;
 * a throw records the error out-of-band on the final attempt (it must survive the worker-tx rollback) then
 * re-throws so the outbox applies retry/DLQ.
 */
export async function runTask(
  task: TaskDecl,
  msg: DeliveredMsg,
  ctx: TaskCtx,
  resultStorageThreshold: number = DEFAULT_TASK_RESULT_STORAGE_THRESHOLD,
): Promise<void> {
  const taskId = (msg.payload as { taskId?: string } | undefined)?.taskId ??
    msg.aggregateId;
  const claim = await ctx.query(
    `UPDATE "_tasks" SET status='running', updated_at=now() WHERE id=$1 AND status='queued' RETURNING input`,
    [taskId],
  );
  if (claim.rows.length === 0) return; // already claimed / terminal — a duplicate delivery is a no-op
  const input = task.input.parse(
    jsonCol((claim.rows[0] as { input: unknown }).input),
  );
  const cancelled = async (): Promise<boolean> => {
    const r = await ctx.query(
      `SELECT cancel_requested FROM "_task_progress" WHERE task_id=$1`,
      [taskId],
    );
    return boolCol(
      (r.rows[0] as { cancel_requested?: unknown } | undefined)
        ?.cancel_requested,
    );
  };
  const taskCtx: TaskCtx = {
    ...ctx,
    taskId,
    idempotencyKey: msg.id,
    progress: (f: number, m?: string) =>
      writeProgress(ctx.baseDb, taskId, f, m),
    cancelled,
  };
  try {
    const result = await task.run(input, taskCtx);
    if (await cancelled()) {
      await ctx.query(
        `UPDATE "_tasks" SET status='cancelled', updated_at=now(), completed_at=now() WHERE id=$1`,
        [taskId],
      );
      return;
    }
    const stored = task.result ? task.result.parse(result) : result;
    // a genuine result carrying the `$hzStorage` own-key is indistinguishable from the offload marker at poll
    // time — refuse loud at store, at any size, rather than silently corrupting the poll.
    if (
      typeof stored === "object" && stored !== null && !Array.isArray(stored) &&
      TASK_RESULT_STORAGE_KEY in stored
    ) {
      throw new Error(
        `[hazelnut] task '${task.name}': the result carries the reserved top-level key "${TASK_RESULT_STORAGE_KEY}" (the framework's storage-offload marker) — rename that field; the poll cannot disambiguate it from an offloaded result`,
      );
    }
    const json = JSON.stringify(stored ?? null);
    const bytes = new TextEncoder().encode(json); // byte length, not UTF-16 string length
    // over-threshold + a bound driver ⇒ bytes go off-box under the deterministic per-task key; the row keeps
    // only the marker. A put-then-rollback orphan is bounded by the deterministic key (a retry re-puts the same
    // object) plus the final-failure GC below.
    let resultJson = json;
    if (bytes.byteLength > resultStorageThreshold && ctx.storage) {
      const key = taskResultStorageKey(taskId);
      await ctx.storage.put(key, bytes, { contentType: "application/json" });
      resultJson = JSON.stringify({ [TASK_RESULT_STORAGE_KEY]: key });
    }
    await ctx.query(
      `UPDATE "_tasks" SET status='succeeded', result=$2::text::jsonb, updated_at=now(), completed_at=now() WHERE id=$1`,
      [taskId, resultJson],
    );
  } catch (e) {
    if (msg.attempts + 1 >= (task.maxAttempts ?? 1)) {
      await writeFailure(ctx.baseDb, taskId, e); // final attempt → out-of-band failure record
      // best-effort: a prior attempt may have offloaded the result then rolled back, orphaning the deterministic
      // key (the ttl-purge only sweeps succeeded rows). Enqueue GC out-of-band; swallow so it never masks the error.
      if (ctx.storage && ctx.baseDb) {
        try {
          await enqueue(ctx.baseDb, FILE_GC_TOPIC, {
            keys: [taskResultStorageKey(taskId)],
          });
        } catch {
          /* best-effort — the failure record + DLQ stay authoritative */
        }
      }
    }
    throw e; // let the outbox roll the run's writes back + apply retry/DLQ
  }
}

/** The per-task `ctx.tasks.<name>` surface — `submit(input)` and `cancel(taskId)`, bound to the caller's tx db
 *  + scope. Built from `app.tasks` in `makeCtx`; empty when the app declares no task. */
export interface TaskSurface {
  submit(input: unknown): Promise<Result<{ taskId: string }>>;
  cancel(taskId: string): Promise<Result<{ cancelling: boolean }>>;
}
export function tasksSurface(
  app: App,
  db: Db,
  origin: EmitOrigin,
): Record<string, TaskSurface> {
  const out: Record<string, TaskSurface> = {};
  for (const task of app.tasks ?? []) {
    out[task.name] = {
      submit: (input) => submitTask(db, task, input, origin, app.backpressure),
      cancel: (taskId) => cancelTask(db, taskId, origin.scope),
    };
  }
  return loudNameDoor(out, "tasks", "defineTask");
}

/** The poll shape (`GET /tasks/:id`) — the live status + progress, the result on success, the error on failure, and
 *  a `cancelRequested` flag while a cancel is in flight but the run has not yet stopped. */
export interface TaskStatus {
  readonly status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  readonly progress: number;
  readonly message?: string;
  readonly result?: unknown;
  /** The presigned, TTL-bounded URL of an offloaded result — a `succeeded` task answers `result` (inline) or
   *  `resultUrl` (offloaded), never both. */
  readonly resultUrl?: string;
  readonly error?: { readonly kind: string; readonly message: string };
  readonly cancelRequested?: boolean;
}

/**
 * Poll a task (05-runtime.md §task). Reads the `_tasks` row (scope-guarded) left-joined to `_task_progress` and
 * `_outbox_dead`. `succeeded`/`cancelled` are the worker-tx terminal writes; `failed` prefers the out-of-band
 * `_task_progress.error` and falls back to the DLQ when there was no base connection to write it or the run
 * crashed before recording. A run that has reported progress but whose `running` claim is not yet visible still
 * reads as `running` (from `progress > 0`) rather than `queued`. Returns `null` when no such task in this scope.
 */
export async function pollTask(
  db: Db,
  taskId: string,
  scope: string,
  storage?: StorageDriver,
): Promise<TaskStatus | null> {
  const r = await db.query<
    {
      status: string;
      result: unknown;
      progress: number | null;
      message: string | null;
      cancel_requested: unknown;
      prog_error: string | null;
      prog_kind: string | null;
      dead_error: string | null;
      dead_kind: string | null;
    }
  >(
    `SELECT t.status, t.result, p.progress, p.message, p.cancel_requested, p.error AS prog_error, p.error_kind AS prog_kind, d.error AS dead_error, d.final_error_kind AS dead_kind
       FROM "_tasks" t
       LEFT JOIN "_task_progress" p ON p.task_id = t.id
       LEFT JOIN LATERAL (
         SELECT error, final_error_kind FROM "_outbox_dead"
          WHERE aggregate_id = t.id::text
          ORDER BY dead_at DESC
          LIMIT 1
       ) d ON true
      WHERE t.id = $1 AND t.scope_key = $2`,
    [taskId, scope],
  );
  const row = r.rows[0];
  if (!row) return null;
  const progress = row.progress === null ? 0 : Number(row.progress);
  const message = row.message !== null ? { message: row.message } : {};
  if (row.status === "succeeded") {
    const raw = jsonCol(row.result);
    const key = taskResultOffloadKey(raw);
    if (key !== null) {
      // an offloaded result — answer a presigned URL, never the marker itself. No driver bound here is a
      // misconfiguration (the worker stored through one) — fail loud rather than leak the marker as a result.
      if (!storage) {
        throw new Error(
          `[hazelnut] task ${taskId}: the result is offloaded to storage (key "${key}") but this poll surface has no StorageDriver bound — thread the same boot.storage the worker ran with (createApp(config, { storage }))`,
        );
      }
      return {
        status: "succeeded",
        progress,
        ...message,
        resultUrl: await storage.presignedGet(key, TASK_RESULT_URL_TTL_SEC),
      };
    }
    return { status: "succeeded", progress, ...message, result: raw };
  }
  if (row.status === "cancelled") {
    return { status: "cancelled", progress, ...message };
  }
  const errText = row.prog_error ?? row.dead_error; // first-class out-of-band error, else the DLQ-derived fallback
  if (errText !== null) {
    return {
      status: "failed",
      progress,
      ...message,
      error: {
        kind: (row.prog_kind ?? row.dead_kind) ?? "internal",
        message: errText,
      },
    };
  }
  const live = row.status === "running" || progress > 0 ? "running" : "queued";
  return {
    status: live,
    progress,
    ...message,
    ...(boolCol(row.cancel_requested) ? { cancelRequested: true } : {}),
  };
}
