// The pinned Kit stores array rank separately but omits dimensions-only ALTERs.
// Keep this correction at the generation boundary; conversions remain authored SQL.
import type { App } from "../core/app.ts";
import {
  columnTypeSql,
  normalizePgType,
  parseColumnClause,
  parseCreateTables,
} from "./ddl-parse.ts";
import { deriveSchemaSql } from "./migrate-derive.ts";
import { migrationTableName, splitAlterActions } from "./migrate-online.ts";
import { bareName } from "./migrate-safety-names.ts";
import { splitSqlStatements, stripSqlComments } from "./migrate-sql-text.ts";

export interface ArrayRankChange {
  readonly schema: string;
  readonly table: string;
  readonly column: string;
  readonly typeSql: string;
  readonly dimensions: number;
}

const key = (schema: string, table: string, column: string) =>
  JSON.stringify([schema, table, column]);
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const suffix = /(?:\s*\[\s*\])+\s*$/;
const rank = (type: string) =>
  (type.match(suffix)?.[0].match(/\[/g) ?? []).length;
const base = (type: string) => type.replace(suffix, "").trim();
const ident = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)`;
const qualified = `${ident}(?:\\s*\\.\\s*${ident})?`;
const alter = new RegExp(
  String.raw`^ALTER\s+TABLE\s+(${qualified})\s+([\s\S]+)$`,
  "i",
);

/** Follow only explicit Kit identity changes; a dropped object is no longer an existing column. */
function existingColumns(baseline: unknown, sql: string) {
  let existing = columns(baseline).flatMap((row) =>
    typeof row.table === "string" && typeof row.name === "string" &&
      typeof row.type === "string"
      ? [{
        schema: typeof row.schema === "string" ? row.schema : "public",
        table: row.table,
        column: row.name,
        type: row.type,
        dimensions: Math.max(
          rank(row.type),
          typeof row.dimensions === "number" ? row.dimensions : 0,
        ),
      }]
      : []
  );
  const dropTable = new RegExp(
    String.raw`^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(${qualified})`,
    "i",
  );
  const dropColumn = new RegExp(
    String.raw`^DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?(${ident})(?:\s|$)`,
    "i",
  );
  const renameColumn = new RegExp(
    String.raw`^RENAME\s+COLUMN\s+(${ident})\s+TO\s+(${ident})\s*$`,
    "i",
  );
  const renameTable = new RegExp(
    String.raw`^RENAME\s+TO\s+(${ident})\s*$`,
    "i",
  );
  const moveSchema = new RegExp(
    String.raw`^SET\s+SCHEMA\s+(${ident})\s*$`,
    "i",
  );
  for (const statement of splitSqlStatements(stripSqlComments(sql))) {
    const text = statement.trim();
    const dropped = dropTable.exec(text);
    if (dropped) {
      const { schema, table } = migrationTableName(dropped[1]!);
      existing = existing.filter((row) =>
        row.schema !== schema || row.table !== table
      );
      continue;
    }
    const match = alter.exec(text);
    if (!match) continue;
    const { schema, table } = migrationTableName(match[1]!);
    for (const action of splitAlterActions(match[2]!)) {
      const removed = dropColumn.exec(action);
      if (removed) {
        existing = existing.filter((row) =>
          row.schema !== schema || row.table !== table ||
          row.column !== bareName(removed[1]!)
        );
      }
      const renamed = renameColumn.exec(action);
      const tableName = renameTable.exec(action)?.[1];
      const schemaName = moveSchema.exec(action)?.[1];
      for (const row of existing) {
        if (row.schema !== schema || row.table !== table) continue;
        if (renamed && row.column === bareName(renamed[1]!)) {
          row.column = bareName(renamed[2]!)!;
        }
        if (tableName) row.table = bareName(tableName)!;
        if (schemaName) row.schema = bareName(schemaName)!;
      }
    }
  }
  return existing;
}

function columns(snapshot: unknown): Record<string, unknown>[] {
  const ddl = (snapshot as { ddl?: unknown } | undefined)?.ddl;
  return Array.isArray(ddl)
    ? ddl.filter((row) => row?.entityType === "columns")
    : [];
}

/** Only existing columns whose scalar type is unchanged qualify for the Kit rank correction. */
export function arrayRankChanges(
  app: App,
  baseline: unknown,
  sql = "",
): ArrayRankChange[] {
  const desired = new Map<string, ArrayRankChange>();
  for (const sql of deriveSchemaSql(app)) {
    for (const table of parseCreateTables(sql)) {
      for (const clause of table.clauses) {
        const column = parseColumnClause(clause);
        if (!column) continue;
        const typeSql = columnTypeSql(clause)!;
        desired.set(key(table.schema, table.table, column.name), {
          schema: table.schema,
          table: table.table,
          column: column.name,
          typeSql,
          dimensions: rank(typeSql),
        });
      }
    }
  }
  const changes: ArrayRankChange[] = [];
  for (const row of existingColumns(baseline, sql)) {
    const target = desired.get(key(row.schema, row.table, row.column));
    if (!target) continue;
    // Positive ranks describe the same PostgreSQL type; changing 1 to 2 alone
    // neither converts values nor warrants a destructive migration.
    if (
      (row.dimensions > 0) !== (target.dimensions > 0) &&
      normalizePgType(base(row.type)) === normalizePgType(base(target.typeSql))
    ) {
      changes.push(target);
    }
  }
  return changes;
}

/** Respect an ALTER already supplied by Kit (including a future corrected Kit renderer). */
export function appendArrayRankChanges(
  sql: string,
  changes: readonly ArrayRankChange[],
): string {
  const altered = new Set<string>();
  const type = new RegExp(
    String.raw`^ALTER\s+(?:COLUMN\s+)?(${ident})\s+(?:SET\s+DATA\s+)?TYPE\s+`,
    "i",
  );
  for (const statement of splitSqlStatements(stripSqlComments(sql))) {
    const match = alter.exec(statement.trim());
    if (!match) continue;
    const { schema, table } = migrationTableName(match[1]!);
    for (const action of splitAlterActions(match[2]!)) {
      const column = type.exec(action)?.[1];
      if (column) altered.add(key(schema, table, bareName(column)!));
    }
  }
  const missing = changes.filter((change) =>
    !altered.has(key(change.schema, change.table, change.column))
  );
  if (missing.length === 0) return sql;
  const statements = missing.map((change) =>
    `ALTER TABLE ${quote(change.schema)}.${quote(change.table)} ALTER COLUMN ${
      quote(change.column)
    } SET DATA TYPE ${change.typeSql};`
  );
  return [sql.trimEnd(), ...statements].filter(Boolean).join(
    "\n--> statement-breakpoint\n",
  ) + "\n";
}

/** Advance only the newly written snapshot; never mutate an existing history node. */
export function updateArrayRankSnapshot(
  snapshot: Record<string, unknown>,
  changes: readonly ArrayRankChange[],
): Record<string, unknown> {
  const targets = new Map(
    changes.map((
      change,
    ) => [key(change.schema, change.table, change.column), change.dimensions]),
  );
  const ddl = snapshot.ddl;
  if (!Array.isArray(ddl)) {
    throw new Error("migrate/array-rank-snapshot: new snapshot has no ddl");
  }
  const updated = ddl.map((row) => {
    if (row?.entityType !== "columns") return row;
    const id = key(row.schema ?? "public", row.table, row.name);
    const dimensions = targets.get(id);
    if (dimensions === undefined) return row;
    targets.delete(id);
    return { ...row, dimensions };
  });
  if (targets.size > 0) {
    throw new Error(
      "migrate/array-rank-snapshot: new snapshot is missing a changed column",
    );
  }
  return { ...snapshot, ddl: updated };
}
