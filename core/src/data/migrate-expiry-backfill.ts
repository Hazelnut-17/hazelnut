import type { App } from "../core/app.ts";
import {
  durationToInterval,
  normalizeExpiry,
  wholeImmutable,
} from "./schema-normalize.ts";
import { migrationTableName, splitAlterActions } from "./migrate-online.ts";
import { QUALIFIED_NAME } from "./migrate-safety-names.ts";
import { splitSqlStatements, stripSqlComments } from "./migrate-sql-text.ts";

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
/** Enabling uniform expiry uses each retained row's historical birth. Never let ADD DEFAULT stamp all
 * legacy rows with the migration clock, or pretend a newly added created_at is a historical timestamp. */
export function stageExpiryBackfills(
  app: App,
  script: string,
  baseline: unknown,
): { sql: string; refusal?: string } {
  const statements = splitSqlStatements(stripSqlComments(script));
  const old = (baseline as {
    ddl?: {
      entityType?: string;
      schema?: string;
      table?: string;
      name?: string;
      type?: string;
      notNull?: boolean;
    }[];
  } | undefined)?.ddl ?? [];
  const alter = new RegExp(
    String.raw`^ALTER\s+TABLE\s+(${QUALIFIED_NAME})\s+([\s\S]*)$`,
    "i",
  );
  const created = new Set(statements.flatMap((statement) => {
    const m = new RegExp(String.raw`^CREATE\s+TABLE\s+(${QUALIFIED_NAME})`, "i")
      .exec(statement);
    return m ? [JSON.stringify(migrationTableName(m[1]!))] : [];
  }));
  const tails: string[] = [];
  for (const model of app.model) {
    const expiry = normalizeExpiry(
      model.features.expiry as Parameters<typeof normalizeExpiry>[0],
    );
    if (
      !expiry?.after ||
      created.has(JSON.stringify({ schema: model.pgSchema, table: model.name }))
    ) continue;
    for (let i = 0; i < statements.length; i++) {
      const m = alter.exec(statements[i]!);
      if (!m) continue;
      const table = migrationTableName(m[1]!);
      if (table.schema !== model.pgSchema || table.table !== model.name) {
        continue;
      }
      const actions = splitAlterActions(m[2]!);
      const added = actions.findIndex((action) =>
        /^ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:"expires_at"|expires_at)\s/i
          .test(action)
      );
      if (added < 0) continue;
      if (wholeImmutable(model.features)) {
        return {
          sql: script,
          refusal:
            `expiry/not-immutable: ${table.schema}.${table.table} is immutable; expiry and purge cannot rewrite or remove WORM history. Remove the contradictory feature combination; no migration or snapshot was retained.`,
        };
      }
      const reliableBirth = old.some((column) =>
        column.entityType === "columns" &&
        (column.schema ?? "public") === table.schema &&
        column.table === table.table && column.name === "created_at" &&
        column.notNull === true &&
        /^(?:timestamp(?:\(\d+\))? with time zone|timestamptz(?:\(\d+\))?)$/i
          .test(column.type ?? "")
      );
      if (!reliableBirth) {
        return {
          sql: script,
          refusal:
            `expiry/backfill-birth-missing: ${table.schema}.${table.table} has no committed historical created_at timestamp. Enabling expiry.after cannot invent each existing row's birth. Author and review an explicit manual deadline backfill before enabling automatic purge; no migration or snapshot was retained.`,
        };
      }
      actions[added] = actions[added]!.replace(/\s+DEFAULT\b[\s\S]*$/i, "");
      statements[i] = `ALTER TABLE ${m[1]} ${actions.join(", ")}`;
      const qualified = `${quote(table.schema)}.${quote(table.table)}`,
        interval = durationToInterval(expiry.after);
      tails.push(
        `UPDATE ${qualified} SET "expires_at" = "created_at" + ${interval} WHERE "expires_at" IS NULL AND "created_at" IS NOT NULL`,
        `ALTER TABLE ${qualified} ALTER COLUMN "expires_at" SET DEFAULT now() + ${interval}`,
      );
    }
  }
  return {
    sql: tails.length === 0
      ? script
      : [...statements, ...tails].join(";\n--> statement-breakpoint\n") + ";\n",
  };
}
