// `semanticSearch` — the vector KNN read, composed on the same read stack every other repo read uses.
import type { ResourceModel } from "../core/app.ts";
import { all, type Where } from "../core/where.ts";
import { sourceHash, vectorLiteral } from "../features/embed.ts";
import { decryptRows, type Kms } from "../features/encrypt.ts";
import type { Db, Transactor } from "./db.ts";
import { decodeDeclaredBigints } from "./native-cast.ts";
import { readWhereSql } from "./read-sql.ts";
import { querySql, readMetadata } from "./read-compiler.ts";
import { equalityWhere } from "./repo-list.ts";
import type { ReadCtx, RowPolicy } from "./repo.ts";
import { sql } from "drizzle-orm/sql";

/** An internal repo row plus cosine distance and whether its retained vector predates its current text. */
export type SemanticHit<Row> = Row & {
  readonly _distance: number;
  readonly _stale: boolean;
};

/**
 * `semanticSearch` (security-critical): k-nearest-neighbour over the embedding column, AND'd with the
 * full read WHERE-stack at the same `buildReadWhere` site every other read uses — rowPolicy is never a
 * post-query filter, and an omitted `rowPolicy` is the resource's declared one, never `all()`. Rows come
 * back as repo `list` returns them (decrypted with `kms`) with `_distance`. `SET LOCAL
 * hnsw.iterative_scan = 'relaxed_order'` lets pgvector scan beyond the first unfiltered top-K candidates;
 * the maxScanTuples work bound and the approximate index can still return fewer than k rows, slightly out
 * of distance order.
 */
export async function semanticSearch<Row>(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  queryVec: Float32Array,
  k: number,
  rowPolicy: RowPolicy<Row> = (model.rowPolicy as RowPolicy<Row> | null) ??
    (() => all<Row>()),
  caller: Where<Row> = all<Row>(),
  maxScanTuples = 20000,
  kms?: Kms,
): Promise<SemanticHit<Row>[]> {
  const v = model.vector;
  if (!v) throw new Error(`resource '${model.name}' has no vector field`);
  const predicate = readWhereSql(
    model,
    ctx,
    rowPolicy,
    await equalityWhere(db, model, caller, kms),
    (value) => sql`${sql.param(value)}`,
  );
  const distance = sql`${sql.identifier(v.field)} <=> ${
    vectorLiteral(queryVec)
  }`;
  const select = sql`SELECT *, ${distance} AS "_distance" FROM ${
    readMetadata(model).table
  } WHERE ${predicate} AND ${sql.identifier(v.field)} IS NOT NULL AND ${
    sql.identifier(v.source)
  } IS NOT NULL ORDER BY ${distance} LIMIT ${Math.max(0, Math.floor(k))}`;
  // SET LOCAL is tx-scoped (auto-resets at commit, never leaks on a pooled connection) — the scan setting
  // and the ORDER-BY read below MUST share one transaction, or the guard above silently doesn't apply.
  const run = async (tx: Db): Promise<Record<string, unknown>[]> => {
    await tx.query(`SET LOCAL hnsw.iterative_scan = 'relaxed_order'`);
    await tx.query(
      `SET LOCAL hnsw.max_scan_tuples = ${
        Math.max(1, Math.floor(maxScanTuples))
      }`,
    );
    return (await querySql<Record<string, unknown>>(tx, select)).rows;
  };
  const rows = await inScanTransaction(db, run);
  if (model.encrypted.length > 0) {
    if (!kms) {
      throw new Error(
        `resource '${model.name}' declares encrypted fields but no KMS is bound`,
      );
    }
    await decryptRows(kms, model.encrypted, rows, {
      schema: model.pgSchema,
      table: model.name,
    });
  }
  for (const r of rows) {
    r._distance = Number(r._distance);
    r._stale =
      r[`${v.field}_source_hash`] !== await sourceHash(String(r[v.source]));
  }
  return decodeDeclaredBigints(model, rows) as SemanticHit<Row>[];
}

async function inScanTransaction<T>(
  db: Db,
  run: (tx: Db) => Promise<T>,
): Promise<T> {
  const t = db as Db & Partial<Transactor>;
  if (typeof t.transaction === "function") return await t.transaction(run);
  // a pooled handle without a tx callback cannot keep SET LOCAL on the same connection as the KNN read.
  if (db.concurrent === true) {
    throw new Error(
      `semanticSearch: a concurrent (pooled) handle must expose transaction() so SET LOCAL hnsw.* stays session-scoped`,
    );
  }
  // a bare Db: drive an explicit BEGIN/COMMIT so SET LOCAL is still tx-scoped (reset on ROLLBACK if the read
  // throws). PGlite serializes on one connection, so this is correct for the in-process substrate.
  await db.query(`BEGIN`);
  try {
    const rows = await run(db);
    await db.query(`COMMIT`);
    return rows;
  } catch (e) {
    await db.query(`ROLLBACK`);
    throw e;
  }
}
