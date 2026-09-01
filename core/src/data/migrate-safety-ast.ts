// A strict widening, never a weakening: a script with no dollar-quoting/DO returns byte-identical input;
// a parseable one returns the flattened statement list.
import { parse, toSql } from "pgsql-ast-parser";
import { dollarQuoteOpens } from "./ddl-parse.ts";
import { carriesDynamicSql } from "./migrate-sql-text.ts";

/** Node types the model may re-render as plain static statements — DDL/DML that runs at migration time.
 *  Anything outside (create function/trigger/procedure — dormant bodies) falls to the refuse-floor. */
const STATIC_STATEMENT_TYPES: ReadonlySet<string> = new Set([
  "alter table",
  "create table",
  "create index",
  "create schema",
  "create sequence",
  "create extension",
  "alter sequence",
  "drop table",
  "drop index",
  "drop sequence",
  "truncate table",
  "insert",
  "update",
  "delete",
  "select",
  "set",
  "comment",
  "create view",
  "drop view",
]);

/** Does the script carry the constructs the textual gates refuse (the check-7 trigger set)? The dynamic-SQL
 *  half is `carriesDynamicSql`'s answer and the dollar half is the walker's, so the refuse-floor and the
 *  blanking decision cannot disagree. */
export function hasProceduralSurface(sql: string): boolean {
  return /(^|;)\s*DO\b/i.test(sql) || carriesDynamicSql(sql) ||
    dollarQuoteOpens(sql);
}

/** Parse + flatten a DO body ("BEGIN <static statements> END") to rendered statements, or null. */
function flattenDoBody(code: string): string[] | null {
  if (/\bEXECUTE\b/i.test(code)) return null; // dynamic SQL — only the refuse-floor is honest
  if (/\bDECLARE\b/i.test(code)) return null; // procedural state — beyond a static statement model
  const m = code.match(/^\s*BEGIN\b([\s\S]*?)\bEND\s*;?\s*$/i);
  if (!m) return null; // not the plain BEGIN…END shape — refuse-floor
  try {
    return parse(m[1]!).map((st) => toSql.statement(st));
  } catch {
    return null; // an unparseable body is exactly what the refuse-floor exists for
  }
}

/** The statement-model preprocessor the migrate gates share: null keeps the refuse-floor; a string runs
 *  every gate over it (byte-identical to the input unless the script carried dollar-quoting/DO). */
export function expandProceduralScript(sql: string): string | null {
  if (!hasProceduralSurface(sql)) return sql; // the common case: byte-identical, zero parser involvement
  if (carriesDynamicSql(sql)) return null; // dynamic SQL anywhere — refuse (composable destruction)
  let stmts;
  try {
    stmts = parse(sql);
  } catch {
    return null; // the parser cannot prove it static — the refuse-floor stands
  }
  const out: string[] = [];
  for (const st of stmts) {
    if (st.type === "do") {
      const flat = flattenDoBody((st as { code?: string }).code ?? "");
      if (flat === null) return null;
      out.push(...flat);
    } else if (STATIC_STATEMENT_TYPES.has(st.type)) {
      out.push(toSql.statement(st));
    } else {
      // a node outside the known-static allowlist (CREATE FUNCTION/TRIGGER/PROCEDURE — bodies that run
      // later) is future procedural code the model cannot classify by flattening — refuse-floor stands.
      return null;
    }
  }
  return out.map((s) => (s.trimEnd().endsWith(";") ? s : `${s};`)).join("\n");
}
