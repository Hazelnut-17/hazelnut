// Barrel re-exports keep import sites stable.
import type { Db, Transactor } from "./db.ts";
import { readMigrationHistory } from "./migrate-drizzle-schema.ts";
import { blankSqlLiterals, stripSqlComments } from "./migrate-sql-text.ts";

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
 * `withMigrateLock(db, fn)` — runs a migrate mutation (apply / reset) holding the cooperative advisory lock, so
 * two migrators against the same DB cannot interleave their drops/pushes (cli/migrate.md §concurrency-safety).
 * The acquire is non-blocking: if another migrator holds the lock the call throws loudly, never silently races
 * or hangs; a thrown `fn` still frees the lock via `finally`. Orphan recovery needs nothing: the lock is SESSION-scoped, so a dead migrator released it.
 */
export async function withMigrateLock<T>(
  db: Db,
  fn: () => Promise<T>,
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
      return await fn();
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
 * Postgres forbids `CREATE INDEX CONCURRENTLY`, `DROP INDEX CONCURRENTLY`, `VACUUM`, `REINDEX … CONCURRENTLY`,
 * and `ALTER TYPE … ADD VALUE` (pre-12) inside `BEGIN … COMMIT` — wrapping them throws `25001`. Such a file runs
 * outside the explicit tx (not atomic — a mid-file failure may half-apply). Matched word-boundary + case-insensitive;
 * a false-positive only costs the non-atomic path, never correctness.
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
 * silently remove). A file without the marker returns as one statement, never bare-`;` split (a `;` inside a
 * DO block / function body / string literal must not split it). Blank fragments are dropped.
 */
export function splitMigrationStatements(sql: string): string[] {
  const parts = sql.includes("--> statement-breakpoint")
    ? sql.split("--> statement-breakpoint")
    : [sql];
  return parts.map((s) => s.trim().replace(/;\s*$/, "").trim()).filter((s) =>
    s.length > 0
  );
}

/** The result of an `applyMigrations` run — which migration dirs were freshly applied vs already-recorded
 *  (skipped). `applied` is the ordered list this run executed; `skipped` were present in the ledger already. */
export interface ApplyMigrationsResult {
  readonly applied: readonly string[]; // dir names executed this run (in apply order)
  readonly skipped: readonly string[]; // dir names already recorded in __drizzle_migrations (idempotent skip)
  readonly total: number; // the committed history length
  // dirs run outside the explicit tx (the CONCURRENTLY/VACUUM carve-out) — a mid-file crash there may
  // half-apply. Omitted (not `[]`) when none, so the common all-atomic result stays the prior 3-field shape.
  readonly nonAtomic?: readonly string[];
}

/**
 * `applyMigrations(db, drizzleDir)` — applies the committed drizzle-kit migration files to a live DB, in dir
 * order, each exactly once (cli/migrate.md §who-writes-what), recording each applied file's content hash in
 * `__drizzle_migrations` so a re-run skips it (idempotent). Each migration's exec + ledger insert run inside one
 * explicit transaction — a mid-file crash rolls the whole migration back, except the `CONCURRENTLY`/`VACUUM`
 * carve-out (`isNonTransactionalDdl`), which runs outside the tx and is reported in `nonAtomic`.
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
  // (no Transactor) falls back to the un-wrapped exec, unchanged from before.
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
  ): Promise<void> => {
    // execs each authored statement separately (drizzle's `--> statement-breakpoint` boundary) so atomicity rests
    // on the explicit enclosing tx — a mid-file throw rolls every prior statement + the ledger record back together.
    for (const stmt of splitMigrationStatements(sql)) await conn.exec(stmt);
    await conn.query(
      `INSERT INTO "__drizzle_migrations" (hash, folder, created_at) VALUES ($1, $2, $3) ON CONFLICT (hash) DO NOTHING`,
      [hash, folder, Date.now()],
    );
  };
  for (const m of history) {
    const hash = migrationHash(m.sql);
    const prev = hashByFolder.get(m.dir);
    if (prev !== undefined) {
      if (prev !== hash) {
        throw new Error(
          `migrate/hash-stable: applied migration '${m.dir}' changed hash (${prev} → ${hash}) — restore the file or re-baseline`,
        );
      }
      skipped.push(m.dir);
      continue;
    }
    if (recorded.has(hash)) {
      skipped.push(m.dir);
      await db.query(
        `UPDATE "__drizzle_migrations" SET folder = $1 WHERE hash = $2 AND folder IS NULL`,
        [m.dir, hash],
      );
      continue;
    }
    if (tx && !isNonTransactionalDdl(m.sql)) {
      // explicit per-migration tx: DDL + ledger record commit, or roll back on a mid-file throw, together.
      await tx.call(db, (conn) => applyOne(conn, m.sql, hash, m.dir));
    } else {
      // No tx capability or a non-transactional file (CONCURRENTLY/VACUUM) — run un-wrapped. The latter is the
      // documented carve-out (a mid-file crash may half-apply; those statements cannot run in a tx block).
      await applyOne(db, m.sql, hash, m.dir);
      if (tx && isNonTransactionalDdl(m.sql)) nonAtomic.push(m.dir);
    }
    applied.push(m.dir);
    recorded.add(hash);
    hashByFolder.set(m.dir, hash);
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

// See `deriveVectorMigration` (migrate-derive.ts).
