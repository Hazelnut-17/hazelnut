import type { Db, Transactor } from "./db.ts";
import { QUALIFIED_NAME } from "./migrate-safety-names.ts";
import { migrationTableName } from "./migrate-online.ts";

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const create = new RegExp(
  String
    .raw`^CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+(?:IF\s+NOT\s+EXISTS\s+)?(${QUALIFIED_NAME})\s+ON\s+(?:ONLY\s+)?(${QUALIFIED_NAME})([\s\S]*)$`,
  "i",
);
const drop = new RegExp(
  String
    .raw`^DROP\s+INDEX\s+CONCURRENTLY\s+(?:IF\s+EXISTS\s+)?(${QUALIFIED_NAME})\s*$`,
  "i",
);

async function identity(
  db: Db,
  schema: string,
  name: string,
): Promise<
  {
    signature: string;
    valid: boolean;
    source_schema: string;
    source_table: string;
  } | undefined
> {
  return (await db.query<
    {
      signature: string;
      valid: boolean;
      source_schema: string;
      source_table: string;
    }
  >(
    `SELECT jsonb_build_object('unique',i.indisunique,'nulls',i.indnullsnotdistinct,
      'method',am.amname,'keys',i.indnkeyatts,'options',i.indoption::text,
      'classes',i.indclass::text,'collations',i.indcollation::text,
      'columns',ARRAY(SELECT pg_get_indexdef(i.indexrelid,k,true) FROM generate_series(1,i.indnatts) k),
      'predicate',pg_get_expr(i.indpred,i.indrelid),'storage',idx.reloptions)::text AS signature,
      i.indisvalid AND i.indisready AND i.indislive AS valid, tn.nspname AS source_schema, t.relname AS source_table
     FROM pg_index i JOIN pg_class idx ON idx.oid=i.indexrelid JOIN pg_namespace ns ON ns.oid=idx.relnamespace
     JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace tn ON tn.oid=t.relnamespace JOIN pg_am am ON am.oid=idx.relam WHERE ns.nspname=$1 AND idx.relname=$2`,
    [schema, name],
  )).rows[0];
}

/** Resolve only catalog-provable CREATE/DROP crash gaps. A same-named unrelated index is never adopted
 * or removed. PostgreSQL itself canonicalizes the full index on an empty LIKE table in a short tx. */
export async function recoverConcurrentIndex(
  db: Db & Transactor,
  statement: string,
): Promise<"execute" | "complete"> {
  const removed = drop.exec(statement);
  if (removed) {
    const target = migrationTableName(removed[1]!);
    return await identity(db, target.schema, target.table)
      ? "execute"
      : "complete";
  }
  const built = create.exec(statement);
  if (!built) return "execute";
  const target = migrationTableName(built[3]!);
  const name = migrationTableName(built[2]!).table;
  const existing = await identity(db, target.schema, name);
  if (!existing) return "execute";
  if (
    existing.source_schema !== target.schema ||
    existing.source_table !== target.table
  ) {
    throw new Error(
      `migrate/index-recovery-mismatch: ${target.schema}.${name} belongs to a different table — reconcile it before resuming`,
    );
  }
  const expected = await db.transaction(async (tx) => {
    const probe = `__hz_index_${crypto.randomUUID().replaceAll("-", "")}`;
    const probeIndex = `${probe}_idx`;
    await tx.exec(
      `CREATE TABLE ${quote(target.schema)}.${quote(probe)} (LIKE ${
        quote(target.schema)
      }.${quote(target.table)})`,
    );
    await tx.exec(
      `CREATE ${built[1] ?? ""}INDEX ${quote(probeIndex)} ON ${
        quote(target.schema)
      }.${quote(probe)}${built[4]}`,
    );
    const result = await identity(tx, target.schema, probeIndex);
    await tx.exec(`DROP TABLE ${quote(target.schema)}.${quote(probe)}`);
    return result;
  });
  if (!expected || existing.signature !== expected.signature) {
    throw new Error(
      `migrate/index-recovery-mismatch: ${target.schema}.${name} exists with a different index definition — reconcile it before resuming; no existing index was dropped`,
    );
  }
  if (existing.valid) return "complete";
  await db.exec(
    `DROP INDEX CONCURRENTLY ${quote(target.schema)}.${quote(name)}`,
  );
  return "execute";
}

/** Re-check completed online builds before advancing to a destructive tail. A process can stop between
 * build and drop; its cursor proves execution order, while the catalog proves the replacement still
 * exists now. Follow completed drop/rename actions rather than rebuilding intentionally retired names. */
export async function recoverCompletedConcurrentIndexes(
  db: Db & Transactor,
  completed: readonly string[],
): Promise<void> {
  const builds = new Map<string, string>();
  const rename = new RegExp(
    String
      .raw`^ALTER\s+INDEX\s+(${QUALIFIED_NAME})\s+RENAME\s+TO\s+(${QUALIFIED_NAME})\s*$`,
    "i",
  );
  for (const statement of completed) {
    const built = create.exec(statement);
    if (built) {
      const target = migrationTableName(built[3]!);
      builds.set(
        JSON.stringify([target.schema, migrationTableName(built[2]!).table]),
        statement,
      );
    }
    const removed = drop.exec(statement);
    if (removed) {
      const name = migrationTableName(removed[1]!);
      builds.delete(JSON.stringify([name.schema, name.table]));
    }
    const moved = rename.exec(statement);
    if (moved) {
      const from = migrationTableName(moved[1]!);
      const key = JSON.stringify([from.schema, from.table]);
      const previous = builds.get(key);
      if (previous) {
        const name = migrationTableName(moved[2]!).table;
        const head = create.exec(previous)!;
        builds.delete(key);
        builds.set(
          JSON.stringify([from.schema, name]),
          `CREATE ${head[1] ?? ""}INDEX CONCURRENTLY ${quote(name)} ON ${
            head[3]
          }${head[4]}`,
        );
      }
    }
  }
  for (const statement of builds.values()) {
    if (await recoverConcurrentIndex(db, statement) === "execute") {
      await db.exec(statement);
    }
    const head = create.exec(statement)!;
    const table = migrationTableName(head[3]!);
    if (
      !(await identity(db, table.schema, migrationTableName(head[2]!).table))
        ?.valid
    ) {
      throw new Error(
        "migrate/index-recovery-invalid: a completed online index is not valid; refusing to advance",
      );
    }
  }
}
