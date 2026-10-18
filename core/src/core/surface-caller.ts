import type { Db } from "../data/db.ts";

/** Caller facts exist only during synchronous surface composition. Surface methods copy these facts. */
export interface SurfaceCaller {
  readonly readOnly: boolean;
  readonly transactionActive: boolean;
}

const READ_ONLY_BUILD_OPTIONS = new WeakSet<object>();
const SURFACE_CALLERS = new WeakMap<Db, Readonly<SurfaceCaller>>();

/** Mark pipeline-owned options without adding a field to the context builder's options contract. */
export function markReadOnlyBuildOptions<T extends object>(options: T): T {
  READ_ONLY_BUILD_OPTIONS.add(options);
  return options;
}

export function readOnlyBuildOptions(options: object): boolean {
  return READ_ONLY_BUILD_OPTIONS.has(options);
}

/** The factory reads this before wrapping the database and retains only copied scalar caller facts. */
export function currentSurfaceCaller(
  db: Db,
): Readonly<SurfaceCaller> | undefined {
  return SURFACE_CALLERS.get(db);
}

/** No await occurs in this scope. Nested builds restore the outer frame, including when a factory throws. */
export function withSurfaceCaller<T>(
  db: Db,
  caller: SurfaceCaller,
  compose: () => T,
): T {
  const previous = SURFACE_CALLERS.get(db);
  SURFACE_CALLERS.set(db, Object.freeze({ ...caller }));
  try {
    return compose();
  } finally {
    if (previous === undefined) SURFACE_CALLERS.delete(db);
    else SURFACE_CALLERS.set(db, previous);
  }
}
