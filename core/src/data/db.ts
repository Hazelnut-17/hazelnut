import type { PGlite } from "@electric-sql/pglite";

/** The minimal database surface the repo + migrate need — parameterized query + DDL exec. Satisfied by
 *  PGlite (tests, in-process) and a postgres.js wrapper (real Postgres): the framework stays db-engine-agnostic. */
export interface Db {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
  /** Whether this handle can run a query concurrently with an open transaction on another connection (a real
   *  pool, `max >= 2`) — true for `postgresDb`, absent for single-connection `pgliteDb` (a query during an open
   *  `.transaction()` there deadlocks the one connection). The relay reads this to gate out-of-band task progress. */
  readonly concurrent?: boolean;
  /** Pins every query inside `fn` to ONE pooled connection. Session-scoped state (an advisory lock taken
   *  with `pg_try_advisory_lock`) is only released by the SAME session that took it — on a rotating pool an
   *  un-pinned acquire/release pair releases nothing and the first connection holds the lock until recycled.
   *  Absent on single-connection handles (PGlite), where every query is already the one session. */
  reserve?<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  /** Cancels a mid-flight statement on backend `pid` via a side channel (`pg_cancel_backend`) — raises `57014`
   *  without closing/poisoning the pooled connection. Present on `postgresDb` (a spare pool connection sends
   *  the cancel); absent on single-connection `pgliteDb`, where cancel degrades to `statement_timeout`. */
  cancelBackend?(pid: number): Promise<void>;
  /** Runs `fn` in a nested savepoint: a failure unwinds only `fn`'s writes and this transaction stays
   *  usable. Present on TX handles only. It must be the driver's own API, never hand-written SQL —
   *  postgres.js reports a query error to the enclosing `begin` even after the callback catches it and
   *  rolls back, so a raw `ROLLBACK TO SAVEPOINT` recovers the session and loses the transaction anyway. */
  savepoint?<T>(fn: (sp: Db) => Promise<T>): Promise<T>;
}

/** The transaction capability, kept separate from `Db` so plain `Db` consumers (repo, migrate, serve,
 *  outbox) stay engine-agnostic; only the op-pipeline needs a real tx (`Db & Transactor`). */
export interface Transactor {
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

let pgliteSavepointSeq = 0;

/** Adapt a PGlite instance to `Db & Transactor` — the tx callback receives a `Db` bound to the PG tx. */
export function pgliteDb(pg: PGlite): Db & Transactor {
  return {
    query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
      pg.query<T>(sql, params as unknown[]).then((r) => ({ rows: r.rows })),
    exec: (sql: string) => pg.exec(sql),
    transaction: <T>(fn: (tx: Db) => Promise<T>) =>
      pg.transaction((tx) => {
        const handle: Db = {
          query: <U = Record<string, unknown>>(
            sql: string,
            params?: unknown[],
          ) =>
            tx.query<U>(sql, params as unknown[]).then((r) => ({
              rows: r.rows,
            })),
          exec: (sql: string) => tx.exec(sql),
          // PGlite raises an inner failure to this callback only, so the SQL form is the driver's own here.
          savepoint: async <U>(fn: (sp: Db) => Promise<U>): Promise<U> => {
            const name = `hz_sp_${++pgliteSavepointSeq}`;
            await tx.exec(`SAVEPOINT ${name}`);
            try {
              const v = await fn(handle);
              await tx.exec(`RELEASE SAVEPOINT ${name}`);
              return v;
            } catch (e) {
              await tx.exec(`ROLLBACK TO SAVEPOINT ${name}`);
              await tx.exec(`RELEASE SAVEPOINT ${name}`);
              throw e;
            }
          },
        };
        return fn(handle);
      }) as Promise<T>,
  };
}

/** The minimal parameterized-query surface every postgres.js connection exposes — `.unsafe(query, params)`.
 *  Typed structurally so `db.ts` carries no static dependency on `npm:postgres@3` (loaded dynamically in `hazelnut.ts`). */
export interface PostgresUnsafe {
  unsafe(query: string, params?: unknown[]): Promise<unknown>;
}

/** A postgres.js reserved (pinned) connection — `.unsafe` plus the `release()` that returns it to the pool. */
export interface PostgresReserved extends PostgresUnsafe {
  release(): void;
}

/** The minimal postgres.js root-client surface `postgresDb` adapts — `.unsafe` plus `.begin(fn)`, whose
 *  callback receives a narrower `PostgresUnsafe` tx connection (matches the real client's `TransactionSql`),
 *  and `.reserve()` for session-scoped state (advisory locks). */
export interface PostgresSql extends PostgresUnsafe {
  begin<T>(fn: (tx: PostgresTx) => Promise<T> | T): Promise<T>;
  reserve(): Promise<PostgresReserved>;
}

/** A postgres.js transaction connection: `.unsafe` plus the driver's own `.savepoint(fn)`, which is the
 *  ONLY nesting form that leaves the enclosing tx alive after an inner failure. */
export interface PostgresTx extends PostgresUnsafe {
  savepoint<T>(fn: (sp: PostgresTx) => Promise<T> | T): Promise<T>;
}

/** Adapts a postgres.js client (`sql`) to `Db & Transactor`, the canonical live-Postgres adapter:
 *  `.transaction(fn)` runs a real `sql.begin(...)` tx, so a relay handler's write and its `_processed`
 *  claim commit or roll back together (05-runtime.md §relay-mode). `.query`/`.exec` are unchanged, so
 *  migrate/rotate-key/verify-integrity (which never call `.transaction`) are unaffected. */
export function postgresDb(sql: PostgresSql): Db & Transactor {
  const adapt = (s: PostgresUnsafe): Db => ({
    query: async <T = Record<string, unknown>>(
      q: string,
      params?: unknown[],
    ) => ({
      rows: (await s.unsafe(q, (params ?? []) as never[])) as unknown as T[],
    }),
    exec: async (q: string) => {
      await s.unsafe(q);
    },
  });
  const adaptTx = (s: PostgresTx): Db => ({
    ...adapt(s),
    savepoint: <T>(fn: (sp: Db) => Promise<T>) =>
      s.savepoint((spSql) => fn(adaptTx(spSql))) as Promise<T>,
  });
  return {
    ...adapt(sql),
    // the root pool (postgres.js default max 10) queries concurrently with an open `sql.begin` tx, so
    // out-of-band task progress works.
    concurrent: true,
    transaction: <T>(fn: (tx: Db) => Promise<T>) =>
      sql.begin((txSql) => fn(adaptTx(txSql))) as Promise<T>,
    reserve: async <T>(fn: (one: Db) => Promise<T>): Promise<T> => {
      const held = await sql.reserve();
      try {
        return await fn(adapt(held));
      } finally {
        await held.release();
      }
    },
    // cancels a mid-flight statement out-of-band: `pg_cancel_backend(pid)` runs on a different pooled
    // connection than the busy tx, reaching the busy backend (57014) without closing/poisoning the connection.
    cancelBackend: async (pid: number) => {
      await sql.unsafe(`SELECT pg_cancel_backend($1)`, [pid] as never[]);
    },
  };
}

/** A Postgres unique-violation (SQLSTATE `23505`) — a `unique`-feature clash, or a concurrent singleton
 *  seed losing the PK race. Lives in `db.ts` (the lowest layer) so every consumer (pipeline's `conflict`
 *  mapping, HTTP/MCP doors, the read-or-create seed) shares one predicate without a layer-inverting import. */
export function isUniqueViolation(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  if ((e as { code?: unknown }).code === "23505") return true;
  const msg = (e as { message?: unknown }).message;
  return typeof msg === "string" &&
    /duplicate key value|unique constraint/i.test(msg);
}

/** A Postgres exclusion-constraint violation (SQLSTATE `23P01`) — the `temporal: { noOverlap }` exclude
 *  refusing an overlapping validity window; same `conflict` mapping tier as `isUniqueViolation` (04-features.md §temporal). */
export function isExclusionViolation(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  if ((e as { code?: unknown }).code === "23P01") return true;
  const msg = (e as { message?: unknown }).message;
  return typeof msg === "string" && /exclusion constraint/i.test(msg);
}

/** A Postgres foreign-key violation (SQLSTATE `23503`) — the junction `link` INSERT hits this on a TOCTOU
 *  (endpoint check passes, target hard-deleted before the cascade-FK insert); mapped to `notFound`, never a raw 500. */
export function isForeignKeyViolation(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  if ((e as { code?: unknown }).code === "23503") return true;
  const msg = (e as { message?: unknown }).message;
  return typeof msg === "string" &&
    /foreign key constraint|violates foreign key/i.test(msg);
}

/** A Postgres deadlock (`40P01`) or serialization failure (`40001`) — a transient concurrency abort the
 *  engine resolves by rolling back one victim tx; retry the whole transaction. Can still surface rarely from
 *  the rollup×cascade lock order (`repo.ts lockRollupCascadeEdges`), which statement order alone can't pin. */
export function isDeadlock(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const code = (e as { code?: unknown }).code;
  if (code === "40P01" || code === "40001") return true;
  const msg = (e as { message?: unknown }).message;
  return typeof msg === "string" &&
    /deadlock detected|could not serialize/i.test(msg);
}

/** Runs a tx-opening thunk, retrying it on a transient deadlock/serialization abort ({@link isDeadlock}) up
 *  to `attempts` times with jittered backoff. `fn` MUST be the tx opener (`() => db.transaction(...)`), never
 *  a half-open tx. Deliberately not applied to the custom-op pipeline — a handler's external side effects
 *  could double-fire on a silent re-run, so a custom-op deadlock surfaces as a retryable error instead. */
export async function withDeadlockRetry<T>(
  fn: () => Promise<T>,
  attempts = 5,
): Promise<T> {
  for (let attempt = 1;; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= attempts || !isDeadlock(e)) throw e;
      await new Promise((r) =>
        setTimeout(r, attempt * 3 + Math.floor(Math.random() * 5))
      );
    }
  }
}

/** Does this handle carry a transaction door? The narrowing predicate lives WITH `Transactor` — a
 *  caller anywhere may ask, and homing it in one consumer is what made that consumer a cycle member. */
export function isTransactor(db: Db): db is Db & Transactor {
  return typeof (db as Partial<Transactor>).transaction === "function";
}
