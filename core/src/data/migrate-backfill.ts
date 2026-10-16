// Data-bearing feature changes need more than a storage-type diff: a newly added rollup starts from the
// existing child set, and an encrypted cell must be sealed through the write stack rather than SQL-cast.
import type { App } from "../core/app.ts";
import { compileSql } from "../core/lower-sql.ts";
import { type SQL, sql as query } from "drizzle-orm/sql";
import { lifecycleSql } from "./read-sql.ts";
import { scanSqlLiteral } from "./ddl-parse.ts";
import {
  blankStringLiterals,
  splitSqlStatements,
  stripSqlComments,
} from "./migrate-sql-text.ts";

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const identifier = (name: string): string =>
  `(?:"${escape(name)}"|${escape(name)})`;
const tablePattern = (schema: string, table: string): string =>
  schema === "public"
    ? `(?:${identifier(schema)}\\s*\\.\\s*)?${identifier(table)}`
    : `${identifier(schema)}\\s*\\.\\s*${identifier(table)}`;

/** Decode the literal containing a static DO body without importing the migration AST parser into the
 * app graph. PostgreSQL E strings admit quote/backslash, control, octal, hex and Unicode escapes. */
function doLiteralValue(token: string): string | undefined {
  if (token.startsWith("$")) {
    const tag = /^(\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$)/.exec(token)?.[1];
    return tag && token.endsWith(tag)
      ? token.slice(tag.length, -tag.length)
      : undefined;
  }
  const escaped = /^[Ee]'/.test(token);
  if (!escaped && !token.startsWith("'")) return undefined;
  const body = token.slice(escaped ? 2 : 1, -1);
  let out = "";
  for (let i = 0; i < body.length;) {
    const c = body[i++]!;
    if (c === "'" && body[i] === "'") {
      out += "'";
      i++;
    } else if (escaped && c === "\\") {
      const rest = body.slice(i);
      const unicode = /^(?:u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8}))/.exec(rest);
      const hex = /^x([0-9a-f]{1,2})/i.exec(rest);
      const octal = /^([0-7]{1,3})/.exec(rest);
      if (unicode) {
        const point = Number.parseInt(unicode[1] ?? unicode[2]!, 16);
        if (point > 0x10FFFF) return undefined;
        out += String.fromCodePoint(point);
        i += unicode[0].length;
      } else if (hex || octal) {
        const match = (hex ?? octal)!;
        out += String.fromCharCode(Number.parseInt(match[1]!, hex ? 16 : 8));
        i += match[0].length;
      } else {
        const next = body[i++];
        if (next === undefined) return undefined;
        const controls: Readonly<Record<string, string>> = {
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
        };
        out += controls[next] ?? next;
      }
    } else out += c;
  }
  return out;
}

function staticDoBody(statement: string): string | undefined {
  const head = /^DO\b\s*/i.exec(statement.trimStart());
  if (!head) return undefined;
  let rest = statement.trimStart().slice(head[0].length);
  const language = /^LANGUAGE\s+(?:"(?:[^"]|"")*"|[A-Za-z_]\w*)\s*/i.exec(rest);
  if (language) rest = rest.slice(language[0].length);
  const literal = scanSqlLiteral(rest, 0);
  if (literal.end === 0 || !literal.closed) return undefined;
  if (
    !/^(?:LANGUAGE\s+(?:"(?:[^"]|"")*"|[A-Za-z_]\w*))?\s*$/i.test(
      rest.slice(literal.end).trim(),
    )
  ) {
    return undefined;
  }
  const code = doLiteralValue(rest.slice(0, literal.end));
  return code === undefined
    ? undefined
    : /^\s*BEGIN\b([\s\S]*)\bEND\s*;?\s*$/i.exec(stripSqlComments(code))?.[1];
}

function envelopeChangeStatements(script: string): string[] {
  // This helper is reachable from the app's applySchema barrel as well as the CLI. Keep the shared
  // quote-aware lexer dependency-free; a migration AST parser belongs to the CLI safety gate. Inspect
  // plain static DO bodies directly, including ALTER TYPE/USING spellings that AST parsers may omit.
  return splitSqlStatements(stripSqlComments(script)).flatMap((statement) => {
    const body = staticDoBody(statement);
    return splitSqlStatements(
      blankStringLiterals(stripSqlComments(body ?? statement)),
    );
  });
}

/** Return a non-waivable refusal for a type or position change on a declared encrypted cell. A cast to bytea
 * stores plaintext bytes; a rename does not rebind an existing envelope's authentication. Used before generate retains its
 * new snapshot, and before apply executes a pending file (including an older file carrying unsafe consent).
 * Adding a fresh nullable encrypted column remains the expand step this refusal points at. */
export function encryptedEnvelopeConversionRefusal(
  app: App,
  script: string,
): string | null {
  const statements = envelopeChangeStatements(script);
  const cells: string[] = [];
  for (const m of app.model) {
    const alters = new RegExp(
      `^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?${
        tablePattern(m.pgSchema, m.name)
      }(?:\\s*\\*)?(?=\\s|$)`,
      "i",
    );
    for (const field of m.encrypted) {
      const changesType = new RegExp(
        `\\bALTER\\s+(?:COLUMN\\s+)?${
          identifier(field)
        }\\s+(?:SET\\s+DATA\\s+)?TYPE\\b`,
        "i",
      );
      const renamesToField = new RegExp(
        `\\bRENAME\\s+(?:COLUMN\\s+)?(?:"(?:[^"]|"")+"|[A-Za-z_]\\w*)\\s+TO\\s+${
          identifier(field)
        }(?=\\s|$)`,
        "i",
      );
      if (
        statements.some((statement) =>
          alters.test(statement) &&
          (changesType.test(statement) || renamesToField.test(statement))
        )
      ) cells.push(`${m.pgSchema}.${m.name}.${field}`);
    }
  }
  if (cells.length === 0) return null;
  return `encrypted/seal-forward-required: ${
    cells.sort().join(", ")
  } changes an existing column's encrypted storage or authenticated position. SQL TYPE/USING casts do not seal values, and RENAME does not rebind an envelope; --allow-unsafe-ddl cannot author or apply this conversion. Add a separate nullable encrypted field, seal existing values through ctx.data updates with the configured KMS, verify every retained row, switch all readers/writers, then remove the plaintext in a later migration. Keep the sealed field's name: its authenticated envelope is bound to that field and cannot be renamed by copying bytes. See the handbook's encrypted-migration.md for the staged workflow.`;
}

/** Append an idempotent aggregate UPDATE only for newly added rollup columns on an existing parent.
 * Existing rollups are left alone, and a freshly created parent has no prior child set to backfill. Derive
 * lifecycle predicates from the same source as runtime maintenance, including rectified/expired rows. */
export function appendRollupBackfills(app: App, script: string): string | null {
  const statements = splitSqlStatements(
    blankStringLiterals(stripSqlComments(script)),
  );
  const appends: string[] = [];
  for (const parent of app.model) {
    if (parent.rollupOwnCols.length === 0) continue;
    const table = tablePattern(parent.pgSchema, parent.name);
    const creates = new RegExp(
      `^CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${table}\\s*\\(`,
      "i",
    );
    if (statements.some((statement) => creates.test(statement))) continue;
    const alters = new RegExp(
      `^ALTER\\s+TABLE\\s+(?:ONLY\\s+)?${table}\\s+`,
      "i",
    );
    const added = new Set(parent.rollupOwnCols.filter((column) => {
      const adds = new RegExp(
        `\\bADD\\s+(?:COLUMN\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?${
          identifier(column)
        }(?=\\s|$)`,
        "i",
      );
      return statements.some((statement) =>
        alters.test(statement) && adds.test(statement)
      );
    }));
    if (added.size === 0) continue;
    const parentTable = `"${parent.pgSchema}"."${parent.name}"`;
    const assignments: SQL[] = [];
    for (const child of app.model) {
      for (const target of child.rollupTargets) {
        if (target.parentTable !== parentTable || !added.has(target.column)) {
          continue;
        }
        const field = query`${query.identifier("_rollup_child")}.${
          query.identifier(target.field ?? "id")
        }`;
        const agg = target.kind === "count"
          ? query`count(*)`
          : target.kind === "sum"
          ? query`coalesce(sum(${field}), 0)`
          : target.kind === "avg"
          ? query`avg(${field})`
          : target.kind === "min"
          ? query`min(${field})`
          : query`max(${field})`;
        const predicates = [
          query`${query.identifier("_rollup_child")}.${
            query.identifier(target.parentFk)
          } = ${query.identifier("_rollup_parent")}."id"`,
          ...lifecycleSql(child.features, query`now()`, "_rollup_child"),
        ];
        assignments.push(
          query`${query.identifier(target.column)} = (SELECT ${agg} FROM ${
            query.identifier(child.pgSchema)
          }.${query.identifier(child.name)} AS ${
            query.identifier("_rollup_child")
          } WHERE ${query.join(predicates, query` AND `)})`,
        );
      }
    }
    if (assignments.length === 0) continue;
    appends.push(
      compileSql(
        query`UPDATE ${query.raw(parentTable)} AS ${
          query.identifier("_rollup_parent")
        } SET ${query.join(assignments, query`, `)}`,
      ).sql + ";",
    );
  }
  if (appends.length === 0) return null;
  return `${script.trimEnd()}\n--> statement-breakpoint\n${
    appends.join("\n--> statement-breakpoint\n")
  }\n`;
}
