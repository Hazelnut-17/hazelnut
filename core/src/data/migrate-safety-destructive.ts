import { bareName, QUALIFIED_NAME } from "./migrate-safety-names.ts";
import {
  blankSqlLiterals,
  blankStringLiterals,
  carriesDynamicSql,
} from "./migrate-sql-text.ts";
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

/** One table reference as Postgres spells it in a list: `ONLY t`, `t *`, `"s"."t"`. */
const TABLE_REF = String.raw`(?:ONLY\s+)?${QUALIFIED_NAME}(?:\s*\*)?`;
const TABLE_REF_LIST = String.raw`${TABLE_REF}(?:\s*,\s*${TABLE_REF})*`;

/** Every name in a comma-separated table list, reduced via `bareName`. `ONLY` and the descendant `*` are
 *  syntax, not part of the name — leaving them attached made `bareName` return the keyword. */
function nameList(captured: string | undefined): string[] {
  return (captured ?? "")
    .split(",")
    .map((t) => bareName(t.replace(/^\s*ONLY\b/i, "").replace(/\*\s*$/, "")))
    .filter((t): t is string => t !== null);
}

function firstName(captured: string | undefined): string[] {
  const bare = bareName(captured ?? "");
  return bare ? [bare] : [];
}

/** The table(s) a statement targets, normalized via `bareName`. `DROP TABLE`, `TRUNCATE` and `DROP INDEX`
 *  each take a comma-separated list — all are returned so the gate fires if any is off-limits. Returns []
 *  for a statement with no base table. */
function targetTables(stmt: string): string[] {
  const drop = new RegExp(
    String.raw`\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(${TABLE_REF_LIST})`,
    "i",
  ).exec(stmt);
  if (drop) return nameList(drop[1]);
  // TRUNCATE takes a list too. Reading only its head let a WORM table's POSITION decide the verdict:
  // `TRUNCATE users, _audit` read clean while `TRUNCATE _audit, users` was a hard error.
  const truncate = new RegExp(
    String.raw`\bTRUNCATE\s+(?:TABLE\s+)?(${TABLE_REF_LIST})`,
    "i",
  ).exec(stmt);
  if (truncate) return nameList(truncate[1]);
  const del = new RegExp(
    String.raw`\bDELETE\s+FROM\s+(?:ONLY\s+)?(${QUALIFIED_NAME})`,
    "i",
  ).exec(stmt);
  if (del) return firstName(del[1]);
  const dropSchema = new RegExp(
    String
      .raw`\bDROP\s+(?:SCHEMA|DATABASE)\s+(?:IF\s+EXISTS\s+)?(${QUALIFIED_NAME})`,
    "i",
  ).exec(stmt);
  if (dropSchema) return firstName(dropSchema[1]);
  // A trigger or policy is named on its table, and on `_audit` it is plausibly the append-only enforcement
  // itself — so the protected set must see the table it hangs on, not the object's own name.
  const onTable = new RegExp(
    String
      .raw`\bDROP\s+(?:TRIGGER|POLICY|RULE)\s+(?:IF\s+EXISTS\s+)?${QUALIFIED_NAME}\s+ON\s+(?:ONLY\s+)?(${QUALIFIED_NAME})`,
    "i",
  ).exec(stmt);
  if (onTable) return firstName(onTable[1]);
  // `DROP INDEX [CONCURRENTLY] [IF EXISTS] <name>[, …]` — the INDEX's own name, which is what the
  // immutable / framework-table sets are matched against; a DROP INDEX names no base table.
  const dropIndex = new RegExp(
    String
      .raw`\bDROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?(${QUALIFIED_NAME}(?:\s*,\s*${QUALIFIED_NAME})*)`,
    "i",
  ).exec(stmt);
  if (dropIndex) return nameList(dropIndex[1]);
  const alter = new RegExp(
    String
      .raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QUALIFIED_NAME})`,
    "i",
  ).exec(stmt);
  if (alter) return firstName(alter[1]);
  return [];
}

/** A table-rename ALTER: `ALTER TABLE <t> RENAME TO <t2>` — the table disappears at its declared name
 *  (destructive per `cli/migrate.md`). `RENAME COLUMN`/`RENAME CONSTRAINT` carry a keyword before `TO`,
 *  so `\bRENAME\s+TO\b` matches the table rename only. */
function isTableRename(stmt: string): boolean {
  return /\bALTER\s+TABLE\b/i.test(stmt) && /\bRENAME\s+TO\b/i.test(stmt);
}

/** The object kinds whose DROP removes a declaration the app depends on. Silence here was not a decision:
 *  the AST model already classifies `DROP VIEW` / `DROP SEQUENCE`, and the classifier read them clean. */
const DROPPABLE_OBJECT = String
  .raw`MATERIALIZED\s+VIEW|VIEW|FUNCTION|PROCEDURE|TRIGGER|SEQUENCE|TYPE|DOMAIN|RULE|POLICY`;

/** A `DELETE` with no `WHERE` empties the table — `TRUNCATE` spelled differently, and destructive against
 *  any table. With a `WHERE` it is an ordinary targeted repair; `removesRows` holds the WORM reading. */
function isUnqualifiedDelete(stmt: string): boolean {
  return /\bDELETE\s+FROM\b/i.test(stmt) && !/\bWHERE\b/i.test(stmt);
}

/** Any row-removing DML. Destructive against an APPEND-ONLY table only, where a `WHERE` changes nothing:
 *  removing one row of WORM history breaks the same invariant as removing all of them. */
function removesRows(stmt: string): boolean {
  return /\bDELETE\s+FROM\b/i.test(stmt);
}

/** `DROP OWNED BY <role>` drops every object that role owns. Which tables those are cannot be resolved
 *  offline, so a protected-table gate must treat it as reaching all of them. */
function isDropOwned(stmt: string): boolean {
  return /\bDROP\s+OWNED\b/i.test(stmt);
}

/** Destructive: a table/column/constraint/default/not-null DROP, a table RENAME (vanishes at its name),
 *  TRUNCATE, an unqualified DELETE, a DROP INDEX, or a DROP of any declared object. ADD (column /
 *  constraint / table) is additive, never destructive. */
function isDestructive(stmt: string): boolean {
  if (/\bDROP\s+TABLE\b/i.test(stmt)) return true;
  if (/\bTRUNCATE\b/i.test(stmt)) return true;
  if (isUnqualifiedDelete(stmt)) return true;
  if (isTableRename(stmt)) return true; // the table disappears at its name — destructive per cli/migrate.md
  // No CASCADE precondition: `DROP SCHEMA app` and `DROP OWNED BY r` drop what they reach on their own,
  // and RESTRICT only refuses when something DEPENDS on it — never when the objects are merely present.
  if (/\bDROP\s+(?:SCHEMA|DATABASE|OWNED)\b/i.test(stmt)) return true;
  if (
    new RegExp(String.raw`\bDROP\s+(?:${DROPPABLE_OBJECT})\b`, "i").test(stmt)
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
  if (isDropOwned(stmt)) return "DROP OWNED";
  if (/\bTRUNCATE\b/i.test(stmt)) return "TRUNCATE";
  if (removesRows(stmt)) return "DELETE FROM";
  if (isTableRename(stmt)) return "ALTER … RENAME TO";
  if (/\bDROP\s+INDEX\b/i.test(stmt)) return "DROP INDEX";
  const object = new RegExp(String.raw`\bDROP\s+(${DROPPABLE_OBJECT})\b`, "i")
    .exec(stmt);
  if (object) return `DROP ${object[1]!.toUpperCase().replace(/\s+/g, " ")}`;
  if (/\bDROP\s+COLUMN\b/i.test(stmt)) return "ALTER … DROP COLUMN";
  return "destructive ALTER (DROP constraint/default/not-null)";
}

/**
 * The ONE walk both protected-table gates run, so a predicate added to the destructive model reaches
 * both. They each carried their own copy of this loop, and every reader added to one — the DELETE
 * clause, the DROP OWNED reach — would have had to be remembered twice to bind at all.
 */
function scanProtected(
  sql: string,
  scan: {
    tables: ReadonlySet<string>;
    id: string;
    resource: string;
    message: (kind: string, target: string) => string;
    ownedMessage: string;
    indexMessage: (index: string, table: string) => string;
  },
): Violation[] {
  const out: Violation[] = [];
  const dynamic = carriesDynamicSql(sql);
  const push = (message: string) =>
    out.push({ id: scan.id, resource: scan.resource, message });
  for (const rawStmt of statements(sql)) {
    // TWO views of one statement, because the two questions want different text. A DDL keyword inside a
    // STRING is prose in both — but only while the script has no dynamic SQL, where a string IS the
    // statement.
    //  · `shape` blanks quoted-identifier bodies too, and is what KEYWORDS are matched on: a column named
    //    `"drop constraint"` is a name, and reading it as a clause refused a purely additive migration.
    //  · `named` keeps them, and is what NAMES are read from — blanking there would hide the table.
    const named = dynamic ? rawStmt : blankStringLiterals(rawStmt);
    const shape = dynamic ? rawStmt : blankSqlLiterals(rawStmt);
    if (isDropOwned(shape)) {
      push(scan.ownedMessage);
      continue;
    }
    // `removesRows` beside `isDestructive`: a `DELETE … WHERE` is an ordinary repair on an app table and
    // an append-only violation here, so the WORM reading is wider than the any-table one.
    if (!isDestructive(shape) && !removesRows(shape)) continue;
    const kind = destructiveKind(shape);
    const indexDrop = /\bDROP\s+INDEX\b/i.test(shape);
    for (const name of targetTables(named)) {
      if (scan.tables.has(name)) {
        push(scan.message(kind, name));
        continue;
      }
      // A `DROP INDEX` names an index, and which table it belongs to cannot be resolved offline. Postgres
      // names its own `<table>_<column>_{key,idx}`, so an index whose name begins with a protected table's
      // is conservatively read as that table's — the alternative is a WORM table's uniqueness guarantee
      // leaving through the waivable door while the gate that exists to stop it says nothing.
      if (!indexDrop) continue;
      const owner = [...scan.tables].find((t) => name.startsWith(`${t}_`));
      if (owner) push(scan.indexMessage(name, owner));
    }
  }
  return out;
}

/**
 * `migrate/immutable-protected`: destructive DDL (DROP / destructive ALTER / TRUNCATE) or any row removal
 * against an immutable table (`_audit` plus any `opts.immutable`) is a hard build error with no accept
 * path — the runtime `REVOKE` cannot stop a migration (it runs in the owner role), so this static gate is
 * the front line. Additive ops, and destructive ops on non-immutable tables, are out of scope here.
 */
export function immutableProtected(
  sql: string,
  opts: { immutable?: readonly string[]; resource?: string } = {},
): Violation[] {
  return scanProtected(sql, {
    tables: new Set<string>(["_audit", ...(opts.immutable ?? [])]),
    id: IMMUTABLE_PROTECTED,
    resource: opts.resource ?? "migration",
    message: (kind, target) =>
      `${kind} against immutable table '${target}' is a build error with no --accept — an immutable / _audit table is WORM (append-only); destructive DDL is never constructible. Add a new table/column or supply a forward migration, never drop or truncate immutable history`,
    ownedMessage:
      `DROP OWNED drops every object the named role owns, which offline cannot be shown to exclude the immutable / _audit tables — a build error with no --accept. Name the objects to drop explicitly, so the gate can read which tables they are`,
    indexMessage: (index, table) =>
      `DROP INDEX '${index}' reads as an index of immutable table '${table}' (Postgres names its own <table>_<column>_key/_idx) — a build error with no --accept. An immutable / _audit table is WORM, and a UNIQUE index IS the uniqueness guarantee, so dropping it removes an invariant the table's history depends on. Which table an index belongs to cannot be resolved offline, so a name that begins with a protected table's is read as that table's; rename the index if it is not one`,
  });
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
  return scanProtected(sql, {
    tables: FRAMEWORK_TABLES,
    id: FRAMEWORK_TABLE_ADDITIVE,
    resource,
    message: (kind, target) =>
      `${kind} against framework table '${target}' must be additive-only — framework-emitted DDL touching a _-prefixed framework table is a build error with no --accept (the framework does not exempt itself from its own immutable guard). Only ADD COLUMN / CREATE is permitted against framework tables; evolve them additively`,
    ownedMessage:
      `DROP OWNED drops every object the named role owns, which offline cannot be shown to exclude the _-prefixed framework tables — a build error with no --accept. Name the objects to drop explicitly, so the gate can read which tables they are`,
    indexMessage: (index, table) =>
      `DROP INDEX '${index}' reads as an index of framework table '${table}' (Postgres names its own <table>_<column>_key/_idx) — a build error with no --accept. Framework-emitted DDL touching a _-prefixed framework table must be additive-only, and a UNIQUE index IS the uniqueness guarantee. Which table an index belongs to cannot be resolved offline, so a name that begins with a framework table's is read as that table's`,
  });
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
 * It reads `isDestructive` directly, which is the same model the protected gates walk. It used to route
 * through `immutableProtected` with every identifier in the statement marked immutable, and that made the
 * verdict depend on an identifier MATCHING: `DROP OWNED` answered a lowercase `"owned"` sentinel, so the
 * statement read clean whenever its author capitalised the keyword. Two readers need this: `generate`
 * refuses on it unless `--allow-destructive`, and the standalone `--safe-ddl` lint reports it.
 */
/** The line `generate --allow-destructive` stamps into the migration it authors. A COMMENT, so every gate's
 *  comment-stripping pass ignores it and only the readers that ask about authorization see it. */
export const ALLOW_DESTRUCTIVE_MARKER = "-- hazelnut: allow-destructive";

/**
 * Whether a committed migration carries the operator's destructive confirm. Without it the framework's own
 * prescription was unreachable: the refusal says to re-run with `--allow-destructive`, that run wrote
 * nothing down, and `audit --strict` then convicted the very migration it had told the operator to author.
 * It answers for the DESTRUCTIVE reading only — an immutable / framework-table violation has no accept path,
 * so a marker must never launder one.
 */
export function carriesDestructiveConsent(sql: string): boolean {
  return new RegExp(`^\\s*${ALLOW_DESTRUCTIVE_MARKER}\\b`, "im").test(sql);
}

export function destructiveStatements(sql: string): string[] {
  return statements(sql).filter((rawStmt) => {
    // The SHAPE view: identifier bodies blanked too, because this asks only about keywords. Reading them
    // called `ALTER TABLE t ADD COLUMN "drop constraint" text` — a purely additive statement — destructive.
    const shape = carriesDynamicSql(rawStmt)
      ? rawStmt
      : blankSqlLiterals(rawStmt);
    return isDestructive(shape);
  });
}
