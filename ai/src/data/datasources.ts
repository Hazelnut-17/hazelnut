// Named external datasources (05-runtime.md §datasources) — the live registry behind `ctx.datasource(name)`.
// A datasource is another database reached via raw SQL only: no auto WHERE-stack/scope/rowPolicy, unmigrated.
// The handle enforces each datasource's declared access mode (`access:"read"` refuses writes at runtime).
import type { Db } from "./db.ts";
import type { DatasourceDecl } from "../core/app-define.ts";

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

/** Strips leading SQL comments (`--` line and slash-star block) + whitespace, then returns the first keyword
 *  lower-cased (or `""` when none) — the read-guard checks this leading keyword; a query is one statement. */
export function leadingKeyword(sql: string): string {
  let s = sql;
  for (;;) {
    const t = s.trimStart();
    if (t.startsWith("--")) {
      const nl = t.indexOf("\n");
      s = nl === -1 ? "" : t.slice(nl + 1);
      continue;
    }
    if (t.startsWith("/*")) {
      const end = t.indexOf("*/");
      s = end === -1 ? "" : t.slice(end + 2);
      continue;
    }
    s = t;
    break;
  }
  const m = /^[a-zA-Z]+/.exec(s);
  return m ? m[0].toLowerCase() : "";
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
          decls[name]!.url ? `'${decls[name]!.url}'` : "its url"
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
