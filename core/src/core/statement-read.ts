import type { Db, Transactor } from "../data/db.ts";
import { statementHeads } from "../data/sql-transaction-control.ts";

/** Only internal composition sees the transaction opener. The handler receives the capability-minimal db. */
export interface StatementReadPorts {
  readonly db: Db;
  readonly base: Db & Transactor;
}

function refuseControl(sql: string): void {
  const heads = statementHeads(sql);
  if (
    heads.length === 0 ||
    heads.some(({ tokens }) =>
      !["select", "with", "show", "explain", "values", "table"].includes(
        tokens[0] ?? "",
      )
    )
  ) {
    throw Object.assign(
      new Error(
        "tx/read-op-no-write: statement-consistent reads accept read statements only; transaction/configuration control belongs to the framework",
      ),
      { kind: "forbidden" as const },
    );
  }
}

/** A read op with no long-lived connection. Every query is still protected by the database's actual
 * READ ONLY mode, including volatile SELECT functions and data-modifying CTEs. The lexical check only
 * refuses transaction/configuration escapes; it does not substitute for that substrate guarantee. */
export function statementReadPorts(
  root: Db & Transactor,
  deadlineMs: number,
  signal?: AbortSignal,
): StatementReadPorts {
  const transaction = <T>(fn: (tx: Db) => Promise<T>): Promise<T> =>
    root.transaction(async (tx) => {
      if (signal?.aborted) {
        throw Object.assign(
          new Error("operation was cancelled before its database statement"),
          { kind: "timeout" as const },
        );
      }
      await tx.query("SET TRANSACTION READ ONLY");
      let pid = Number.NaN;
      if (signal && root.cancelBackend) {
        pid = Number(
          (await tx.query<{ pid: number }>(
            deadlineMs > 0
              ? `SELECT set_config('statement_timeout', $1, true) AS _t, pg_backend_pid() AS pid`
              : `SELECT pg_backend_pid() AS pid`,
            deadlineMs > 0 ? [String(Math.floor(deadlineMs))] : undefined,
          )).rows[0]?.pid,
        );
      } else if (deadlineMs > 0) {
        await tx.query(
          `SET LOCAL statement_timeout = ${Math.floor(deadlineMs)}`,
        );
      }
      const onAbort = signal && root.cancelBackend && Number.isFinite(pid)
        ? () => {
          void root.cancelBackend!(pid).catch(() => {});
        }
        : undefined;
      if (onAbort) {
        if (signal!.aborted) onAbort();
        else signal!.addEventListener("abort", onAbort, { once: true });
      }
      const restricted: Db = {
        query: (sql, params) => {
          refuseControl(sql);
          return tx.query(sql, params);
        },
        exec: (sql) => {
          refuseControl(sql);
          return tx.exec(sql);
        },
        ...(tx.queryArrays
          ? {
            queryArrays: (sql: string, params?: unknown[]) => {
              refuseControl(sql);
              return tx.queryArrays!(sql, params);
            },
          }
          : {}),
        transactionScoped: true,
      };
      // A nested framework operation may set its own READ ONLY flag/statement deadline. It cannot remove
      // READ ONLY, acquire a raw driver handle, or issue arbitrary SET/COMMIT through the internal base.
      const internal: Db = {
        ...restricted,
        query: (sql, params) => {
          if (/^SET TRANSACTION READ ONLY$/i.test(sql.trim())) {
            return tx.query(sql, params);
          }
          const timeout = /^SET LOCAL statement_timeout = (\d+)$/i.exec(
            sql.trim(),
          );
          if (timeout) {
            const requested = Number(timeout[1]);
            // A dependency may tighten this phase's SQL bound, but cannot remove or enlarge its caller's bound.
            const effective =
              deadlineMs > 0 && (requested === 0 || requested > deadlineMs)
                ? Math.floor(deadlineMs)
                : requested;
            return tx.query(`SET LOCAL statement_timeout = ${effective}`);
          }
          return restricted.query(sql, params);
        },
      };
      try {
        if (signal?.aborted) {
          throw Object.assign(
            new Error("operation was cancelled before its database statement"),
            { kind: "timeout" as const },
          );
        }
        return await fn(internal);
      } finally {
        if (onAbort) {
          signal!.removeEventListener("abort", onAbort);
        }
      }
    });
  const db: Db = {
    query: (sql, params) => {
      refuseControl(sql);
      return transaction((tx) => tx.query(sql, params));
    },
    exec: (sql) => {
      refuseControl(sql);
      return transaction((tx) => tx.exec(sql));
    },
    ...(root.queryArrays
      ? {
        queryArrays: (sql: string, params?: unknown[]) => {
          refuseControl(sql);
          return transaction((tx) => tx.queryArrays!(sql, params));
        },
      }
      : {}),
  };
  return { db, base: { ...db, concurrent: true, transaction } };
}
