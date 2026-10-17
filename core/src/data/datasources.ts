// Named external datasources (05-runtime.md §datasources) — the live registry behind `ctx.datasource(name)`.
// A datasource is another database reached via raw SQL only: no auto WHERE-stack/scope/rowPolicy, unmigrated.
// The handle enforces each datasource's declared access mode (`access:"read"` refuses writes at runtime).
import type { Db } from "./db.ts";
import { displayUrl } from "../core/loggable-error.ts";
import type { DatasourceDecl } from "../core/app-define.ts";
import {
  refuseTransactionControl,
  statementHeads,
} from "./sql-transaction-control.ts";

/** The handle `ctx.datasource(name)` returns — raw parameterized SQL bound to that datasource's connection,
 *  its access mode enforced. Mirrors `ctx.query`'s `(sql, params?)` shape so the two seams read identically. */
export interface DatasourceHandle {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

/** The live datasource registry — `datasource(name)` returns a handle bound to that datasource's connection with
 *  its access mode enforced. Built once at boot from the boot connections + the config access declarations. */
export interface Datasources {
  datasource(name: string): DatasourceHandle;
}

// The leading-keyword allowlist for `access:"read"` (05-runtime.md §datasources): an unlisted keyword is refused.
// Ceiling: a data-modifying CTE reads as `with` and slips through — a read-only DB role on the connection is authoritative.
const READ_LEADING: ReadonlySet<string> = new Set([
  "select",
  "with",
  "explain",
  "show",
  "table",
  "values",
]);

/** The first keyword of the first statement, lower-cased, or `""` when it opens with a literal or
 *  punctuation. Comments (nested block comments included) and literals read the way Postgres reads them. */
export function leadingKeyword(sql: string): string {
  return statementHeads(sql)[0]?.tokens[0] ?? "";
}

/** Is this SQL at most one statement? A `;` inside a comment, string, quoted identifier or dollar-quoted
 *  body is text; a second top-level statement is what `access:"read"` must never let through. */
export function isOneStatement(sql: string): boolean {
  return statementHeads(sql).length <= 1;
}

/** Is this SQL a read statement (its leading keyword is in the read allowlist)? The runtime half of the
 *  `access:"read"` write-refusal (05-runtime.md §datasources). A `WITH`-hidden write is the documented ceiling. */
export function isReadStatement(sql: string): boolean {
  return READ_LEADING.has(leadingKeyword(sql));
}

/** Builds the live datasource registry (05-runtime.md §datasources) from boot connections + config access
 *  declarations, refusing eagerly at boot when a declared datasource has no live connection. Each query runs
 *  on the datasource's own connection, never the owned `db` — a datasource write is best-effort by construction. */
export function buildDatasources(
  connections: Readonly<Record<string, Db>>,
  decls: Readonly<Record<string, DatasourceDecl>>,
): Datasources {
  // boot refuse: every declared datasource MUST have a live connection.
  for (const name of Object.keys(decls)) {
    if (!connections[name]) {
      throw new Error(
        `datasources/missing-connection: datasource '${name}' is declared in config.datasources but has no live connection in boot.datasources — provide boot.datasources['${name}'] (a Db built from ${
          decls[name]!.url ? `'${displayUrl(decls[name]!.url!)}'` : "its url"
        }), or remove the declaration.`,
      );
    }
  }
  return {
    datasource(name: string): DatasourceHandle {
      const decl = decls[name];
      if (!decl) {
        throw new Error(
          `ctx.datasource: no datasource '${name}' declared — declare it in config.datasources { ${name}: { url, access } }. Declared: ${
            Object.keys(decls).sort().join(", ") || "(none)"
          }.`,
        );
      }
      const conn = connections[name]!; // guaranteed by the boot refuse above
      return {
        query: <T = Record<string, unknown>>(
          sql: string,
          params?: unknown[],
        ): Promise<{ rows: T[] }> => {
          try {
            refuseTransactionControl(sql, `ctx.datasource('${name}').query`);
          } catch (e) {
            return Promise.reject(e);
          }
          if (!isOneStatement(sql)) {
            return Promise.reject(
              new Error(
                `datasource/one-statement: ctx.datasource('${name}') refuses a multi-statement query — one statement per query`,
              ),
            );
          }
          if (decl.access === "read" && !isReadStatement(sql)) {
            return Promise.reject(
              new Error(
                `ctx.datasource('${name}'): access is "read" — a write/DDL statement (leading '${
                  leadingKeyword(sql) || "?"
                }') is refused. Declare access:"readwrite" to write directly (best-effort, outside the op tx), or route a RELIABLE cross-datasource write through the outbox.`,
              ),
            );
          }
          return conn.query<T>(sql, params);
        },
      };
    },
  };
}
