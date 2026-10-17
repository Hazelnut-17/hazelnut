import type { Db } from "../data/db.ts";

/** A real cancellation signal and a rejecting deadline for async framework handlers. */
export async function withAsyncDeadline<T>(
  ms: number | false,
  parent: AbortSignal | undefined,
  start: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: (reason: unknown) => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const abort = (reason: unknown) => {
    if (controller.signal.aborted) return;
    const failure = reason instanceof Error && "kind" in reason
      ? reason
      : Object.assign(new Error("async handler cancelled", { cause: reason }), {
        kind: "timeout" as const,
      });
    controller.abort(failure);
    rejectAbort(failure);
  };
  const onParent = () => abort(parent?.reason);
  if (parent?.aborted) onParent();
  else parent?.addEventListener("abort", onParent, { once: true });
  if (ms !== false) {
    timer = setTimeout(() =>
      abort(Object.assign(
        new Error(`async handler exceeded ${ms}ms`),
        { kind: "timeout" as const },
      )), ms);
  }
  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    return await Promise.race([start(controller.signal), aborted]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    parent?.removeEventListener("abort", onParent);
  }
}

/** Set a transaction-local SQL backstop and cancel a running statement when the handler aborts.
 * Restore the caller's setting on success; an error is unwound by its transaction/savepoint. */
export async function withSqlDeadline<T>(
  db: Db,
  ms: number | false,
  signal: AbortSignal,
  fn: () => Promise<T>,
): Promise<T> {
  const row = (await db.query<{ previous: string; pid: number }>(
    `SELECT current_setting('statement_timeout') AS previous, pg_backend_pid() AS pid`,
  )).rows[0];
  if (ms !== false) {
    await db.query(`SELECT set_config('statement_timeout', $1, true)`, [
      String(Math.max(1, Math.floor(ms))),
    ]);
  }
  const cancel = () => {
    if (db.cancelBackend && row) {
      void db.cancelBackend(Number(row.pid)).catch(() => {});
    }
  };
  if (signal.aborted) throw signal.reason;
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const value = await fn();
    if (signal.aborted) throw signal.reason;
    if (ms !== false && row) {
      await db.query(`SELECT set_config('statement_timeout', $1, true)`, [
        row.previous,
      ]);
    }
    return value;
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (
      typeof error === "object" && error !== null && "code" in error &&
      error.code === "57014"
    ) {
      throw Object.assign(
        new Error("async SQL statement exceeded its handler deadline", {
          cause: error,
        }),
        { kind: "timeout" as const },
      );
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
