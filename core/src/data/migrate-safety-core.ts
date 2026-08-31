import { bareName, QUALIFIED_NAME } from "./migrate-safety-names.ts";
import {
  expandProceduralScript,
  hasProceduralSurface,
} from "./migrate-safety-ast.ts";
import type { Violation } from "../core/structural-violation.ts";
import {
  blankSqlLiterals,
  blankStringLiterals,
  carriesDynamicSql,
  createdTables,
  hasLockTimeout,
  indexTargetTable,
  splitSqlStatements,
  stripSqlComments,
} from "./migrate-sql-text.ts";

// Migrate safe-DDL + history-linear gates — pure functions over SQL/dir names (no DB); drizzle-kit emits
// correct-but-unsafe SQL, so these are the Postgres-safe-DDL lint (Squawk/Strong-Migrations class) plus
// the history-shape check. Roster: cli/migrate.md §safe-ddl / §history-linearization.

export const SAFE_DDL = "migrate/safe-ddl";
const HISTORY_LINEAR = "migrate/history-linear";
export const IMMUTABLE_PROTECTED = "migrate/immutable-protected";
export const FRAMEWORK_TABLE_ADDITIVE = "migrate/framework-table-additive";
export const BASELINE_FRESH = "migrate/baseline-fresh";

/** Split a migration script into statements on `;` (after comment-stripping); empty fragments dropped.
 *  A `--> statement-breakpoint` marker is a comment, already stripped. Quote-aware: a `;` inside a
 *  string / identifier / dollar-quote is not a statement boundary. */
export function statements(sql: string): string[] {
  return splitSqlStatements(stripSqlComments(sql));
}

const v = (resource: string, message: string): Violation => ({
  id: SAFE_DDL,
  resource,
  message,
});

/**
 * The hard half of `version/field-live` (multi-version.md §9): a migration that DROP COLUMNs a column a
 * live API version still serves is refused (a build error), not merely surfaced by `migrate preview`.
 * `locked` is the `resource.column`/bare-`column` set a live version still lists in `fields`. REMOVE that
 * version's `defineVersion` once its clients have migrated off and the reclaim passes; a sunset DATE
 * releases nothing, because the lock follows DECLARATION and a past-sunset version still serves.
 */
export function fieldLiveContractViolations(
  sql: string,
  locked: ReadonlySet<string>,
): Violation[] {
  const out: Violation[] = [];
  if (locked.size === 0) return out;
  // Comments and string bodies are not DDL: a commented-out `-- removed in v2: ALTER TABLE users DROP
  // COLUMN email` refused the migration for contracting a field it does not touch, and there is no waiver.
  const text = carriesDynamicSql(sql)
    ? sql
    : blankStringLiterals(stripSqlComments(sql));
  // non-greedy `[\s\S]*?` between the table and DROP COLUMN so a statement with a leading clause (`ADD
  // COLUMN a, DROP COLUMN y`) still fires, not only the DROP-first form.
  const re =
    /\bALTER\s+TABLE\s+(?:"?[\w$]+"?\s*\.\s*)?"?([\w$]+)"?[\s\S]*?\bDROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"?([\w$]+)"?/gi;
  for (const mch of text.matchAll(re)) {
    const table = mch[1]!, col = mch[2]!;
    if (locked.has(`${table}.${col}`) || locked.has(col)) {
      out.push({
        id: "version/field-live",
        resource: "migration",
        message:
          `DROP COLUMN "${col}" contracts a field a LIVE API version still serves (version/field-live) — refused; a sunset date does NOT release the lock — REMOVE that version's defineVersion once its clients have migrated off, then reclaim the column`,
      });
    }
  }
  return out;
}

/** A function-call DEFAULT (`now()`, `gen_random_uuid()`, …) is volatile — PG can't store it as catalog
 *  metadata, so `ADD COLUMN … DEFAULT` rewrites the whole table under ACCESS EXCLUSIVE. A constant
 *  default (PG 11+) is metadata-only and safe. Run over the literal-blanked statement: a `(` or a
 *  keyword inside a string default (`DEFAULT 'N/A (see docs)'`) is data, not a call. */
function hasVolatileDefault(addColumnStmt: string): boolean {
  const m = /\bDEFAULT\b([\s\S]*?)(?:\bNOT\s+NULL\b|,|$)/i.exec(
    blankSqlLiterals(addColumnStmt),
  );
  if (!m) return false;
  return /\w+\s*\(/.test(m[1] ?? "") ||
    /\bCURRENT_(?:TIMESTAMP|DATE|TIME)\b/i.test(m[1] ?? "");
}

/**
 * The action list of an `ALTER TABLE` split on TOP-LEVEL commas, so each clause is read on its own.
 * `ADD CONSTRAINT c UNIQUE (a, b)` is ONE clause — the commas inside the parens belong to the column list,
 * which is why this counts depth rather than splitting on every comma. Give it the SHAPE view: a comma
 * inside a string or a quoted identifier must never split.
 */
function alterActionClauses(shape: string): string[] {
  const head = new RegExp(
    String
      .raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${QUALIFIED_NAME}\s`,
    "i",
  ).exec(shape);
  if (!head) return [];
  const body = shape.slice(head.index + head[0].length);
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Whether ONE `ALTER TABLE` clause builds a unique index — the constraint form (`ADD CONSTRAINT c UNIQUE
 *  (x)`) and the column form (`ADD COLUMN id uuid PRIMARY KEY`) alike. Both take ACCESS EXCLUSIVE and scan
 *  the table; only the first was ever asked about. */
function addsUniqueIndex(clause: string): boolean {
  return /^\s*ADD\b/i.test(clause) &&
    /\b(?:UNIQUE|PRIMARY\s+KEY)\b/i.test(clause);
}

/** Every table a statement names as an FK parent (`REFERENCES <t>`), normalized. An FK add takes SHARE
 *  ROW EXCLUSIVE on the parent even when NOT VALID, so an uncreated parent is a live table under lock. */
function referencedTables(stmt: string): string[] {
  const re = new RegExp(String.raw`\bREFERENCES\s+(${QUALIFIED_NAME})`, "gi");
  return [...stmt.matchAll(re)]
    .map((m) => bareName(m[1] ?? ""))
    .filter((t): t is string => t !== null);
}

/**
 * `migrate/safe-ddl`: the Postgres-safe-DDL lint. Flags each unsafe pattern independently (no early
 * short-circuit), so a script with several unsafe statements reports each one. `resource` names the
 * finding location; default `"migration"`.
 *
 * `opts.newTableAware` (the Strong-Migrations/Squawk "new table" exemption): an index/constraint on a
 * table this script creates is exempt — its validating scan is over zero rows. `lock_timeout` is waived
 * only for a script that touches nothing pre-existing, FK parents included: a `REFERENCES` to a live
 * table locks that table, and the timeout, not `NOT VALID`, is what bounds the wait.
 */
export function safeDdl(
  sql: string,
  resource = "migration",
  opts: { newTableAware?: boolean } = {},
): Violation[] {
  const out: Violation[] = [];
  // migrate-safety-ast.ts flattens a parseable dollar-quoted/DO script for classification below; an
  // inexpandable one (parse failure/EXECUTE/DECLARE) keeps the refuse-floor at check (7).
  const expanded = expandProceduralScript(sql);
  const effective = expanded ?? sql;
  const stmts = statements(effective);
  const created = opts.newTableAware ? createdTables(stmts) : new Set<string>();
  // a statement is exempt (new-table-aware) iff it targets a table CREATEd earlier in this same script.
  const onNewTable = (stmt: string): boolean => {
    if (!opts.newTableAware) return false;
    const t = indexTargetTable(stmt);
    return t !== null && created.has(t);
  };
  // pure-create: every statement is SET/CREATE SCHEMA|SEQUENCE|TABLE or an index/constraint on a
  // just-created table, and every FK parent it names is created here too — an FK against a live parent
  // takes SHARE ROW EXCLUSIVE on it, so the script can still stall traffic and lock_timeout returns.
  const pureCreate = !!opts.newTableAware && stmts.every((stmt) => {
    if (!referencedTables(stmt).every((t) => created.has(t))) return false;
    if (
      /^\s*(?:SET\b|CREATE\s+(?:SCHEMA|SEQUENCE|EXTENSION|TYPE)\b)/i.test(stmt)
    ) return true;
    if (/\bCREATE\s+TABLE\b/i.test(stmt)) return true;
    const t = indexTargetTable(stmt);
    return t !== null && created.has(t);
  });

  const dynamic = carriesDynamicSql(sql);
  for (const rawStmt of stmts) {
    // Every clause below asks about STRUCTURE, so a DDL keyword inside a string is prose. Quoted identifiers
    // are kept verbatim — they carry the table name — and a dynamic-SQL script is read raw, because there a
    // string is the statement and the refuse-floor is what answers for it.
    const stmt = dynamic ? rawStmt : blankStringLiterals(rawStmt);
    // The SHAPE view — identifier bodies blanked too. Clause (5b) asks only about keywords, and a
    // constraint or column named `"USING INDEX"` read as an adopt-form on the view that keeps them.
    const shape = dynamic ? rawStmt : blankSqlLiterals(rawStmt);
    const upper = stmt.toUpperCase();

    // (1b) ADD COLUMN … NOT NULL with no DEFAULT on a live table (rewrite / fail on existing rows)
    if (
      /\bADD\s+COLUMN\b/i.test(stmt) &&
      /(?<!IS\s)NOT\s+NULL/i.test(stmt) &&
      !/\bDEFAULT\b/i.test(stmt) &&
      !onNewTable(stmt)
    ) {
      out.push(
        v(
          resource,
          `ADD COLUMN … NOT NULL with no DEFAULT fails or rewrites a populated table — safe pattern: ADD the column NULL → backfill → SET NOT NULL`,
        ),
      );
    }

    // (1) table-rewriting `ADD COLUMN … DEFAULT <volatile>`
    if (
      /\bADD\s+COLUMN\b/i.test(stmt) && hasVolatileDefault(stmt) &&
      !onNewTable(stmt)
    ) {
      out.push(
        v(
          resource,
          `ADD COLUMN with a volatile DEFAULT rewrites the whole table under ACCESS EXCLUSIVE — safe pattern: ADD the column NULL → backfill in batches → SET the DEFAULT separately (ADD-NULL → backfill → VALIDATE)`,
        ),
      );
    }

    // (2) blocking `SET NOT NULL` (a full-table validating scan under lock)
    if (
      /\bALTER\s+COLUMN\b[\s\S]*\bSET\s+NOT\s+NULL\b/i.test(stmt) &&
      !onNewTable(stmt)
    ) {
      out.push(
        v(
          resource,
          `SET NOT NULL scans the whole table under ACCESS EXCLUSIVE — safe pattern: ADD a CHECK (col IS NOT NULL) NOT VALID constraint, then VALIDATE CONSTRAINT (which takes only a SHARE UPDATE lock), then SET NOT NULL against the validated constraint`,
        ),
      );
    }

    // (3) type-narrowing / type-changing `ALTER COLUMN … TYPE …` (rewrites the table, may fail mid-scan)
    if (
      /\bALTER\s+COLUMN\b[\s\S]*\b(?:SET\s+DATA\s+)?TYPE\b/i.test(stmt) &&
      !onNewTable(stmt)
    ) {
      out.push(
        v(
          resource,
          `ALTER COLUMN … TYPE rewrites the whole table under ACCESS EXCLUSIVE (and a narrowing change can fail mid-scan) — safe pattern: ADD a new column of the target type → backfill → swap, rather than an in-place type change`,
        ),
      );
    }

    // (4) non-`CONCURRENTLY` `CREATE INDEX` (a SHARE lock blocks writes for the whole build) — exempt on a
    //     brand-new table (no rows / no concurrent traffic to block) under the new-table-aware mode.
    if (
      /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(stmt) &&
      !/\bCONCURRENTLY\b/i.test(stmt) && !onNewTable(stmt)
    ) {
      out.push(
        v(
          resource,
          `CREATE INDEX without CONCURRENTLY holds a SHARE lock that blocks writes for the whole build — safe pattern: CREATE INDEX CONCURRENTLY (note: it cannot run inside a transaction block)`,
        ),
      );
    }

    // (4b) the DROP side of the same lock. `DROP INDEX` takes ACCESS EXCLUSIVE on the indexed table, so a
    //      drop behind a long read queues every write on it. Separate from the destructive verdict on the
    //      same statement: that one asks whether the invariant should go, this one is about how it goes.
    if (
      /\bDROP\s+INDEX\b/i.test(stmt) && !/\bCONCURRENTLY\b/i.test(stmt) &&
      !onNewTable(stmt)
    ) {
      out.push(
        v(
          resource,
          `DROP INDEX without CONCURRENTLY takes ACCESS EXCLUSIVE on the table, so every read and write queues behind it — safe pattern: DROP INDEX CONCURRENTLY (note: it cannot run inside a transaction block)`,
        ),
      );
    }

    // (5) a validating constraint add (CHECK / FOREIGN KEY) that omits `NOT VALID` — exempt on a new table.
    if (
      /\bADD\s+CONSTRAINT\b/i.test(stmt) &&
      /\b(?:CHECK|FOREIGN\s+KEY|REFERENCES)\b/i.test(upper) &&
      !/\bNOT\s+VALID\b/i.test(stmt) && !onNewTable(stmt)
    ) {
      out.push(
        v(
          resource,
          `ADD CONSTRAINT (CHECK / FOREIGN KEY) without NOT VALID scans every existing row under lock to validate — safe pattern: ADD … NOT VALID first (instant), then VALIDATE CONSTRAINT in a separate statement (a non-blocking SHARE UPDATE lock)`,
        ),
      );
    }

    // (5b) UNIQUE / PRIMARY KEY constraint add. The same ACCESS EXCLUSIVE + full-table validating scan as
    //      (5), but it gets its OWN clause because the (5) remedy does not exist here: Postgres has no
    //      `NOT VALID` for UNIQUE or PRIMARY KEY. The index must be built concurrently FIRST and then
    //      adopted, which is a different two-step and would be wrong advice under the (5) wording.
    //
    //      Read PER CLAUSE. Every earlier form of this test read the whole statement, and each escape it
    //      offered was therefore statement-wide: an `ADD COLUMN` anywhere exempted a UNIQUE sibling, so
    //      `ADD COLUMN email text, ADD CONSTRAINT email_uk UNIQUE (email)` passed — as did the column form
    //      `ADD COLUMN id uuid PRIMARY KEY`, which builds the same index. Counting adopt-forms against add
    //      -forms was the previous repair for one half of that, and a quoted identifier spelled
    //      `"USING INDEX"` equalised the count. Per-clause needs neither escape nor count: a clause either
    //      adopts a finished index or it builds one.
    if (!onNewTable(stmt)) {
      const offending = alterActionClauses(shape).filter((clause) =>
        // `USING INDEX` is the adopt-form this clause's own remedy prescribes: the index was already built
        // CONCURRENTLY, so the constraint takes it without a second scan. Refusing it refuses the fix.
        addsUniqueIndex(clause) && !/\bUSING\s+INDEX\b/i.test(clause)
      );
      if (offending.length > 0) {
        out.push(
          v(
            resource,
            `ADD … UNIQUE / PRIMARY KEY builds its index under ACCESS EXCLUSIVE, scanning every existing row while writes are blocked — and NOT VALID does not exist for these — in this statement: \`${
              offending[0]!.replace(/\s+/g, " ").slice(0, 80)
            }\` — safe pattern: CREATE UNIQUE INDEX CONCURRENTLY first (outside a transaction), then ALTER TABLE … ADD CONSTRAINT … USING INDEX, which adopts the finished index without a second scan. A constraint written as its own clause is read on its own: an ADD COLUMN beside it no longer exempts it`,
          ),
        );
      }
    }
  }

  // (6) missing lock_timeout — a script-level check: an unbounded migration can wait forever behind a
  //     long read, queueing every following query. Waived for a pure-create (new-table-aware) script.
  if (stmts.length > 0 && !pureCreate && !hasLockTimeout(effective)) {
    out.push(
      v(
        resource,
        `migration sets no lock_timeout — any statement that blocks on a held lock waits forever and queues every following query — safe pattern: begin the migration with SET lock_timeout = '<n>s' (or SET LOCAL inside the transaction) so a contended statement fails fast instead of stalling live traffic`,
      ),
    );
  }

  // (7) dynamic SQL is unclassifiable by a textual gate — a script-level refuse: EXECUTE can compose a
  //     destructive statement out of fragments no pattern can see, and dollar-quoting defeats the `;` splitter.
  const whole = stripSqlComments(sql);
  if (expanded === null && hasProceduralSurface(whole)) {
    out.push(
      v(
        resource,
        `the script carries dynamic SQL the statement model cannot prove static (an EXECUTE, a DECLARE body, or an unparseable dollar-quoted construct) — refused as UNCLASSIFIABLE rather than pretend-scanned. A parseable DO body of plain static statements IS classified (the parser-backed model); express anything else as plain static DDL, or take it through explicit review, never the automated gate`,
      ),
    );
  }

  return out;
}

/** The drizzle v1 migration-dir ordinal prefix (`0000_init`, …) — the chain position; `history-linear`
 *  asserts prefix↔position is a bijection. Returns null when absent. */
/** Above this, a dir prefix is a wall-clock stamp (drizzle-kit's `YYYYMMDDHHMMSS_`), not a chain
 *  position. A 0-based chain reaching a million migrations is not a case this bound has to serve. */
const TIMESTAMP_ORDINAL_FLOOR = 1_000_000;

function ordinalOf(dir: string): number | null {
  const m = /^(\d+)_/.exec(dir);
  return m ? Number(m[1]) : null;
}

/** A `.data.ts` data-migration transform file (cli/migrate.md §data-migration). */
const isDataMigrationFile = (f: string): boolean => f.endsWith(".data.ts");

/** A DDL baseline sibling — the `migration.sql` drizzle-kit wrote and its `snapshot.json`. A `.data.ts`
 *  is ordinal-safe only when its dir also carries one of these (a schema baseline to transform against). */
const isDdlSibling = (f: string): boolean =>
  f === "migration.sql" || f === "snapshot.json";

/** Clause (d) — ordinal-safety of `.data.ts`. A dir carrying a transform but no DDL sibling
 *  (`migration.sql`/`snapshot.json`) at the same position has no schema baseline to run against — it would
 *  run against the wrong schema (silent corruption). Pushes a HISTORY_LINEAR violation per orphan dir. */
function orphanDataMigrations(
  files: Readonly<Record<string, readonly string[]>>,
  resource: string,
): Violation[] {
  const out: Violation[] = [];
  for (const dir of Object.keys(files).sort()) {
    const listing = files[dir] ?? [];
    const dataFiles = listing.filter(isDataMigrationFile);
    if (dataFiles.length === 0) continue; // no transform in this dir — nothing to ordinal-anchor
    if (listing.some(isDdlSibling)) continue; // a same-position DDL baseline exists — ordinal-safe
    out.push({
      id: HISTORY_LINEAR,
      resource,
      message: `migration dir '${dir}' carries a data-transform (${
        dataFiles.sort().join(", ")
      }) but NO DDL sibling (migration.sql / snapshot.json) at the same ordinal position — a .data.ts at a position with no schema baseline runs against the WRONG schema (data corruption). Re-home the transform into the same ordinal-prefixed dir as the DDL it transforms — run hazelnut migrate rebase`,
    });
  }
  return out;
}

/**
 * `historyLinear(dirs)` — the migration-history shape check (file-pure, no DB): (a) the ordinals form a
 * continuous `0..n-1` chain with no gap; (c) the prefix↔position map is a bijection (no duplicate
 * prefix, every dir ordinal-prefixed); (d) every `.data.ts` transform sits in an ordinal dir that also
 * carries a DDL sibling at the same position (`opts.files`; a no-op when omitted).
 *
 * Clause (b) (the `prevIds[]` DAG is single-leaf) reads the snapshot DAG, beyond a bare dir-name list,
 * so it is out of scope here. Fix hint: `hazelnut migrate rebase`.
 */
export function historyLinear(
  dirs: string[],
  resource = "migrations",
  opts: { files?: Readonly<Record<string, readonly string[]>> } = {},
): Violation[] {
  const out: Violation[] = [];
  // clause (d) runs over the supplied per-dir file listing, independent of the ordinal-chain checks below —
  // it fires even in an otherwise-linear chain (an orphan .data.ts).
  if (opts.files) out.push(...orphanDataMigrations(opts.files, resource));
  if (dirs.length === 0) return out; // an empty history is trivially linear (for the dir-name clauses)

  const ordinals: number[] = [];
  for (const dir of dirs) {
    const ord = ordinalOf(dir);
    if (ord === null) {
      out.push({
        id: HISTORY_LINEAR,
        resource,
        message:
          `migration dir '${dir}' has no ordinal prefix — every dir must be 'NNNN_<name>' so the on-disk prefix ↔ chain position map is a bijection — run hazelnut migrate rebase`,
      });
      continue;
    }
    ordinals.push(ord);
  }
  if (ordinals.length === 0) return out;

  // (c) duplicate prefix — two dirs claim the same chain position (the not-a-bijection case)
  const seen = new Set<number>();
  const dupes = new Set<number>();
  for (const o of ordinals) {
    if (seen.has(o)) dupes.add(o);
    seen.add(o);
  }
  for (const d of [...dupes].sort((a, b) => a - b)) {
    out.push({
      id: HISTORY_LINEAR,
      resource,
      message: `two migration dirs share the ordinal prefix ${
        String(d).padStart(4, "0")
      } — a forked / duplicated chain position (prefix ↔ position is not a bijection) — run hazelnut migrate rebase`,
    });
  }

  // (a) continuous chain — the distinct ordinals must be exactly 0..max with no gap
  // Continuity applies to a 0-BASED chain and to nothing else. drizzle-kit names a dir
  // `YYYYMMDDHHMMSS_<name>` — the only shape this framework ever produces — so `ordinalOf` reads a
  // fourteen-digit clock as a chain position, and counting `0..max` from one meant ~2e13 iterations,
  // each appending a violation. The clause was unreachable in practice (nothing supplies `--dir`), which
  // is the only reason it never hung. Two fixes, not one: recognise the shape, and never count to `max`.
  const sorted = [...seen].sort((a, b) => a - b);
  if (sorted[sorted.length - 1]! >= TIMESTAMP_ORDINAL_FLOOR) {
    // A timestamp chain: unique (clause c above) and ordered is all "linear" can mean — there is no
    // position 3 to be missing between two wall-clock stamps.
    return out;
  }
  // A genuine `NNNN_` chain: the distinct ordinals must be exactly 0..n-1. Derived from the sorted set,
  // so the work is bounded by the number of migrations rather than by the largest name on disk.
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] === i) continue;
    out.push({
      id: HISTORY_LINEAR,
      resource,
      message: `migration chain has a gap at ordinal ${
        String(i).padStart(4, "0")
      } — a 0-based dir chain must be continuous (no missing position between 0 and the tip) — run hazelnut migrate rebase`,
    });
    break; // one gap is the finding; enumerating the rest of the chain adds no information
  }

  return out;
}

// ── destructive-DDL classification (shared by immutable-protected + framework-table-additive) ──
//
// Both gates ask "is this destructive, and against which table?" but differ only in the off-limits
// table set. Detection is factored out here; each gate supplies its own predicate + id. Mirrors
// `cli/migrate.md §safety`'s destructive verdict plus TRUNCATE (bypasses RLS — §prod-guard).

// roster/engine extracted into cohesive submodules, re-exported so importers stay stable.
