import type { Db } from "../data/db.ts";
import { thrownField } from "./throw-value.ts";

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
    let tagged = false;
    try {
      tagged = reason instanceof Error && "kind" in reason;
    } catch {
      // Opaque parent reasons retain their cause through the cancellation wrapper.
    }
    const failure = tagged
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
    let work: Promise<T>;
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      work = start(controller.signal);
    } catch (error) {
      // Keep eager start and race precedence, while observing the abort promise
      // even when cancellation or a synchronous callback throw ends setup.
      work = Promise.reject(error);
    }
    return await Promise.race([work, aborted]);
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
    if (thrownField(error, "code") === "57014") {
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
