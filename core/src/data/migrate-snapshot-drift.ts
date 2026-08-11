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

/** One entity row of a drizzle `snapshot.json` — only `columns` rows carry the fingerprint. */
interface SnapshotEntity {
  readonly entityType?: string;
  readonly schema?: string;
  readonly table?: string;
  readonly name?: string;
  readonly type?: string;
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
 *  the newest snapshot does not carry — a hand-edit (or a snapshot that was not regenerated). */
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
  for (const entry of history) {
    if (!entry.sql) continue;
    for (const [k] of createTableFingerprint(entry.sql)) {
      if (!snapshot.has(k)) invented.add(k);
    }
    addCol.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = addCol.exec(entry.sql)) !== null) {
      const tableTok = m[1] ?? "";
      const col = bareName(m[2] ?? "");
      if (!col) continue;
      const dot = tableTok.lastIndexOf(".");
      const schema = dot === -1
        ? "public"
        : (bareName(tableTok.slice(0, dot)) ?? "public");
      const table = bareName(dot === -1 ? tableTok : tableTok.slice(dot + 1));
      if (!table) continue;
      const key = `${schema}.${table}.${col}`;
      if (!snapshot.has(key)) invented.add(key);
    }
  }
  return [...invented].sort();
}

/** The outcome of the on-disk staleness check. `state:"none"` is a repo with no committed migration yet —
 *  nothing on disk to be stale, so it is a pass with a notice, not a failure. */
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
  const head = history.at(-1);
  if (!head) return { state: "none" };
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(
      await Deno.readTextFile(`${drizzleDir}/${head.dir}/snapshot.json`),
    );
  } catch (e) {
    return { state: "unreadable", dir: head.dir, why: String(e) };
  }
  const snapFp = snapshotFingerprint(snapshot);
  return {
    state: "checked",
    dir: head.dir,
    drift: fingerprintDrift(derivedFingerprint(app), snapFp),
    sqlInvented: sqlInventedColumns(history, snapFp),
  };
}
