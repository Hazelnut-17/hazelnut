// Keep both native adapter dependencies in the runtime graph. Type-only discovery
// lets a later lazy import change Drizzle's optional-peer identity during cold
// Deno resolution. Loading the library does not construct an engine or connection.
import {
  type PGlite,
  type Results,
  types as pgliteTypes,
} from "@electric-sql/pglite";
import postgres from "postgres";
import { noteTransactionRetry } from "../core/transaction-retry-observation.ts";
import { thrownField } from "../core/throw-value.ts";
import {
  inTransactionScope,
  transactionScopeSource,
} from "./transaction-scope.ts";

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
   *  pool, `max >= 2`) — true for `postgresDb`, false for single-connection `pgliteDb` (a query during an open
   *  `.transaction()` there deadlocks the one connection). The relay reads this to gate out-of-band task progress. */
  readonly concurrent?: boolean;
  /** Run one autocommit statement on an independent, short-lived connection. Unlike querying the root
   *  pool, this still makes progress when every pool slot is occupied by an operation transaction.
   *  Sequence allocation uses it for gaps-ok partition counters. Absent on PGlite's single connection. */
  autocommitQuery?<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
  /** Run a transaction on an independent, short-lived connection, even while the root pool is fully
   *  occupied. Feature jobs use this for bounded work while their cron claim keeps its own tx open. */
  independentTransaction?<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  /** Pins every query inside `fn` to ONE pooled connection. Session-scoped state (an advisory lock taken
   *  with `pg_try_advisory_lock`) is only released by the SAME session that took it — on a rotating pool an
   *  un-pinned acquire/release pair releases nothing and the first connection holds the lock until recycled.
   *  Absent on single-connection handles (PGlite), where every query is already the one session. */
  reserve?<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  /** Cancel backend `pid` on an independent channel, even with every root-pool slot occupied.
   * Resolve only when the issued side effect and channel teardown have settled in bounded time: the
   * caller joins this promise before releasing its transaction backend. A detached/root-pool-queued
   * cancel is unsafe. Native cancellation is best-effort on failure; statement_timeout is its backstop.
   * Absent on PGlite and structural clients without independent connection settings. */
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

/** Some manual transaction drivers resolve after COMMIT silently rolls an aborted transaction back.
 * Check the backend before accepting success, retaining the original unrecovered SQL error for classification. */
class ManualTransactionHealth {
  private failure: unknown;

  async statement<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const code = sqlState(error);
      if (
        this.failure === undefined && code !== undefined && code !== "25P02"
      ) {
        this.failure = error;
      }
      throw error;
    }
  }

  checkpoint(): unknown {
    return this.failure;
  }

  restored(previous: unknown): void {
    this.failure = previous;
  }

  async assertUsable(probe: () => Promise<unknown>): Promise<void> {
    try {
      await probe();
    } catch (error) {
      throw sqlState(error) === "25P02" && this.failure !== undefined
        ? this.failure
        : error;
    }
  }

  monitor(db: Db): Db {
    return {
      ...db,
      query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
        this.statement(() => db.query<T>(sql, params)),
      ...(db.queryArrays === undefined ? {} : {
        queryArrays: (sql: string, params?: unknown[]) =>
          this.statement(() => db.queryArrays!(sql, params)),
      }),
      exec: (sql: string) => this.statement(() => db.exec(sql)),
    };
  }
}

let pgliteSavepointSeq = 0;

const asText = (text: string) => text;

/** PGlite's tokenizer keeps shared quote state. Finish tokenizing before a user
 * or strict scalar decoder can throw; otherwise the next unrelated array starts
 * inside the rejected leaf. Preserve NULL leaves and native dimensions. */
function parsedArray(
  text: string,
  element: (text: string) => unknown,
  oid: number,
): unknown {
  const raw: unknown = pgliteTypes.arrayParser(text, asText, oid);
  const decode = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(decode)
      : value === null
      ? null
      : typeof value === "string"
      ? element(value)
      : value;
  return decode(raw);
}

/** PostgreSQL ISO output is unambiguous; permissive Date parsing can swap DMY
 * fields or turn a non-ISO session's result into Invalid Date. Never emit either. */
function instantFromIso(text: string): Date {
  const match =
    /^(\d{4,6}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}(?::?\d{2})?(?::?\d{2})?)$/
      .exec(text);
  if (match) {
    const [year, month, day] = match[1]!.split("-").map(Number);
    const [hour, minute, seconds] = match[2]!.split(":");
    const [second, fraction = ""] = seconds!.split(".");
    const zone = match[3]!;
    const parts = zone === "Z"
      ? []
      : zone.slice(1).replaceAll(":", "").match(/.{2}/g)!;
    const offset = (Number(parts[0] ?? 0) * 3600 +
      Number(parts[1] ?? 0) * 60 + Number(parts[2] ?? 0)) *
      (zone.startsWith("-") ? -1 : 1);
    // Date.UTC accepts second-resolution historical offsets, unlike Date.parse.
    // Its special 0..99 year rule needs one Gregorian 400-year cycle removed.
    const early = year! < 100;
    const value = new Date(
      Date.UTC(
        early ? year! + 400 : year!,
        month! - 1,
        day!,
        Number(hour),
        Number(minute),
        Number(second) - offset,
        Number(fraction.padEnd(3, "0").slice(0, 3)),
      ) - (early ? 146097 * 86400000 : 0),
    );
    if (Number.isFinite(value.getTime())) return value;
  }
  throw new Error(
    "db/timestamptz-format: expected ISO output within the JavaScript Date range; configure DateStyle = ISO and reconnect an already-open PostgreSQL client",
  );
}

/** Preserve an explicitly requested input order while choosing ISO output.
 * Unknown or conflicting configuration still reaches PostgreSQL's own refusal. */
function isoDateStyle(requested: unknown): unknown {
  if (requested === undefined) return "ISO";
  if (typeof requested !== "string") return requested;
  let style: string | undefined;
  let order: string | undefined;
  for (
    const part of requested.toLowerCase().split(",").map((part) => part.trim())
  ) {
    const next = part === "dmy" || part === "euro" || part === "european"
      ? "DMY"
      : part === "mdy" || part === "us" || part === "noneuro" ||
          part === "noneuropean"
      ? "MDY"
      : part === "ymd"
      ? "YMD"
      : undefined;
    if (next) {
      if (order && order !== next) return requested;
      order = next;
    } else if (["iso", "sql", "postgres", "german"].includes(part)) {
      if (style && style !== part) return requested;
      style = part;
    } else return requested;
  }
  return `ISO${order ? `, ${order}` : style === "german" ? ", DMY" : ""}`;
}

function preferIsoStartup(sql: PostgresSql): void {
  if (!sql.options) return;
  const original = Reflect.get(sql.options, "connection");
  const settings = typeof original === "object" && original !== null
    ? Object.entries(original)
    : [];
  const requested = settings.filter(([key]) =>
    key.toLowerCase() === "datestyle"
  ).at(-1)?.[1];
  Reflect.set(sql.options, "connection", {
    ...Object.fromEntries(
      settings.filter(([key]) => key.toLowerCase() !== "datestyle"),
    ),
    DateStyle: isoDateStyle(requested),
  });
}

/** int8 and int8[] read as decimal text, as postgres.js returns them (03-api-shape.md §db-schema).
 *  `date` / `timestamp` / `time` / `timetz` read as the PostgreSQL text too: postgres.js otherwise parses
 *  `date` and `timestamp` with the same Date handler as `timestamptz`, and a later `toISOString` shifts a
 *  wall-clock timestamp by the process zone. `timestamptz` (1184) stays a Date — that is `z.date()`.
 *  Passed per query so the caller's own PGlite instance keeps its parsers. */
const INT8_AS_TEXT: Readonly<
  Record<number, (text: string, typeId?: number) => unknown>
> = {
  20: asText,
  1016: (text) => parsedArray(text, asText, 1016),
  [pgliteTypes.DATE]: asText,
  [pgliteTypes.TIMESTAMP]: asText,
  [pgliteTypes.TIME]: asText,
  [pgliteTypes.TIMETZ]: asText,
  1184: instantFromIso,
  1185: (text) => parsedArray(text, instantFromIso, 1185),
  1182: (text) => parsedArray(text, asText, 1182),
  1115: (text) => parsedArray(text, asText, 1115),
  1183: (text) => parsedArray(text, asText, 1183),
  1270: (text) => parsedArray(text, asText, 1270),
};

/** date[] / timestamp[] / time[] / timetz[]. postgres.js discovers these after connect and
 *  closes the element codec into the array handler. 1082 and 1114 share the timestamptz
 *  Date codec, so a wall-clock string in an array is rewritten with `toISOString` before
 *  it is stored. Install both sides here, before or after that discovery. */
const CALENDAR_ARRAY_OIDS = [1182, 1115, 1183, 1270] as const;

function calendarText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function calendarArrayText(value: unknown): string {
  if (!Array.isArray(value)) return calendarText(value);
  if (value.length === 0) return "{}";
  return `{${
    value.map((item) =>
      item === null
        ? "null"
        : Array.isArray(item)
        ? calendarArrayText(item)
        : `"${
          calendarText(item).replaceAll("\\", "\\\\").replaceAll('"', '\\"')
        }"`
    ).join(",")
  }}`;
}

/** A postgres.js array parser is handed text with the first `{` already removed.
 *  A one-dimensional value then no longer starts with `{`. A deeper value still does,
 *  but its first `}` closes before the end, so the outer brace has to be put back
 *  or only the first child is kept. */
function calendarArrayLiteral(text: string): string {
  if (!text.startsWith("{")) return `{${text}`;
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === "\\") i++;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) return i === text.length - 1 ? text : `{${text}`;
    }
  }
  return `{${text}`;
}

/** postgres.js calls an array parser with `.array` after dropping the opening brace. */
function calendarArrayValue(text: string): unknown {
  return parsedArray(
    calendarArrayLiteral(text),
    asText,
    pgliteTypes.TIMESTAMP,
  );
}
Object.assign(calendarArrayValue, { array: true });

function instantArrayValue(text: string): unknown {
  return parsedArray(
    calendarArrayLiteral(text),
    instantFromIso,
    1185,
  );
}
Object.assign(instantArrayValue, { array: true });

const ARRAY_NULL_GUARD = Symbol.for("hazelnut.array-null");

function arrayElementOid(map: object, arrayOid: number): number | undefined {
  for (const [element, array] of Object.entries(map)) {
    if (Number(array) === arrayOid) return Number(element);
  }
  return undefined;
}

/** The scalar codec at the bottom of an array oid. postgres.js stores `int4[][]`
 *  under the `int4[]` codec, which would turn a leaf `"1"` into an array. */
function scalarElementParser(
  parsers: object,
  map: object,
  arrayOid: number,
): (text: string) => unknown {
  let oid = arrayOid;
  for (let depth = 0; depth < 8; depth++) {
    const element = arrayElementOid(map, oid);
    if (element === undefined) break;
    const parser = Reflect.get(parsers, element);
    const arrayParser = typeof parser === "function" &&
      Reflect.get(parser, "array") === true;
    if (!arrayParser) {
      return typeof parser === "function" ? parser : asText;
    }
    oid = element;
  }
  return asText;
}

function nullSafeArrayParser(
  element: (text: string) => unknown,
  oid: number,
): (text: string) => unknown {
  const parse = (text: string) =>
    parsedArray(calendarArrayLiteral(text), element, oid);
  Object.assign(parse, { array: true });
  return parse;
}

/** postgres.js hands the letters `NULL` to the element codec, so a null becomes the
 *  string `"NULL"`, `NaN`, or `false`. Install a null-keeping parser for array oids
 *  already discovered, and for every array oid the driver adds on its first query. */
function installArrayNullGuard(sql: PostgresSql): void {
  if (sql.options === undefined) return;
  if (Reflect.get(sql.options, ARRAY_NULL_GUARD) === true) return;
  const parsers = Reflect.get(sql.options, "parsers");
  const shared = Reflect.get(sql.options, "shared");
  const typeArrayMap = typeof shared === "object" && shared !== null
    ? Reflect.get(shared, "typeArrayMap")
    : undefined;
  if (typeof parsers !== "object" || parsers === null) return;
  if (typeof typeArrayMap === "object" && typeArrayMap !== null) {
    for (const arrayOid of new Set(Object.values(typeArrayMap).map(Number))) {
      Reflect.set(
        parsers,
        arrayOid,
        nullSafeArrayParser(
          scalarElementParser(parsers, typeArrayMap, arrayOid),
          arrayOid,
        ),
      );
    }
  }
  const map = typeArrayMap;
  const proxy = new Proxy(parsers, {
    set(target, prop, value) {
      const oid = Number(prop);
      if (
        typeof map === "object" && map !== null && Number.isInteger(oid) &&
        arrayElementOid(map, oid) !== undefined
      ) {
        return Reflect.set(
          target,
          prop,
          nullSafeArrayParser(scalarElementParser(target, map, oid), oid),
        );
      }
      return Reflect.set(target, prop, value);
    },
  });
  Reflect.set(sql.options, "parsers", proxy);
  Reflect.set(sql.options, ARRAY_NULL_GUARD, true);
}

/** postgres.js bundles oid 1082 and 1114 into the timestamptz Date parser. A client handed to `postgresDb`
 *  keeps timestamptz as Date and reads calendar scalars and their arrays as the text the server sent. */
function keepCalendarText(sql: PostgresSql): void {
  if (sql.options === undefined) return;
  const parsers = Reflect.get(sql.options, "parsers");
  const serializers = Reflect.get(sql.options, "serializers");
  if (typeof parsers !== "object" || parsers === null) return;
  Reflect.set(parsers, pgliteTypes.DATE, asText);
  Reflect.set(parsers, pgliteTypes.TIMESTAMP, asText);
  Reflect.set(parsers, 1184, instantFromIso);
  Reflect.set(parsers, 1185, instantArrayValue);
  if (typeof serializers === "object" && serializers !== null) {
    Reflect.set(serializers, pgliteTypes.DATE, calendarText);
    Reflect.set(serializers, pgliteTypes.TIMESTAMP, calendarText);
    // Strings bound as timestamptz must reach PostgreSQL. `new Date` throws on
    // "not-a-time" and overflows 31 Feb. Reads stay Dates: only the serializer changes.
    Reflect.set(serializers, 1184, calendarText);
    Reflect.set(serializers, 1185, calendarArrayText);
  }
  for (const oid of CALENDAR_ARRAY_OIDS) {
    Reflect.set(parsers, oid, calendarArrayValue);
    if (typeof serializers === "object" && serializers !== null) {
      Reflect.set(serializers, oid, calendarArrayText);
    }
  }
  installArrayNullGuard(sql);
}

// Keep a logical root query and its lazy type lookup ahead of a later transaction on this engine.
// Transaction callbacks use their own bound query handle and never re-enter this root queue.
const PGLITE_OPERATIONS = new WeakMap<PGlite, Promise<void>>();
function pgliteOperation<T>(pg: PGlite, run: () => Promise<T>): Promise<T> {
  const next = (PGLITE_OPERATIONS.get(pg) ?? Promise.resolve()).then(run);
  PGLITE_OPERATIONS.set(pg, next.then(() => {}, () => {}));
  return next;
}

/** Adapt a PGlite instance to `Db & Transactor` — the tx callback receives a `Db` bound to the PG tx. */
export function pgliteDb(pg: PGlite): Db & Transactor {
  let dateStyleReady = false;
  const operation = <T>(run: () => Promise<T>): Promise<T> =>
    pgliteOperation(pg, async () => {
      if (!dateStyleReady) {
        await pg.exec("SET DateStyle TO ISO");
        dateStyleReady = true;
      }
      return await run();
    });
  // PGlite discovers arrays before extensions are created. Resolve new result OIDs on demand,
  // without refreshing or mutating the caller's parser table and without replaying their statement.
  const arrayElements = new Map<number, number>();
  const decode = (id: number) => (text: string): unknown => {
    const parse = INT8_AS_TEXT[id] ?? pg.parsers[id];
    if (parse) return parse(text, id);
    const element = arrayElements.get(id);
    return element ? parsedArray(text, decode(element), id) : text;
  };
  const query = async <T>(
    source: Pick<PGlite, "query">,
    sql: string,
    params?: unknown[],
    positional = false,
  ): Promise<Results<T>> => {
    const result = await source.query<T>(sql, params, {
      rowMode: positional ? "array" : "object",
      parsers: INT8_AS_TEXT,
    });
    const unseen = [...new Set(result.fields.map((field) => field.dataTypeID))]
      .filter((id) =>
        !INT8_AS_TEXT[id] && !pg.parsers[id] && !arrayElements.has(id)
      );
    if (unseen.length > 0) {
      const types = await source.query<{ oid: string; element: string }>(
        `SELECT t.oid::text AS oid,
          (CASE WHEN t.typcategory = 'A' AND e.typdelim = ',' THEN t.typelem ELSE 0::oid END)::text AS element
         FROM pg_catalog.pg_type t LEFT JOIN pg_catalog.pg_type e ON e.oid = t.typelem
         WHERE t.oid IN (${
          unseen.map((_, index) => `$${index + 1}::oid`).join(", ")
        })`,
        unseen,
        {
          parsers: { [pgliteTypes.TEXT]: (text) => text },
          serializers: { [pgliteTypes.OID]: (value) => String(value) },
        },
      );
      for (const type of types.rows) {
        arrayElements.set(Number(type.oid), Number(type.element));
      }
    }
    // Object mode keeps the last duplicate label, exactly as the driver's Object.fromEntries does.
    const fields = positional
      ? result.fields.map((field, index) => [String(index), field] as const)
      : [
        ...new Map(result.fields.map((field) => [field.name, field])).entries(),
      ];
    for (const row of result.rows) {
      if (row === null || typeof row !== "object") continue;
      for (const [key, field] of fields) {
        const id = field.dataTypeID;
        if (!arrayElements.get(id) || INT8_AS_TEXT[id] || pg.parsers[id]) {
          continue;
        }
        const value: unknown = Reflect.get(row, key);
        if (typeof value === "string") Reflect.set(row, key, decode(id)(value));
      }
    }
    return result;
  };
  const positionalRows = (result: Results<unknown[]>): NativeArrayRows => ({
    rows: result.rows,
    columns: result.fields.map((field) => field.name),
    decoders: new Map(
      result.fields.map((field) => [field.name, decode(field.dataTypeID)]),
    ),
  });
  return {
    query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
      operation(
        async () => ({ rows: (await query<T>(pg, sql, params)).rows }),
      ),
    queryArrays: (sql, params) =>
      operation(
        async () =>
          positionalRows(await query<unknown[]>(pg, sql, params, true)),
      ),
    exec: (sql: string) =>
      operation(() => pg.exec(sql, { parsers: INT8_AS_TEXT })),
    concurrent: false,
    transaction: <T>(fn: (tx: Db) => Promise<T>) =>
      operation(() =>
        pg.transaction(async (tx) => {
          const health = new ManualTransactionHealth();
          const handle: Db = frameworkTransactionHandle(health.monitor({
            query: async <U = Record<string, unknown>>(
              sql: string,
              params?: unknown[],
            ) => ({ rows: (await query<U>(tx, sql, params)).rows }),
            queryArrays: async (sql, params) =>
              positionalRows(await query<unknown[]>(tx, sql, params, true)),
            exec: (sql: string) => tx.exec(sql, { parsers: INT8_AS_TEXT }),
            concurrent: false,
            transactionScoped: true,
            // PGlite raises an inner failure to this callback only, so the SQL form is the driver's own here.
            savepoint: async <U>(fn: (sp: Db) => Promise<U>): Promise<U> => {
              const name = `hz_sp_${++pgliteSavepointSeq}`;
              const previous = health.checkpoint();
              await health.statement(() => tx.exec(`SAVEPOINT ${name}`));
              try {
                const v = await fn(handle);
                await health.statement(() =>
                  tx.exec(`RELEASE SAVEPOINT ${name}`)
                );
                return v;
              } catch (e) {
                await health.statement(() =>
                  tx.exec(`ROLLBACK TO SAVEPOINT ${name}`)
                );
                await health.statement(() =>
                  tx.exec(`RELEASE SAVEPOINT ${name}`)
                );
                health.restored(previous);
                throw e;
              }
            },
          }));
          const value = await inTransactionScope(handle, fn);
          await health.assertUsable(() => tx.query("SELECT 1"));
          return value;
        })
      ) as Promise<T>,
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
  /** postgres.js's public parsed connection options. Structural custom clients may omit them. */
  readonly options?: object;
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
  preferIsoStartup(sql);
  keepCalendarText(sql);
  let reservedSavepointSeq = 0;
  // Copy public connection settings only. Parsed options also carry live driver state, which a second
  // client must never share. A dedicated short connection avoids the max:1 / fully occupied pool deadlock.
  const connectionOptions = sql.options === undefined
    ? undefined
    : Object.fromEntries(
      [
        "host",
        "port",
        "path",
        "database",
        "user",
        "pass",
        "password",
        "ssl",
        "sslnegotiation",
        "connect_timeout",
        "connection",
        "target_session_attrs",
        "socket",
        "onnotice",
        "onparameter",
        "onclose",
        "debug",
        "prepare",
        "fetch_types",
      ].filter((key) => key in sql.options!).map((key) => [
        key,
        Reflect.get(sql.options!, key),
      ]),
    );
  const autocommitQuery: Db["autocommitQuery"] = connectionOptions === undefined
    ? undefined
    : async <T = Record<string, unknown>>(
      q: string,
      params?: unknown[],
    ): Promise<{ rows: T[] }> => {
      const one = postgres({ ...connectionOptions, max: 1 });
      keepCalendarText(one as PostgresSql);
      try {
        return {
          rows:
            (await one.unsafe(q, (params ?? []) as never[])) as unknown as T[],
        };
      } finally {
        await one.end();
      }
    };
  const independentTransaction: Db["independentTransaction"] =
    connectionOptions === undefined
      ? undefined
      : async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => {
        const one = postgres({ ...connectionOptions, max: 1 });
        keepCalendarText(one as PostgresSql);
        try {
          return await (one.begin((txSql) =>
            inTransactionScope(adaptTx(txSql), fn)
          ) as Promise<T>);
        } finally {
          await one.end();
        }
      };
  const adapt = (s: PostgresUnsafe): Db => ({
    ...(autocommitQuery ? { autocommitQuery } : {}),
    ...(independentTransaction ? { independentTransaction } : {}),
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
        // Match the pinned postgres.js DataRow framing: only its generated
        // parsers marked `.array === true` consume text after the opening
        // brace. Plain caller parsers receive the complete native literal.
        // This untyped driver convention needs parity checks on upgrades;
        // catalog array identity alone cannot choose a callback's input.
        decoders.set(
          column.name,
          parser
            ? (text) =>
              parser(
                Reflect.get(parser, "array") === true ? text.slice(1) : text,
              )
            : (text) => text,
        );
      }
      return { rows: rows as unknown[][], columns, decoders };
    },
    exec: async (q: string) => {
      await s.unsafe(q);
    },
  });
  const adaptTx = (s: PostgresTx, health?: ManualTransactionHealth): Db =>
    frameworkTransactionHandle({
      ...(health === undefined ? adapt(s) : health.monitor(adapt(s))),
      transactionScoped: true,
      savepoint: <T>(fn: (sp: Db) => Promise<T>) =>
        s.savepoint((spSql) => fn(adaptTx(spSql, health))) as Promise<T>,
    });
  // postgres.js `reserve()` returns a query client bound to one connection, but unlike the root client it does
  // not actually expose `.begin()` at runtime (the published declaration inherits it incorrectly). Running
  // `sql.begin()` here would need a second pool slot and deadlock when the caller configured `max: 1`; explicit
  // transaction statements keep both the advisory lock and migration DDL on this reserved session. SQL
  // savepoints are safe here because the handle is not inside postgres.js's `begin` callback error tracking.
  const adaptReservedTx = (
    s: PostgresReserved,
    health: ManualTransactionHealth,
  ): PostgresTx => ({
    unsafe: (query, params) => s.unsafe(query, params),
    savepoint: async <T>(
      fn: (sp: PostgresTx) => Promise<T> | T,
    ): Promise<T> => {
      const name = `hz_reserved_sp_${++reservedSavepointSeq}`;
      const previous = health.checkpoint();
      await health.statement(() => s.unsafe(`SAVEPOINT ${name}`));
      try {
        const value = await fn(adaptReservedTx(s, health));
        await health.statement(() => s.unsafe(`RELEASE SAVEPOINT ${name}`));
        return value;
      } catch (error) {
        await health.statement(() => s.unsafe(`ROLLBACK TO SAVEPOINT ${name}`));
        await health.statement(() => s.unsafe(`RELEASE SAVEPOINT ${name}`));
        health.restored(previous);
        throw error;
      }
    },
  });
  const adaptReserved = (s: PostgresReserved): Db & Transactor => ({
    ...adapt(s),
    transaction: async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => {
      await s.unsafe("BEGIN");
      const health = new ManualTransactionHealth();
      try {
        const value = await inTransactionScope(
          adaptTx(adaptReservedTx(s, health), health),
          fn,
        );
        await health.assertUsable(() => s.unsafe("SELECT 1"));
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
      sql.begin((txSql) => inTransactionScope(adaptTx(txSql), fn)) as Promise<
        T
      >,
    reserve: async <T>(fn: (one: Db) => Promise<T>): Promise<T> => {
      const held = await sql.reserve();
      try {
        return await fn(adaptReserved(held));
      } finally {
        await held.release();
      }
    },
    ...(connectionOptions === undefined ? {} : {
      cancelBackend: async (pid: number): Promise<void> => {
        // The root pool may have max:1. Joining a cancel queued on that same pool would deadlock;
        // abandoning it could target a backend after its transaction releases it for another caller.
        const startup = connectionOptions.connection;
        const one = postgres({
          ...connectionOptions,
          max: 1,
          connect_timeout: 5,
          connection: {
            ...(typeof startup === "object" && startup !== null ? startup : {}),
            statement_timeout: 1000,
          },
        });
        const pending = one.unsafe(
          `SELECT pg_cancel_backend($1)`,
          [pid] as never[],
        ).then(() => {});
        // Start teardown alongside the issued query, bounding a lost response as well as connect.
        // Both settle before returning; no timed-out cancel promise is left running in the background.
        const [query, closed] = await Promise.allSettled([
          pending,
          one.end({ timeout: 5 }),
        ]);
        if (query.status === "rejected") throw query.reason;
        if (closed.status === "rejected") throw closed.reason;
      },
    }),
  };
}

/** A Postgres unique-violation (SQLSTATE `23505`) — a `unique`-feature clash, or a concurrent singleton
 *  seed losing the PK race. Lives in `db.ts` (the lowest layer) so every consumer (pipeline's `conflict`
 *  mapping, HTTP/MCP doors, the read-or-create seed) shares one predicate without a layer-inverting import. */
export function isUniqueViolation(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  if (thrownField(e, "code") === "23505") return true;
  const msg = thrownField(e, "message");
  return typeof msg === "string" &&
    /duplicate key value violates unique constraint/i.test(msg);
}

/** A Postgres exclusion-constraint violation (SQLSTATE `23P01`) — the `temporal: { noOverlap }` exclude
 *  refusing an overlapping validity window; same `conflict` mapping tier as `isUniqueViolation` (04-features.md §temporal). */
export function isExclusionViolation(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  if (thrownField(e, "code") === "23P01") return true;
  const msg = thrownField(e, "message");
  return typeof msg === "string" && /exclusion constraint/i.test(msg);
}

/** A Postgres foreign-key violation (SQLSTATE `23503`) — the junction `link` INSERT hits this on a TOCTOU
 *  (endpoint check passes, target hard-deleted before the cascade-FK insert); mapped to `notFound`, never a raw 500. */
export function isForeignKeyViolation(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  if (thrownField(e, "code") === "23503") return true;
  const msg = thrownField(e, "message");
  return typeof msg === "string" &&
    /foreign key constraint|violates foreign key/i.test(msg);
}

/** A Postgres deadlock (`40P01`) or serialization failure (`40001`) — a transient concurrency abort the
 *  engine resolves by rolling back one victim tx; retry the whole transaction. Can still surface rarely from
 *  the rollup×cascade lock order (`repo.ts lockRollupCascadeEdges`) or concurrent EXCLUDE insert/check;
 *  neither is proof that a final committed row occupies the rejected request's window. */
export function isDeadlock(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const code = thrownField(e, "code");
  if (code === "40P01" || code === "40001") return true;
  const msg = thrownField(e, "message");
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
      if (attempt > 1) noteTransactionRetry(false);
      return await fn();
    } catch (e) {
      if (attempt >= attempts) {
        try {
          if (isDeadlock(e)) noteTransactionRetry(true);
        } catch {
          /* observing the capped error cannot replace the original throw */
        }
        throw e;
      }
      if (!isDeadlock(e)) throw e;
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
    FRAMEWORK_TRANSACTION_HANDLES.has(transactionScopeSource(db));
}

/** The SQLSTATE of a driver error, or undefined. */
function sqlState(e: unknown): string | undefined {
  const code = thrownField(e, "code");
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)
    ? code
    : undefined;
}

/** A database refusal as a door reports it: the kind and a fixed message naming the class of problem,
 *  never the table, constraint or value Postgres quoted. */
export type DbFault = {
  readonly kind: "conflict" | "validation";
  readonly message: string;
};

/** An integrity clash (unique, foreign key, exclusion) — a `conflict` whoever's SQL raised it. */
export function integrityFault(e: unknown): DbFault | undefined {
  if (isUniqueViolation(e)) {
    return { kind: "conflict", message: "unique constraint violated" };
  }
  if (isForeignKeyViolation(e)) {
    return { kind: "conflict", message: "foreign key constraint violated" };
  }
  if (isExclusionViolation(e)) {
    return {
      kind: "conflict",
      message:
        "validity windows overlap — a same-key row already holds an overlapping window (temporal noOverlap)",
    };
  }
  return undefined;
}

/** `integrityFault`, plus a value the database cannot store (class 22, 23502, 23514) as `validation`.
 *  A CRUD door and `ctx.i18n.set` may say so: there the values are the caller's. In a view or an
 *  operation's own SQL the same SQLSTATE is the author's bug and stays `internal`. */
export function dbFault(e: unknown): DbFault | undefined {
  const integrity = integrityFault(e);
  if (integrity !== undefined) return integrity;
  const code = sqlState(e);
  if (code === undefined) return undefined;
  const validation = (message: string) =>
    ({ kind: "validation", message }) as const;
  if (code === "23502") return validation("a required value is missing");
  if (code === "23514") {
    return validation("a value is not one its column allows");
  }
  if (code === "22001") {
    return validation("a value is longer than its column allows");
  }
  if (code === "22003") {
    return validation("a number is outside the range its column stores");
  }
  if (code === "22021" || code === "22P05") {
    return validation(
      "a text value contains a character the database cannot store (U+0000)",
    );
  }
  if (code === "54000") {
    const diagnostic = thrownField(e, "message");
    const message = typeof diagnostic === "string" ? diagnostic : "";
    // An incompressible indexed value overflows the btree page. Other 54000
    // program limits stay internal: they are not the caller's stored value.
    if (
      message.includes("index row size") || message.includes("row is too big")
    ) {
      return validation("a value is too long to store in an index");
    }
  }
  if (code.startsWith("22")) {
    return validation("a value is not valid for its column type");
  }
  return undefined;
}
