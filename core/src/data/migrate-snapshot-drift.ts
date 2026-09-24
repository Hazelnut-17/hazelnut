// The committed-migration staleness gate: the declaration-derived schema vs the newest committed
// `drizzle/<ts>/snapshot.json`, offline and in-process (no drizzle-kit spawn — that is the boot lane).
// A second axis catches hand-edited `migration.sql`: columns and indexes the SQL would create that the
// snapshot never heard of, and snapshot keys SQL never materializes (ARCH-1 — the apply path runs SQL, so
// a gate that only reads snapshot.json is blind).
import type { App } from "../core/app.ts";
import {
  endOfSqlLiteral,
  normalizePgType,
  parseColumnClause,
  parseCreateTables,
} from "./ddl-parse.ts";
import { deriveSchemaSql } from "./migrate-derive.ts";
import {
  type MigrationEntry,
  readMigrationHistory,
} from "./migrate-drizzle-schema.ts";
import { bareName, QUALIFIED_NAME } from "./migrate-safety-names.ts";
import { splitSqlStatements, stripSqlComments } from "./migrate-sql-text.ts";

/**
 * A column fingerprint keyed `schema.table.column`, valued by its normalized Postgres type. Comparing the
 * two fingerprints as SETS is the gate: a declared column absent from the committed snapshot means the
 * migration on disk would not create it, so prod DDL diverges from every tested shape.
 */
export type SchemaFingerprint = ReadonlyMap<string, string>;

/** The fingerprint of every CREATE TABLE in `sql`. */
export function createTableFingerprint(sql: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of parseCreateTables(sql)) {
    for (const [name, type] of t.columns) {
      out.set(`${t.schema}.${t.table}.${name}`, type);
    }
  }
  return out;
}

/** The fingerprint of the schema the declarations derive — the same statements `migrate generate` feeds
 *  drizzle-kit, so a field added to a `defineResource` lands here immediately. */
export function derivedFingerprint(app: App): Map<string, string> {
  const out = new Map<string, string>();
  for (const stmt of deriveSchemaSql(app)) {
    for (const [k, v] of createTableFingerprint(stmt)) out.set(k, v);
  }
  return out;
}

/** One entity row of a drizzle `snapshot.json` — `columns` and `indexes` rows both carry a fingerprint. */
interface SnapshotEntity {
  readonly entityType?: string;
  readonly schema?: string;
  readonly table?: string;
  readonly name?: string;
  readonly type?: string;
  readonly isUnique?: boolean;
  readonly where?: string | null;
  readonly columns?: ReadonlyArray<SnapshotIndexColumn | string>;
  readonly method?: string;
  readonly include?: readonly string[];
  readonly nullsNotDistinct?: boolean;
  readonly with?: string;
  readonly notNull?: boolean;
  readonly default?: string | null;
}

interface SnapshotIndexColumn {
  readonly value?: string;
  readonly asc?: boolean;
  readonly nullsFirst?: boolean;
  readonly opclass?:
    | { readonly name?: string; readonly default?: boolean }
    | string
    | null;
}

// ── the CONSTRAINT axis ───────────────────────────────────
//
// Tables and columns were the whole comparison, so a resource that declared `unique: [["title"]]` after
// its migration was generated left the committed migration without that index and `drift` answered "the
// committed migration matches" — while `migrate generate`, run immediately after, wrote a migration
// containing the CREATE INDEX. The same tree telling itself the two disagree. Uniqueness is a correctness
// constraint, not a hint: without the index the rows the declaration forbids can be written, and `drift`
// rides the emitted `ci` chain, so the gate was green while the declared uniqueness did not exist.

/** One index's identity, including every physical choice the snapshot knows how to represent. */
function indexIdentity(
  isUnique: boolean,
  cols: readonly string[],
  where: string | null | undefined,
  method = "btree",
  include: readonly string[] = [],
  nullsNotDistinct = false,
  withParams = "",
): string {
  const w = (where ?? "").trim();
  const included = include.length === 0 ? "" : ` INCLUDE(${include.join(",")})`;
  const nullRule = nullsNotDistinct ? " NULLS NOT DISTINCT" : "";
  const storage = withParams.trim() === "" ? "" : ` WITH(${withParams.trim()})`;
  return `${isUnique ? "unique" : "index"} USING ${method.toLowerCase()} (${
    cols.join(",")
  })${included}${nullRule}${storage}${
    w === "" ? "" : ` WHERE ${w.replace(/\s+/g, " ")}`
  }`;
}

/** Every `CREATE [UNIQUE] INDEX [CONCURRENTLY]` in `sql`, keyed `schema.table.index:<name>`.
 *  `CONCURRENTLY` is a build option — the emitter rewrites live-table indexes to that form
 *  (`concurrentIndexes`) — so it is skipped in the head and does not change the key. Quoting is
 *  normalised away on both sides — the derived SQL quotes identifiers and a snapshot does not.
 *
 *  The column list is scanned with BALANCED parens, never a `[^)]*` run: a real index key can be an
 *  EXPRESSION (`md5(payload::text)`), and stopping at the first `)` truncated it, swallowed the closing
 *  paren, and reported the framework's own `_outbox` index as drifted against itself. */
export function createIndexFingerprint(sql: string): Map<string, string> {
  const out = new Map<string, string>();
  const head =
    /CREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?([^"\s(]+)"?\s+ON\s+("?[^"\s(]+"?(?:\."?[^"\s(]+"?)?)\s*(?:USING\s+(\w+)\s*)?\(/gi;
  for (const m of sql.matchAll(head)) {
    const [, uniq, name, target, method] = m;
    // walk from the opening paren the head consumed to its match
    let depth = 1;
    let i = m.index + m[0].length;
    const from = i;
    while (i < sql.length && depth > 0) {
      if (sql[i] === "(") depth++;
      else if (sql[i] === ")") depth--;
      i++;
    }
    if (depth !== 0) continue; // unbalanced — not a statement this can read, so it reports nothing
    const cols = splitTopLevel(sql.slice(from, i - 1)).map(
      sqlIndexColumnIdentity,
    );
    const semi = sql.indexOf(";", i);
    const tail = sql.slice(i, semi === -1 ? undefined : semi);
    const include = indexClauseList(tail, "INCLUDE");
    const withParams = indexClauseList(tail, "WITH")?.join(",") ?? "";
    const parts = target!.replaceAll('"', "").split(".");
    const schema = parts.length > 1 ? parts[0]! : "public";
    out.set(
      `${schema}.${parts.at(-1)!}.index:${name!.replaceAll('"', "")}`,
      indexIdentity(
        uniq !== undefined,
        cols,
        /\bWHERE\b([\s\S]*)$/i.exec(tail)?.[1] ?? null,
        method ?? "btree",
        include?.map(normalizeIndexSql) ?? [],
        /\bNULLS\s+NOT\s+DISTINCT\b/i.test(tail),
        withParams,
      ),
    );
  }
  return out;
}

/** Split an index key list on TOP-LEVEL commas, so an expression key keeps its own arguments. */
function splitTopLevel(list: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim()).filter((c) => c !== "");
}

/** Split optional INCLUDE/WITH lists without mistaking nested expressions for a close paren. */
function indexClauseList(
  tail: string,
  keyword: "INCLUDE" | "WITH",
): string[] | null {
  const m = new RegExp(`\\b${keyword}\\s*\\(`, "i").exec(tail);
  if (!m) return null;
  const open = m.index + m[0].lastIndexOf("(");
  let depth = 1;
  for (let i = open + 1; i < tail.length; i++) {
    const end = endOfSqlLiteral(tail, i);
    if (end > i) {
      i = end - 1;
      continue;
    }
    if (tail[i] === "(") depth++;
    else if (tail[i] === ")" && --depth === 0) {
      return splitTopLevel(tail.slice(open + 1, i));
    }
  }
  return null;
}

function normalizeIndexSql(value: string): string {
  return value.trim().replaceAll('"', "").replace(/\s+/g, " ");
}

/** PostgreSQL's per-key order, null placement and operator class are all part of index behavior. */
function sqlIndexColumnIdentity(raw: string): string {
  let value = raw.trim();
  let asc = true;
  let nullsFirst: boolean | undefined;
  const nulls = /\s+NULLS\s+(FIRST|LAST)$/i.exec(value);
  if (nulls) {
    nullsFirst = nulls[1]!.toUpperCase() === "FIRST";
    value = value.slice(0, nulls.index).trim();
  }
  const direction = /\s+(ASC|DESC)$/i.exec(value);
  if (direction) {
    asc = direction[1]!.toUpperCase() === "ASC";
    value = value.slice(0, direction.index).trim();
  }
  if (nullsFirst === undefined) nullsFirst = !asc;
  let opclass: string | null = null;
  const split = lastTopLevelWhitespace(value);
  if (split > 0) {
    const suffix = value.slice(split).trim();
    if (
      /^(?:"[^"]+"|[A-Za-z_][\w$]*)(?:\.(?:"[^"]+"|[A-Za-z_][\w$]*))*$/.test(
        suffix,
      )
    ) {
      opclass = normalizeIndexSql(suffix);
      value = value.slice(0, split).trim();
    }
  }
  return `${normalizeIndexSql(value)} ${asc ? "ASC" : "DESC"} NULLS ${
    nullsFirst ? "FIRST" : "LAST"
  }${opclass === null ? "" : ` OPCLASS ${opclass}`}`;
}

function lastTopLevelWhitespace(value: string): number {
  let depth = 0;
  let quoted = false;
  let last = -1;
  for (let i = 0; i < value.length; i++) {
    const end = endOfSqlLiteral(value, i);
    if (end > i) {
      i = end - 1;
      continue;
    }
    if (value[i] === '"') {
      if (quoted && value[i + 1] === '"') i++;
      else quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (value[i] === "(") depth++;
    else if (value[i] === ")") depth--;
    else if (depth === 0 && /\s/.test(value[i]!)) last = i;
  }
  return last;
}

/** The index fingerprint the declarations derive — the same statements `migrate generate` feeds drizzle-kit. */
export function derivedIndexFingerprint(app: App): Map<string, string> {
  const out = new Map<string, string>();
  for (const stmt of deriveSchemaSql(app)) {
    for (const [k, v] of createIndexFingerprint(stmt)) out.set(k, v);
  }
  return out;
}

/** The index fingerprint the committed snapshot describes (drizzle v8 `entityType: "indexes"` rows). */
export function snapshotIndexFingerprint(
  snapshot: unknown,
): Map<string, string> {
  const out = new Map<string, string>();
  const ddl = (snapshot as { ddl?: readonly SnapshotEntity[] })?.ddl;
  if (!Array.isArray(ddl)) return out;
  for (const e of ddl) {
    if (e?.entityType !== "indexes") continue;
    if (!e.name || !e.table) continue;
    out.set(
      `${e.schema ?? "public"}.${e.table}.index:${e.name}`,
      indexIdentity(
        e.isUnique === true,
        (e.columns ?? []).map((raw: SnapshotIndexColumn | string) => {
          if (typeof raw === "string") return raw;
          const asc = raw.asc !== false;
          const nullsFirst = raw.nullsFirst ?? !asc;
          const opclass = typeof raw.opclass === "string"
            ? raw.opclass
            : raw.opclass?.name;
          return `${normalizeIndexSql(raw.value ?? "")} ${
            asc ? "ASC" : "DESC"
          } NULLS ${nullsFirst ? "FIRST" : "LAST"}${
            opclass ? ` OPCLASS ${normalizeIndexSql(opclass)}` : ""
          }`;
        }),
        e.where,
        e.method ?? "btree",
        (e.include ?? []).map(normalizeIndexSql),
        e.nullsNotDistinct === true,
        e.with ?? "",
      ),
    );
  }
  return out;
}

/** The fingerprint the committed snapshot describes. A drizzle v8 snapshot holds the CUMULATIVE desired
 *  state, so the newest one alone is the committed schema. */
export function snapshotFingerprint(snapshot: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const ddl = (snapshot as { ddl?: readonly SnapshotEntity[] })?.ddl;
  if (!Array.isArray(ddl)) return out;
  for (const e of ddl) {
    if (e?.entityType !== "columns") continue;
    if (!e.name || !e.table) continue;
    out.set(
      `${e.schema ?? "public"}.${e.table}.${e.name}`,
      normalizePgType(e.type ?? ""),
    );
  }
  return out;
}

function pkIdentity(cols: readonly string[]): string {
  return [...cols].map((c) => c.replaceAll('"', "").trim()).filter((c) =>
    c.length > 0
  ).sort().join(",");
}

function snapshotPkColumns(e: SnapshotEntity): string[] {
  return (e.columns ?? []).map((c) =>
    typeof c === "string" ? c : (c.value ?? "")
  );
}

/** drizzle v8 snapshots stamp `notNull` as boolean; synthetic fixtures used by column-only teeth do not. */
export function snapshotHasConstraintAxis(snapshot: unknown): boolean {
  const ddl = (snapshot as { ddl?: readonly SnapshotEntity[] })?.ddl;
  if (!Array.isArray(ddl)) return false;
  const columns = ddl.filter((e) => e?.entityType === "columns");
  return columns.length > 0 &&
    columns.every((e) =>
      typeof e.notNull === "boolean" && Object.hasOwn(e, "default") &&
      (e.default === null || typeof e.default === "string")
    );
}

/** Nullability, default, and primary-key membership the CREATE TABLE DDL materializes. */
export function createConstraintFingerprint(sql: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of parseCreateTables(sql)) {
    for (const [name, nn] of t.notNull) {
      out.set(
        `${t.schema}.${t.table}.${name}:nullability`,
        nn ? "notnull" : "nullable",
      );
    }
    for (const [name, d] of t.defaults) {
      out.set(
        `${t.schema}.${t.table}.${name}:default`,
        normalizeDefault(d),
      );
    }
    if (t.primaryKey && t.primaryKey.length > 0) {
      out.set(`${t.schema}.${t.table}:pk`, pkIdentity(t.primaryKey));
    }
  }
  return out;
}

export function derivedConstraintFingerprint(app: App): Map<string, string> {
  const out = new Map<string, string>();
  for (const stmt of deriveSchemaSql(app)) {
    for (const [k, v] of createConstraintFingerprint(stmt)) out.set(k, v);
  }
  return out;
}

export function snapshotConstraintFingerprint(
  snapshot: unknown,
): Map<string, string> {
  const out = new Map<string, string>();
  const ddl = (snapshot as { ddl?: readonly SnapshotEntity[] })?.ddl;
  if (!Array.isArray(ddl)) return out;
  for (const e of ddl) {
    if (e?.entityType === "columns") {
      if (!e.name || !e.table) continue;
      const key = `${e.schema ?? "public"}.${e.table}.${e.name}`;
      out.set(
        `${key}:nullability`,
        e.notNull === true ? "notnull" : "nullable",
      );
      out.set(`${key}:default`, normalizeDefault(e.default));
    }
    if (e?.entityType === "pks") {
      if (!e.table) continue;
      const cols = snapshotPkColumns(e);
      if (cols.length === 0) continue;
      out.set(`${e.schema ?? "public"}.${e.table}:pk`, pkIdentity(cols));
    }
  }
  return out;
}

/** The drift between the declarations and the committed migration, as three disjoint sorted lists — an
 *  EQUALITY over the fingerprint, so a removed column and a re-typed one are as RED as an added one. */
export interface SnapshotDrift {
  /** declared, absent from the committed snapshot — the migration would not create it */
  readonly missing: readonly string[];
  /** in the committed snapshot, no longer declared — the migration creates a column nothing derives */
  readonly extra: readonly string[];
  /** present on both sides with a different type, as `key: committed → declared` */
  readonly retyped: readonly string[];
}

/** `fingerprintDrift(declared, committed)` — the set difference in both directions plus the type mismatch. */
export function fingerprintDrift(
  declared: SchemaFingerprint,
  committed: SchemaFingerprint,
): SnapshotDrift {
  const missing: string[] = [];
  const retyped: string[] = [];
  for (const [k, t] of declared) {
    const c = committed.get(k);
    if (c === undefined) missing.push(k);
    else if (c !== t) retyped.push(`${k}: ${c} → ${t}`);
  }
  const extra = [...committed.keys()].filter((k) => !declared.has(k));
  return {
    missing: missing.sort(),
    extra: extra.sort(),
    retyped: retyped.sort(),
  };
}

/** The two axes as ONE result — the CLI renders one report, and a constraint difference is as stale as a
 *  column one. Sorted so the merged lists read the same however the halves were ordered. */
export function mergeDrift(a: SnapshotDrift, b: SnapshotDrift): SnapshotDrift {
  return {
    missing: [...a.missing, ...b.missing].sort(),
    extra: [...a.extra, ...b.extra].sort(),
    retyped: [...a.retyped, ...b.retyped].sort(),
  };
}

/** Whether a drift result is clean — one predicate, so the CLI verb and its teeth cannot disagree. */
export function isDriftClean(d: SnapshotDrift): boolean {
  return d.missing.length === 0 && d.extra.length === 0 &&
    d.retyped.length === 0;
}

/** Declared↔snapshot AND SQL↔snapshot are both clean — the full migration freshness predicate. */
export function isMigrationFresh(
  drift: SnapshotDrift,
  sqlInvented: readonly string[],
  sqlOmitted: readonly string[] = [],
  sqlRetyped: readonly string[] = [],
  sqlInventedIndexes: readonly string[] = [],
  sqlOmittedIndexes: readonly string[] = [],
  sqlRetypedIndexes: readonly string[] = [],
  sqlInventedRelationalConstraints: readonly string[] = [],
  sqlOmittedRelationalConstraints: readonly string[] = [],
  sqlInventedConstraints: readonly string[] = [],
  sqlOmittedConstraints: readonly string[] = [],
  sqlRetypedConstraints: readonly string[] = [],
): boolean {
  return isDriftClean(drift) && sqlInvented.length === 0 &&
    sqlOmitted.length === 0 && sqlRetyped.length === 0 &&
    sqlInventedIndexes.length === 0 && sqlOmittedIndexes.length === 0 &&
    sqlRetypedIndexes.length === 0 &&
    sqlInventedRelationalConstraints.length === 0 &&
    sqlOmittedRelationalConstraints.length === 0 &&
    sqlInventedConstraints.length === 0 &&
    sqlOmittedConstraints.length === 0 &&
    sqlRetypedConstraints.length === 0;
}

/** Canonical default expression: absent and SQL-NULL collapse to `-`; quoting/case/whitespace fold;
 *  a trailing Postgres cast (`'{}'::jsonb`) is drizzle-kit spelling of the same default. */
export function normalizeDefault(raw: string | null | undefined): string {
  if (raw == null) return "-";
  const s = String(raw).trim().replace(/\s+/g, " ").toLowerCase().replace(
    /::[a-z_][\w$]*(?:\s*\([^)]*\))?(?:\[\])?/g,
    "",
  ).trim();
  return s === "" || s === "null" ? "-" : s;
}

/** Columns the committed SQL history currently materializes (`schema.table.column` → normalized type). */
export function sqlMaterializedColumns(
  history: readonly MigrationEntry[],
): Map<string, string> {
  const live = new Map<string, string>();
  const addCol = new RegExp(
    String
      .raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QUALIFIED_NAME})\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:"[^"]+"|[A-Za-z_][\w$]*))`,
    "gi",
  );
  const dropCol = new RegExp(
    String
      .raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QUALIFIED_NAME})\s+DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?((?:"[^"]+"|[A-Za-z_][\w$]*))`,
    "gi",
  );
  const dropTable = new RegExp(
    String.raw`\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(${QUALIFIED_NAME})`,
    "gi",
  );
  const renameCol = new RegExp(
    String
      .raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QUALIFIED_NAME})\s+RENAME\s+(?:COLUMN\s+)?((?:"[^"]+"|[A-Za-z_][\w$]*))\s+TO\s+((?:"[^"]+"|[A-Za-z_][\w$]*))`,
    "gi",
  );
  const tableKey = (
    tableTok: string,
  ): { schema: string; table: string } | null => {
    const dot = tableTok.lastIndexOf(".");
    const schema = dot === -1
      ? "public"
      : (bareName(tableTok.slice(0, dot)) ?? "public");
    const table = bareName(dot === -1 ? tableTok : tableTok.slice(dot + 1));
    if (!table) return null;
    return { schema, table };
  };
  for (const entry of history) {
    if (!entry.sql) continue;
    for (const [k, t] of createTableFingerprint(entry.sql)) live.set(k, t);
    addCol.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = addCol.exec(entry.sql)) !== null) {
      const parsed = tableKey(m[1] ?? "");
      const col = bareName(m[2] ?? "");
      if (!parsed || !col) continue;
      const start = m.index + m[0].length;
      const semi = entry.sql.indexOf(";", start);
      const rest = entry.sql.slice(start, semi === -1 ? undefined : semi);
      const typed = parseColumnClause(`"${col}" ${rest}`);
      live.set(
        `${parsed.schema}.${parsed.table}.${col}`,
        typed?.type ?? "",
      );
    }
    dropCol.lastIndex = 0;
    while ((m = dropCol.exec(entry.sql)) !== null) {
      const parsed = tableKey(m[1] ?? "");
      const col = bareName(m[2] ?? "");
      if (!parsed || !col) continue;
      live.delete(`${parsed.schema}.${parsed.table}.${col}`);
    }
    renameCol.lastIndex = 0;
    while ((m = renameCol.exec(entry.sql)) !== null) {
      const parsed = tableKey(m[1] ?? "");
      const from = bareName(m[2] ?? "");
      const to = bareName(m[3] ?? "");
      if (!parsed || !from || !to) continue;
      const fromKey = `${parsed.schema}.${parsed.table}.${from}`;
      const toKey = `${parsed.schema}.${parsed.table}.${to}`;
      const t = live.get(fromKey);
      live.delete(fromKey);
      live.set(toKey, t ?? "");
    }
    dropTable.lastIndex = 0;
    while ((m = dropTable.exec(entry.sql)) !== null) {
      const parsed = tableKey(m[1] ?? "");
      if (!parsed) continue;
      const prefix = `${parsed.schema}.${parsed.table}.`;
      for (const k of [...live.keys()]) {
        if (k.startsWith(prefix)) live.delete(k);
      }
    }
  }
  return live;
}

/** `schema.table.column` keys SQL creates that the newest snapshot does not carry. */
export function sqlInventedColumns(
  history: readonly MigrationEntry[],
  snapshot: SchemaFingerprint,
): string[] {
  return [...sqlMaterializedColumns(history).keys()].filter((k) =>
    !snapshot.has(k)
  ).sort();
}

/** Snapshot columns the committed SQL never CREATE/ADDs (or later DROP/RENAMEs away). */
export function sqlOmittedColumns(
  history: readonly MigrationEntry[],
  snapshot: SchemaFingerprint,
): string[] {
  const live = sqlMaterializedColumns(history);
  return [...snapshot.keys()].filter((k) => !live.has(k)).sort();
}

/** Columns both sides name whose SQL type disagrees with the snapshot. Empty SQL type is "present, unread". */
export function sqlRetypedColumns(
  history: readonly MigrationEntry[],
  snapshot: SchemaFingerprint,
): string[] {
  const live = sqlMaterializedColumns(history);
  const out: string[] = [];
  for (const [k, t] of snapshot) {
    const s = live.get(k);
    if (s !== undefined && s !== "" && s !== t) out.push(`${k}: ${s} → ${t}`);
  }
  return out.sort();
}

/** Indexes the committed SQL history currently materializes (`schema.table.index:<name>` → identity). */
export function sqlMaterializedIndexes(
  history: readonly MigrationEntry[],
): Map<string, string> {
  const live = new Map<string, string>();
  const dropIndex = new RegExp(
    String
      .raw`\bDROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?(${QUALIFIED_NAME})`,
    "gi",
  );
  const dropTable = new RegExp(
    String.raw`\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(${QUALIFIED_NAME})`,
    "gi",
  );
  const tableKey = (
    tableTok: string,
  ): { schema: string; table: string } | null => {
    const dot = tableTok.lastIndexOf(".");
    const schema = dot === -1
      ? "public"
      : (bareName(tableTok.slice(0, dot)) ?? "public");
    const table = bareName(dot === -1 ? tableTok : tableTok.slice(dot + 1));
    if (!table) return null;
    return { schema, table };
  };
  for (const entry of history) {
    if (!entry.sql) continue;
    // Statement order is semantic: an index replacement may DROP a legacy name and CREATE that same name
    // later in one restart-safe migration. Processing all creates before all drops read that valid final
    // CREATE as absent. Every statement is independently parsed so the materialized map follows replay.
    for (const stmt of splitSqlStatements(stripSqlComments(entry.sql))) {
      for (const [k, v] of createIndexFingerprint(stmt)) live.set(k, v);
      dropIndex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = dropIndex.exec(stmt)) !== null) {
        const name = bareName(m[1] ?? "");
        if (!name) continue;
        const suffix = `.index:${name}`;
        for (const k of [...live.keys()]) {
          if (k.endsWith(suffix)) live.delete(k);
        }
      }
      dropTable.lastIndex = 0;
      while ((m = dropTable.exec(stmt)) !== null) {
        const parsed = tableKey(m[1] ?? "");
        if (!parsed) continue;
        const prefix = `${parsed.schema}.${parsed.table}.`;
        for (const k of [...live.keys()]) {
          if (k.startsWith(prefix)) live.delete(k);
        }
      }
    }
  }
  return live;
}

/** `schema.table.index:<name>` keys SQL creates that the newest snapshot does not carry. */
export function sqlInventedIndexes(
  history: readonly MigrationEntry[],
  snapshot: SchemaFingerprint,
): string[] {
  return [...sqlMaterializedIndexes(history).keys()].filter((k) =>
    !snapshot.has(k)
  ).sort();
}

/** Snapshot indexes the committed SQL never CREATE INDEXes (or later DROP INDEXes / DROP TABLEs away). */
export function sqlOmittedIndexes(
  history: readonly MigrationEntry[],
  snapshot: SchemaFingerprint,
): string[] {
  const live = sqlMaterializedIndexes(history);
  return [...snapshot.keys()].filter((k) => !live.has(k)).sort();
}

/** Indexes both sides name whose identity disagrees with the snapshot. */
export function sqlRetypedIndexes(
  history: readonly MigrationEntry[],
  snapshot: SchemaFingerprint,
): string[] {
  const live = sqlMaterializedIndexes(history);
  const out: string[] = [];
  for (const [k, t] of snapshot) {
    const s = live.get(k);
    if (s !== undefined && s !== t) out.push(`${k}: ${s} → ${t}`);
  }
  return out.sort();
}

/** Replay the nullability/default/PK state left by committed migration SQL. */
export function sqlMaterializedConstraintFingerprint(
  history: readonly MigrationEntry[],
): Map<string, string> {
  const live = new Map<string, string>();
  const pkNames = new Map<string, string>();
  const pkColumns = new Map<string, readonly string[]>();
  // Track existence separately from constraint rows: a table with no NOT NULL/default/PK has an empty
  // fingerprint but still makes a later CREATE TABLE IF NOT EXISTS a PostgreSQL no-op.
  const createdTables = new Set<string>();
  // ADD COLUMN IF NOT EXISTS is also a PostgreSQL no-op when the column exists. Track plain columns
  // separately because nullable/no-default columns have no rows in `live` to prove their existence.
  const createdColumns = new Map<string, Set<string>>();
  const columnsFor = (table: { schema: string; table: string }) =>
    createdColumns.get(`${table.schema}.${table.table}`) ?? new Set<string>();
  const tableKey = (token: string) => relationalTableKey(token);
  const setPk = (
    table: { schema: string; table: string },
    columns: readonly string[],
    name?: string,
  ) => {
    const key = `${table.schema}.${table.table}:pk`;
    live.set(key, pkIdentity(columns));
    pkColumns.set(`${table.schema}.${table.table}`, [...columns]);
    // PostgreSQL makes PK columns NOT NULL. Dropping the PK later leaves those
    // NOT NULL attributes in place, so this is a materialized state transition.
    for (const column of columns) {
      const columnKey = `${table.schema}.${table.table}.${column}`;
      live.set(`${columnKey}:nullability`, "notnull");
    }
    if (name) pkNames.set(`${table.schema}.${table.table}.${name}`, key);
  };
  const dropTableState = (table: { schema: string; table: string }) => {
    const prefix = `${table.schema}.${table.table}.`;
    for (const key of [...live.keys()]) {
      if (
        key.startsWith(prefix) || key === `${table.schema}.${table.table}:pk`
      ) {
        live.delete(key);
      }
    }
    pkColumns.delete(`${table.schema}.${table.table}`);
    createdColumns.delete(`${table.schema}.${table.table}`);
    for (const name of [...pkNames.keys()]) {
      if (name.startsWith(prefix)) pkNames.delete(name);
    }
  };
  const setColumn = (
    table: { schema: string; table: string },
    column: string,
    notNull: boolean,
    defaultValue: string | null,
  ) => {
    const key = `${table.schema}.${table.table}.${column}`;
    const identity = `${table.schema}.${table.table}`;
    const columns = createdColumns.get(identity) ?? new Set<string>();
    columns.add(column);
    createdColumns.set(identity, columns);
    live.set(`${key}:nullability`, notNull ? "notnull" : "nullable");
    live.set(`${key}:default`, normalizeDefault(defaultValue));
  };

  for (const entry of history) {
    if (!entry.sql) continue;
    for (const stmt of splitSqlStatements(stripSqlComments(entry.sql))) {
      const createIfAbsent = /^\s*CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\b/i.test(
        stmt,
      );
      for (const parsed of parseCreateTables(stmt)) {
        const table = { schema: parsed.schema, table: parsed.table };
        const identity = `${table.schema}.${table.table}`;
        if (createIfAbsent && createdTables.has(identity)) continue;
        dropTableState(table);
        createdColumns.set(identity, new Set(parsed.columns.keys()));
        for (const [column, notNull] of parsed.notNull) {
          setColumn(
            table,
            column,
            notNull,
            parsed.defaults.get(column) ?? null,
          );
        }
        if (parsed.primaryKey?.length) {
          const named = parsed.clauses.map((c) =>
            /^\s*(?:CONSTRAINT\s+(?:"([^"]+)"|([A-Za-z_][\w$]*))\s+)?PRIMARY\s+KEY\s*\(/i
              .exec(c)
          ).find(Boolean);
          setPk(
            table,
            parsed.primaryKey,
            named?.[1] ?? named?.[2] ?? `${parsed.table}_pkey`,
          );
        }
        createdTables.add(identity);
      }

      const droppedTable = /^\s*DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([^\s;]+)/i
        .exec(stmt);
      if (droppedTable) {
        const table = tableKey(droppedTable[1]!);
        if (table) {
          dropTableState(table);
          createdTables.delete(`${table.schema}.${table.table}`);
        }
        continue;
      }
      const altered =
        /^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([^\s;]+)\s+([\s\S]*)$/i
          .exec(stmt);
      if (!altered) continue;
      const table = tableKey(altered[1]!);
      if (!table) continue;
      if (
        /^\s*ALTER\s+TABLE\s+IF\s+EXISTS\b/i.test(stmt) &&
        !createdTables.has(`${table.schema}.${table.table}`)
      ) continue;
      for (const action of splitAlterActions(altered[2]!)) {
        const addColumn =
          /^ADD\s+(?:COLUMN\s+)?(?!(?:CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK|EXCLUDE)\b)(IF\s+NOT\s+EXISTS\s+)?("[^"]+"|[A-Za-z_][\w$]*)\s+([\s\S]+)$/i
            .exec(action);
        if (addColumn) {
          const column = bareName(addColumn[2]!);
          if (
            addColumn[1] && column &&
            columnsFor(table).has(column)
          ) continue;
          if (column) {
            const parsed = parseColumnClause(`"${column}" ${addColumn[3]}`);
            if (parsed) {
              setColumn(table, column, parsed.notNull, parsed.defaultExpr);
              if (parsed.inlinePk) {
                setPk(table, [column], `${table.table}_pkey`);
              }
            }
          }
          continue;
        }
        const dropColumn =
          /^DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?("[^"]+"|[A-Za-z_][\w$]*)/i.exec(
            action,
          );
        if (dropColumn) {
          const column = bareName(dropColumn[1]!);
          if (column) {
            columnsFor(table).delete(column);
            live.delete(`${table.schema}.${table.table}.${column}:nullability`);
            live.delete(`${table.schema}.${table.table}.${column}:default`);
            const key = `${table.schema}.${table.table}:pk`;
            if (
              (pkColumns.get(`${table.schema}.${table.table}`) ?? []).includes(
                column,
              )
            ) {
              // PostgreSQL drops a PK that depends on a dropped column; surviving
              // columns keep the NOT NULL state the PK had materialized.
              live.delete(key);
              pkColumns.delete(`${table.schema}.${table.table}`);
              for (const [name, pkKey] of pkNames) {
                if (pkKey === key) pkNames.delete(name);
              }
            }
          }
          continue;
        }
        const renameColumn =
          /^RENAME\s+(?:COLUMN\s+)?("[^"]+"|[A-Za-z_][\w$]*)\s+TO\s+("[^"]+"|[A-Za-z_][\w$]*)/i
            .exec(action);
        if (renameColumn) {
          const from = bareName(renameColumn[1]!);
          const to = bareName(renameColumn[2]!);
          if (from && to) {
            const columns = columnsFor(table);
            if (columns.delete(from)) columns.add(to);
            for (const suffix of ["nullability", "default"]) {
              const oldKey = `${table.schema}.${table.table}.${from}:${suffix}`;
              const value = live.get(oldKey);
              live.delete(oldKey);
              if (value !== undefined) {
                live.set(
                  `${table.schema}.${table.table}.${to}:${suffix}`,
                  value,
                );
              }
            }
            const key = `${table.schema}.${table.table}:pk`;
            const cols = live.get(key)?.split(",");
            if (cols?.includes(from)) {
              live.set(key, pkIdentity(cols.map((c) => c === from ? to : c)));
            }
            const pk = pkColumns.get(`${table.schema}.${table.table}`);
            if (pk?.includes(from)) {
              pkColumns.set(
                `${table.schema}.${table.table}`,
                pk.map((c) => c === from ? to : c),
              );
            }
          }
          continue;
        }
        const alterColumn =
          /^ALTER\s+(?:COLUMN\s+)?("[^"]+"|[A-Za-z_][\w$]*)\s+(SET\s+NOT\s+NULL|DROP\s+NOT\s+NULL|SET\s+DEFAULT\s+[\s\S]+|DROP\s+DEFAULT)$/i
            .exec(action);
        if (alterColumn) {
          const column = bareName(alterColumn[1]!);
          const operation = alterColumn[2]!;
          if (!column) continue;
          const key = `${table.schema}.${table.table}.${column}`;
          if (/^SET\s+NOT\s+NULL$/i.test(operation)) {
            live.set(`${key}:nullability`, "notnull");
          } else if (/^DROP\s+NOT\s+NULL$/i.test(operation)) {
            const remainsPrimaryKey =
              (pkColumns.get(`${table.schema}.${table.table}`) ?? []).includes(
                column,
              );
            live.set(
              `${key}:nullability`,
              remainsPrimaryKey ? "notnull" : "nullable",
            );
          } else if (/^DROP\s+DEFAULT$/i.test(operation)) {
            live.set(`${key}:default`, "-");
          } else {live.set(
              `${key}:default`,
              normalizeDefault(
                /^SET\s+DEFAULT\s+([\s\S]+)$/i.exec(operation)?.[1],
              ),
            );}
          continue;
        }
        const addPk =
          /^ADD\s+(?:CONSTRAINT\s+("[^"]+"|[A-Za-z_][\w$]*)\s+)?PRIMARY\s+KEY\s*\(([\s\S]*)\)$/i
            .exec(action);
        if (addPk) {
          setPk(
            table,
            splitTopLevel(addPk[2]!).map((c) => bareName(c) ?? c),
            bareName(addPk[1] ?? "") ?? `${table.table}_pkey`,
          );
          continue;
        }
        const dropConstraint =
          /^DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?("[^"]+"|[A-Za-z_][\w$]*)/i
            .exec(action);
        if (dropConstraint) {
          const name = bareName(dropConstraint[1]!);
          const namedKey = name
            ? pkNames.get(`${table.schema}.${table.table}.${name}`)
            : undefined;
          if (namedKey) {
            live.delete(namedKey);
            pkColumns.delete(`${table.schema}.${table.table}`);
          }
          if (name) {
            pkNames.delete(`${table.schema}.${table.table}.${name}`);
            if (name === `${table.table}_pkey`) {
              live.delete(`${table.schema}.${table.table}:pk`);
              pkColumns.delete(`${table.schema}.${table.table}`);
            }
          }
        }
      }
    }
  }
  return live;
}

export function sqlInventedConstraints(
  history: readonly MigrationEntry[],
  snapshot: SchemaFingerprint,
): string[] {
  return [...sqlMaterializedConstraintFingerprint(history).keys()].filter((k) =>
    !snapshot.has(k)
  ).sort();
}

export function sqlOmittedConstraints(
  history: readonly MigrationEntry[],
  snapshot: SchemaFingerprint,
): string[] {
  const live = sqlMaterializedConstraintFingerprint(history);
  return [...snapshot.keys()].filter((k) => !live.has(k)).sort();
}

export function sqlRetypedConstraints(
  history: readonly MigrationEntry[],
  snapshot: SchemaFingerprint,
): string[] {
  const live = sqlMaterializedConstraintFingerprint(history);
  const out: string[] = [];
  for (const [key, expected] of snapshot) {
    const actual = live.get(key);
    if (actual !== undefined && actual !== expected) {
      out.push(`${key}: ${actual} → ${expected}`);
    }
  }
  return out.sort();
}

// ── relational-constraint SQL axis ───────────────────────
//
// Drizzle snapshots record FK and CHECK rows today but omit EXCLUDE rows. More importantly, an apply path
// executes migration.sql, not snapshot.json. These constraints therefore compare declaration DDL directly
// with the live result of committed SQL history. Names are not an identity: deriveDDL leaves FKs unnamed
// while drizzle-kit assigns one in ALTER TABLE, yet both statements create the same constraint.

interface ParsedRelationalConstraint {
  readonly key: string;
  readonly name: string | null;
}

function constraintNameAndBody(
  clause: string,
): { name: string | null; body: string } | null {
  const m = /^\s*(?:CONSTRAINT\s+((?:"[^"]+"|[A-Za-z_][\w$]*))\s+)?([\s\S]*)$/i
    .exec(clause);
  if (!m) return null;
  const body = m[2]!.trim();
  if (!/^(?:FOREIGN\s+KEY|CHECK\s*\(|EXCLUDE\b)/i.test(body)) return null;
  return { name: bareName(m[1] ?? ""), body };
}

/** Canonical SQL without weakening literal or quoted-uppercase identifier distinctions. */
function normalizeConstraintSql(sql: string): string {
  let out = "";
  for (let i = 0; i < sql.length;) {
    if (sql[i] === "'") {
      // Preserve CHECK literal bytes: 'A' → 'a' must not false-green the gate.
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      out += sql.slice(i, j);
      i = j;
      continue;
    }
    if (sql[i] === '"') {
      const end = sql.indexOf('"', i + 1);
      if (end < 0) return sql.trim();
      const ident = sql.slice(i + 1, end);
      // Quotes around lower-case identifiers do not change PostgreSQL's meaning. Upper/special names stay exact.
      out += /^[a-z_][a-z0-9_$]*$/.test(ident) ? ident : `"${ident}"`;
      i = end + 1;
      continue;
    }
    out += sql[i]!.toLowerCase();
    i++;
  }
  return out.replace(/\s+/g, " ").replace(/\s*([(),.])\s*/g, "$1").trim();
}

function relationalConstraint(
  schema: string,
  table: string,
  clause: string,
): ParsedRelationalConstraint | null {
  const parsed = constraintNameAndBody(clause);
  if (!parsed) return null;
  return {
    key: `${schema}.${table}:constraint:${normalizeConstraintSql(parsed.body)}`,
    name: parsed.name,
  };
}

function inlineReferenceConstraint(
  schema: string,
  table: string,
  clause: string,
): ParsedRelationalConstraint | null {
  const ref = sqlKeywordOffset(clause, "REFERENCES");
  if (ref < 0) return null;
  const column = /^\s*((?:"[^"]+"|[A-Za-z_][\w$]*))(?:\s|$)/.exec(clause)
    ?.[1];
  if (!column) return null;
  return relationalConstraint(
    schema,
    table,
    `FOREIGN KEY (${column}) ${clause.slice(ref)}`,
  );
}

/** A structural keyword must not be borrowed from a string or dollar-quoted DEFAULT expression. */
function sqlKeywordOffset(sql: string, keyword: string): number {
  const folded = keyword.toLowerCase();
  for (let i = 0; i < sql.length;) {
    const end = endOfSqlLiteral(sql, i);
    if (end > i) {
      i = end;
      continue;
    }
    if (
      sql.slice(i, i + keyword.length).toLowerCase() === folded &&
      !/[A-Za-z0-9_$]/.test(sql[i - 1] ?? "") &&
      !/[A-Za-z0-9_$]/.test(sql[i + keyword.length] ?? "")
    ) return i;
    i++;
  }
  return -1;
}

function matchingConstraintParen(sql: string, open: number): number {
  let depth = 0;
  for (let i = open; i < sql.length; i++) {
    const end = endOfSqlLiteral(sql, i);
    if (end > i) {
      i = end - 1;
      continue;
    }
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/** CHECK may be a column tail, before a later DEFAULT, rather than a table-level clause. */
function inlineCheckConstraint(
  schema: string,
  table: string,
  clause: string,
): ParsedRelationalConstraint | null {
  const check = sqlKeywordOffset(clause, "CHECK");
  if (check < 0) return null;
  const open = clause.indexOf("(", check);
  const close = matchingConstraintParen(clause, open);
  return close < 0
    ? null
    : relationalConstraint(schema, table, clause.slice(check, close + 1));
}

function clauseRelationalConstraints(
  schema: string,
  table: string,
  clause: string,
): readonly ParsedRelationalConstraint[] {
  const direct = relationalConstraint(schema, table, clause);
  if (direct) return [direct];
  return [
    inlineReferenceConstraint(schema, table, clause),
    inlineCheckConstraint(schema, table, clause),
  ].filter((c): c is ParsedRelationalConstraint => c !== null);
}

/** FK, CHECK and EXCLUDE constraints inline in CREATE TABLE statements. */
export function createRelationalConstraintFingerprint(
  sql: string,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of parseCreateTables(sql)) {
    for (const clause of t.clauses) {
      for (
        const parsed of clauseRelationalConstraints(t.schema, t.table, clause)
      ) {
        out.set(parsed.key, parsed.key);
      }
    }
  }
  return out;
}

export function derivedRelationalConstraintFingerprint(
  app: App,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const stmt of deriveSchemaSql(app)) {
    for (const [k, v] of createRelationalConstraintFingerprint(stmt)) {
      out.set(k, v);
    }
  }
  return out;
}

function relationalTableKey(
  tableTok: string,
): { schema: string; table: string } | null {
  const dot = tableTok.lastIndexOf(".");
  const schema = dot === -1
    ? "public"
    : (bareName(tableTok.slice(0, dot)) ?? "public");
  const table = bareName(dot === -1 ? tableTok : tableTok.slice(dot + 1));
  return table ? { schema, table } : null;
}

/** Top-level ALTER TABLE actions, so `DROP CONSTRAINT old, ADD CONSTRAINT new …` evolves state in order. */
function splitAlterActions(body: string): readonly string[] {
  const out: string[] = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const end = endOfSqlLiteral(body, i);
    if (end > i) {
      i = end - 1;
      continue;
    }
    if (body[i] === "(") depth++;
    else if (body[i] === ")") depth--;
    else if (body[i] === "," && depth === 0) {
      out.push(body.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(body.slice(start).trim());
  return out.filter((action) => action !== "");
}

/** FK, CHECK and EXCLUDE constraints the full committed migration history leaves in place. */
export function sqlMaterializedRelationalConstraints(
  history: readonly MigrationEntry[],
): Map<string, string> {
  const live = new Map<string, string>();
  const named = new Map<string, string>();
  const alter = new RegExp(
    String
      .raw`^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QUALIFIED_NAME})\s+([\s\S]*)$`,
    "i",
  );
  const dropTable = new RegExp(
    String.raw`^\s*DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(${QUALIFIED_NAME})`,
    "i",
  );
  for (const entry of history) {
    for (const stmt of splitSqlStatements(stripSqlComments(entry.sql))) {
      for (const t of parseCreateTables(stmt)) {
        for (const clause of t.clauses) {
          for (
            const parsed of clauseRelationalConstraints(
              t.schema,
              t.table,
              clause,
            )
          ) {
            live.set(parsed.key, parsed.key);
            if (parsed.name) {
              named.set(`${t.schema}.${t.table}.${parsed.name}`, parsed.key);
            }
          }
        }
      }
      const tableDrop = dropTable.exec(stmt);
      if (tableDrop) {
        const table = relationalTableKey(tableDrop[1] ?? "");
        if (!table) continue;
        const prefix = `${table.schema}.${table.table}:constraint:`;
        for (const key of [...live.keys()]) {
          if (key.startsWith(prefix)) live.delete(key);
        }
        for (const [name, key] of named) {
          if (key.startsWith(prefix)) named.delete(name);
        }
        continue;
      }
      const m = alter.exec(stmt);
      if (!m) continue;
      const table = relationalTableKey(m[1] ?? "");
      if (!table) continue;
      for (const action of splitAlterActions(m[2]!.trim())) {
        const dropped =
          /^DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?((?:"[^"]+"|[A-Za-z_][\w$]*))/i
            .exec(action);
        if (dropped) {
          const name = bareName(dropped[1] ?? "");
          const namedKey = name
            ? named.get(`${table.schema}.${table.table}.${name}`)
            : undefined;
          if (namedKey) live.delete(namedKey);
          if (name) named.delete(`${table.schema}.${table.table}.${name}`);
          continue;
        }
        const add = /^ADD\s+([\s\S]*)$/i.exec(action);
        if (!add) continue;
        const parsed = relationalConstraint(table.schema, table.table, add[1]!);
        if (!parsed) continue;
        live.set(parsed.key, parsed.key);
        if (parsed.name) {
          named.set(
            `${table.schema}.${table.table}.${parsed.name}`,
            parsed.key,
          );
        }
      }
    }
  }
  return live;
}

/** Constraints declarations require but committed migration.sql does not leave in place. */
export function sqlOmittedRelationalConstraints(
  history: readonly MigrationEntry[],
  declared: SchemaFingerprint,
): string[] {
  const live = sqlMaterializedRelationalConstraints(history);
  return [...declared.keys()].filter((k) => !live.has(k)).sort();
}

/** Constraints migration.sql leaves in place even though declarations no longer require them. */
export function sqlInventedRelationalConstraints(
  history: readonly MigrationEntry[],
  declared: SchemaFingerprint,
): string[] {
  return [...sqlMaterializedRelationalConstraints(history).keys()].filter((k) =>
    !declared.has(k)
  ).sort();
}

/** The outcome of the on-disk staleness check. `state:"none"` is a repo with no committed migration yet;
 *  the CLI verb decides what that means, because "nothing on disk to be stale" is only a pass for an app
 *  that declares nothing to put there. */
export type SnapshotDriftReport =
  | { readonly state: "none" }
  | { readonly state: "unreadable"; readonly dir: string; readonly why: string }
  | {
    readonly state: "checked";
    readonly dir: string;
    readonly drift: SnapshotDrift;
    /** SQL creates these; the snapshot does not — hand-edited migration.sql (or stale snapshot). */
    readonly sqlInvented: readonly string[];
    /** Snapshot columns SQL never materializes — truncated or empty migration.sql. */
    readonly sqlOmitted: readonly string[];
    /** SQL type disagrees with the snapshot for a column both name. */
    readonly sqlRetyped: readonly string[];
    /** SQL creates these indexes; the snapshot does not. */
    readonly sqlInventedIndexes: readonly string[];
    /** Snapshot indexes SQL never materializes. */
    readonly sqlOmittedIndexes: readonly string[];
    /** SQL index identity disagrees with the snapshot for a key both name. */
    readonly sqlRetypedIndexes: readonly string[];
    /** SQL leaves FK/CHECK/EXCLUDE constraints declarations no longer require. */
    readonly sqlInventedRelationalConstraints: readonly string[];
    /** Declared FK/CHECK/EXCLUDE constraints SQL does not leave in place. */
    readonly sqlOmittedRelationalConstraints: readonly string[];
    /** SQL-created nullability/default/PK state that the snapshot does not carry. */
    readonly sqlInventedConstraints: readonly string[];
    /** Snapshot nullability/default/PK state the committed SQL does not leave in place. */
    readonly sqlOmittedConstraints: readonly string[];
    /** Nullability/default/PK values that differ between committed SQL and the snapshot. */
    readonly sqlRetypedConstraints: readonly string[];
  };

/**
 * `checkCommittedSnapshot(app, drizzleDir)` — reads the newest committed migration's `snapshot.json` and
 * diffs it against the declaration-derived schema, AND checks committed `migration.sql` materializes that
 * snapshot (both directions, including types and indexes). Offline: no database, no drizzle-kit spawn.
 */
export async function checkCommittedSnapshot(
  app: App,
  drizzleDir: string,
): Promise<SnapshotDriftReport> {
  const history = await readMigrationHistory(drizzleDir);
  let snapshot: unknown | undefined;
  let head: (typeof history)[number] | undefined;
  for (let i = history.length - 1; i >= 0; i--) {
    const e = history[i]!;
    try {
      snapshot = JSON.parse(
        await Deno.readTextFile(`${drizzleDir}/${e.dir}/snapshot.json`),
      );
      head = e;
      break;
    } catch {
      // L-32: a sql-only dir is still applyable; it is not the drift head.
    }
  }
  if (!head || snapshot === undefined) {
    if (history.length === 0) return { state: "none" };
    return {
      state: "unreadable",
      dir: history.at(-1)!.dir,
      why: "no readable snapshot.json in the committed chain",
    };
  }
  if (head.version !== "8") {
    return {
      state: "unreadable",
      dir: head.dir,
      why: `unsupported or missing snapshot version '${
        head.version ?? "(missing)"
      }' (this build requires version 8)`,
    };
  }
  const snapshotDdl = (snapshot as { ddl?: readonly SnapshotEntity[] })?.ddl;
  const hasColumns = Array.isArray(snapshotDdl) &&
    snapshotDdl.some((e) => e?.entityType === "columns");
  if (hasColumns && !snapshotHasConstraintAxis(snapshot)) {
    return {
      state: "unreadable",
      dir: head.dir,
      why:
        "snapshot version 8 is missing complete column nullability/default metadata",
    };
  }
  const snapFp = snapshotFingerprint(snapshot);
  const snapIdx = snapshotIndexFingerprint(snapshot);
  let drift = mergeDrift(
    fingerprintDrift(derivedFingerprint(app), snapFp),
    fingerprintDrift(
      derivedIndexFingerprint(app),
      snapshotIndexFingerprint(snapshot),
    ),
  );
  const snapConstraint = snapshotConstraintFingerprint(snapshot);
  drift = mergeDrift(
    drift,
    fingerprintDrift(
      derivedConstraintFingerprint(app),
      snapConstraint,
    ),
  );
  const declaredRelationalConstraints = derivedRelationalConstraintFingerprint(
    app,
  );
  return {
    state: "checked",
    dir: head.dir,
    drift,
    sqlInvented: sqlInventedColumns(history, snapFp),
    sqlOmitted: sqlOmittedColumns(history, snapFp),
    sqlRetyped: sqlRetypedColumns(history, snapFp),
    sqlInventedIndexes: sqlInventedIndexes(history, snapIdx),
    sqlOmittedIndexes: sqlOmittedIndexes(history, snapIdx),
    sqlRetypedIndexes: sqlRetypedIndexes(history, snapIdx),
    sqlInventedRelationalConstraints: sqlInventedRelationalConstraints(
      history,
      declaredRelationalConstraints,
    ),
    sqlOmittedRelationalConstraints: sqlOmittedRelationalConstraints(
      history,
      declaredRelationalConstraints,
    ),
    sqlInventedConstraints: sqlInventedConstraints(history, snapConstraint),
    sqlOmittedConstraints: sqlOmittedConstraints(history, snapConstraint),
    sqlRetypedConstraints: sqlRetypedConstraints(history, snapConstraint),
  };
}
