// Barrel re-exports keep import sites stable.
import { tableOf } from "../core/app-define.ts";
import type { ResourceModel } from "../core/app.ts";
import { all, toNode, type Where } from "../core/where.ts";
import {
  decryptRows,
  type Kms,
  rewriteEqualityNode,
} from "../features/encrypt.ts";
import type { Db } from "./db.ts";
import {
  buildReadWhere,
  clampCount,
  cursorKey,
  encodeCursor,
  type Page,
  pageClause,
} from "./repo-read.ts";
import type { ReadCtx, RowPolicy } from "./repo.ts";
import { FILE_GC_TOPIC } from "./repo-topics.ts";
import { updateWritableOf } from "./write-plan.ts";
import { enqueue } from "../runtime/outbox.ts";

/** Read with the full stack injected (the only read path). `page` appends offset or keyset (cursor)
 *  pagination after the WHERE-stack (never bypassing scope); omit it for the full stack-visible set. */
export function list<Row>(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  rowPolicy: RowPolicy<Row>,
  caller: Where<Row>,
  kms?: Kms,
  page?: Page,
  // temporal as-of instant (04-features.md §temporal): threads to `buildReadWhere`'s `at` so the one read
  // site serves "what was valid then" (the canon `Query.asOf` door rides this). Ignored on a non-temporal read.
  at?: Date | string,
): Promise<Row[]> {
  return readRows<Row>(db, model, ctx, rowPolicy, caller, kms, page, at, false);
}

/**
 * The locking single-row read (03-api-shape.md §2 `findForUpdate`) — the SAME stack site as `list`, plus
 * `FOR UPDATE`. Inside the op's write tx the row lock is held to commit, so the `version` this returns is
 * still current when the CAS that follows it runs: the safe write is one extra call, not a retry loop.
 * Outside a transaction Postgres releases the lock at statement end and this reads exactly like `find`.
 */
export async function findForUpdate<Row>(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  rowPolicy: RowPolicy<Row>,
  id: string,
  kms?: Kms,
): Promise<Row | null> {
  const rows = await readRows<Row>(
    db,
    model,
    ctx,
    rowPolicy,
    { id } as unknown as Where<Row>,
    kms,
    undefined,
    undefined,
    true,
  );
  return rows[0] ?? null;
}

/** The one read site both `list` and `findForUpdate` lower through — `lock` is the only difference, so a
 *  locking read can never drift away from the WHERE-stack the unlocked one applies. */
async function readRows<Row>(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  rowPolicy: RowPolicy<Row>,
  caller: Where<Row>,
  kms: Kms | undefined,
  page: Page | undefined,
  at: Date | string | undefined,
  lock: boolean,
): Promise<Row[]> {
  const { sql, params } = buildReadWhere(
    model,
    ctx,
    rowPolicy,
    await equalityWhere(model, caller, kms),
    at,
  );
  const r = await db.query<Record<string, unknown>>(
    `SELECT * FROM ${tableOf(model)} WHERE ${sql}${
      pageClause(page, params, model)
    }${lock ? " FOR UPDATE" : ""}`,
    params,
  );
  if (model.encrypted.length > 0) {
    if (!kms) {
      throw new Error(
        `resource '${model.name}' declares encrypted fields but no KMS is bound`,
      );
    }
    await decryptRows(kms, model.encrypted, r.rows, {
      schema: model.pgSchema,
      table: model.name,
    });
  }
  return r.rows as Row[];
}

/**
 * COUNT through the same WHERE-stack as `list`, without materializing rows or running per-row KMS
 * decrypt. `count`/`exists` on an encrypted resource used to `SELECT *` + `decryptRow` for a number.
 */
export async function countRows<Row>(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  rowPolicy: RowPolicy<Row>,
  caller: Where<Row>,
  kms?: Kms,
  at?: Date | string,
): Promise<number> {
  const { sql, params } = buildReadWhere(
    model,
    ctx,
    rowPolicy,
    await equalityWhere(model, caller, kms),
    at,
  );
  const r = await db.query<{ n: string | number }>(
    `SELECT COUNT(*)::int AS n FROM ${tableOf(model)} WHERE ${sql}`,
    params,
  );
  return Number(r.rows[0]?.n ?? 0);
}

/** Existence through the same stack as `find`, as `SELECT 1 … LIMIT 1` — never a decrypted row set. */
export async function existsRow<Row>(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  rowPolicy: RowPolicy<Row>,
  id: string,
  kms?: Kms,
): Promise<boolean> {
  const { sql, params } = buildReadWhere(
    model,
    ctx,
    rowPolicy,
    await equalityWhere(model, callerWhereId<Row>(id), kms),
  );
  const r = await db.query(
    `SELECT 1 FROM ${tableOf(model)} WHERE ${sql} LIMIT 1`,
    params,
  );
  return r.rows.length > 0;
}

function callerWhereId<Row>(id: string): Where<Row> {
  return { id } as unknown as Where<Row>;
}

/** A keyset page result — the rows, plus the opaque `nextCursor` to feed the next `after` (absent on the
 *  last page) and `hasMore` (explicit, never silent truncation — mirrors the view tool's envelope). */
export interface CursorPage<Row> {
  readonly items: Row[];
  readonly nextCursor?: string;
  readonly hasMore: boolean;
}

/**
 * Keyset (cursor) read — the one named cursor composition site. Routes through the same `list` →
 * `buildReadWhere` stack as every other read, so a foreign-scope / soft-deleted row can never appear on any
 * page. Over-fetches `limit+1` to derive `hasMore` + `nextCursor` without a count-oracle.
 */
export async function listPage<Row>(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  rowPolicy: RowPolicy<Row>,
  caller: Where<Row>,
  page: Page,
  kms?: Kms,
): Promise<CursorPage<Row>> {
  const limit = clampCount(page.limit) ?? 50; // a keyset read is always bounded (no take-rest)
  const key = cursorKey(page, model);
  // ORDER BY the cursor's own key, ALWAYS. `pageClause` only orders when `after`/`orderBy` is present, so a
  // first call with neither read UNORDERED and still returned a `nextCursor` — page 1 in whatever order the
  // engine chose, page 2 keyset-ordered against it, with rows duplicated and skipped across the seam. A verb
  // that hands back a cursor has already promised the order the cursor walks.
  const rows = await list<Row>(db, model, ctx, rowPolicy, caller, kms, {
    ...page,
    orderBy: key,
    limit: limit + 1,
  });
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1] as Record<string, unknown> | undefined;
  const nextCursor = hasMore && last
    ? encodeCursor(key.map((c) => [c, last[c]] as const))
    : undefined;
  return {
    items,
    hasMore,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

/** `hasMany` — read a parent's children: the same full WHERE-stack, narrowed to `<parent>_id = parentId`. */
export function children<Row>(
  db: Db,
  child: ResourceModel,
  ctx: ReadCtx,
  parentId: string,
  rowPolicy: RowPolicy<Row> = () => all<Row>(),
  kms?: Kms,
): Promise<Row[]> {
  if (!child.parentFk) {
    throw new Error(
      `resource '${child.name}' has no parent (declare \`parent\`)`,
    );
  }
  return list<Row>(
    db,
    child,
    ctx,
    rowPolicy,
    { [child.parentFk]: parentId } as Where<Row>,
    kms,
    { orderBy: ["id"] },
  );
}

/** `temporal` as-of read — the same WHERE-stack, but the temporal conjunct is evaluated at `at`
 *  (a point in time) instead of now(): "what was valid then". */
export async function asOf<Row>(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  at: Date | string,
  rowPolicy: RowPolicy<Row> = () => all<Row>(),
  caller: Where<Row> = all<Row>(),
  kms?: Kms,
): Promise<Row[]> {
  if (!model.features.temporal) {
    throw new Error(`resource '${model.name}' is not temporal`);
  }
  const { sql, params } = buildReadWhere(
    model,
    ctx,
    rowPolicy,
    await equalityWhere(model, caller, kms),
    at,
  );
  const r = await db.query<Record<string, unknown>>(
    `SELECT * FROM ${tableOf(model)} WHERE ${sql}`,
    params,
  );
  if (model.encrypted.length > 0) {
    if (!kms) {
      throw new Error(
        `resource '${model.name}' declares encrypted fields but no KMS is bound`,
      );
    }
    await decryptRows(kms, model.encrypted, r.rows, {
      schema: model.pgSchema,
      table: model.name,
    });
  }
  return r.rows as Row[];
}

/** `searchable` — full-text search over the derived tsvector, and'd with the full read WHERE-stack
 *  (so search obeys scope / softDelete / rowPolicy like any other read). */
export async function search<Row>(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  query: string,
  rowPolicy: RowPolicy<Row> = () => all<Row>(),
  caller: Where<Row> = all<Row>(),
  kms?: Kms,
  // optional pagination (the query-method read path, RFC 10008): the same offset/keyset tail `list` appends,
  // through the same allocator, after the tsvector conjunct — a page can never bypass scope/rowPolicy.
  page?: Page,
): Promise<Row[]> {
  if (model.searchable.length === 0) {
    throw new Error(`resource '${model.name}' is not searchable`);
  }
  const { sql, params } = buildReadWhere(
    model,
    ctx,
    rowPolicy,
    await equalityWhere(model, caller, kms),
    undefined,
  );
  params.push(query); // the tsquery parameter — now the last-allocated $n; the page tail (if any) allocates after it
  const r = await db.query<Record<string, unknown>>(
    `SELECT * FROM ${
      tableOf(model)
    } WHERE ${sql} AND search_vector @@ plainto_tsquery('english', $${params.length})${
      pageClause(page, params, model)
    }`,
    params,
  );
  if (model.encrypted.length > 0) {
    if (!kms) {
      throw new Error(
        `resource '${model.name}' declares encrypted fields but no KMS is bound`,
      );
    }
    await decryptRows(kms, model.encrypted, r.rows, {
      schema: model.pgSchema,
      table: model.name,
    });
  }
  return r.rows as Row[];
}

/**
 * Set-based (by-filter) update — the P2 bulk write (03-api-shape.md §bulk). One `UPDATE … SET … WHERE
 * <read-stack ∧ rowPolicy ∧ caller-filter>` statement can only touch rows the actor may already read. Safe
 * only for a resource with no per-row guarantee — gated by data.ts `setBasedBulkBlocker`; `timestamps` still auto-sets `updated_at`.
 */
export async function updateWhere<Row>(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  patch: Record<string, unknown>,
  rowPolicy: RowPolicy<Row> = () => all<Row>(),
  caller: Where<Row> = all<Row>(),
  kms?: Kms,
): Promise<number> {
  const { sql, params } = buildReadWhere(
    model,
    ctx,
    rowPolicy,
    await equalityWhere(model, caller, kms),
    undefined,
  );
  const sets: string[] = [];
  // the row update's own writable surface: authored columns ∪ the card-allows lifecycle columns. A key
  // outside it is either minted (id, parent_id) or reserved (scope_key) — set-addressable neither.
  const writable = updateWritableOf(model);
  for (const [col, val] of Object.entries(patch)) {
    if (!(col in model.columns) && !writable.allow.has(col)) {
      throw new Error(
        `updateWhere: patch key '${col}' is outside the writable surface of '${model.name}' — reserved and framework-minted columns are not set-addressable; the row update refuses the same key`,
      );
    }
    params.push(val);
    sets.push(`"${col}" = $${params.length}`); // SET params allocate after the WHERE params — $n is positional, textual order is irrelevant
  }
  if (sets.length === 0) return 0; // an empty / no-writable patch must not stamp updated_at on the whole match set
  if (model.features.timestamps) sets.push(`"updated_at" = now()`);
  const r = await db.query<{ id: string }>(
    `UPDATE ${tableOf(model)} SET ${
      sets.join(", ")
    } WHERE ${sql} RETURNING "id"`,
    params,
  );
  return r.rows.length;
}

/**
 * Set-based (by-filter) delete — the P2 bulk write's delete face (03-api-shape.md §bulk). Same
 * `buildReadWhere` stack as `updateWhere`. `softDelete` tombstones (`SET deleted_at = now()`, hidden by the
 * read stack's softDelete conjunct) instead of a hard `DELETE`. Facade-gated identically.
 */
export async function deleteWhere<Row>(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  rowPolicy: RowPolicy<Row> = () => all<Row>(),
  caller: Where<Row> = all<Row>(),
  kms?: Kms,
): Promise<number> {
  const { sql, params } = buildReadWhere(
    model,
    ctx,
    rowPolicy,
    await equalityWhere(model, caller, kms),
    undefined,
  );
  const fileCols = model.files.map((f) => `"${f}"`).join(", ");
  const stmt = model.features.softDelete
    ? `UPDATE ${
      tableOf(model)
    } SET "deleted_at" = now() WHERE ${sql} RETURNING "id"`
    : `DELETE FROM ${tableOf(model)} WHERE ${sql} RETURNING "id"${
      fileCols ? `, ${fileCols}` : ""
    }`;
  const r = await db.query<Record<string, unknown>>(stmt, params);
  // the no-orphan chokepoint remove() owns: a HARD delete dereferences the row's bytes, so their GC is
  // enqueued here — a tombstone keeps the bytes referenced and enqueues nothing.
  if (
    !model.features.softDelete && model.files.length > 0 && r.rows.length > 0
  ) {
    const keys = r.rows.flatMap((row) =>
      model.files.map((f) => row[f]).filter((
        k,
      ): k is string => typeof k === "string" && k.length > 0)
    );
    if (keys.length > 0) {
      await enqueue(db, FILE_GC_TOPIC, { keys }, {
        scope: model.features.scope ? ctx.scope : undefined,
      });
    }
  }
  return r.rows.length;
}

/** Rewrite a caller-WHERE's equality-field conjuncts onto their `<f>_bidx` blind-index columns
 *  (04-features.md §encrypted equality) — the async pre-pass every caller-where site runs before the sync
 *  `buildReadWhere` lowering. A resource with no equality fields returns the caller unchanged. */
export async function equalityWhere<Row>(
  model: ResourceModel,
  caller: Where<Row>,
  kms: Kms | undefined,
): Promise<Where<Row>> {
  if (model.encryptedConfig.equality.length === 0) return caller;
  if (!kms) {
    throw new Error(
      `resource '${model.name}' declares encrypted fields but no KMS is bound`,
    );
  }
  const node = await rewriteEqualityNode(kms, model.encryptedConfig.equality, {
    schema: model.pgSchema,
    table: model.name,
  }, toNode(caller as Where<Record<string, unknown>>));
  return { node } as unknown as Where<Row>;
}
