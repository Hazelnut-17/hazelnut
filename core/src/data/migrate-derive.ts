// Barrel re-exports keep import sites stable.
import type { App } from "../core/app.ts";
import {
  PASSWORD_LOGIN_THROTTLE_DDL,
  PASSWORD_REFRESH_DDL,
} from "../features/password-auth.ts";
import { SCHEDULE_QUOTA_DDL } from "../runtime/outbox.ts";
import type { Db } from "./db.ts";
import { ddlColumnNames } from "./ddl-parse.ts";
import { topoSortModels } from "./migrate-apply.ts";
import {
  deriveTreeDDL,
  taskProgressTableDDL,
  tasksTableDDL,
  temporalNoOverlap,
  workflowJournalDDL,
  workflowProgressDDL,
} from "./schema.ts";
import { readModelDDL } from "../features/readmodel.ts"; // read-model projection DDL — mirrored onto raw/reset so generate/reset/parity see it, not just applySchema

/** The derived plan for a vector model/dimension change. `addColumns` mints the side-by-side `_v2`
 *  column plus shadow columns (the additive expand step); `drops` stays empty (contract happens later,
 *  at cut-over); `destructive` is true only if the plan would drop/re-type a live column — the safe-DDL
 *  gate refuses that, and this derivation never produces it. */
export interface VectorMigration {
  readonly addColumns: readonly string[];
  readonly drops: readonly string[];
  readonly destructive: boolean;
  readonly v2Field: string; // the minted side-by-side column the backfill re-embeds into
}

/**
 * Derives the additive expand step of a vector dims/model change: mints the side-by-side `<field>_v2` column
 * (typed by the new dims) plus shadow columns, as `ADD COLUMN IF NOT EXISTS` statements — never drops or
 * re-types the existing column, so the safe-DDL gate passes. RED revert: an in-place `ALTER COLUMN … TYPE`
 * here flips `destructive` true, reproducing the data loss this prevents.
 */
export function deriveVectorMigration(
  table: string,
  field: string,
  newDims: number,
): VectorMigration {
  // import the same vector type/opclass derivation the DDL uses (one source — no drift between create + migrate).
  const v2 = `${field}_v2`;
  const colType = newDims <= 2000
    ? `vector(${newDims})`
    : `halfvec(${newDims})`;
  const addColumns = [
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS "${v2}" ${colType}`,
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS "${v2}_embedded_at" timestamptz`,
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS "${v2}_source_hash" text`,
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS "${v2}_model" text`,
  ];
  return { addColumns, drops: [], destructive: false, v2Field: v2 };
}

/** One pending schema change the next apply would run, classified by safety (cli/migrate.md preview). `add`
 *  is the safe additive class (a declared column absent from the live DB); `drop` is the destructive class (a
 *  live column absent from the declarations — an irreversible data-removing change a prod apply must flag). */
export interface PendingChange {
  readonly kind: "add" | "drop";
  readonly resource: string;
  readonly column: string;
  readonly destructive: boolean;
  // multi-version.md §8/§9 anti-bloat lock: set on a `drop` when a live `defineVersion` still lists this
  // column in `fields`. Names the blocking version; `migrate check` fails until that version sunsets.
  readonly blockedBy?: string;
}

/**
 * `pendingChanges(db, app)` — the preview schema-diff floor (cli/migrate.md interface): a non-mutating
 * `information_schema` read per resource, classifying each change `add` (declared, not live — safe) or
 * `drop` (live, not declared — destructive, irreversible). Row-move counts stay the expand-contract ceiling
 *, deferred. Returns changes in stable (resource, column) order.
 */
export async function pendingChanges(
  db: Db,
  app: App,
): Promise<PendingChange[]> {
  const out: PendingChange[] = [];
  for (const m of app.model) {
    const r = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND table_schema = $2`,
      [m.name, m.pgSchema],
    );
    const live = new Set(r.rows.map((x) => x.column_name));
    const declared = ddlColumnNames(m.ddl);
    // declared but absent from the live DB → a pending add (safe / additive)
    for (const col of [...declared].sort()) {
      if (!live.has(col)) {
        out.push({
          kind: "add",
          resource: m.name,
          column: col,
          destructive: false,
        });
      }
    }
    // live but the DDL would not create it → a pending drop candidate (destructive / irreversible)
    for (const col of [...live].sort()) {
      if (declared.has(col)) continue;
      // multi-version.md §9 anti-bloat lock: the lock follows declaration, not serve state — a past-sunset
      // version still holds its lock. Reclaim trigger is removing the version's `defineVersion`, not the calendar.
      const keptBy = (app.versions ?? []).find((v) =>
        v.resource === m.name && (v.fields ?? []).includes(col)
      );
      out.push({
        kind: "drop",
        resource: m.name,
        column: col,
        destructive: true,
        ...(keptBy ? { blockedBy: keptBy.version } : {}),
      });
    }
  }
  return out;
}

/** `fieldLiveBlocked(changes)` — the pending drops a live version still keeps alive (`blockedBy` set): the
 *  anti-bloat lock (multi-version.md §9) `migrate check` fails on, so such a column is never silently dropped. */
export function fieldLiveBlocked(
  changes: readonly PendingChange[],
): PendingChange[] {
  return changes.filter((c) => c.kind === "drop" && c.blockedBy !== undefined);
}

/**
 * The nine framework `_*` tables' CREATE DDL (cli/migrate.md §framework-tables), the same shapes
 * `applySchema` materializes, so `generate` and `reset` re-derive an identical schema. No `IF NOT EXISTS`
 * — the live apply path adds that guard; this feeds the safe-ddl lint as fresh CREATEs. `_audit` is listed
 * first so a reset that preserves it can scope by position.
 */
export function frameworkTableDDL(): string[] {
  return [
    `CREATE TABLE "_audit" (
       id text PRIMARY KEY, module text NOT NULL DEFAULT 'app', resource text NOT NULL, row_id text NOT NULL, op text NOT NULL,
       actor_type text, actor_id text, on_behalf_of jsonb, diff jsonb, snapshot jsonb, scope text, origin text,
       at timestamptz NOT NULL DEFAULT now())`,
    `CREATE TABLE "_seq_counters" (resource text NOT NULL, scope_key text NOT NULL DEFAULT '', period_key text NOT NULL DEFAULT '', val bigint NOT NULL DEFAULT 0, PRIMARY KEY (resource, scope_key, period_key))`,
    `CREATE TABLE "_idempotency" (key text PRIMARY KEY, result jsonb, created_at timestamptz NOT NULL DEFAULT now(), locked_at timestamptz NOT NULL DEFAULT now())`,
    `CREATE TABLE "_outbox" (
       id text PRIMARY KEY, seq bigserial, aggregate_type text NOT NULL, aggregate_id text NOT NULL,
       topic text NOT NULL, payload jsonb NOT NULL, kind text NOT NULL DEFAULT 'event',
       trace_context jsonb, scope text, schema_version integer NOT NULL DEFAULT 1, scheduled_time timestamptz,
       attempts integer NOT NULL DEFAULT 0, next_retry_at timestamptz NOT NULL DEFAULT now(),
       created_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz,
       last_error text, last_error_kind text,
       _fw_schema_version integer NOT NULL DEFAULT 1)`,
    // Keyed on md5(payload::text) too, so a distinct-payload `ctx.schedule` one-shot at the same (topic, minute)
    // bucket isn't silently collapsed; a cron tick's payload is the constant '{}' so its dedup is unaffected.
    `CREATE UNIQUE INDEX "_outbox_cron_once" ON "_outbox" (topic, scheduled_time, md5(payload::text)) WHERE kind = 'queue' AND scheduled_time IS NOT NULL`,
    // the drain poll's partition-aware head-cursor index (05-runtime.md §per-aggregate-ordering — partition-blind
    // `(next_retry_at)` alone won't serve the per-aggregate `NOT EXISTS` head-cursor); partial = live backlog only
    `CREATE INDEX "_outbox_drain" ON "_outbox" (aggregate_type, aggregate_id, seq) WHERE processed_at IS NULL`,
    // composite `(consumer, msg_id)` PK — the per-consumer effectively-once fence (05-runtime.md §5.1)
    `CREATE TABLE "_processed" (msg_id text NOT NULL, consumer text NOT NULL DEFAULT '_relay', processed_at timestamptz NOT NULL DEFAULT now(), _fw_schema_version integer NOT NULL DEFAULT 1, PRIMARY KEY (consumer, msg_id))`,
    // per-(consumer, msg) retry counter — gates each consumer's `maxAttempts` against its own accrued
    // attempts, not the shared `_outbox.attempts` (a flaky sibling would burn that). Internal relay bookkeeping.
    `CREATE TABLE "_outbox_retry" (msg_id text NOT NULL, consumer text NOT NULL, attempts integer NOT NULL DEFAULT 0, PRIMARY KEY (consumer, msg_id))`,
    // per-actor rate-limit counter — the born-on containment floor's shared budget row. Internal bookkeeping.
    `CREATE TABLE "_rate_limit" (key text PRIMARY KEY, count int NOT NULL, window_start double precision NOT NULL, window_sec double precision NOT NULL DEFAULT 0)`,
    // operator levers, read per drain cycle / per rate-limit window (05-runtime.md §ops-levers). The CHECK is
    // load-bearing, not decoration: it is what stops a hand-written lever row from meaning nothing.
    `CREATE TABLE "_ops_control" (
       lever text NOT NULL, key text NOT NULL DEFAULT '', value double precision, reason text,
       set_at timestamptz NOT NULL DEFAULT now(),
       PRIMARY KEY (lever, key),
       CONSTRAINT "_ops_control_lever_shape" CHECK (
         (lever = 'relay-drain' AND key = '' AND value IS NULL)
         OR (lever = 'rate-limit' AND value IS NOT NULL AND value > 0)))`,
    // the DLQ carries the full `_outbox` column set + dead_at + final_error_kind (05-runtime.md §5.1 "same shape")
    `CREATE TABLE "_outbox_dead" (
       id text PRIMARY KEY, aggregate_type text, aggregate_id text, topic text, payload jsonb, kind text,
       trace_context jsonb, scope text, schema_version integer, attempts integer,
       error text, final_error_kind text, dead_at timestamptz NOT NULL DEFAULT now(),
       _fw_schema_version integer NOT NULL DEFAULT 1)`,
  ];
}

/**
 * schema-from-declarations (cli/migrate.md "the hardest reason the shell must exist"): the full ordered DDL
 * the framework derives from the Zod declarations — the exact statements `migrate generate` feeds drizzle-kit
 * and `reset` pushes. Composed, never codegen-to-disk. Order mirrors `applySchema`: CREATE SCHEMA, framework
 * `_*` tables, topo-sorted resource tables (+ sidecars), then junctions.
 */
export function deriveSchemaSql(app: App): string[] {
  const out: string[] = [];
  for (const s of app.schemas) {
    if (s !== "public") out.push(`CREATE SCHEMA "${s}"`);
  }
  out.push(...frameworkTableDDL());
  if (app.workflows?.length) {
    out.push(workflowJournalDDL(), workflowProgressDDL()); // feature-gated: journal + out-of-band failure progress (05-runtime.md §workflow)
  }
  if (app.tasks?.length) out.push(tasksTableDDL(), taskProgressTableDDL()); // feature-gated `_*` tables (async-task status + live progress; 05-runtime.md §task)
  if (app.model.some((m) => m.passwords.length > 0)) { // feature-gated password-auth tables, only when a resource uses password()
    out.push(PASSWORD_REFRESH_DDL); // revocable refresh tokens
    out.push(PASSWORD_LOGIN_THROTTLE_DDL); // per-identifier pre-auth login throttle
  }
  if (app.schedulingCap != null) out.push(SCHEDULE_QUOTA_DDL); // feature-gated (default-on); must mirror applySchema or reset/lint-baseline drops it
  // feature-gated read-model projection tables (05-runtime.md §readmodel) — mirrors applySchema so generate/
  // reset/parity all see them; an applySchema-only wire left prod read-model apps with no table.
  for (const rm of app.readModels ?? []) out.push(readModelDDL(rm, rm.scoped)); // rm.scoped stamped by composeReadModelScopes
  // btree_gist before any table that carries a temporal no-overlap EXCLUDE (mirrors applySchema)
  if (app.model.some((m) => temporalNoOverlap(m.features.temporal))) {
    out.push(`CREATE EXTENSION IF NOT EXISTS btree_gist`);
  }
  for (const m of topoSortModels(app.model)) {
    out.push(m.ddl);
    if (m.i18nDdl) out.push(m.i18nDdl);
    if (m.features.tree && m.features.treeClosure) {
      out.push(deriveTreeDDL(m.name, m.pgSchema));
    }
  }
  for (const j of app.junctions) out.push(j.ddl);
  return out;
}

/** The non-audit framework tables a dev reset drops (cli/migrate.md §reset step 3) — the single roster
 *  both reset reads; every `_*` framework table except `_audit` (WORM, preserved unless `--include-audit`).
 *  Feature-gated tables drop unconditionally too (each create is `IF NOT EXISTS`), so a stale leftover
 *  journal never replays steps. */
export const NON_AUDIT_FRAMEWORK_TABLES: readonly string[] = [
  "_outbox",
  "_outbox_dead",
  "_processed",
  "_outbox_retry",
  "_rate_limit",
  "_ops_control", // operator levers — a dev reset clears a stale hold/cap with the rest of the runtime state
  "_idempotency",
  "_seq_counters",
  // feature-gated framework tables — created only when the app opts in, but reset-dropped unconditionally
  // (IF EXISTS) so a dev re-sync never orphans their stale state:
  "_workflow_journal", // durable-workflow step journal (schema.ts workflowJournalDDL; create migrate.ts when app.workflows)
  "_workflow_progress", // durable-workflow out-of-band failure record (schema.ts workflowProgressDDL; create with the journal)
  "_tasks", // async-task status store (schema.ts tasksTableDDL; create migrate.ts when app.tasks)
  "_task_progress", // async-task live progress (schema.ts taskProgressTableDDL; create migrate.ts when app.tasks)
  "_schedule_quota", // per-agent scheduling-cap counter (outbox.ts SCHEDULE_QUOTA_DDL; create when getSchedulingCap() !== null)
  "_password_refresh", // revocable refresh tokens (password-auth.ts PASSWORD_REFRESH_DDL; create when a resource uses password())
  "_password_login_attempt", // per-identifier pre-auth login throttle (password-auth.ts PASSWORD_LOGIN_THROTTLE_DDL)
];

/**
 * The DROP statements a dev `reset` runs (cli/migrate.md §reset step 3): per-module `DROP SCHEMA …
 * CASCADE`, then `NON_AUDIT_FRAMEWORK_TABLES`, then `__drizzle_migrations`. `_audit` drops only when
 * `includeAudit`. All `IF EXISTS`, idempotent on a crash-mid-reset. `public` itself is never dropped.
 * Pure list — `resetSchema` execs it.
 */
export function resetDropStatements(
  app: App,
  opts: { includeAudit?: boolean } = {},
): string[] {
  const drops: string[] = [];
  // partitioned per-module schema drop — public stays (it holds the framework `_*` set), module schemas go
  for (const s of app.schemas) {
    if (s !== "public") drops.push(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
  }
  // an app on the flat (public) path has its resource tables in public — drop them individually (CASCADE
  // carries their i18n/tree sidecars + junctions), since `public` itself is never dropped
  for (const m of app.model) {
    if (m.pgSchema === "public") {
      drops.push(`DROP TABLE IF EXISTS "public"."${m.name}" CASCADE`);
    }
  }
  for (const j of app.junctions) {
    if (j.pgSchema === "public") {
      drops.push(`DROP TABLE IF EXISTS "public"."${j.name}" CASCADE`);
    }
  }
  // read-model projection tables (author-named, public, feature-gated on defineReadModel) — reset-dropped so a
  // renamed/removed read-model never orphans its stale projection table (matches the feature-gated `_*` discipline).
  for (const rm of app.readModels ?? []) {
    drops.push(`DROP TABLE IF EXISTS "${rm.name}" CASCADE`);
  }
  // every non-audit framework table (CASCADE drops dependents); `_audit` stays unless opted-in. Feature-
  // gated entries drop unconditionally, so a reset never orphans stale feature-gated table state.
  for (const t of NON_AUDIT_FRAMEWORK_TABLES) {
    drops.push(`DROP TABLE IF EXISTS "${t}" CASCADE`);
  }
  if (opts.includeAudit) drops.push(`DROP TABLE IF EXISTS "_audit" CASCADE`);
  drops.push(`DROP TABLE IF EXISTS "__drizzle_migrations" CASCADE`);
  return drops;
}
