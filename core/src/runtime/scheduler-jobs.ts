import { isTransactor } from "../data/db.ts";
// Barrel re-exports keep import sites stable.
import { systemActor } from "../authz/auth.ts";
import { tableOf } from "../core/app-define.ts";
import type { App, ResourceModel } from "../core/app.ts";
import type { Db } from "../data/db.ts";
import { NO_CAS, type ReadCtx, recomputeRollup, remove } from "../data/repo.ts";
import { FILE_GC_TOPIC } from "../data/repo-topics.ts";
import { reapOrphanProcessedSql } from "./outbox-relay.ts";
import { enqueue } from "./outbox.ts";
import { taskResultOffloadKeys } from "./tasks.ts";
import { normalizeExpiry } from "../data/schema.ts";
import type { Kms } from "../features/encrypt.ts";
import {
  type AnyJob,
  type JobCtxFactory,
  jobCtxFactory,
  recordCronTickFailure,
  runCronTick,
  runJobHandler,
  type Scheduler,
} from "./scheduler-core.ts";
import { getAlarmSink } from "./alarm.ts";

/**
 * In-memory adapter — the default registry and test substrate; `fire` triggers a job by name. Given
 * `ctxBuild`, runs the handler with a tx-bound system ctx exactly like a claimed cron tick; absent, the
 * handler runs with `undefined` (framework feature-auto jobs build their own ctx).
 */
export function inMemoryScheduler(
  ctxBuild?: JobCtxFactory,
): Scheduler & { fire(name: string, db?: Db): Promise<void> } {
  const jobs: AnyJob[] = [];
  return {
    jobs,
    register(job) {
      jobs.push(job);
    },
    async fire(name, db) {
      const job = jobs.find((j) => j.name === name);
      if (!job) throw new Error(`no job registered as '${name}'`);
      // when a db is handed in (the tx capability the job ctx binds to), run through the same tx-bound
      // dispatch a claimed cron tick uses; otherwise invoke the handler bare (the feature-auto jobs' path).
      if (db) await runJobHandler(db, job, ctxBuild);
      else await job.handler();
    },
  };
}

/**
 * Deno.cron adapter — binds each job to a real cron tick. `Deno.cron` is per-process in-memory, so N
 * replicas fire the same tick N times (05-runtime.md §4.1); the callback routes through `runCronTick`,
 * which enqueues the quantized bucket and runs the handler only on the replica winning the partial-unique claim.
 * `Deno.cron` needs `--unstable-cron`; absent the flag, registration refuses (`scheduler/unstable-cron`).
 */
function refuseCronUnavailable(): never {
  throw new Error(
    'scheduler/unstable-cron: Deno.cron is unavailable (run with --unstable-cron) — feature TTL sweeps + expiry purge would silently no-op. Add --unstable-cron to the serve command (the scaffold does), or declare scheduler: "external" and drive the sweeps from a separate process.',
  );
}

/** `Deno.cron` accepts only `[A-Za-z0-9 _-]` in a name (throws otherwise); maps every other character to
 *  `-` so a `:`-namespaced job identity (`_tasks:ttl-purge`) registers cleanly, injectively. */
export function cronSafeName(name: string): string {
  return name.replace(/[^A-Za-z0-9 _-]/g, "-");
}

/**
 * Run a claimed cron tick; on a handler throw record the failure durably AND raise a structured `AlarmSink`
 * signal. The alarm alone is process-local — the rolled-back claim tx takes the arbiter row with it, so
 * without the record a failed tick is invisible to any later query. Extracted so the failure path is
 * testable without `--unstable-cron`.
 */
export async function runCronTickGuarded(
  db: Db,
  job: AnyJob,
  ctxBuild?: JobCtxFactory,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    return await runCronTick(db, job, now, ctxBuild);
  } catch (e) {
    const unwritten = await recordCronTickFailure(db, job.name, now, e);
    getAlarmSink().raise({
      id: `cron/${job.name}`,
      level: "alarm",
      firing: true,
      detail: `cron job '${job.name}' handler failed: ${
        e instanceof Error ? e.message : String(e)
      }${
        unwritten === undefined
          ? ""
          : ` (durable record unwritten: ${unwritten})`
      }`,
    });
    return false; // the claim tx already rolled back; report "did not run" so a caller never treats a failed tick as done
  }
}

export function denoCronScheduler(db: Db, app?: App, kms?: Kms): Scheduler {
  const jobs: AnyJob[] = [];
  return {
    jobs,
    register(job) {
      jobs.push(job);
      // guard `Deno.cron` (absent without `--unstable-cron`) so an unflagged process never crashes at boot;
      // `jobs` above still records registration regardless of the primitive's availability.
      const cron = (Deno as unknown as {
        cron?: (
          name: string,
          schedule: string,
          handler: () => unknown,
        ) => void;
      }).cron;
      if (typeof cron !== "function") {
        refuseCronUnavailable();
      }
      // thread the App's job-ctx factory into the dispatch so a claimed handler reacts-and-writes
      // through the framework in one tx; absent an App the handler runs with the bare-db / no-ctx floor.
      const ctxBuild = app
        ? jobCtxFactory(app, job.name, kms, job.module ?? "app")
        : undefined;
      // Deno.cron rejects a name with anything outside `[A-Za-z0-9 _-]`; the sanitized name is registered here,
      // while `job.name` elsewhere (dispatch, jobCtx) keeps its readable colon form.
      cron(
        cronSafeName(job.name),
        job.cron,
        () => runCronTickGuarded(db, job, ctxBuild),
      ); // a handler throw raises an AlarmSink signal, never a silent stderr line
    },
  };
}

/** Reclaim rows past their TTL (the read-stack already hides them; this only frees storage). With `softDelete`
 * also on, this is a SOFT-purge (`deleted_at = now()`) rather than a hard `DELETE` (04-features.md §expiry);
 * already soft-deleted rows are skipped (idempotent re-runs).
 */
export async function purgeExpired(
  db: Db,
  model: ResourceModel,
): Promise<number> {
  return purgeViaRemove(db, model);
}

// The model-driven auto-purge: reap every past-TTL row through `remove()` (rollup/audit/onDelete-correct),
// batched in one tx when the db is a Transactor. Skips already soft-deleted rows (idempotent, no double-decrement).
async function purgeViaRemove(db: Db, model: ResourceModel): Promise<number> {
  const scoped = Boolean(model.features.scope);
  const cols = scoped ? `id, scope_key` : `id`;
  const notYetPurged = model.features.softDelete
    ? ` AND deleted_at IS NULL`
    : "";
  const candidates = (await db.query<{ id: string; scope_key?: string }>(
    `SELECT ${cols} FROM ${
      tableOf(model)
    } WHERE expires_at IS NOT NULL AND expires_at <= now()${notYetPurged}`,
  )).rows;
  if (candidates.length === 0) return 0;
  const actor = systemActor("purge-expired");
  const reap = async (tx: Db): Promise<number> => {
    let purged = 0;
    for (const row of candidates) {
      const ctx: ReadCtx = {
        actor,
        scope: scoped ? String(row.scope_key) : "",
      };
      // purgeGuard=true re-asserts `expires_at <= now()` (+ `deleted_at IS NULL`) INSIDE the reap tx, so
      // a row revived/soft-deleted between the (out-of-tx) scan and this reap survives instead of being tombstoned.
      // NO_CAS: the reaper holds no caller version, and the TTL predicate below is the precondition a
      // version would be — an expired row must go whatever concurrent bump it carries.
      const { deleted } = await remove(
        tx,
        model,
        ctx,
        row.id,
        undefined,
        NO_CAS,
        true,
      );
      if (deleted) purged++;
    }
    return purged;
  };
  return isTransactor(db) ? await db.transaction(reap) : await reap(db);
}

/** One feature-auto job the composed app depends on. `run` takes the db at fire time so the roster derives
 *  from the App alone — the same list drives both registration and the boot-choice warn, never drifting. */
export interface FeatureJob {
  readonly name: string;
  readonly cron: string;
  readonly run: (db: Db) => Promise<void>;
}

/**
 * The feature-auto job roster for a composed app — the single source. `expiry` resources get an hourly
 * purge; every framework counter/fence store gets a daily TTL sweep (unswept, these grow without
 * bound: `_processed`, `_password_refresh`, `_password_login_attempt`, etc).
 * Feature-gated sweeps derive under the same predicates migrate.ts uses to create their tables; the
 * `_idempotency`/`_outbox`/`_processed`/`_rate_limit` sweeps are unconditional (born-on tables).
 */
export function schedulerJobsFor(app: App): FeatureJob[] {
  const jobs: FeatureJob[] = [];
  for (const m of app.model) {
    const expiry = normalizeExpiry(
      m.features.expiry as Parameters<typeof normalizeExpiry>[0],
    );
    // `purge:false` = soft expiry (04-features.md §expiry): the row stays filtered forever, never reaped,
    // so no purge job derives. With softDelete also on, the sweep soft-purges to deleted_at.
    if (expiry && expiry.purge) {
      // passes the model (not just table name) so the purge routes each row through `remove()`, inheriting
      // rollup/audit/onDelete; it builds its own system ctx and ignores the dispatch-passed one.
      jobs.push({
        name: `${m.name}:purge-expired`,
        cron: "0 * * * *",
        run: (db) => purgeExpired(db, m).then(() => {}),
      });
    }
  }
  // rollup-resync: a rollup CHILD whose visibility is time-driven (temporal, or soft expiry with `purge:false`)
  // can leave its parent aggregate stale with no write to hook — this job recomputes it periodically instead.
  for (const child of app.model) {
    if (child.rollupTargets.length === 0) continue;
    const exp = normalizeExpiry(
      child.features.expiry as Parameters<typeof normalizeExpiry>[0],
    );
    const timeDriven = child.features.temporal || (exp !== null && !exp.purge); // temporal, or SOFT expiry (no purge to reap+decrement)
    if (!timeDriven) continue;
    jobs.push({
      name: `${child.name}:rollup-resync`,
      cron: "0 * * * *",
      run: async (db) => {
        for (const rt of child.rollupTargets) {
          const parents = await db.query<{ pid: string }>(
            `SELECT DISTINCT "${rt.parentFk}" AS pid FROM ${
              tableOf(child)
            } WHERE "${rt.parentFk}" IS NOT NULL`,
          );
          for (const p of parents.rows) {
            // recompute in a tx per parent so recomputeRollup's owner-row lock holds across the read→write
            // (concurrency floor, same as the write-path recompute); bare-db fallback for a non-Transactor.
            if (isTransactor(db)) {
              await db.transaction((tx) =>
                recomputeRollup(
                  tx,
                  rt.parentTable,
                  rt.column,
                  child,
                  rt.parentFk,
                  String(p.pid),
                  rt.kind,
                  rt.field,
                )
              );
            } else {await recomputeRollup(
                db,
                rt.parentTable,
                rt.column,
                child,
                rt.parentFk,
                String(p.pid),
                rt.kind,
                rt.field,
              );}
          }
        }
      },
    });
  }
  // never sweeps an in-flight claim: reaps only finalized claims (`result` stored) or genuinely abandoned
  // ones (no heartbeat for >1 day) — a live claim's heartbeat keeps `locked_at` fresh.
  jobs.push({
    name: "_idempotency:ttl-purge",
    cron: "0 3 * * *",
    run: async (db) => {
      await db.query(
        `DELETE FROM "_idempotency" WHERE created_at < now() - interval '7 days' AND (result IS NOT NULL OR locked_at < now() - interval '1 day')`,
      );
    },
  });
  jobs.push({
    name: "_outbox:ttl-purge",
    cron: "0 3 * * *",
    run: async (db) => {
      await db.query(
        `DELETE FROM "_outbox" WHERE processed_at IS NOT NULL AND processed_at < now() - interval '7 days'`,
      );
    },
  });
  // `_processed` fence rows are load-bearing only while their message could be redelivered (a live `_outbox`
  // row or `_outbox_dead` corpse); `reapOrphanProcessedSql` is the shared predicate two reapers share, no drift.
  jobs.push({
    name: "_processed:ttl-purge",
    cron: "0 3 * * *",
    run: async (db) => {
      await db.query(reapOrphanProcessedSql("7 days"));
    },
  });
  // sweeps a counter row only after ITS OWN window closes (`window_start + window_sec < now`), never a fixed
  // 24h horizon — a >24h window (weekly quota, extended lockout) would otherwise be deleted live.
  jobs.push({
    name: "_rate_limit:ttl-purge",
    cron: "0 3 * * *",
    run: async (db) => {
      await db.query(
        `DELETE FROM "_rate_limit" WHERE window_start + window_sec < extract(epoch from now())`,
      );
    },
  });
  // password-auth recipe stores — gated on the SAME predicate migrate.ts creates their tables under.
  if (app.model.some((m) => m.passwords.length > 0)) {
    // a refresh token is dead once revoked (rotation) or expired; the 7-day grace keeps the recent trail
    // inspectable (revocation time is not stored, so the revoked arm ages on created_at).
    jobs.push({
      name: "_password_refresh:ttl-purge",
      cron: "0 3 * * *",
      run: async (db) => {
        await db.query(
          `DELETE FROM "_password_refresh" WHERE (revoked AND created_at < now() - interval '7 days') OR expires_at < now() - interval '7 days'`,
        );
      },
    });
    // per-identifier login-throttle counters (epoch-seconds windows, same shape as _rate_limit) — the sweep is
    // what bounds an identifier-spraying attacker's ability to grow the table without bound.
    jobs.push({
      name: "_password_login_attempt:ttl-purge",
      cron: "0 3 * * *",
      run: async (db) => {
        await db.query(
          `DELETE FROM "_password_login_attempt" WHERE window_start + window_sec < extract(epoch from now())`,
        );
      },
    }); // sweep only after this row's own window closed
  }
  // async-task retention (05-runtime.md §task): reaps terminal (`succeeded`/`cancelled`) `_tasks` past a
  // 7-day grace, enqueuing `_file_gc` in the same tx for any offloaded `result` so no off-box object orphans.
  if (app.tasks?.length) {
    jobs.push({
      name: "_tasks:ttl-purge",
      cron: "0 3 * * *",
      run: async (db) => {
        const sweep = async (tx: Db): Promise<void> => {
          const { rows } = await tx.query<{ result: unknown }>(
            `DELETE FROM "_tasks" WHERE status IN ('succeeded', 'cancelled') AND completed_at < now() - interval '7 days' RETURNING result`,
          );
          const keys = taskResultOffloadKeys(rows.map((r) => r.result));
          if (keys.length > 0) await enqueue(tx, FILE_GC_TOPIC, { keys }); // same-tx ⇒ the gc intent commits iff the purge commits
          await tx.query(
            `DELETE FROM "_task_progress" WHERE NOT EXISTS (SELECT 1 FROM "_tasks" t WHERE t.id = "_task_progress".task_id)`,
          );
        };
        if (isTransactor(db)) await db.transaction((tx) => sweep(tx));
        else await sweep(db);
      },
    });
  }
  // per-agent scheduling-cap counter TTL sweep — derived whenever the app carries a cap (the born-on floor,
  // `app.schedulingCap`; `null` only when opted out) — the same predicate as `migrate.ts`'s table create.
  if (app.schedulingCap != null) {
    jobs.push({
      name: "_schedule_quota:ttl-purge",
      cron: "0 3 * * *",
      run: async (db) => {
        await db.query(
          `DELETE FROM "_schedule_quota" WHERE window_start + window_sec < extract(epoch from now())`,
        );
      },
    }); // sweep only after this row's own window closed
  }
  return jobs;
}

/** Register every feature-auto job for the composed app — the author writes nothing — PLUS each declared
 *  `app.jobs` entry (the same `scheduler.register` call a manual serve-boot registration would make).
 *  Consumes the SAME `schedulerJobsFor` roster the boot-choice warn reads, binding each feature job's `run`
 *  to this deployment's db. `scheduler.register` remains a working escape for tests that inject a job not
 *  listed on `AppConfig.jobs`. */
export function registerFeatureJobs(
  scheduler: Scheduler,
  app: App,
  db: Db,
): void {
  for (const j of schedulerJobsFor(app)) {
    scheduler.register({
      name: j.name,
      cron: j.cron,
      handler: () => j.run(db),
    });
  }
  for (const j of app.jobs ?? []) {
    scheduler.register(j);
  }
}

/**
 * The live cron composition: registers the `schedulerJobsFor` roster (feature TTL sweeps + `expiry` purges)
 * and every `app.jobs` entry on a scheduler — default `denoCronScheduler`. Called either by
 * `createApp(..., { scheduler: "in-process" })` or directly by a separate scheduler process
 * (`scheduler: "external"`). Never fired implicitly: registration is an explicit boot choice, injectable
 * (`inMemoryScheduler()` in tests) so `Deno.cron` stays untouched. Each replica registers its own
 * in-process cron; `runCronTick`'s partial-unique claim keeps ticks leaderless.
 */
export function startFeatureScheduler(
  app: App,
  db: Db,
  scheduler?: Scheduler,
): Scheduler {
  const s = scheduler ?? denoCronScheduler(db, app);
  registerFeatureJobs(s, app, db);
  return s;
}
