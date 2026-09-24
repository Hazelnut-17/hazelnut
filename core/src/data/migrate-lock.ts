// Barrel re-exports keep import sites stable.
import type { Db, Transactor } from "./db.ts";
import { readMigrationHistory } from "./migrate-drizzle-schema.ts";
import {
  blankSqlLiterals,
  splitSqlStatements,
  stripSqlComments,
} from "./migrate-sql-text.ts";

/** The cooperative-lock key (cli/migrate.md §concurrency-safety) — the DB's identity, not a connection's, so
 *  two DSNs pointing at one physical DB derive the same key and contend on the same advisory lock. Composed
 *  from `system_identifier` (the cluster's permanent id, cast to text) + `current_database()` — the connection-
 *  identity primitive cli/migrate.md §prod-guard names as the dev concurrency-lock key. */
export async function migrateLockKey(db: Db): Promise<string> {
  const r = await db.query<{ sysid: string; db: string }>(
    `SELECT system_identifier::text AS sysid, current_database() AS db FROM pg_control_system()`,
  );
  const row = r.rows[0];
  if (!row) {
    throw new Error(
      "migrate lock: could not read pg_control_system() — no connection identity to key the advisory lock on",
    );
  }
  return `${row.sysid}:${row.db}`;
}

/** Tries to acquire the migrate advisory lock (cli/migrate.md §concurrency-safety) via `pg_try_advisory_lock`
 *  — non-blocking: it returns false rather than waiting, so a contended migrate loud-fails instead of hanging.
 *  Returns true when this session now holds the lock, false when another migrator against the same DB holds it.
 *  The lock is session-scoped and auto-released on connection death (no orphan-lock cleanup needed). */
export async function acquireMigrateLock(db: Db): Promise<boolean> {
  const key = await migrateLockKey(db);
  const r = await db.query<{ ok: boolean }>(
    `SELECT pg_try_advisory_lock(hashtext($1)) AS ok`,
    [key],
  );
  return r.rows[0]?.ok === true;
}

/** Releases the migrate advisory lock acquired by `acquireMigrateLock` — `pg_advisory_unlock(hashtext(key))`.
 *  Returns true when a lock was actually released (false when this session held none, e.g. a double-release).
 *  A session-level advisory lock is reentrant, so a balanced acquire/release pair is required per acquisition;
 *  `withMigrateLock` guarantees the pairing. Connection death also auto-releases, so a leaked lock is bounded. */
export async function releaseMigrateLock(db: Db): Promise<boolean> {
  const key = await migrateLockKey(db);
  const r = await db.query<{ ok: boolean }>(
    `SELECT pg_advisory_unlock(hashtext($1)) AS ok`,
    [key],
  );
  return r.rows[0]?.ok === true;
}

/**
 * `withMigrateLock(db, fn)` — runs a migrate mutation (apply / rebase --execute) holding the cooperative advisory lock, so
 * two migrators against the same DB cannot interleave their drops/pushes (cli/migrate.md §concurrency-safety).
 * The acquire is non-blocking: if another migrator holds the lock the call throws loudly, never silently races
 * or hangs; a thrown `fn` still frees the lock via `finally`. Orphan recovery needs nothing: the lock is SESSION-scoped, so a dead migrator released it.
 */
export async function withMigrateLock<T>(
  db: Db,
  fn: (handle: Db) => Promise<T>,
): Promise<T> {
  // The lock is SESSION-scoped, so acquire→fn→release must land on ONE connection: on a rotating pool an
  // unpinned pair releases nothing (the unlock runs on a different session) and the first connection holds
  // the lock until the pool recycles it — every later migrate on this handle reads as "another migrator".
  const run = async (handle: Db): Promise<T> => {
    const acquired = await acquireMigrateLock(handle);
    if (!acquired) {
      throw new Error(
        "migrate: the advisory lock is held by another migrator against this DB — refusing to race. Wait for it to finish and re-run. The lock is SESSION-scoped (pg_try_advisory_lock), so it needs no unlocking: a migrator that died released it when its connection closed, and a lock still held means a live session still holds it. If you believe otherwise, `SELECT * FROM pg_locks WHERE locktype = 'advisory'` names the holding pid.",
      );
    }
    try {
      return await fn(handle);
    } finally {
      await releaseMigrateLock(handle).catch(() => {}); // best-effort — connection death also auto-releases
    }
  };
  return db.reserve ? await db.reserve(run) : await run(db);
}

// ══ migrate APPLY — the ordered drizzle-kit migration-file application (cli/migrate.md §who-writes-what) ═
//
// `hazelnut migrate apply` runs the committed `drizzle/<TS>_<name>/migration.sql` files, in dir order, each
// exactly once, replaying the versioned history rather than re-deriving the live shape (distinct from the
// dev `applySchema` throwaway push). Order, exactly-once, and per-file atomicity are pinned invariants —
// cli/migrate.md §concurrency-safety.

/** A stable, fast non-crypto content hash (FNV-1a, 32-bit, hex) for the `__drizzle_migrations` ledger key. The
 *  drizzle-kit substrate keys the applied-migration UNIQUE on the migration's content `hash`; this is the floor
 *  hash (deterministic over the SQL bytes) — enough to make apply idempotent and detect a tampered already-applied
 *  file. It is not a cryptographic anchor (that is the §4 tamper-evidence ceiling), only a content fingerprint. */
export function migrationHash(sql: string): string {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < sql.length; i++) {
    h ^= sql.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0; // FNV prime, kept in uint32
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Does this migration's SQL carry a statement that cannot run inside a transaction block (the carve-out)?
 * Postgres forbids `CREATE INDEX CONCURRENTLY`, `DROP INDEX CONCURRENTLY`, `VACUUM`, and `REINDEX … CONCURRENTLY`
 * inside `BEGIN … COMMIT` — wrapping them throws `25001`. PostgreSQL 16 permits `ALTER TYPE … ADD VALUE` in a
 * transaction, but the added enum label remains unusable until commit. We conservatively route that whole file
 * outside the explicit tx too, preserving hand-written migrations that add and immediately use the label; it is
 * therefore non-atomic and may half-apply. Matched word-boundary + case-insensitive; a false-positive only costs
 * the non-atomic path, never correctness.
 */
export function isNonTransactionalDdl(sql: string): boolean {
  // Comment- and literal-blind detection wrongly forces a pure-transactional file down the non-atomic
  // path (a mid-file crash can then half-apply), so `-- rebuilt CONCURRENTLY last week` never trips it.
  const bare = blankSqlLiterals(stripSqlComments(sql));
  return /\bCONCURRENTLY\b/i.test(bare) || /\bVACUUM\b/i.test(bare) ||
    /\bALTER\s+TYPE\b[\s\S]*\bADD\s+VALUE\b/i.test(bare);
}

/**
 * Splits a `migration.sql` into its individual statements, on drizzle-kit's `--> statement-breakpoint` marker,
 * so each execs separately inside the explicit per-migration tx — atomicity rests on the explicit `BEGIN …
 * COMMIT`, never a driver's implicit multi-statement all-or-nothing (which an extended-protocol change could
 * silently remove). Blank fragments are dropped.
 *
 * A file with NO marker is hand-written — everything the framework emits carries one. It used to return as
 * one blob on the reasoning that a bare `;` split is unsafe, which was true of a bare split and is not true
 * of `splitSqlStatements`: that walker is string / quoted-identifier / dollar-quote aware, so a `;` inside a
 * DO body or a literal is not a boundary. The blob was its own bug — two hand-written `CREATE INDEX
 * CONCURRENTLY` statements reached the driver as one exec, which Postgres rejects (25001) for a construct
 * that is legal one statement at a time.
 */
export function splitMigrationStatements(sql: string): string[] {
  if (!sql.includes("--> statement-breakpoint")) {
    return splitSqlStatements(stripSqlComments(sql)).map((s) =>
      s.replace(/;\s*$/, "").trim()
    ).filter((s) => s.length > 0);
  }
  return sql.split("--> statement-breakpoint")
    .map((s) => s.trim().replace(/;\s*$/, "").trim())
    .filter((s) => s.length > 0);
}

interface TemporalWindowValidation {
  statement: string;
  schema: string;
  table: string;
  constraint: string;
}

/** The framework's staged validity-window check is the one migration statement whose
 *  validation must run after the ADD + ledger transaction commits. Keep recognition
 *  narrow: generated SQL uses fully quoted identifiers and the framework-owned suffix. */
function temporalWindowValidation(
  stmt: string,
): TemporalWindowValidation | undefined {
  const id = String.raw`"((?:[^"]|"")*)"`;
  const match = stripSqlComments(stmt).match(
    new RegExp(
      String
        .raw`^\s*ALTER\s+TABLE\s+${id}\s*\.\s*${id}\s+VALIDATE\s+CONSTRAINT\s+${id}\s*;?\s*$`,
      "i",
    ),
  );
  if (!match) return undefined;
  const decode = (value: string) => value.replaceAll('""', '"');
  const schema = decode(match[1]!);
  const table = decode(match[2]!);
  const constraint = decode(match[3]!);
  if (!constraint.toLowerCase().endsWith("_valid_window_check")) {
    return undefined;
  }
  return { statement: stmt, schema, table, constraint };
}

function temporalWindowValidations(sql: string): TemporalWindowValidation[] {
  const statements = splitMigrationStatements(sql);
  return statements.flatMap((stmt) => {
    const validation = temporalWindowValidation(stmt);
    if (!validation) return [];
    const id = String.raw`(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)`;
    const hasStagedAdd = statements.some((candidate) => {
      const match = stripSqlComments(candidate).match(
        new RegExp(
          String
            .raw`^\s*ALTER\s+TABLE\s+(?:(${id})\s*\.\s*)?(${id})\s+ADD\s+CONSTRAINT\s+(${id})\s+CHECK\s*\(([\s\S]*)\)\s+NOT\s+VALID\s*;?\s*$`,
          "i",
        ),
      );
      if (!match) return false;
      const decode = (value: string) =>
        value.startsWith('"')
          ? value.slice(1, -1).replaceAll('""', '"')
          : value.toLowerCase();
      return (match[1] ? decode(match[1]) : "public") === validation.schema &&
        decode(match[2]!) === validation.table &&
        decode(match[3]!) === validation.constraint &&
        temporalWindowCheckShape(`CHECK (${match[4]})`) ===
          "checkvalid_toisnullorvalid_to>valid_from";
    });
    return hasStagedAdd ? [validation] : [];
  });
}

function temporalWindowCheckShape(def: string): string {
  return def.toLowerCase().replace(/\s+not valid$/, "").replaceAll('"', "")
    .replace(/[()\s]/g, "");
}

/** Confirm the staged statement targets the exact framework-owned CHECK before
 *  validating it; a same-named drifted constraint must not be blessed by apply. */
async function assertTemporalWindowCheck(
  db: Db,
  validation: TemporalWindowValidation,
): Promise<boolean> {
  const row = (await db.query<{ def: string | null; validated: boolean }>(
    `SELECT pg_get_constraintdef(c.oid) AS def, c.convalidated AS validated
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND t.relname = $2 AND c.conname = $3 AND c.contype = 'c'`,
    [validation.schema, validation.table, validation.constraint],
  )).rows[0];
  if (
    !row?.def ||
    temporalWindowCheckShape(row.def) !==
      "checkvalid_toisnullorvalid_to>valid_from"
  ) {
    throw new Error(
      `migrate apply: temporal validity-window constraint ${validation.schema}.${validation.table}.${validation.constraint} is missing or drifted; expected CHECK (valid_to IS NULL OR valid_to > valid_from).`,
    );
  }
  return row.validated;
}

/** A concurrent index build can leave an INVALID catalog entry after it fails. PostgreSQL then treats a
 * retry with `IF NOT EXISTS` as a successful no-op, even though the index cannot arbitrate `ON CONFLICT`.
 * Read the exact index the statement named before the migration ledger records that file. */
function concurrentIndexName(stmt: string): string | undefined {
  const bare = stripSqlComments(stmt);
  const identifier = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
  const match = bare.match(
    new RegExp(
      String
        .raw`^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+(?:IF\s+NOT\s+EXISTS\s+)?(?<index>${identifier}(?:\s*\.\s*${identifier})?)\s+ON\s+(?:ONLY\s+)?(?:(?<tableSchema>${identifier})\s*\.\s*)?${identifier}(?=\s|\(|$)`,
      "i",
    ),
  );
  const index = match?.groups?.index?.replace(/\s*\.\s*/g, ".");
  if (!index) return undefined;
  // An unqualified index name belongs to the table's schema, not necessarily the connection search_path.
  const schema = match?.groups?.tableSchema;
  return schema && !index.includes(".") ? `${schema}.${index}` : index;
}

async function assertConcurrentIndexesValid(
  conn: Db,
  stmt: string,
): Promise<void> {
  const name = concurrentIndexName(stmt);
  if (!name) return;
  const row = (await conn.query<{ valid: boolean | null }>(
    `SELECT i.indisvalid AS valid FROM pg_index AS i WHERE i.indexrelid = to_regclass($1)`,
    [name],
  )).rows[0];
  if (row?.valid === true) return;
  throw new Error(
    `migrate apply: concurrent index ${name} is absent or INVALID after CREATE INDEX CONCURRENTLY; it cannot enforce uniqueness or arbitrate ON CONFLICT. Reconcile the live database before retrying; the migration was not recorded.`,
  );
}

/** The result of an `applyMigrations` run — which migration dirs were freshly applied vs already-recorded
 *  (skipped). `applied` is the ordered list this run executed; `skipped` were present in the ledger already. */
export interface ApplyMigrationsResult {
  readonly applied: readonly string[]; // dir names executed this run (in apply order)
  readonly skipped: readonly string[]; // dir names already recorded in __drizzle_migrations (idempotent skip)
  readonly total: number; // the committed history length
  // dirs run outside the explicit tx (the CONCURRENTLY/VACUUM and conservative enum-add-value carve-outs) — a
  // mid-file crash there may half-apply. Omitted (not `[]`) when none, so the common all-atomic result stays
  // the prior 3-field shape.
  readonly nonAtomic?: readonly string[];
}

/**
 * `applyMigrations(db, drizzleDir)` — applies the committed drizzle-kit migration files to a live DB, in dir
 * order, each exactly once (cli/migrate.md §who-writes-what), recording each applied file's content hash in
 * `__drizzle_migrations` so a re-run skips it (idempotent). Each migration's exec + ledger insert run inside one
 * explicit transaction — a mid-file crash rolls the whole migration back, except the `CONCURRENTLY`/`VACUUM`
 * and conservative enum-add-value carve-outs (`isNonTransactionalDdl`), which run outside the tx and are reported
 * in `nonAtomic`. Framework temporal-window VALIDATE statements run after that commit, each in their own
 * transaction; an unvalidated recorded constraint is retried before later files.
 */
export async function applyMigrations(
  db: Db,
  drizzleDir: string,
): Promise<ApplyMigrationsResult> {
  const history = await readMigrationHistory(drizzleDir);
  // the exactly-once ledger (drizzle-kit's substrate shape) — UNIQUE on the content hash binds a racing agent.
  // `folder` binds dir ↔ hash so a tampered already-applied file (new hash, same dir) cannot re-run as a "new" migration.
  await db.exec(
    `CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (id bigserial PRIMARY KEY, hash text NOT NULL UNIQUE, folder text, created_at bigint)`,
  );
  await db.exec(
    `ALTER TABLE "__drizzle_migrations" ADD COLUMN IF NOT EXISTS folder text`,
  );
  await db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS "__drizzle_migrations_folder_uidx" ON "__drizzle_migrations" (folder) WHERE folder IS NOT NULL`,
  );
  const recordedRows = (await db.query<{ hash: string; folder: string | null }>(
    `SELECT hash, folder FROM "__drizzle_migrations"`,
  )).rows;
  const recorded = new Set(recordedRows.map((r) => r.hash));
  const hashByFolder = new Map<string, string>();
  for (const r of recordedRows) {
    if (r.folder) hashByFolder.set(r.folder, r.hash);
  }
  // the explicit-tx capability — present on every real adapter (pgliteDb / postgresDb); a bare `Db`
  // (no Transactor) falls back to un-wrapped exec except pending staged temporal checks, which fail closed.
  const tx = (db as Partial<Transactor>).transaction;
  const applied: string[] = [];
  const skipped: string[] = [];
  const nonAtomic: string[] = [];
  // exec the file's bytes then record the content hash — the two MUST be one unit, so a crash between them never
  // leaves a fully-applied-but-unrecorded (→ re-run duplicate-error) or recorded-but-unapplied (→ silent skip) split.
  const applyOne = async (
    conn: Db,
    sql: string,
    hash: string,
    folder: string,
    deferredValidations: ReadonlySet<string>,
  ): Promise<void> => {
    // Exec each authored statement separately (drizzle's `--> statement-breakpoint` boundary), so atomicity rests
    // on the explicit enclosing tx — a mid-file throw rolls every prior statement + the ledger record back together.
    // The staged temporal-window VALIDATE is the sole deferred statement; it runs after this transaction commits.
    for (const stmt of splitMigrationStatements(sql)) {
      if (deferredValidations.has(stmt)) continue;
      await conn.exec(stmt);
      await assertConcurrentIndexesValid(conn, stmt);
    }
    await conn.query(
      `INSERT INTO "__drizzle_migrations" (hash, folder, created_at) VALUES ($1, $2, $3) ON CONFLICT (hash) DO NOTHING`,
      [hash, folder, Date.now()],
    );
  };
  for (const m of history) {
    const hash = migrationHash(m.sql);
    const validations = temporalWindowValidations(m.sql);
    const deferredValidations = new Set(validations.map((v) => v.statement));
    const prev = hashByFolder.get(m.dir);
    let wasRecorded = false;
    if (prev !== undefined) {
      if (prev !== hash) {
        throw new Error(
          `migrate/hash-stable: applied migration '${m.dir}' changed hash (${prev} → ${hash}) — restore the file or re-baseline`,
        );
      }
      skipped.push(m.dir);
      wasRecorded = true;
    } else if (recorded.has(hash)) {
      skipped.push(m.dir);
      await db.query(
        `UPDATE "__drizzle_migrations" SET folder = $1 WHERE hash = $2 AND folder IS NULL`,
        [m.dir, hash],
      );
      wasRecorded = true;
    }
    if (!wasRecorded) {
      const nonTransactional = isNonTransactionalDdl(m.sql);
      if (validations.length > 0 && (!tx || nonTransactional)) {
        throw new Error(
          `migrate apply: '${m.dir}' stages a temporal validity-window check and requires a transaction-capable Db so the NOT VALID addition and migration ledger commit atomically before validation. Refusing this file before executing its SQL.`,
        );
      }
      if (tx && !nonTransactional) {
        // explicit per-migration tx: DDL + ledger record commit, or roll back on a mid-file throw, together.
        await tx.call(
          db,
          (conn) => applyOne(conn, m.sql, hash, m.dir, deferredValidations),
        );
      } else {
        // No tx capability or a non-transactional file (CONCURRENTLY/VACUUM, or conservative enum add-value) — run
        // un-wrapped. The latter is the documented carve-out (a mid-file crash may half-apply; enum add-value keeps
        // same-file immediate use compatible on PostgreSQL 16).
        try {
          await applyOne(db, m.sql, hash, m.dir, deferredValidations);
        } catch (cause) {
          const message = cause instanceof Error
            ? cause.message
            : String(cause);
          throw new Error(
            `migrate apply: '${m.dir}' failed OUTSIDE a transaction; partial effects may remain. Inspect and reconcile the live database before retrying or rebasing; a retry starts this unrecorded file from its first statement. Original error: ${message}`,
            { cause },
          );
        }
        if (tx && nonTransactional) nonAtomic.push(m.dir);
      }
      applied.push(m.dir);
      recorded.add(hash);
      hashByFolder.set(m.dir, hash);
    }
    // A NOT VALID check skips the add-time scan but still protects new writes. Validate after the ledger/ADD
    // transaction commits, so PostgreSQL can release the stronger ADD lock before its validation scan. Retrying
    // already-recorded migrations here makes a failed/crashed validation resumable and blocks later files.
    for (const validation of validations) {
      if (await assertTemporalWindowCheck(db, validation)) continue;
      try {
        if (tx) {
          await tx.call(db, (conn) => conn.exec(validation.statement));
        } else {
          // Existing ledger entry: a standalone VALIDATE is itself one autocommit transaction and safe to retry.
          await db.exec(validation.statement);
        }
        if (!(await assertTemporalWindowCheck(db, validation))) {
          throw new Error(
            "the constraint remains unvalidated after VALIDATE CONSTRAINT",
          );
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        throw new Error(
          `migrate apply: temporal validity-window validation for '${m.dir}' failed after the NOT VALID constraint and migration ledger committed; the constraint still rejects new invalid writes but remains unvalidated. Repair existing invalid rows, then rerun migrate apply; it will retry this validation before advancing to later migrations. Original error: ${message}`,
          { cause },
        );
      }
    }
  }
  // omit `nonAtomic` when empty so the all-atomic result keeps the prior `{ applied, skipped, total }` shape.
  return nonAtomic.length > 0
    ? { applied, skipped, total: history.length, nonAtomic }
    : { applied, skipped, total: history.length };
}

// ══ migrate PREVIEW — pending-change reporting (cli/migrate.md interface: "what runs … what is irreversible")
// ═ The schema-diff floor of `hazelnut migrate preview`: a non-mutating read classifying each pending change
// add (safe) or drop candidate (destructive, irreversible) — see `pendingChanges` (migrate-derive.ts). Row-move
// counts are the expand-contract ceiling, deferred.

// ══ vector model/dimension migration — the expand-contract upcaster ═════════════ A vector field's dims/model change
// is a literal expand-contract (cli/migrate.md §expand-contract): pgvector cannot widen a column in place, so the
// framework derives a side-by-side `<field>_v2` column (the safe additive step); the backfill rides the outbox
// re-embed job, and cut-over + the old-column drop are the contract step the migrate gate already blocks. See
// `deriveVectorMigration` (migrate-derive.ts).
