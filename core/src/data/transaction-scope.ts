/** Logical ownership of one connection's savepoint stack. Independent connections do not share it. */
import type {
  Db,
  TransactionIsolationLevel,
  TransactionOptions,
  Transactor,
} from "./db.ts";

interface Scope {
  raw: Db;
  db: Db;
  readonly bounded: boolean;
  readonly assigned: Map<PropertyKey, unknown>;
  readonly parent?: Scope;
  child?: Scope;
  readonly pending: Set<Promise<unknown>>;
  readonly independentPending: Set<Promise<unknown>>;
  readonly independentScopes: Set<Scope>;
  state: "open" | "closing" | "closed";
  managed: boolean;
  readonly interrupted: Promise<never>;
  interrupt(reason: unknown): void;
  reason?: unknown;
  task?: Promise<unknown>;
}

const scopes = new WeakMap<Db, Scope>();
// A root port remains a root between callbacks, even when an adapter supplies that same object as tx.
const roots = new WeakMap<Db, Db>();
const rootSources = new WeakMap<Db, Db>();
const callbacks = new WeakMap<Db, Db>();
// A borrowed logical callback shares its parent's physical transaction and lock history.
const borrowedParents = new WeakMap<Db, Db>();
// A root declaration belongs to its facade, never to a driver object reused as a callback.
const declaredRoots = new WeakSet<Db>();
const frameworkTransactionRoots = new WeakSet<object>();
const applyIntrinsic = Reflect.apply;
const ISOLATION_LEVEL_SQL: Record<TransactionIsolationLevel, string> = {
  "read committed": "READ COMMITTED",
  "repeatable read": "REPEATABLE READ",
  serializable: "SERIALIZABLE",
};

/** SQL form for an explicit root-transaction isolation choice. */
export function transactionIsolationStatement(
  options: TransactionOptions | undefined,
): string | undefined {
  if (options?.isolationLevel === undefined) return undefined;
  const level = ISOLATION_LEVEL_SQL[options.isolationLevel];
  if (level === undefined) {
    throw new TypeError("transaction/isolation: unsupported isolation level");
  }
  return `SET TRANSACTION ISOLATION LEVEL ${level}`;
}
// The facade owns this particular operation's root callback until it returns.
// Its private handle is distinct from the adapter's externally held handle.
const ownedWrites = new WeakSet<Db>();
const retiredOwnedWrites = new WeakSet<Db>();

/** Called only inside a framework-owned root transaction or savepoint callback. */
export async function inOwnedWriteBoundary<T>(
  tx: Db,
  fn: (owned: Db) => Promise<T>,
): Promise<T> {
  assertOwnedWriteBoundaryActive(tx);
  const owned = new Proxy(tx, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  ownedWrites.add(owned);
  // The private view has the same transaction's edge-lock history as the
  // callback handle. A new object must not appear to be a fresh connection.
  borrowedParents.set(owned, tx);
  try {
    return await fn(owned);
  } finally {
    ownedWrites.delete(owned);
    retiredOwnedWrites.add(owned);
    borrowedParents.delete(owned);
  }
}

/** Refuse entry through an owned handle whose private owner has already closed. */
export function assertOwnedWriteBoundaryActive(db: Db): void {
  const seen = new Set<Db>();
  for (let current = db;;) {
    if (retiredOwnedWrites.has(current)) {
      throw new TransactionScopeError(
        "an owned write boundary has already closed",
      );
    }
    if (!ownedWrites.has(current)) return;
    const parent = borrowedParents.get(current);
    if (parent === undefined || seen.has(current)) {
      throw new TransactionScopeError(
        "an owned write boundary has no active parent",
      );
    }
    seen.add(current);
    current = parent;
  }
}

export function ownsWriteBoundary(db: Db): boolean {
  return ownedWrites.has(db);
}

/** A fixed authored-usage refusal; carried as a Result code through every served data/op door. */
export class TransactionScopeError extends Error {
  readonly kind = "validation" as const;
  readonly code = "transaction/scope-overlap";
  constructor(detail: string) {
    super(
      `transaction/scope-overlap: ${detail}; await each transaction/savepoint effect and use the active callback's handle for nested work`,
    );
  }
}

const overlap = (detail: string): TransactionScopeError =>
  new TransactionScopeError(detail);

function assertOwner(scope: Scope): void {
  if (scope.state !== "open") {
    throw overlap("this transaction/savepoint handle has already closed");
  }
  if (scope.child !== undefined) {
    throw overlap("a child savepoint owns this connection");
  }
  for (let child = scope; child.parent; child = child.parent) {
    if (child.parent.state !== "open" || child.parent.child !== child) {
      throw overlap("this callback no longer owns its parent transaction");
    }
  }
}

/** Count IO synchronously, before the driver can yield. Concurrent leaf queries are legal; they prevent
 * opening a savepoint until settled, because their SQL must not straddle a new rollback boundary. */
function forward<T>(scope: Scope, run: () => Promise<T>): Promise<T> {
  try {
    assertOwner(scope);
    const task = run();
    scope.pending.add(task);
    task.then(
      () => scope.pending.delete(task),
      () => scope.pending.delete(task),
    );
    return task;
  } catch (error) {
    return Promise.reject(error);
  }
}

/** Independent connections do not reserve this connection, but their work must finish with its callback. */
function forwardIndependent<T>(
  scope: Scope,
  run: () => Promise<T>,
): Promise<T> {
  try {
    if (scope.state !== "open") {
      throw overlap("this transaction/savepoint handle has already closed");
    }
    const task = Promise.resolve(run());
    scope.independentPending.add(task);
    task.then(
      () => scope.independentPending.delete(task),
      () => scope.independentPending.delete(task),
    );
    task.catch(() => {});
    return task;
  } catch (error) {
    return Promise.reject(error);
  }
}

function interruptTree(scope: Scope, reason: unknown): void {
  if (scope.state === "closed") return;
  scope.state = "closing";
  scope.reason = reason;
  scope.interrupt(reason);
  if (scope.child) interruptTree(scope.child, reason);
  for (const independent of scope.independentScopes) {
    interruptTree(independent, reason);
  }
}

/** Invalidate capabilities first, then join DRIVER work, not arbitrary user JavaScript. A child driver's
 * callback races interruption, so even a detached callback awaiting an unrelated promise cannot defer its
 * rollback until after the ancestor has committed/released the connection. Its later IO is refused. */
async function close(scope: Scope, reason: unknown): Promise<void> {
  interruptTree(scope, reason);
  const child = scope.child;
  if (child?.task) await child.task.catch(() => {});
  await Promise.allSettled([...scope.pending, ...scope.independentPending]);
  scope.state = "closed";
}

async function callback<T>(
  scope: Scope,
  fn: (db: Db) => Promise<T>,
  transaction = true,
): Promise<T> {
  try {
    if (scope.state !== "open") throw scope.reason;
    scope.managed = transaction;
    const value = await Promise.race([
      Promise.resolve().then(() => fn(scope.db)),
      scope.interrupted,
    ]);
    if (
      scope.child !== undefined || scope.pending.size !== 0 ||
      scope.independentPending.size !== 0
    ) {
      throw overlap("the callback returned with unfinished database effects");
    }
    scope.state = "closed";
    return value;
  } catch (error) {
    await close(scope, error);
    throw error;
  }
}

function childSavepoint<T>(
  parent: Scope,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  let child: Scope;
  try {
    assertOwner(parent);
    if (parent.pending.size !== 0) {
      throw overlap("a parent query is still pending");
    }
    child = makeScope(parent.raw, parent);
    // Reserve before the driver's first SAVEPOINT await. PGlite may reuse its raw handle for children;
    // the distinct logical handle, rather than raw object identity, owns this reservation.
    parent.child = child;
  } catch (error) {
    return Promise.reject(error);
  }
  const run = async (): Promise<T> => {
    try {
      return await parent.raw.savepoint!((raw) => {
        bindScope(child, raw);
        return callback(child, fn);
      });
    } finally {
      child.state = "closed";
      if (parent.child === child) parent.child = undefined;
    }
  };
  const task = run();
  child.task = task;
  // A caller may start an async sibling and await it later. It still observes the original rejection,
  // while a boundary ending first owns and joins cleanup instead of leaving an unhandled driver task.
  task.catch(() => {});
  return task;
}

/** Preserve class/prototype ports and their private receiver, including optional native transports. */
interface ScopePortAccessor {
  get(): unknown;
  set(value: unknown): void;
  getForDescriptor?(value: unknown): unknown;
}

function delegate<T extends Db>(
  raw: T,
  overrides: ReadonlyMap<PropertyKey, unknown>,
  accessors?: ReadonlyMap<PropertyKey, ScopePortAccessor>,
): T {
  const facade: T = new Proxy(raw, {
    get(target, key) {
      const accessor = accessors?.get(key);
      if (accessor) return accessor.get();
      if (overrides.has(key)) return overrides.get(key);
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, key, value, receiver) {
      const accessor = accessors?.get(key);
      if (accessor && receiver === facade) {
        accessor.set(value);
        return true;
      }
      if (receiver === facade) return Reflect.set(target, key, value, target);
      // Object.create(facade) is a distinct decorator. Its assignment must create an own port,
      // not replace the prototype callback's port and redirect that decorator back into itself.
      return Reflect.set(target, key, value, receiver);
    },
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (!descriptor) return descriptor;
      const accessor = accessors?.get(key);
      // A proxy over a fixed own property cannot present a guarded descriptor.
      // Refuse reflection instead of leaking the raw transaction capability.
      if (
        !descriptor.configurable &&
        (!("value" in descriptor) || !descriptor.writable) &&
        (accessor || overrides.has(key))
      ) {
        throw overlap(
          "a fixed adapter port cannot expose a guarded descriptor",
        );
      }
      if (accessor) {
        if ("value" in descriptor) {
          return {
            ...descriptor,
            value: accessor.getForDescriptor
              ? accessor.getForDescriptor(descriptor.value)
              : accessor.get(),
          };
        }
        return {
          ...descriptor,
          get: descriptor.get === undefined ? undefined : () => accessor.get(),
          set: descriptor.set === undefined
            ? undefined
            : (value: unknown) => accessor.set(value),
        };
      }
      if (overrides.has(key)) {
        const value = overrides.get(key);
        if ("value" in descriptor) return { ...descriptor, value };
        return {
          ...descriptor,
          get: descriptor.get === undefined ? undefined : () => value,
        };
      }
      return descriptor;
    },
  });
  return facade;
}

/** Explicit external bindings expose only Db ports, never the driver's prototype or extensions. */
function boundedDelegate(
  scope: Scope,
  raw: Db,
  overrides: ReadonlyMap<PropertyKey, unknown>,
  accessors: ReadonlyMap<PropertyKey, ScopePortAccessor>,
): Db {
  const ports = [
    "query",
    "exec",
    "queryArrays",
    "concurrent",
    "autocommitQuery",
    "independentTransaction",
    "reserve",
    "cancelBackend",
    "savepoint",
    "transactionScoped",
  ] as const;
  const allowed = new Set<PropertyKey>(ports);
  const target: object = Object.create(null);
  const declared = (key: PropertyKey): boolean => {
    let current: object | null = raw;
    const seen = new Set<object>();
    try {
      while (current !== null && !seen.has(current)) {
        seen.add(current);
        if (Reflect.getOwnPropertyDescriptor(current, key)) return true;
        current = Reflect.getPrototypeOf(current);
      }
    } catch {
      // An opaque adapter may still expose a port through its normal get trap.
    }
    return false;
  };
  const read = (key: PropertyKey): unknown => {
    const accessor = accessors.get(key);
    if (accessor) return accessor.get();
    const value = overrides.has(key)
      ? overrides.get(key)
      : Reflect.get(raw, key, raw);
    if (typeof value !== "function") return value;
    return (...args: unknown[]) => {
      if (
        key === "independentTransaction" || key === "reserve" ||
        key === "autocommitQuery" || key === "cancelBackend"
      ) {
        return forwardIndependent(
          scope,
          () => applyIntrinsic(value, raw, args) as Promise<unknown>,
        );
      }
      if (scope.state !== "open") {
        return Promise.reject(
          overlap("this transaction/savepoint handle has already closed"),
        );
      }
      return applyIntrinsic(value, raw, args);
    };
  };
  for (const key of ports) {
    if (
      key !== "query" && key !== "exec" && !overrides.has(key) && !declared(key)
    ) continue;
    const accessor = accessors.get(key);
    Object.defineProperty(target, key, {
      enumerable: true,
      configurable: true,
      get: () => read(key),
      ...(accessor ? { set: (value: unknown) => accessor.set(value) } : {}),
    });
  }
  const facade: Db = new Proxy(target, {
    get(target, key, receiver) {
      if (!allowed.has(key)) return undefined;
      return Reflect.has(target, key)
        ? Reflect.get(target, key, receiver)
        : read(key);
    },
    set(_target, key, value, receiver) {
      const accessor = accessors.get(key);
      if (!accessor) return false;
      if (receiver !== facade) {
        return Reflect.defineProperty(receiver, key, {
          value,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
      accessor.set(value);
      return true;
    },
    defineProperty: () => false,
    deleteProperty: () => false,
    setPrototypeOf: () => false,
    preventExtensions: () => false,
  }) as Db;
  return facade;
}

/** These ports own OTHER connections: retain their independence while closing their own callbacks. */
function independentPorts(
  raw: Db,
  overrides: Map<PropertyKey, unknown>,
  bounded = false,
  owner?: Scope,
): void {
  if (raw.independentTransaction) {
    overrides.set(
      "independentTransaction",
      <T>(fn: (tx: Db) => Promise<T>) =>
        raw.independentTransaction!((tx) =>
          bounded
            ? withTransactionDb(
              tx,
              (bound) => independentCallback(owner, bound, fn),
            )
            : inTransactionScope(tx, fn)
        ),
    );
  }
  if (raw.reserve) {
    overrides.set(
      "reserve",
      <T>(fn: (one: Db) => Promise<T>) =>
        raw.reserve!((one) =>
          bounded
            ? inReservedScope(
              one,
              (bound) => independentCallback(owner, bound, fn),
            )
            : fn(transactionScopeDb(one))
        ),
    );
  }
}

async function independentCallback<T>(
  owner: Scope | undefined,
  db: Db,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  if (!owner) return await fn(db);
  if (owner.state !== "open") {
    throw overlap("the enclosing callback has already closed");
  }
  const child = scopes.get(db);
  if (!child) throw overlap("the independent callback has no managed scope");
  owner.independentScopes.add(child);
  try {
    return await fn(db);
  } finally {
    owner.independentScopes.delete(child);
  }
}

/** A reservation owns a connection lease, not a transaction. */
function inReservedScope<T>(raw: Db, fn: (one: Db) => Promise<T>): Promise<T> {
  const scope = makeScope(raw, undefined, true);
  const transaction = Reflect.get(raw, "transaction", raw);
  if (typeof transaction === "function") {
    const open = <U>(work: (tx: Db) => Promise<U>) =>
      reservedTransaction(scope, raw, transaction, work);
    const facade: Db = new Proxy(scope.db, {
      get(target, key) {
        return key === "transaction" ? open : Reflect.get(target, key, target);
      },
      has(target, key) {
        return key === "transaction" || Reflect.has(target, key);
      },
      ownKeys(target) {
        return [...Reflect.ownKeys(target), "transaction"];
      },
      getOwnPropertyDescriptor(target, key) {
        return key === "transaction"
          ? {
            configurable: true,
            enumerable: true,
            writable: false,
            value: open,
          }
          : Reflect.getOwnPropertyDescriptor(target, key);
      },
      set(target, key, value, receiver) {
        if (key === "transaction") return false;
        if (receiver === facade) return Reflect.set(target, key, value, target);
        return Reflect.defineProperty(receiver, key, {
          value,
          configurable: true,
          enumerable: true,
          writable: true,
        });
      },
    });
    scope.db = facade;
    scopes.set(facade, scope);
  }
  return callback(scope, fn, false);
}

function reservedTransaction<T>(
  parent: Scope,
  raw: Db,
  transaction: (...args: never[]) => unknown,
  fn: (tx: Db) => Promise<T>,
): Promise<T> {
  let child: Scope;
  try {
    assertOwner(parent);
    if (parent.pending.size !== 0) {
      throw overlap("a parent query is still pending");
    }
    child = makeScope(raw, parent, true);
    parent.child = child;
  } catch (error) {
    return Promise.reject(error);
  }
  const run = async (): Promise<T> => {
    try {
      return await applyIntrinsic(transaction, raw, [
        (tx: Db) => {
          if (child.state !== "open") throw child.reason;
          bindScope(child, tx);
          return callback(child, fn);
        },
      ]) as T;
    } finally {
      child.state = "closed";
      if (parent.child === child) parent.child = undefined;
    }
  };
  const task = run();
  child.task = task;
  task.catch(() => {});
  return task;
}

function makeScope(
  raw: Db,
  parent?: Scope,
  bounded = parent?.bounded ?? false,
): Scope {
  let interrupt!: (reason: unknown) => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    interrupt = reject;
  });
  interrupted.catch(() => {});
  const scope: Scope = {
    raw,
    db: raw,
    bounded,
    assigned: new Map(),
    parent,
    pending: new Set(),
    independentPending: new Set(),
    independentScopes: new Set(),
    state: "open",
    managed: false,
    interrupted,
    interrupt,
  };
  // A child reserves ownership before SAVEPOINT, but its actual adapter capabilities are not known
  // until the driver invokes its callback. Never lend that child the parent's optional transports.
  if (parent === undefined) bindScope(scope, raw);
  return scope;
}

function bindScope(scope: Scope, raw: Db): void {
  scope.raw = raw;
  // SQL methods are writable Db ports. A decorator may save tx.query, replace it and restore it later.
  // Capture the selected method and its real receiver at GET time: the saved guard must not retarget
  // itself to a newly installed decorator. Keep assignments local to this logical facade so restoring
  // a captured guard cannot install a closed scope into a serial same-object adapter's backing port.
  const assigned = scope.assigned;
  const port = <K extends "query" | "exec" | "queryArrays">(key: K): Db[K] =>
    (assigned.has(key) ? assigned.get(key) : Reflect.get(raw, key, raw)) as Db[
      K
    ];
  let restrictedReceiver: Db | undefined;
  const receiver = (decorated: boolean): Db => {
    if (!decorated) return raw;
    if (scope.bounded) return scope.db;
    if (!restrictedReceiver) {
      restrictedReceiver = boundedDelegate(scope, raw, overrides, accessors);
      scopes.set(restrictedReceiver, scope);
    }
    return restrictedReceiver;
  };
  const accessors = new Map<PropertyKey, ScopePortAccessor>([
    ["query", {
      get: () => {
        try {
          assertOwner(scope);
        } catch (error) {
          return () => Promise.reject(error);
        }
        const decorated = assigned.has("query");
        const query = port("query");
        return <T>(sql: string, params?: unknown[]) =>
          forward(
            scope,
            () =>
              applyIntrinsic(query, receiver(decorated), [
                sql,
                params,
              ]) as Promise<
                { rows: T[] }
              >,
          );
      },
      set: (value) => assigned.set("query", value),
      getForDescriptor: (value) => {
        const decorated = assigned.has("query");
        const selected =
          (assigned.has("query") ? assigned.get("query") : value) as Db[
            "query"
          ];
        if (typeof selected !== "function") {
          return selected;
        }
        return <T>(sql: string, params?: unknown[]) =>
          forward(
            scope,
            () =>
              applyIntrinsic(selected, receiver(decorated), [
                sql,
                params,
              ]) as Promise<{
                rows: T[];
              }>,
          );
      },
    }],
    ["exec", {
      get: () => {
        try {
          assertOwner(scope);
        } catch (error) {
          return () => Promise.reject(error);
        }
        const decorated = assigned.has("exec");
        const exec = port("exec");
        return (sql: string) =>
          forward(
            scope,
            () =>
              applyIntrinsic(exec, receiver(decorated), [sql]) as ReturnType<
                Db["exec"]
              >,
          );
      },
      set: (value) => assigned.set("exec", value),
      getForDescriptor: (value) => {
        const decorated = assigned.has("exec");
        const selected =
          (assigned.has("exec") ? assigned.get("exec") : value) as Db["exec"];
        if (typeof selected !== "function") {
          return selected;
        }
        return (sql: string) =>
          forward(
            scope,
            () =>
              applyIntrinsic(selected, receiver(decorated), [
                sql,
              ]) as ReturnType<Db["exec"]>,
          );
      },
    }],
    ["queryArrays", {
      get: () => {
        const decorated = assigned.has("queryArrays");
        const method = port("queryArrays");
        if (method === undefined) return undefined;
        return (sql: string, params?: unknown[]) =>
          forward(
            scope,
            () =>
              applyIntrinsic(method, receiver(decorated), [
                sql,
                params,
              ]) as ReturnType<
                NonNullable<Db["queryArrays"]>
              >,
          );
      },
      set: (value) => assigned.set("queryArrays", value),
      getForDescriptor: (value) => {
        const decorated = assigned.has("queryArrays");
        const selected = (assigned.has("queryArrays")
          ? assigned.get("queryArrays")
          : value) as Db["queryArrays"];
        if (typeof selected !== "function") {
          return selected;
        }
        return (sql: string, params?: unknown[]) =>
          forward(scope, () =>
            applyIntrinsic(selected, receiver(decorated), [
              sql,
              params,
            ]) as ReturnType<
              NonNullable<Db["queryArrays"]>
            >);
      },
    }],
  ]);
  const overrides = new Map<PropertyKey, unknown>([
    // A transaction CALLBACK owns this connection, even when a structural adapter forwards its root's
    // transaction method. A facade must nest on this live scope, not accidentally open another tx.
    ["transaction", undefined],
  ]);
  if (raw.savepoint !== undefined) {
    overrides.set(
      "savepoint",
      <T>(fn: (sp: Db) => Promise<T>) => childSavepoint(scope, fn),
    );
  }
  independentPorts(raw, overrides, scope.bounded, scope);
  scope.db = scope.bounded
    ? boundedDelegate(scope, raw, overrides, accessors)
    : delegate(raw, overrides, accessors);
  scopes.set(scope.db, scope);
}

/** Return the original adapter handle solely for private transaction provenance checks. */
export function transactionScopeSource(db: Db): Db {
  let current = db;
  const seen = new Set<Db>();
  while (!seen.has(current)) {
    seen.add(current);
    const source = scopes.get(current)?.raw ?? rootSources.get(current);
    if (source === undefined || source === current) break;
    current = source;
  }
  return current;
}

/** True for a callback handle whose lifecycle is owned by the scope coordinator. */
export function isManagedTransactionScope(db: Db): boolean {
  return scopes.get(db)?.managed === true;
}

/** A scope made from a structural handle is not necessarily owned by a driver callback. */
export function isTransactionScope(db: Db): boolean {
  return scopes.has(db);
}

/** Only logical rebindings, not savepoints, inherit this transaction identity. */
export function borrowedTransactionParent(db: Db): Db | undefined {
  return borrowedParents.get(db);
}

/** SQL interceptors receive only the current callback's guarded continuation. */
export interface TransactionSqlInterceptors {
  query?<T>(
    next: Db["query"],
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
  exec?(next: Db["exec"], sql: string): Promise<unknown>;
  queryArrays?(
    next: NonNullable<Db["queryArrays"]>,
    sql: string,
    params?: unknown[],
  ): Promise<import("./db.ts").NativeArrayRows>;
}

/** A retained continuation cannot start work after its interceptor has settled. */
function interceptorNext<F extends (...args: never[]) => Promise<unknown>>(
  underlying: F,
): { next: F; close(): void } {
  let active = true;
  const next =
    ((...args: unknown[]) =>
      active ? applyIntrinsic(underlying, undefined, args) : Promise.reject(
        overlap("this SQL interceptor has already returned"),
      )) as unknown as F;
  return { next, close: () => active = false };
}

function installSqlInterceptors(
  db: Db,
  interceptors: TransactionSqlInterceptors | undefined,
): void {
  const query = interceptors?.query;
  const exec = interceptors?.exec;
  const arrays = interceptors?.queryArrays;
  if (query) {
    const underlying = db.query;
    db.query = async <T>(sql: string, params?: unknown[]) => {
      const guarded = interceptorNext(underlying);
      try {
        return await query<T>(guarded.next, sql, params);
      } finally {
        guarded.close();
      }
    };
  }
  if (exec) {
    const underlying = db.exec;
    db.exec = async (sql: string) => {
      const guarded = interceptorNext(underlying);
      try {
        return await exec(guarded.next, sql);
      } finally {
        guarded.close();
      }
    };
  }
  if (arrays) {
    const underlying = db.queryArrays;
    if (underlying !== undefined) {
      db.queryArrays = async (sql: string, params?: unknown[]) => {
        const guarded = interceptorNext(underlying);
        try {
          return await arrays(guarded.next, sql, params);
        } finally {
          guarded.close();
        }
      };
    }
  }
}

/** Declare that a custom port opens real root transactions. The raw port is never marked. */
export function adaptTransactor(
  raw: Db & Transactor,
  interceptors?: TransactionSqlInterceptors,
): Db & Transactor {
  const transaction = Reflect.get(raw, "transaction", raw);
  if (typeof transaction !== "function") {
    throw new TypeError("adaptTransactor: the root must expose transaction()");
  }
  const scope = makeScope(raw, undefined, true);
  const open = <T>(
    fn: (tx: Db) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T> => {
    try {
      const isolation = transactionIsolationStatement(options);
      return Promise.resolve(applyIntrinsic(transaction, raw, [
        (tx: Db) =>
          bindTransactionDb(tx, async (child) => {
            // Apply explicit root isolation before interceptors or application code issue SQL.
            if (isolation !== undefined) await child.query(isolation);
            installSqlInterceptors(child, interceptors);
            return await fn(child);
          }, true),
      ]) as Promise<T>);
    } catch (error) {
      return Promise.reject(error);
    }
  };
  const hidden = (key: PropertyKey) =>
    key === "savepoint" || key === "transactionScoped";
  const facade: Db & Transactor = new Proxy(scope.db, {
    get(target, key) {
      if (key === "transaction") return open;
      return hidden(key) ? undefined : Reflect.get(target, key, target);
    },
    has(target, key) {
      if (key === "transaction") return true;
      return hidden(key) ? false : Reflect.has(target, key);
    },
    ownKeys(target) {
      return [
        ...Reflect.ownKeys(target).filter((key) => !hidden(key)),
        "transaction",
      ];
    },
    getOwnPropertyDescriptor(target, key) {
      if (key === "transaction") {
        return {
          configurable: true,
          enumerable: true,
          writable: false,
          value: open,
        };
      }
      return hidden(key)
        ? undefined
        : Reflect.getOwnPropertyDescriptor(target, key);
    },
    set(target, key, value, receiver) {
      if (key === "transaction" || hidden(key)) return false;
      if (receiver === facade) return Reflect.set(target, key, value, target);
      return Reflect.defineProperty(receiver, key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    },
  }) as Db & Transactor;
  scope.db = facade;
  scopes.set(facade, scope);
  declaredRoots.add(facade);
  return facade;
}

/** An explicit root facade is an adapter-author assertion, not a driver attestation. */
export function isDeclaredTransactionRoot(db: Db): boolean {
  return declaredRoots.has(db);
}

/** Record a built-in adapter root. The same object stays writable. */
export function markFrameworkTransactionRoot<T extends object>(handle: T): T {
  frameworkTransactionRoots.add(handle);
  return handle;
}

/** True for a root or reserved opener created by the built-in adapters. */
export function isFrameworkTransactionRoot(db: Db): boolean {
  return typeof db === "object" && db !== null &&
    !isManagedTransactionScope(db) &&
    frameworkTransactionRoots.has(transactionScopeSource(db));
}

/** Built-in root or an adapter author's explicit root declaration. */
export function hasTransactionRootRole(db: Db): boolean {
  return isDeclaredTransactionRoot(db) || isFrameworkTransactionRoot(db);
}

/** Share one coordinator across every facade bound to a structural/native transaction handle. A root
 * Transactor's callbacks get the same lifetime guard; independent/root autocommit queries remain separate. */
export function transactionScopeDb<T extends Db>(db: T): T {
  const root = roots.get(db);
  if (root) return root as T;
  if (scopes.has(db) && !hasTransactionRootRole(db)) return db;
  const transaction = (db as Db & Partial<Transactor>).transaction;
  if (typeof transaction === "function") {
    const overrides = new Map<PropertyKey, unknown>([
      [
        "transaction",
        <U>(fn: (tx: Db) => Promise<U>, options?: TransactionOptions) => {
          if (!hasTransactionRootRole(db)) {
            return Promise.reject(Object.assign(
              new Error("transaction: ambiguous transaction handle"),
              { kind: "internal" as const },
            ));
          }
          return transaction.call(
            db,
            (tx) => inTransactionScope(tx, fn),
            options,
          ) as Promise<U>;
        },
      ],
    ]);
    independentPorts(db, overrides);
    const root = delegate(db, overrides);
    roots.set(db, root);
    roots.set(root, root);
    rootSources.set(root, db);
    // Preserve an adapter author's explicit root assertion when the new scoped facade wraps an already
    // scoped `adaptTransactor` root. `transactionScopeSource` reaches the underlying raw Db, which is not
    // itself declared as a root.
    if (declaredRoots.has(db)) declaredRoots.add(root);
    return root as T;
  }
  const existing = callbacks.get(db);
  if (existing) return existing as T;
  if (db.savepoint === undefined && db.transactionScoped !== true) return db;
  const scope = makeScope(db);
  callbacks.set(db, scope.db);
  return scope.db as T;
}

/** Finish the logical scope INSIDE the actual driver's transaction callback, before commit/rollback.
 * Re-entering an already managed scope does not close the outer owner's lifetime early. */
export async function inTransactionScope<T>(
  raw: Db,
  fn: (db: Db) => Promise<T>,
  bounded = false,
): Promise<T> {
  // A structural adapter may reuse its raw object for successive real callbacks, or forward a root
  // transaction method on the callback handle. The actual callback, rather than either shape, owns it.
  let db = raw;
  let scope = scopes.get(raw);
  if (!scope) {
    const previous = callbacks.get(raw);
    scope = previous && scopes.get(previous);
    if (scope?.managed && scope.state !== "closed") {
      throw overlap(
        "the adapter reused an active raw callback handle; serialize callbacks or provide independently bound handles",
      );
    }
    if (!scope || scope.state === "closed" || (bounded && !scope.bounded)) {
      scope = makeScope(raw, undefined, bounded);
      callbacks.set(raw, scope.db);
    }
    db = scope.db;
  }
  if (scope.state !== "open") {
    throw overlap("this transaction/savepoint handle has already closed");
  }
  if (scope.managed) return await fn(db);
  scope.managed = true;
  return await callback(scope, fn);
}

/** Bind an actual externally-owned driver callback for the duration of `fn`.
 * The adapter must call and await this from inside its real transaction callback. */
export function withTransactionDb<T>(
  rawTx: Db,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  return bindTransactionDb(rawTx, fn, false);
}

function bindTransactionDb<T>(
  rawTx: Db,
  fn: (db: Db) => Promise<T>,
  requireUndecorated: boolean,
): Promise<T> {
  if (declaredRoots.has(rawTx)) {
    return Promise.reject(overlap("a root handle is not a driver callback"));
  }
  const parent = scopes.get(rawTx);
  if (parent?.managed) {
    if (requireUndecorated && parent.assigned.size !== 0) {
      return Promise.reject(overlap(
        "a managed callback with replaced SQL ports cannot be safely rebound by an adapter root",
      ));
    }
    let child: Scope;
    try {
      assertOwner(parent);
      if (parent.pending.size !== 0) {
        throw overlap("a parent query is still pending");
      }
      child = makeScope(parent.raw, parent, true);
      parent.child = child;
      try {
        bindScope(child, parent.raw);
        borrowedParents.set(child.db, parent.db);
      } catch (error) {
        child.state = "closed";
        parent.child = undefined;
        throw error;
      }
    } catch (error) {
      return Promise.reject(error);
    }
    const run = async (): Promise<T> => {
      try {
        return await callback(child, fn);
      } finally {
        child.state = "closed";
        if (parent.child === child) parent.child = undefined;
      }
    };
    const task = run();
    child.task = task;
    task.catch(() => {});
    return task;
  }
  return inTransactionScope(rawTx, fn, true);
}
