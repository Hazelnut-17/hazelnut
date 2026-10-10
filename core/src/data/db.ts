// Keep both native adapter dependencies in the runtime graph. Type-only discovery
// lets a later lazy import change Drizzle's optional-peer identity during cold
// Deno resolution. Loading the library does not construct an engine or connection.
import { type PGlite, types as pgliteTypes } from "@electric-sql/pglite";
import "postgres";

const FRAMEWORK_TRANSACTION_HANDLES = new WeakSet<object>();
/** Native representations JSON aggregation cannot carry alone. Metadata travels with
 * positional rows, rather than handle identity, so decorated adapters keep their decoder. */
export interface NativeArrayRows {
  readonly rows: unknown[][];
  readonly columns: readonly string[];
  /** Native text parsers from public field metadata, keyed by SQL label. */
  readonly decoders: ReadonlyMap<
    string,
    (text: string, array: boolean) => unknown
  >;
}

/** Mark only handles produced by the adapters' real transaction callbacks. A caller-set `transactionScoped`
 *  boolean is descriptive metadata, not proof that this handle participates in a live transaction. */
function frameworkTransactionHandle<T extends Db>(handle: T): T {
  FRAMEWORK_TRANSACTION_HANDLES.add(handle);
  return handle;
}

/** The minimal database surface the repo + migrate need — parameterized query + DDL exec. Satisfied by
 *  PGlite (tests, in-process) and a postgres.js wrapper (real Postgres): the framework stays db-engine-agnostic. */
export interface Db {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
  /** Optional native positional transport for relational reads. Columns retain the database's
   * SELECT order, including duplicate labels; never reconstruct this from object property order.
   * Supply it on each bound transaction/reserved/savepoint handle as well as the root. */
  queryArrays?(
    sql: string,
    params?: unknown[],
  ): Promise<NativeArrayRows>;
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
  /** True only for the callback handle supplied by the driver's real
   *  transaction API.  Control-plane helpers use this to refuse an advisory
   *  xact lock that would otherwise evaporate before an autocommit write. */
  readonly transactionScoped?: boolean;
}

/** The transaction capability, kept separate from `Db` so plain `Db` consumers (repo, migrate, serve,
 *  outbox) stay engine-agnostic; only the op-pipeline needs a real tx (`Db & Transactor`). */
export interface Transactor {
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

let pgliteSavepointSeq = 0;

/** int8 and int8[] read as decimal text, as postgres.js returns them (03-api-shape.md §db-schema). Passed per
 *  query so the caller's own PGlite instance keeps its parsers. */
const INT8_AS_TEXT: Readonly<
  Record<number, (text: string, typeId?: number) => unknown>
> = {
  20: (text) => text,
  1016: (text) =>
    pgliteTypes.arrayParser(text, (element: string) => element, 1016),
};

/** Adapt a PGlite instance to `Db & Transactor` — the tx callback receives a `Db` bound to the PG tx. */
export function pgliteDb(pg: PGlite): Db & Transactor {
  const decode = (id: number) => (text: string) => {
    const parse = INT8_AS_TEXT[id] ?? pg.parsers[id];
    return parse ? parse(text, id) : text;
  };
  return {
    query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
      pg.query<T>(sql, params as unknown[], { parsers: INT8_AS_TEXT }).then((
        r,
      ) => ({ rows: r.rows })),
    queryArrays: (sql, params) =>
      pg.query<unknown[]>(sql, params, {
        rowMode: "array",
        parsers: INT8_AS_TEXT,
      }).then((r) => ({
        rows: r.rows,
        columns: r.fields.map((field) => field.name),
        decoders: new Map(
          r.fields.map((
            field,
          ) => [
            field.name,
            decode(field.dataTypeID),
          ]),
        ),
      })),
    exec: (sql: string) => pg.exec(sql),
    transaction: <T>(fn: (tx: Db) => Promise<T>) =>
      pg.transaction((tx) => {
        const handle: Db = frameworkTransactionHandle({
          query: <U = Record<string, unknown>>(
            sql: string,
            params?: unknown[],
          ) =>
            tx.query<U>(sql, params as unknown[], { parsers: INT8_AS_TEXT })
              .then((r) => ({ rows: r.rows })),
          queryArrays: (sql, params) =>
            tx.query<unknown[]>(sql, params, {
              rowMode: "array",
              parsers: INT8_AS_TEXT,
            }).then((
              r,
            ) => ({
              rows: r.rows,
              columns: r.fields.map((field) => field.name),
              decoders: new Map(
                r.fields.map((
                  field,
                ) => [
                  field.name,
                  decode(field.dataTypeID),
                ]),
              ),
            })),
          exec: (sql: string) => tx.exec(sql),
          transactionScoped: true,
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
        });
        return fn(handle);
      }) as Promise<T>,
  };
}

/** The minimal parameterized-query surface every postgres.js connection exposes — `.unsafe(query, params)`.
 *  Typed structurally so `db.ts` carries no static dependency on `npm:postgres@3` (loaded dynamically in `hazelnut.ts`). */
export interface PostgresUnsafe {
  unsafe(query: string, params?: unknown[]): Promise<unknown>;
}

/** A postgres.js reserved (pinned) connection. Its runtime API exposes queries and `release()` but not
 * `.begin(...)`; `postgresDb` supplies transaction boundaries on this held session so they can coexist with a
 * session-scoped advisory lock. */
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

/** A Postgres transaction connection. `sql.begin` callbacks use the driver's `.savepoint(fn)` because that is
 * the only nesting form that leaves the driver's enclosing tx alive after an inner failure. The manually
 * bounded reserved-session path supplies the same method with SQL savepoints outside a driver `begin` callback. */
export interface PostgresTx extends PostgresUnsafe {
  savepoint<T>(fn: (sp: PostgresTx) => Promise<T> | T): Promise<T>;
}

/** Adapts a postgres.js client (`sql`) to `Db & Transactor`, the canonical live-Postgres adapter:
 *  `.transaction(fn)` runs a real `sql.begin(...)` tx, so a relay handler's write and its `_processed`
 *  claim commit or roll back together (05-runtime.md §relay-mode). A reserved adapter keeps `.transaction`
 *  on its held session, so advisory-locked migrations retain their per-file atomicity. */
export function postgresDb(sql: PostgresSql): Db & Transactor {
  let reservedSavepointSeq = 0;
  const adapt = (s: PostgresUnsafe): Db => ({
    query: async <T = Record<string, unknown>>(
      q: string,
      params?: unknown[],
    ) => ({
      rows: (await s.unsafe(q, (params ?? []) as never[])) as unknown as T[],
    }),
    queryArrays: async (q, params) => {
      const pending = s.unsafe(q, params ?? []);
      if (!("values" in pending) || typeof pending.values !== "function") {
        // Structural test/custom clients can satisfy the old port without native positional reads.
        await pending;
        throw new Error(
          "graph/native-arrays-required: this postgres client exposes no native values() transport",
        );
      }
      const rows: unknown = await pending.values();
      if (!Array.isArray(rows) || rows.some((row) => !Array.isArray(row))) {
        throw new Error(
          "graph/native-array-shape: the driver returned non-positional rows",
        );
      }
      if (!("columns" in rows) || !Array.isArray(rows.columns)) {
        throw new Error(
          "graph/native-fields-required: positional rows need public column metadata",
        );
      }
      const decoders = new Map<
        string,
        (text: string, array: boolean) => unknown
      >();
      const columns: string[] = [];
      for (const column of rows.columns) {
        if (
          !column || typeof column !== "object" ||
          typeof column.name !== "string" ||
          (column.parser !== undefined && typeof column.parser !== "function")
        ) {
          throw new Error(
            "graph/native-field-shape: native column metadata needs a string name and an optional callable parser; forward the driver's original column metadata",
          );
        }
        columns.push(column.name);
        const parser = column.parser;
        // The native postgres.js array parser consumes the text after the
        // opening brace. The caller supplies a catalog-proven array fact;
        // no undocumented parser flags or private mapper imports are needed.
        decoders.set(
          column.name,
          parser
            ? (text, array) => parser(array ? text.slice(1) : text)
            : (text) => text,
        );
      }
      return { rows: rows as unknown[][], columns, decoders };
    },
    exec: async (q: string) => {
      await s.unsafe(q);
    },
  });
  const adaptTx = (s: PostgresTx): Db =>
    frameworkTransactionHandle({
      ...adapt(s),
      transactionScoped: true,
      savepoint: <T>(fn: (sp: Db) => Promise<T>) =>
        s.savepoint((spSql) => fn(adaptTx(spSql))) as Promise<T>,
    });
  // postgres.js `reserve()` returns a query client bound to one connection, but unlike the root client it does
  // not actually expose `.begin()` at runtime (the published declaration inherits it incorrectly). Running
  // `sql.begin()` here would need a second pool slot and deadlock when the caller configured `max: 1`; explicit
  // transaction statements keep both the advisory lock and migration DDL on this reserved session. SQL
  // savepoints are safe here because the handle is not inside postgres.js's `begin` callback error tracking.
  const adaptReservedTx = (s: PostgresReserved): PostgresTx => ({
    unsafe: (query, params) => s.unsafe(query, params),
    savepoint: async <T>(
      fn: (sp: PostgresTx) => Promise<T> | T,
    ): Promise<T> => {
      const name = `hz_reserved_sp_${++reservedSavepointSeq}`;
      await s.unsafe(`SAVEPOINT ${name}`);
      try {
        const value = await fn(adaptReservedTx(s));
        await s.unsafe(`RELEASE SAVEPOINT ${name}`);
        return value;
      } catch (error) {
        await s.unsafe(`ROLLBACK TO SAVEPOINT ${name}`);
        await s.unsafe(`RELEASE SAVEPOINT ${name}`);
        throw error;
      }
    },
  });
  const adaptReserved = (s: PostgresReserved): Db & Transactor => ({
    ...adapt(s),
    transaction: async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => {
      await s.unsafe("BEGIN");
      try {
        const value = await fn(adaptTx(adaptReservedTx(s)));
        await s.unsafe("COMMIT");
        return value;
      } catch (error) {
        await s.unsafe("ROLLBACK").catch(() => {});
        throw error;
      }
    },
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
        return await fn(adaptReserved(held));
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
    /duplicate key value violates unique constraint/i.test(msg);
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
 *  a half-open tx. Only a thrown abort escaping the thunk is retried. The custom-op pipeline normally
 *  catches handler failures into Result errors: wrapping that transaction opener does not silently
 *  re-run those handlers or their external side effects. */
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

/** True only for a callback handle created by Hazelnut's `pgliteDb`/`postgresDb` transaction adapters. */
export function isFrameworkTransactionHandle(db: Db): boolean {
  return typeof db === "object" && db !== null &&
    FRAMEWORK_TRANSACTION_HANDLES.has(db);
}
