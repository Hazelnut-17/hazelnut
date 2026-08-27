// The committed-migration staleness gate: the declaration-derived schema vs the newest committed
// `drizzle/<ts>/snapshot.json`, offline and in-process (no drizzle-kit spawn — that is the boot lane).
// A second axis catches hand-edited `migration.sql`: columns the SQL would create that the snapshot
// never heard of (ARCH-1 — the apply path runs SQL, so a gate that only reads snapshot.json is blind).
import type { App } from "../core/app.ts";
import { normalizePgType, parseCreateTables } from "./ddl-parse.ts";
import { deriveSchemaSql } from "./migrate-derive.ts";
import {
  type MigrationEntry,
  readMigrationHistory,
} from "./migrate-drizzle-schema.ts";
import { bareName, QUALIFIED_NAME } from "./migrate-safety-names.ts";

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
  readonly columns?: ReadonlyArray<{ readonly value?: string }>;
}

// ── the CONSTRAINT axis ─────────────────────────────────── Tables and columns were the whole
// comparison, so a resource that declared `unique: [["title"]]` after its migration was generated left
// the committed migration without that index and `drift` answered "the committed migration matches" —
// while `migrate generate`, run immediately after, wrote a migration containing the CREATE INDEX. The
// same tree telling itself the two disagree. Uniqueness is a correctness constraint, not a hint: without
// the index the rows the declaration forbids can be written, and `drift` rides the emitted `ci` chain,
// so the gate was green while the declared uniqueness did not exist.

/** One index's identity, spelled the same from either side: `unique|index(cols…)[ WHERE pred]`. */
function indexIdentity(
  isUnique: boolean,
  cols: readonly string[],
  where: string | null | undefined,
): string {
  const w = (where ?? "").trim();
  return `${isUnique ? "unique" : "index"}(${cols.join(",")})${
    w === "" ? "" : ` WHERE ${w.replace(/\s+/g, " ")}`
  }`;
}

/** Every `CREATE [UNIQUE] INDEX` in `sql`, keyed `schema.table.index:<name>`. Quoting is normalised away
 *  on both sides — the derived SQL quotes identifiers and a snapshot does not.
 *
 *  The column list is scanned with BALANCED parens, never a `[^)]*` run: a real index key can be an
 *  EXPRESSION (`md5(payload::text)`), and stopping at the first `)` truncated it, swallowed the closing
 *  paren, and reported the framework's own `_outbox` index as drifted against itself. */
export function createIndexFingerprint(sql: string): Map<string, string> {
  const out = new Map<string, string>();
  const head =
    /CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([^"\s(]+)"?\s+ON\s+("?[^"\s(]+"?(?:\."?[^"\s(]+"?)?)\s*(?:USING\s+\w+\s*)?\(/gi;
  for (const m of sql.matchAll(head)) {
    const [, uniq, name, target] = m;
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
    const cols = splitTopLevel(sql.slice(from, i - 1));
    const semi = sql.indexOf(";", i);
    const tail = sql.slice(i, semi === -1 ? undefined : semi);
    const parts = target!.replaceAll('"', "").split(".");
    const schema = parts.length > 1 ? parts[0]! : "public";
    out.set(
      `${schema}.${parts.at(-1)!}.index:${name!.replaceAll('"', "")}`,
      indexIdentity(
        uniq !== undefined,
        cols,
        /\bWHERE\b([\s\S]*)$/i.exec(tail)?.[1] ?? null,
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
  return out
    .map((c) => c.trim().replaceAll('"', "").replace(/\s+(ASC|DESC)$/i, ""))
    .filter((c) => c !== "");
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
        (e.columns ?? []).map((c: { readonly value?: string }) =>
          (c.value ?? "").trim()
        ),
        e.where,
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
): boolean {
  return isDriftClean(drift) && sqlInvented.length === 0;
}

/** `schema.table.column` keys a `CREATE TABLE` / `ALTER TABLE … ADD COLUMN` in committed SQL invents that
 *  the newest snapshot does not carry — a hand-edit (or a snapshot that was not regenerated). A later
 *  `DROP COLUMN` / `DROP TABLE` in the same history is a proven drop, not an invented leftover. */
export function sqlInventedColumns(
  history: readonly MigrationEntry[],
  snapshot: SchemaFingerprint,
): string[] {
  const invented = new Set<string>();
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
    for (const [k] of createTableFingerprint(entry.sql)) {
      if (!snapshot.has(k)) invented.add(k);
    }
    addCol.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = addCol.exec(entry.sql)) !== null) {
      const parsed = tableKey(m[1] ?? "");
      const col = bareName(m[2] ?? "");
      if (!parsed || !col) continue;
      const key = `${parsed.schema}.${parsed.table}.${col}`;
      if (!snapshot.has(key)) invented.add(key);
    }
    dropCol.lastIndex = 0;
    while ((m = dropCol.exec(entry.sql)) !== null) {
      const parsed = tableKey(m[1] ?? "");
      const col = bareName(m[2] ?? "");
      if (!parsed || !col) continue;
      invented.delete(`${parsed.schema}.${parsed.table}.${col}`);
    }
    dropTable.lastIndex = 0;
    while ((m = dropTable.exec(entry.sql)) !== null) {
      const parsed = tableKey(m[1] ?? "");
      if (!parsed) continue;
      const prefix = `${parsed.schema}.${parsed.table}.`;
      for (const k of [...invented]) {
        if (k.startsWith(prefix)) invented.delete(k);
      }
    }
  }
  return [...invented].sort();
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
  };

/**
 * `checkCommittedSnapshot(app, drizzleDir)` — reads the newest committed migration's `snapshot.json` and
 * diffs it against the declaration-derived schema, AND checks committed `migration.sql` does not invent
 * columns the snapshot never declared. Offline: no database, no drizzle-kit spawn.
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
  const snapFp = snapshotFingerprint(snapshot);
  return {
    state: "checked",
    dir: head.dir,
    // ONE derivation, not a second checker: the constraint axis rides the same set difference over a
    // fingerprint the columns axis already uses, so `drift`'s subject is the whole schema rather than the
    // half a `CREATE TABLE` body happens to carry.
    drift: mergeDrift(
      fingerprintDrift(derivedFingerprint(app), snapFp),
      fingerprintDrift(
        derivedIndexFingerprint(app),
        snapshotIndexFingerprint(snapshot),
      ),
    ),
    sqlInvented: sqlInventedColumns(history, snapFp),
  };
}
