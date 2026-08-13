import type { App, ResourceModel } from "../core/app.ts";
import {
  PASSWORD_LOGIN_THROTTLE_DDL,
  PASSWORD_REFRESH_DDL,
} from "../features/password-auth.ts";
import { RATE_LIMIT_DDL } from "../features/throttle.ts";
import { OPS_CONTROL_DDL, SCHEDULE_QUOTA_DDL } from "../runtime/outbox.ts";
import type { Db } from "./db.ts";
import {
  deriveTreeDDL,
  taskProgressTableDDL,
  tasksTableDDL,
  temporalNoOverlap,
  workflowJournalDDL,
  workflowProgressDDL,
} from "./schema.ts";
import { readModelDDL } from "../features/readmodel.ts"; // the read-model projection table DDL

/**
 * Orders resources so a referenced (parent) table is created before any table whose inline FK points
 * at it — a DFS post-order topo sort. Self-references are skipped; a cycle is left in place for the
 * deferred ALTER-TABLE-ADD-CONSTRAINT pass (03-api-shape.md §onDelete) rather than looping forever.
 */
export function topoSortModels(
  models: readonly ResourceModel[],
): ResourceModel[] {
  // key by schema.name — a resource name is unique only within its module, so two modules may both
  // hold an "invoice"; keying by bare name would collapse them and drop a table.
  const key = (m: ResourceModel) => `${m.pgSchema}.${m.name}`;
  const byKey = new Map(models.map((m) => [key(m), m]));
  const done = new Set<string>();
  const onPath = new Set<string>();
  const out: ResourceModel[] = [];
  const visit = (m: ResourceModel): void => {
    const k = key(m);
    if (done.has(k) || onPath.has(k)) return; // visited, or a cycle edge — stop
    onPath.add(k);
    for (const ref of Object.values(m.references)) {
      if (ref.external) continue; // refById: an unmodeled by-id target has no in-model table to order against
      const dep = byKey.get(`${m.pgSchema}.${ref.to}`); // intra-module FK target (same schema)
      if (dep && key(dep) !== k) visit(dep);
    }
    if (m.parent) { // a child's table depends on its parent's (the cascade FK)
      const dep = byKey.get(`${m.pgSchema}.${m.parent}`);
      if (dep && key(dep) !== k) visit(dep);
    }
    onPath.delete(k);
    done.add(k);
    out.push(m);
  };
  for (const m of models) visit(m);
  return out;
}

/**
 * The op-level idempotency claim-store (02-dsl.md §idempotency). `locked_at` is the crash-reclaim
 * lease stamp: an in-flight claim whose `locked_at` predates the lease is stale (the claimant crashed
 * before its catch-release ran), so a fresh same-key request reclaims it atomically instead of
 * 409-ing for the ttl window. The sole exported creator — `applySchema` and the real-pg
 * cross-connection tests both call this, so a test can never hand-copy a stale table shape.
 */
export async function ensureIdempotencyTable(db: Db): Promise<void> {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS "_idempotency" (key text PRIMARY KEY, result jsonb, created_at timestamptz NOT NULL DEFAULT now(), locked_at timestamptz NOT NULL DEFAULT now())`,
  );
  await db.exec(
    `ALTER TABLE "_idempotency" ADD COLUMN IF NOT EXISTS locked_at timestamptz NOT NULL DEFAULT now()`,
  );
}

/** Loud-refuse guard for a retired framework-table PK shape: a tolerated legacy PRIMARY KEY silently
 *  degrades semantics (e.g. a single-column `_processed` PK collides two consumers' dedup claims).
 *  No silent re-key ladder — a detected legacy PK refuses with the reset path. */
async function refuseLegacyPk(
  db: Db,
  table: string,
  legacyPk: string,
  canonicalPk: string,
  degrade: string,
): Promise<void> {
  const r = await db.query<{ cols: string | null }>(
    `SELECT string_agg(a.attname, ',' ORDER BY array_position(c.conkey, a.attnum)) AS cols
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
      WHERE c.conrelid = to_regclass($1) AND c.contype = 'p'`,
    [`"${table}"`],
  );
  const cols = r.rows[0]?.cols ?? null; // null ⇒ the table does not exist yet — CREATE mints the canonical shape
  if (cols === legacyPk) {
    throw new Error(
      `migrate/legacy-shape: "${table}" carries the retired (${legacyPk}) primary key — the canonical key is (${canonicalPk}). ${degrade} Refusing to apply over the legacy shape: reset the dev database ('hazelnut migrate <app> reset') or re-key the table by hand, then re-apply.`,
    );
  }
}

/** Materializes the derived DDL idempotently — the schema is a pure function of the declarations.
 *  `checkBaseline` (`migrate/baseline-fresh`) asserts live schema still matches and reports drift;
 *  `hazelnut migrate` wraps this in the drizzle-kit safety shell. */
export async function applySchema(db: Db, app: App): Promise<void> {
  // shared framework `_audit` table (04-features.md §audit): on_behalf_of is provenance-only (jsonb,
  // not authz); snapshot is the full before/after image, only present when snapshot:true.
  await db.exec(
    `CREATE TABLE IF NOT EXISTS "_audit" (
       id text PRIMARY KEY, module text NOT NULL DEFAULT 'app', resource text NOT NULL, row_id text NOT NULL, op text NOT NULL,
       actor_type text, actor_id text, on_behalf_of jsonb, diff jsonb, snapshot jsonb, scope text, origin text,
       at timestamptz NOT NULL DEFAULT now())`,
  );
  // additive evolution for a pre-existing _audit — the same idempotent ALTER-IF-NOT-EXISTS discipline
  await db.exec(`ALTER TABLE "_audit" ADD COLUMN IF NOT EXISTS diff jsonb`);
  await db.exec(`ALTER TABLE "_audit" ADD COLUMN IF NOT EXISTS origin text`);
  await db.exec(
    `ALTER TABLE "_audit" ADD COLUMN IF NOT EXISTS module text NOT NULL DEFAULT 'app'`,
  );
  await db.exec(
    `ALTER TABLE "_audit" ADD COLUMN IF NOT EXISTS on_behalf_of jsonb`,
  );
  await db.exec(`ALTER TABLE "_audit" ADD COLUMN IF NOT EXISTS snapshot jsonb`);
  await db.exec(`ALTER TABLE "_audit" ADD COLUMN IF NOT EXISTS scope text`);
  // sequence# counter store (04-features.md §sequence#), keyed (resource, scope_key, period_key): the
  // period_key in the PK means a rolled period gets a fresh row while the prior period's is preserved.
  // a retired (resource, scope) 2-column PK is a loud refuse, never a silent in-place re-key
  await refuseLegacyPk(
    db,
    "_seq_counters",
    "resource,scope",
    "resource,scope_key,period_key",
    "Without the period_key in the key, two periods of one series collide and a rolled period cannot reset.",
  );
  await db.exec(
    `CREATE TABLE IF NOT EXISTS "_seq_counters" (resource text NOT NULL, scope_key text NOT NULL DEFAULT '', period_key text NOT NULL DEFAULT '', val bigint NOT NULL DEFAULT 0, PRIMARY KEY (resource, scope_key, period_key))`,
  );
  await ensureIdempotencyTable(db);
  // durable-workflow step journal + out-of-band failure progress (05-runtime.md §workflow) — feature-gated:
  // created only when the app declares a `defineWorkflow`, so a workflow-free app keeps the born-on `_*` tables.
  if (app.workflows?.length) {
    await db.exec(
      workflowJournalDDL().replace(
        "CREATE TABLE",
        "CREATE TABLE IF NOT EXISTS",
      ),
    );
    // upgrade backfill: a journal minted before the lease fence lacks locked_at; now() default makes a
    // pre-existing 'running' row look freshly-leased once — harmless (reclaimed after one lease interval).
    await db.exec(
      `ALTER TABLE "_workflow_journal" ADD COLUMN IF NOT EXISTS locked_at timestamptz NOT NULL DEFAULT now()`,
    );
    await db.exec(
      workflowProgressDDL().replace(
        "CREATE TABLE",
        "CREATE TABLE IF NOT EXISTS",
      ),
    );
  }
  // async-task status store (05-runtime.md §task) — feature-gated: created only when the app declares
  // a `defineTask`, so a task-free app keeps the core `_*` tables.
  if (app.tasks?.length) {
    await db.exec(
      tasksTableDDL().replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS"),
    );
    await db.exec(
      taskProgressTableDDL().replace(
        "CREATE TABLE",
        "CREATE TABLE IF NOT EXISTS",
      ),
    );
  }
  // read-model projection tables (05-runtime.md §readmodel) — feature-gated (defineReadModel): each
  // table is where `runReadModelMaintain` upserts (source_id PK + data jsonb + scope_key when scoped).
  for (const rm of app.readModels ?? []) {
    // rm.scoped is stamped once by composeReadModelScopes (app.ts) from the source model — reuse it rather
    // than re-deriving by bare name, which is ambiguous across modules.
    await db.exec(
      readModelDDL(rm, rm.scoped).replace(
        "CREATE TABLE",
        "CREATE TABLE IF NOT EXISTS",
      ),
    );
    // scope-toggle backfill: a source that gained scope:true after the table already existed needs
    // scope_key too — the IF NOT EXISTS above no-ops on an existing table, so ALTER it in explicitly.
    if (rm.scoped) {
      await db.exec(
        `ALTER TABLE "${rm.name}" ADD COLUMN IF NOT EXISTS scope_key text`,
      );
    }
  }
  // password-auth recipe tables (13-authz.md §password-auth-recipe) — feature-gated: created only when a
  // resource uses `password()`, so a password-free app keeps the core `_*` tables.
  if (app.model.some((m) => m.passwords.length > 0)) {
    await db.exec(PASSWORD_REFRESH_DDL);
    await db.exec(PASSWORD_LOGIN_THROTTLE_DDL);
    await db.exec(
      `ALTER TABLE "_password_login_attempt" ADD COLUMN IF NOT EXISTS window_sec double precision NOT NULL DEFAULT 0`,
    ); // upgrade backfill
  }
  // per-agent scheduling-cap counter (05-runtime.md §4.1) — a born-on floor, created whenever the app
  // carries a scheduling cap (defaulted on by createApp; null only via schedulingCap:false).
  if (app.schedulingCap != null) {
    await db.exec(SCHEDULE_QUOTA_DDL);
    await db.exec(
      `ALTER TABLE "_schedule_quota" ADD COLUMN IF NOT EXISTS window_sec double precision NOT NULL DEFAULT 0`,
    ); // upgrade backfill
  }
  // transactional outbox (06-generators.md §6c; columns per 05-runtime.md §5.1). The partial UNIQUE
  // (topic, scheduled_time) WHERE kind='queue' is the cron-exactly-once arbiter — across N replicas
  // firing the same tick, exactly one quantized-bucket INSERT wins; the rest hit ON CONFLICT DO NOTHING.
  await db.exec(
    `CREATE TABLE IF NOT EXISTS "_outbox" (
       id text PRIMARY KEY, seq bigserial, aggregate_type text NOT NULL, aggregate_id text NOT NULL,
       topic text NOT NULL, payload jsonb NOT NULL, kind text NOT NULL DEFAULT 'event',
       trace_context jsonb, scope text, schema_version integer NOT NULL DEFAULT 1, scheduled_time timestamptz,
       attempts integer NOT NULL DEFAULT 0, next_retry_at timestamptz NOT NULL DEFAULT now(),
       created_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz,
       last_error text, last_error_kind text,
       _fw_schema_version integer NOT NULL DEFAULT 1)`,
  );
  // additive evolution for a pre-existing _outbox (the same idempotent ALTER-IF-NOT-EXISTS discipline as _audit.diff)
  await db.exec(
    `ALTER TABLE "_outbox" ADD COLUMN IF NOT EXISTS trace_context jsonb`,
  );
  await db.exec(`ALTER TABLE "_outbox" ADD COLUMN IF NOT EXISTS scope text`);
  await db.exec(
    `ALTER TABLE "_outbox" ADD COLUMN IF NOT EXISTS schema_version integer NOT NULL DEFAULT 1`,
  );
  await db.exec(
    `ALTER TABLE "_outbox" ADD COLUMN IF NOT EXISTS scheduled_time timestamptz`,
  );
  // the retry paths' failure record: a row that backs off carries WHY, so a stuck message is diagnosable
  // from the row itself rather than only from a DLQ corpse it may never reach.
  await db.exec(
    `ALTER TABLE "_outbox" ADD COLUMN IF NOT EXISTS last_error text`,
  );
  await db.exec(
    `ALTER TABLE "_outbox" ADD COLUMN IF NOT EXISTS last_error_kind text`,
  );
  // at-rest table-shape revision (cli/migrate.md §framework-table-evolution; fw-upcast.ts) — distinct from
  // schema_version (the event-payload contract version). Reads walk the upcaster chain to current revision.
  await db.exec(
    `ALTER TABLE "_outbox" ADD COLUMN IF NOT EXISTS _fw_schema_version integer NOT NULL DEFAULT 1`,
  );
  // this partial unique index must exist, or ON CONFLICT DO NOTHING fails open — silent duplicate ticks. Keyed
  // on md5(payload::text) too, so a ctx.schedule one-shot with a distinct payload at the same bucket doesn't
  // collapse; DROP first — CREATE ... IF NOT EXISTS is a no-op on a DB that still holds the old index by name.
  await db.exec(`DROP INDEX IF EXISTS "_outbox_cron_once"`);
  await db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS "_outbox_cron_once" ON "_outbox" (topic, scheduled_time, md5(payload::text)) WHERE kind = 'queue' AND scheduled_time IS NOT NULL`,
  );
  // the drain poll's partition-aware head-cursor index (05-runtime.md §per-aggregate-ordering) — a
  // standalone (next_retry_at) index is partition-blind; the partial predicate keeps it to the live backlog.
  await db.exec(
    `CREATE INDEX IF NOT EXISTS "_outbox_drain" ON "_outbox" (aggregate_type, aggregate_id, seq) WHERE processed_at IS NULL`,
  );
  // effectively-once fence (05-runtime.md §5.1): the composite PK (consumer, msg_id) dedups per consumer,
  // so a partial fan-out failure re-runs only the failed sibling on retry. A retired single-column (msg_id)
  // PK collides two consumers' claims and silently skips one's delivery — a loud refuse, never tolerated.
  await refuseLegacyPk(
    db,
    "_processed",
    "msg_id",
    "consumer,msg_id",
    "On the single-column key a fan-out's second consumer claim collides with the first's and that message is SILENTLY SKIPPED for it.",
  );
  await db.exec(
    `CREATE TABLE IF NOT EXISTS "_processed" (msg_id text NOT NULL, consumer text NOT NULL DEFAULT '_relay', processed_at timestamptz NOT NULL DEFAULT now(), _fw_schema_version integer NOT NULL DEFAULT 1, PRIMARY KEY (consumer, msg_id))`,
  );
  // per-(consumer, msg) retry counter (05-runtime.md §relay-mode): per-consumer maxAttempts must be gated
  // per consumer, else one flaky consumer burns the shared `_outbox.attempts` budget and DLQs a sibling early.
  await db.exec(
    `CREATE TABLE IF NOT EXISTS "_outbox_retry" (msg_id text NOT NULL, consumer text NOT NULL, attempts integer NOT NULL DEFAULT 0, PRIMARY KEY (consumer, msg_id))`,
  );
  // per-actor rate-limit counter: the born-on floor (defaultRateLimitStore) shares one row per actor
  // across N instances — a regenerable counter, not a format-contract table.
  await db.exec(RATE_LIMIT_DDL);
  await db.exec(
    `ALTER TABLE "_rate_limit" ADD COLUMN IF NOT EXISTS window_sec double precision NOT NULL DEFAULT 0`,
  ); // upgrade backfill
  // operator levers (05-runtime.md §ops-levers): the relay drain-hold and the per-key rate cap an operator
  // sets WITHOUT a deploy. Born-on — the drain reads it every cycle, so it must exist before the first drain.
  await db.exec(OPS_CONTROL_DDL);
  // dead-letter (05-runtime.md §5.1): the full `_outbox` column set so a redrive can select the matching
  // upcaster chain and the trace/scope survive a death ("DLQ is observable, not silent").
  await db.exec(
    `CREATE TABLE IF NOT EXISTS "_outbox_dead" (
       id text PRIMARY KEY, aggregate_type text, aggregate_id text, topic text, payload jsonb, kind text,
       trace_context jsonb, scope text, schema_version integer, attempts integer,
       error text, final_error_kind text, dead_at timestamptz NOT NULL DEFAULT now(),
       _fw_schema_version integer NOT NULL DEFAULT 1)`,
  );
  // additive evolution for a pre-existing `_outbox_dead` minted before the full-shape change (carry the
  // redrive-correctness + observability columns forward — same idempotent ALTER-IF-NOT-EXISTS discipline as _outbox)
  await db.exec(
    `ALTER TABLE "_outbox_dead" ADD COLUMN IF NOT EXISTS trace_context jsonb`,
  );
  await db.exec(
    `ALTER TABLE "_outbox_dead" ADD COLUMN IF NOT EXISTS scope text`,
  );
  await db.exec(
    `ALTER TABLE "_outbox_dead" ADD COLUMN IF NOT EXISTS schema_version integer`,
  );
  await db.exec(
    `ALTER TABLE "_outbox_dead" ADD COLUMN IF NOT EXISTS final_error_kind text`,
  );
  await db.exec(
    `ALTER TABLE "_outbox_dead" ADD COLUMN IF NOT EXISTS _fw_schema_version integer NOT NULL DEFAULT 1`,
  );
  await db.exec(
    `ALTER TABLE "_processed" ADD COLUMN IF NOT EXISTS _fw_schema_version integer NOT NULL DEFAULT 1`,
  );
  // pgvector extension (04-features.md §vector; canon floor >= 0.8, substrate-provided): must run before
  // any resource table declaring a vector column, or that column type fails to parse. Vector-model-only.
  if (app.model.some((m) => m.vector)) {
    await db.exec(`CREATE EXTENSION IF NOT EXISTS vector`);
  }
  // btree_gist (04-features.md §temporal migrate): a temporal.noOverlap EXCLUDE constraint needs it. On
  // PGlite the extension must also be loaded at construction, or this CREATE fails loud.
  if (app.model.some((m) => temporalNoOverlap(m.features.temporal))) {
    await db.exec(`CREATE EXTENSION IF NOT EXISTS btree_gist`);
  }
  // one pg schema per module (schema-per-module); public always exists. Framework `_*` tables stay in public.
  for (const s of app.schemas) {
    if (s !== "public") await db.exec(`CREATE SCHEMA IF NOT EXISTS "${s}"`);
  }
  for (const m of topoSortModels(app.model)) {
    await db.exec(m.ddl.replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS"));
    // i18n sidecar — created right after its resource table (which it FK's); the model is the single source
    if (m.i18nDdl) {
      await db.exec(
        m.i18nDdl.replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS"),
      );
    }
    // tree closure table (opt-in via treeClosure)
    if (m.features.tree && m.features.treeClosure) {
      await db.exec(
        deriveTreeDDL(m.name, m.pgSchema).replace(
          "CREATE TABLE",
          "CREATE TABLE IF NOT EXISTS",
        ),
      );
    }
  }
  // junction tables last — they FK both resource tables, which now exist
  for (const j of app.junctions) {
    await db.exec(j.ddl.replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS"));
  }
}

/** The full expected column set a resource's `CREATE TABLE` (m.ddl) declares — framework-minted feature
 *  columns plus the zod columns. `Object.keys(m.columns)` alone is blind to a prod schema missing minted ones. */
function expectedMainColumns(ddl: string): string[] {
  const table = ddl.split(";\n").find((s) => /^\s*CREATE TABLE/i.test(s)) ?? "";
  const body = table.slice(table.indexOf("(") + 1, table.lastIndexOf(")"));
  const names: string[] = [];
  for (const raw of body.split(/,(?![^(]*\))/)) { // split on commas not inside parens (CHECK / numeric(12,2))
    const line = raw.trim();
    if (
      !line ||
      /^(PRIMARY KEY|FOREIGN KEY|CHECK|CONSTRAINT|UNIQUE)\b/i.test(line)
    ) continue;
    const m = line.match(/^"?(\w+)"?\s/);
    if (m) names.push(m[1]!);
  }
  return names;
}

/**
 * Post-apply re-verify (`hazelnut migrate` promises "green-or-loud, never a silent green"): checks every
 * resource main table carries its full expected column set (minted feature columns too, not just zod
 * `m.columns`), and every sidecar/junction table exists — a missing one is a runtime "relation does not
 * exist". Returns the drift lines; empty means complete, and the caller fails loud on any.
 */
export async function checkBaseline(db: Db, app: App): Promise<string[]> {
  const drift: string[] = [];
  for (const m of app.model) {
    const r = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND table_schema = $2`,
      [m.name, m.pgSchema],
    );
    const live = new Set(r.rows.map((x) => x.column_name));
    for (const col of expectedMainColumns(m.ddl)) {
      if (!live.has(col)) {
        drift.push(`${m.name}.${col} declared but missing in DB`);
      }
    }
  }
  drift.push(...await structuralBaselineDrift(db, app));
  return drift;
}

/**
 * The declared structures a main-table column diff cannot see: sidecar/junction/read-model TABLES, a scoped
 * read-model's `scope_key`, and a temporal no-overlap EXCLUDE. `checkBaseline` reports these after its column
 * drift, and `migrate preview` renders them beside its own column plan — one enumeration, so the post-apply
 * post-apply check and the pre-apply plan can never disagree about which structures a declaration requires.
 */
export async function structuralBaselineDrift(
  db: Db,
  app: App,
): Promise<string[]> {
  const drift: string[] = [];
  // the sidecar + junction tables (a partial prod migration that emitted only main tables would drop these silently).
  const sidecars: { schema: string; name: string }[] = [];
  for (const m of app.model) {
    if (m.i18nDdl) {
      sidecars.push({ schema: m.pgSchema, name: `${m.name}_i18n` });
    }
    if (m.features.tree && m.features.treeClosure) {
      sidecars.push({ schema: m.pgSchema, name: `${m.name}_tree` });
    }
  }
  for (const j of app.junctions) {
    sidecars.push({ schema: j.pgSchema, name: j.name });
  }
  // read-model projection tables (author-named, public) — a partial migration that skipped them drops the
  // projection silently; assert each exists so the re-verify stays "never a silent green".
  for (const rm of app.readModels ?? []) {
    sidecars.push({ schema: "public", name: rm.name });
  }
  for (const s of sidecars) {
    const r = await db.query<{ n: number }>(
      `SELECT 1 AS n FROM information_schema.tables WHERE table_name = $1 AND table_schema = $2`,
      [s.name, s.schema],
    );
    if (r.rows.length === 0) {
      drift.push(
        `sidecar table ${s.schema}.${s.name} declared but missing in DB`,
      );
    }
  }
  // a scoped read-model must carry scope_key, or the scoped upsert in runReadModelMaintain dead-letters on
  // a missing column.
  for (const rm of app.readModels ?? []) {
    if (!rm.scoped) continue;
    const r = await db.query<{ n: number }>(
      `SELECT 1 AS n FROM information_schema.columns WHERE table_name = $1 AND table_schema = 'public' AND column_name = 'scope_key'`,
      [rm.name],
    );
    if (r.rows.length === 0) {
      drift.push(
        `read-model ${rm.name}.scope_key declared (scoped source) but missing in DB`,
      );
    }
  }
  // temporal no-overlap EXCLUDE (04-features.md §temporal migrate): only auto-lands via drizzle when the
  // migration creates the table (drizzle cannot express EXCLUDE) — noOverlap on an already-provisioned
  // table needs a hand migration; this probe is the loud floor that makes the gap visible.
  for (const m of app.model) {
    if (!temporalNoOverlap(m.features.temporal)) continue;
    const r = await db.query<{ n: number }>(
      `SELECT 1 AS n FROM pg_constraint WHERE conname = $1 AND contype = 'x' AND conrelid = to_regclass($2)`,
      [`${m.name}_no_overlap_excl`, `"${m.pgSchema}"."${m.name}"`],
    );
    if (r.rows.length === 0) {
      drift.push(
        `${m.name} temporal.noOverlap declared but the "${m.name}_no_overlap_excl" EXCLUDE constraint is missing in DB — add it by hand migration (ALTER TABLE … ADD CONSTRAINT … EXCLUDE USING gist)`,
      );
    }
  }
  return drift;
}

// ══ migrate advisory lock (cli/migrate.md §concurrency-safety) ═══════════════════════════════════════
//
// Two layers: the substrate guarantee is drizzle-kit's unique constraint on the applied-migration hash
// inside `__drizzle_migrations` (binds a non-cooperating agent, lock or no lock); the cooperative layer
// built here is a pg advisory lock keyed on `system_identifier + current_database()` (cast to text for
// `hashtext`) — auto-released on connection death, safe across machines/DSNs pointing at the same DB.

// roster/engine extracted into cohesive submodules, re-exported so importers stay stable.
// NOTE: migrate-rebase-engine.ts is NOT re-exported here — it depends on migrate-lock.ts + migrate-drizzle-schema.ts,
// and re-exporting it through this barrel would fold it into the migrate.ts value-import SCC (import-cycle-gate).
// Import it at its direct module path (`data/migrate-rebase-engine.ts`), as the entrypoint + teeth do.
