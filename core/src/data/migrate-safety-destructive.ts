import { bareName, QUALIFIED_NAME } from "./migrate-safety-names.ts";
import { blankStringLiterals, carriesDynamicSql } from "./migrate-sql-text.ts";
// Barrel re-exports keep import sites stable.
import type { Violation } from "../core/structural-violation.ts";
import {
  BASELINE_FRESH,
  FRAMEWORK_TABLE_ADDITIVE,
  IMMUTABLE_PROTECTED,
  SAFE_DDL,
  statements,
} from "./migrate-safety-core.ts";
import { NON_AUDIT_FRAMEWORK_TABLES } from "./migrate-derive.ts"; // single-sources the framework-table roster

/** The table(s) a statement targets, normalized via `bareName`. `DROP TABLE` may name a comma-separated
 *  list — all are returned so the gate fires if any is off-limits. Returns [] for a statement with no base table. */
function targetTables(stmt: string): string[] {
  const drop = new RegExp(
    String
      .raw`\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QUALIFIED_NAME}(?:\s*,\s*${QUALIFIED_NAME})*)`,
    "i",
  ).exec(stmt);
  if (drop) {
    return (drop[1] ?? "")
      .split(",")
      .map((t) => bareName(t))
      .filter((t): t is string => t !== null);
  }
  const dropSchema = new RegExp(
    String
      .raw`\bDROP\s+(?:SCHEMA|DATABASE)\s+(?:IF\s+EXISTS\s+)?(${QUALIFIED_NAME})`,
    "i",
  ).exec(stmt);
  if (dropSchema) {
    const bare = bareName(dropSchema[1] ?? "");
    return bare ? [bare] : [];
  }
  if (/\bDROP\s+OWNED\b/i.test(stmt)) return ["owned"];
  // `DROP INDEX [CONCURRENTLY] [IF EXISTS] <name>[, …]` — the INDEX's own name, which is what the
  // immutable / framework-table sets are matched against; a DROP INDEX names no base table.
  const dropIndex = new RegExp(
    String
      .raw`\bDROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?(${QUALIFIED_NAME}(?:\s*,\s*${QUALIFIED_NAME})*)`,
    "i",
  ).exec(stmt);
  if (dropIndex) {
    return (dropIndex[1] ?? "")
      .split(",")
      .map((t) => bareName(t))
      .filter((t): t is string => t !== null);
  }
  const single = new RegExp(
    String
      .raw`\b(?:ALTER\s+TABLE|TRUNCATE(?:\s+TABLE)?)\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QUALIFIED_NAME})`,
    "i",
  ).exec(stmt);
  if (single) {
    const bare = bareName(single[1] ?? "");
    return bare ? [bare] : [];
  }
  return [];
}

/** A table-rename ALTER: `ALTER TABLE <t> RENAME TO <t2>` — the table disappears at its declared name
 *  (destructive per `cli/migrate.md`). `RENAME COLUMN`/`RENAME CONSTRAINT` carry a keyword before `TO`,
 *  so `\bRENAME\s+TO\b` matches the table rename only. */
function isTableRename(stmt: string): boolean {
  return /\bALTER\s+TABLE\b/i.test(stmt) && /\bRENAME\s+TO\b/i.test(stmt);
}

/** Destructive: a table/column/constraint/default/not-null DROP, a table RENAME (vanishes at its name),
 *  TRUNCATE, or a DROP INDEX. ADD (column/constraint/table) is additive, never destructive. */
function isDestructive(stmt: string): boolean {
  if (/\bDROP\s+TABLE\b/i.test(stmt)) return true;
  if (/\bTRUNCATE\b/i.test(stmt)) return true;
  if (isTableRename(stmt)) return true; // the table disappears at its name — destructive per cli/migrate.md
  // DROP SCHEMA/DATABASE/OWNED … CASCADE used to slip the destructive gate (a classified wipe).
  if (
    /\bDROP\s+(?:SCHEMA|DATABASE|OWNED)\b/i.test(stmt) &&
    /\bCASCADE\b/i.test(stmt)
  ) {
    return true;
  }
  // A bare `DROP INDEX` used to be left "to other gates" — there were none, so a UNIQUE index vanished
  // under a ✓. In Postgres a UNIQUE constraint IS a unique index, so `DROP CONSTRAINT` (gated here since
  // the beginning) and `DROP INDEX` are one act spelled two ways; only one was ever asked about. The
  // declared invariant is what disappears, not the bytes, which is why this is the destructive gate and
  // not the lock lint — `--allow-destructive` is the one flag that already means "an invariant may go".
  if (/\bDROP\s+INDEX\b/i.test(stmt)) return true;
  // requires an ALTER TABLE context and a DROP sub-clause so ADD never trips this.
  if (
    /\bALTER\s+TABLE\b/i.test(stmt) &&
    /\bDROP\s+(?:COLUMN\b|CONSTRAINT\b|DEFAULT\b|NOT\s+NULL\b)/i.test(stmt)
  ) {
    return true;
  }
  return false;
}

/** A single column identifier — a bare identifier (`body`) or a double-quoted one (`"body"`). */
const COLUMN_NAME = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)`;

/** The (table, column) a `ALTER TABLE <t> DROP COLUMN <c>` removes — the silent half of drizzle-kit's
 *  add+drop-for-a-rename. Names are reduced via `bareName` so they match an ADD on the same table. */
function droppedColumn(stmt: string): { table: string; column: string } | null {
  if (!/\bALTER\s+TABLE\b/i.test(stmt)) return null;
  const t = targetTables(stmt)[0];
  if (!t) return null;
  const m = new RegExp(
    String.raw`\bDROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?(${COLUMN_NAME})`,
    "i",
  ).exec(stmt);
  if (!m) return null;
  const col = bareName(m[1] ?? "");
  return col ? { table: t, column: col } : null;
}

/** The (table, column) a `ALTER TABLE <t> ADD COLUMN <c>` adds — the appearing half of a drizzle-kit
 *  add+drop-for-a-rename. Returns null when the statement is not a column add. */
function addedColumn(stmt: string): { table: string; column: string } | null {
  if (!/\bALTER\s+TABLE\b/i.test(stmt)) return null;
  const t = targetTables(stmt)[0];
  if (!t) return null;
  const m = new RegExp(
    String.raw`\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(${COLUMN_NAME})`,
    "i",
  ).exec(stmt);
  if (!m) return null;
  const col = bareName(m[1] ?? "");
  return col ? { table: t, column: col } : null;
}

/** Human-readable destructive-op label for the finding message (DROP TABLE vs DROP COLUMN vs TRUNCATE). */
function destructiveKind(stmt: string): string {
  if (/\bDROP\s+TABLE\b/i.test(stmt)) return "DROP TABLE";
  if (/\bDROP\s+SCHEMA\b/i.test(stmt)) return "DROP SCHEMA";
  if (/\bDROP\s+DATABASE\b/i.test(stmt)) return "DROP DATABASE";
  if (/\bDROP\s+OWNED\b/i.test(stmt)) return "DROP OWNED";
  if (/\bTRUNCATE\b/i.test(stmt)) return "TRUNCATE";
  if (isTableRename(stmt)) return "ALTER … RENAME TO";
  if (/\bDROP\s+INDEX\b/i.test(stmt)) return "DROP INDEX";
  if (/\bDROP\s+COLUMN\b/i.test(stmt)) return "ALTER … DROP COLUMN";
  return "destructive ALTER (DROP constraint/default/not-null)";
}

/**
 * `migrate/immutable-protected`: destructive DDL (DROP / destructive ALTER / TRUNCATE) against an
 * immutable table (`_audit` plus any `opts.immutable`) is a hard build error with no accept path — the
 * runtime `REVOKE` cannot stop a migration (it runs in the owner role), so this static gate is the
 * front line. Additive ops, and destructive ops on non-immutable tables, are out of scope here.
 */
export function immutableProtected(
  sql: string,
  opts: { immutable?: readonly string[]; resource?: string } = {},
): Violation[] {
  const resource = opts.resource ?? "migration";
  const immutable = new Set<string>(["_audit", ...(opts.immutable ?? [])]);
  const out: Violation[] = [];
  const dynamic = carriesDynamicSql(sql);

  for (const rawStmt of statements(sql)) {
    // A DDL keyword inside a STRING is prose, not DDL — but only while the script has no dynamic SQL, where
    // a string IS the statement. Quoted identifiers are never blanked: they carry the table name.
    const stmt = dynamic ? rawStmt : blankStringLiterals(rawStmt);
    if (!isDestructive(stmt)) continue;
    for (const table of targetTables(stmt)) {
      if (!immutable.has(table)) continue;
      out.push({
        id: IMMUTABLE_PROTECTED,
        resource,
        message: `${
          destructiveKind(stmt)
        } against immutable table '${table}' is a build error with no --accept — an immutable / _audit table is WORM (append-only); destructive DDL is never constructible. Add a new table/column or supply a forward migration, never drop or truncate immutable history`,
      });
    }
  }
  return out;
}

/** Framework-internal tables (`cli/migrate.md §framework-tables`): `_audit` plus every table in the
 *  single-source `NON_AUDIT_FRAMEWORK_TABLES` roster, so the feature-gated tables are equally guarded by
 *  the additive gate. Per-resource `<r>_i18n`/`<r>_tree` sidecars are NOT in this set — they travel the
 *  ordinary app-migration safe-DDL path. */
const FRAMEWORK_TABLES: ReadonlySet<string> = new Set([
  "_audit",
  ...NON_AUDIT_FRAMEWORK_TABLES,
]);

/**
 * `migrate/framework-table-additive`: framework-emitted DDL touching a `_`-prefixed framework table
 * must be additive-only — a destructive op is a build error with no `--accept` (the framework does not
 * exempt itself from its own immutable guard). Destructive ops on non-framework tables are out of scope.
 */
export function frameworkTableAdditive(
  sql: string,
  resource = "framework-migration",
): Violation[] {
  const out: Violation[] = [];
  const dynamic = carriesDynamicSql(sql);
  for (const rawStmt of statements(sql)) {
    // A DDL keyword inside a STRING is prose, not DDL — but only while the script has no dynamic SQL, where
    // a string IS the statement. Quoted identifiers are never blanked: they carry the table name.
    const stmt = dynamic ? rawStmt : blankStringLiterals(rawStmt);
    if (!isDestructive(stmt)) continue;
    for (const table of targetTables(stmt)) {
      if (!FRAMEWORK_TABLES.has(table)) continue;
      out.push({
        id: FRAMEWORK_TABLE_ADDITIVE,
        resource,
        message: `${
          destructiveKind(stmt)
        } against framework table '${table}' must be additive-only — framework-emitted DDL touching a _-prefixed framework table is a build error with no --accept (the framework does not exempt itself from its own immutable guard). Only ADD COLUMN / CREATE is permitted against framework tables; evolve them additively`,
      });
    }
  }
  return out;
}

/** A table where a column is both dropped and added in the same migration — drizzle-kit's silent
 *  drop+add for an unrecognized rename. Shared shape: the classifier and the `.data.ts` scaffolder agree. */
export interface AmbiguousRenamePair {
  readonly table: string;
  readonly dropped: readonly string[];
  readonly added: readonly string[];
}

/**
 * The structured detector behind `classifyDangerousChange`: collects, per table, the columns dropped and
 * added in a migration and returns tables where both happen. A pure drop, a pure add, or a drop+add
 * across different tables is not a pair — single-sourced so the danger verdict and the scaffolder agree.
 */
export function ambiguousRenamePairs(sql: string): AmbiguousRenamePair[] {
  // A DROP/ADD COLUMN inside a string is prose — an `INSERT … VALUES ('ALTER TABLE users DROP COLUMN email')`
  // paired with a real ADD and refused the migration as an ambiguous rename, scaffolding a `.data.ts` shell
  // for a rename nobody wrote. Quoted identifiers survive the blanking: they carry the names matched here.
  const dynamic = carriesDynamicSql(sql);
  const stmts = statements(sql).map((s) =>
    dynamic ? s : blankStringLiterals(s)
  );
  const dropped = new Map<string, Set<string>>();
  const added = new Map<string, Set<string>>();
  const record = (
    map: Map<string, Set<string>>,
    table: string,
    column: string,
  ) => {
    const set = map.get(table) ?? new Set<string>();
    set.add(column);
    map.set(table, set);
  };
  for (const stmt of stmts) {
    const d = droppedColumn(stmt);
    if (d) record(dropped, d.table, d.column);
    const a = addedColumn(stmt);
    if (a) record(added, a.table, a.column);
  }
  const pairs: AmbiguousRenamePair[] = [];
  for (const [table, drops] of [...dropped.entries()].sort()) {
    const adds = added.get(table);
    if (!adds || adds.size === 0) continue; // a pure drop is the unambiguous destructive row — not this gate
    pairs.push({ table, dropped: [...drops].sort(), added: [...adds].sort() });
  }
  return pairs;
}

/**
 * The §safety danger classification (cli/migrate.md §safety): a column DROP and a column ADD on the
 * same table in the same migration is exactly drizzle-kit's silent drop+add for a rename it could not
 * infer, so the framework MUST not guess which it is — it blocks until intent is declared (a `RENAME
 * COLUMN`, a `.data.ts` transform, or an explicit confirm). A pure drop or pure add is out of scope here
 * (the destructive/safe rows); pairing is per-table. Rides the `migrate/safe-ddl` id.
 */
export function classifyDangerousChange(
  sql: string,
  resource = "migration",
): Violation[] {
  const out: Violation[] = [];
  // a table with both a drop and an add is the ambiguous drop+add — the silent-rename shape
  for (const { table, dropped, added } of ambiguousRenamePairs(sql)) {
    const droppedList = dropped.join(", ");
    const addedList = added.join(", ");
    out.push({
      id: SAFE_DDL,
      resource,
      message:
        `AMBIGUOUS change on table '${table}': column(s) {${droppedList}} disappear and column(s) {${addedList}} appear in the same migration — this is exactly drizzle-kit's silent drop+add for a column RENAME it could not infer, and the framework will NOT guess whether it is a rename (data preserved) or a genuine drop+add (data discarded). Declare intent: emit ALTER … RENAME COLUMN for a rename, or supply a .data.ts transform to carry the values across; for a genuine drop, take it through \`migrate generate --allow-destructive\`. The build stays red until intent is declared — silent data loss is not constructible`,
    });
  }
  return out;
}

/**
 * `migrate/baseline-fresh`: the terminal committed snapshot re-diffed against the derived schema must be
 * empty or exactly one in-flight migration; anything else is a clean-but-wrong auto-merged baseline that
 * matches no branch — a build error with no `--accept`. This models the re-diff's result (the diff itself
 * is whole-schema and latency-heavy, run only on generate + cold/ci) so the predicate stays pure.
 * `rediffEmpty:false` is deliberately distinct from `{pending:1}` — it carries no count nuance, so it
 * always fires; only the object form can assert the single-in-flight exemption.
 */
export function baselineFresh(
  rediffEmpty: boolean | { pending: number },
  resource = "baseline",
): Violation[] {
  if (rediffEmpty === true) return []; // the re-diff is empty — a fresh baseline
  if (
    typeof rediffEmpty === "object" &&
    (rediffEmpty.pending === 0 || rediffEmpty.pending === 1)
  ) {
    return []; // empty, or exactly one in-flight migration — within the fresh envelope
  }
  const detail = rediffEmpty === false
    ? "a non-empty unexpected diff"
    : `${(rediffEmpty as { pending: number }).pending} unexpected migrations`;
  return [{
    id: BASELINE_FRESH,
    resource,
    message:
      `the terminal committed snapshot re-diffed against the derived schema is not fresh (${detail}) — it must be EMPTY or exactly one in-flight migration; an unexpected diff is a clean-but-wrong auto-merged baseline that matches no branch — re-derive the baseline from the current declarations`,
  }];
}

/**
 * The statements in a script that DESTROY something — any table, not only a protected one.
 *
 * It reuses `immutableProtected` with every identifier in the statement marked immutable, so there is ONE
 * destructive-DDL model rather than a second regex. Two readers need it: `generate` refuses on it unless
 * `--allow-destructive`, and the standalone `--safe-ddl` lint reports it — that mode ran only the
 * `_audit`-scoped guard, so a hand-written `DROP TABLE users` read as clean while `generate` refused it.
 */
export function destructiveStatements(sql: string): string[] {
  return statements(sql).filter((stmt) =>
    immutableProtected(stmt, {
      immutable: [...stmt.matchAll(/"([^"]*)"|([A-Za-z_][\w$]*)/g)].map((m) =>
        m[1] ?? m[2]!
      ),
    }).length > 0
  );
}
