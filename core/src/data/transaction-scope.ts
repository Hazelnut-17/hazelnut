/** Logical ownership of one connection's savepoint stack. Independent connections do not share it. */
import type { Db, Transactor } from "./db.ts";

interface Scope {
  raw: Db;
  db: Db;
  readonly parent?: Scope;
  child?: Scope;
  readonly pending: Set<Promise<unknown>>;
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
const callbacks = new WeakMap<Db, Db>();

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

function interruptTree(scope: Scope, reason: unknown): void {
  if (scope.state === "closed") return;
  scope.state = "closing";
  scope.reason = reason;
  scope.interrupt(reason);
  if (scope.child) interruptTree(scope.child, reason);
}

/** Invalidate capabilities first, then join DRIVER work, not arbitrary user JavaScript. A child driver's
 * callback races interruption, so even a detached callback awaiting an unrelated promise cannot defer its
 * rollback until after the ancestor has committed/released the connection. Its later IO is refused. */
async function close(scope: Scope, reason: unknown): Promise<void> {
  interruptTree(scope, reason);
  const child = scope.child;
  if (child?.task) await child.task.catch(() => {});
  await Promise.allSettled([...scope.pending]);
  scope.state = "closed";
}

async function callback<T>(
  scope: Scope,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  try {
    if (scope.state !== "open") throw scope.reason;
    scope.managed = true;
    const value = await Promise.race([
      Promise.resolve().then(() => fn(scope.db)),
      scope.interrupted,
    ]);
    if (scope.child !== undefined || scope.pending.size !== 0) {
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
  });
  return facade;
}

/** These ports own OTHER connections: retain their independence while closing their own callbacks. */
function independentPorts(raw: Db, overrides: Map<PropertyKey, unknown>): void {
  if (raw.independentTransaction) {
    overrides.set(
      "independentTransaction",
      <T>(fn: (tx: Db) => Promise<T>) =>
        raw.independentTransaction!((tx) => inTransactionScope(tx, fn)),
    );
  }
  if (raw.reserve) {
    overrides.set(
      "reserve",
      <T>(fn: (one: Db) => Promise<T>) =>
        raw.reserve!((one) => fn(transactionScopeDb(one))),
    );
  }
}

function makeScope(raw: Db, parent?: Scope): Scope {
  let interrupt!: (reason: unknown) => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    interrupt = reject;
  });
  interrupted.catch(() => {});
  const scope: Scope = {
    raw,
    db: raw,
    parent,
    pending: new Set(),
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
  const assigned = new Map<PropertyKey, unknown>();
  const port = <K extends "query" | "exec" | "queryArrays">(key: K): Db[K] =>
    (assigned.has(key) ? assigned.get(key) : Reflect.get(raw, key, raw)) as Db[
      K
    ];
  const accessors = new Map<PropertyKey, ScopePortAccessor>([
    ["query", {
      get: () => {
        const query = port("query").bind(raw);
        return <T>(sql: string, params?: unknown[]) =>
          forward(scope, () => query<T>(sql, params));
      },
      set: (value) => assigned.set("query", value),
    }],
    ["exec", {
      get: () => {
        const exec = port("exec").bind(raw);
        return (sql: string) => forward(scope, () => exec(sql));
      },
      set: (value) => assigned.set("exec", value),
    }],
    ["queryArrays", {
      get: () => {
        const method = port("queryArrays");
        if (method === undefined) return undefined;
        const queryArrays = method.bind(raw);
        return (sql: string, params?: unknown[]) =>
          forward(scope, () => queryArrays(sql, params));
      },
      set: (value) => assigned.set("queryArrays", value),
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
  independentPorts(raw, overrides);
  scope.db = delegate(raw, overrides, accessors);
  scopes.set(scope.db, scope);
}

/** Return the original adapter handle solely for private transaction provenance checks. */
export function transactionScopeSource(db: Db): Db {
  return scopes.get(db)?.raw ?? db;
}

/** Share one coordinator across every facade bound to a structural/native transaction handle. A root
 * Transactor's callbacks get the same lifetime guard; independent/root autocommit queries remain separate. */
export function transactionScopeDb<T extends Db>(db: T): T {
  if (scopes.has(db)) return db;
  const root = roots.get(db);
  if (root) return root as T;
  const transaction = (db as Db & Partial<Transactor>).transaction;
  if (typeof transaction === "function") {
    const overrides = new Map<PropertyKey, unknown>([
      [
        "transaction",
        <U>(fn: (tx: Db) => Promise<U>) =>
          transaction.call(db, (tx) => inTransactionScope(tx, fn)) as Promise<
            U
          >,
      ],
    ]);
    independentPorts(db, overrides);
    const root = delegate(db, overrides);
    roots.set(db, root);
    roots.set(root, root);
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
    if (!scope || scope.state === "closed") {
      scope = makeScope(raw);
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
