import type { App, ResourceModel } from "../core/app.ts";
import {
  err,
  type ErrKind,
  errorKind,
  ok,
  type Result,
} from "../core/result.ts";
import {
  all,
  type Condition,
  fields,
  inArray,
  type Where,
} from "../core/where.ts";
import type { Kms } from "../features/encrypt.ts";
import { redactEventPayload } from "../features/redact.ts";
import type { OutboxMsg } from "../runtime/outbox.ts";
import { validationDetail } from "../core/validation.ts";
import { strictify, tamperEvidentOn } from "./schema.ts";
import {
  type Db,
  isExclusionViolation,
  isForeignKeyViolation,
  isTransactor,
  isUniqueViolation,
  type Transactor,
} from "./db.ts";
import { junctionFor, link, relatedIds, unlink } from "../features/relate.ts"; // many-to-many (relates) junction runtime
import {
  children,
  create,
  type CursorPage,
  deleteWhere,
  findForUpdate,
  getOrSeedConfig,
  list,
  listPage,
  lockEdgeKeys,
  move,
  type Page,
  type ReadCtx,
  rectify,
  remove,
  replaceConfig,
  restore,
  rollupEdgeKeysById,
  rollupEdgeKeysOnValues,
  type RowPolicy,
  search,
  treeAncestors,
  treeDepth,
  treeDescendants,
  update,
  updateWhere,
} from "./repo.ts";

/** Mask `msg.aggregateType`'s resource model's `redactionSet` from the event payload; an aggregateType
 *  matching no resource (a sentinel like `"queue"`, or a custom topic) passes through untouched. */
export function redactEmitPayload(app: App, msg: OutboxMsg): unknown {
  const model = app.model.find((m) => m.name === msg.aggregateType);
  return model ? redactEventPayload(model, msg.payload) : msg.payload;
}

/** Parse-at-emit (05-runtime.md §event-surface-lock): strict-parses the payload against the topic's `emits`
 *  schema before it reaches `_outbox`, throwing `validation` (rolls the tx back) on mismatch. Runs on the
 *  author's payload, before `redactEmitPayload` masks it. Every declared topic carries a schema, so an absent
 *  one means the topic was never declared — `event/emit-own-only` refuses that at boot, not here. */
export function validateEmitPayload(app: App, msg: OutboxMsg): void {
  const schema = app.emitSchemas?.[msg.topic];
  if (!schema) return;
  const parsed = strictify(schema).safeParse(msg.payload);
  if (!parsed.success) {
    // the shared redaction-safe per-issue rendering (core/validation.ts) — path + code, never the value
    throw Object.assign(
      new Error(
        validationDetail(
          `parse-at-emit: payload for typed event topic '${msg.topic}' failed its declared emits schema`,
          parsed.error,
        ),
      ),
      { kind: "validation" },
    );
  }
}

/** The `id IN (ids)` caller-where as a typed Condition, routed through the same `inArray` algebra node as
 *  any other read filter — it lowers inside the one WHERE-stack site, so an excluded id is cut, never returned. */
function idIn<Row>(ids: readonly string[]): Condition<Row> {
  const f = fields<{ id: string }>();
  return inArray<{ id: string }, "id">(f.id, ids) as unknown as Condition<Row>;
}

type Row = Record<string, unknown>;

/** The canon read-query shape (03-api-shape.md §2 `Query<R,F>`, runtime form): `where` + offset pagination
 *  (`limit?`/`offset?`, appended after the WHERE-stack, never a bypass) + the temporal `asOf?` instant
 *  (ignored on a non-temporal resource). */
export interface DataQuery {
  readonly where?: Where<Row>;
  readonly limit?: number;
  readonly offset?: number;
  readonly asOf?: Date | string;
}

/** `ctx.data.<r>` — the runtime `ScopedRepo` binding (03-api-shape.md §2): every read runs the same
 *  `list`→`buildReadWhere` site, never bypassed; write read-back skips only the declared rowPolicy for the writer's own id. */
/** The framework bulk-write ceiling (03-api-shape.md §bulk; mirrors `LIST_LIMIT_MAX`) — bounds the atomic
 *  tx's locks/memory; a caller over this chunks the request, or rides the async-task pattern for a large import. */
export const BULK_MAX = 1000;

/** One row's failure in a `continue`-mode bulk write (03-api-shape.md §bulk) — its position + the canon error. */
export interface BulkFailure {
  readonly index: number;
  readonly error: { readonly kind: ErrKind; readonly message: string };
}
/** A bulk-write outcome: the ids that landed + the per-row failures. `atomic` mode's `failed` is always empty (any
 *  failure errs the whole Result); `continue` mode reports each isolated failure while the rest commit. */
export interface BulkOutcome {
  readonly succeeded: readonly string[];
  readonly failed: readonly BulkFailure[];
}
export interface BulkOpts {
  /** `"atomic"` (default) — one tx; any row's failure rolls back the whole batch and the Result is `err`. `"continue"`
   *  — each row its own tx; a failure is isolated + reported in `failed[]`, the rest commit (the import posture).
   *  Inside a CALLER's open tx both modes ride savepoints on it, so `continue`'s survivors commit with that
   *  transaction rather than on their own (03-api-shape.md §bulk). */
  readonly mode?: "atomic" | "continue";
}

/** A per-row failure inside a bulk loop — thrown so `atomic` aborts the wrapping tx and `continue` catches + records. */
class BulkItemError extends Error {
  constructor(readonly kind: ErrKind, message: string) {
    super(message);
  }
}
function bulkErrValue(e: unknown): { kind: ErrKind; message: string } {
  if (e instanceof BulkItemError) return { kind: e.kind, message: e.message };
  if (isUniqueViolation(e)) {
    return { kind: "conflict", message: "unique constraint violated" };
  }
  if (isExclusionViolation(e)) {
    return {
      kind: "conflict",
      message: "validity windows overlap (temporal noOverlap)",
    };
  }
  // a kinded throw keeps its kind (a versioning update with no CAS is `validation`, not `internal` —
  // `internal` is redacted at the wire boundary, so it would reach the caller as an empty message).
  return {
    kind: errorKind(e),
    message: e instanceof Error ? e.message : String(e),
  };
}

/** Runs `fn` inside a savepoint on an ALREADY-OPEN tx: a throw unwinds only `fn`'s writes and leaves the
 *  caller's transaction usable, where a bare failed statement would poison it to `25P02` for good.
 *  Routes through the DRIVER's own savepoint (`db.ts §savepoint`) — postgres.js reports an inner query
 *  error to the enclosing `begin` even after a hand-written `ROLLBACK TO SAVEPOINT` recovers the session,
 *  so the raw-SQL form silently loses the whole transaction on the one engine that ships. */
async function inSavepoint<T>(
  tx: Db,
  fn: (sp: Db) => Promise<T>,
): Promise<T> {
  if (tx.savepoint === undefined) {
    throw Object.assign(
      new Error(
        `this transaction handle exposes no savepoint, so a batch on it cannot be bounded: one failed row ` +
          `would abort the caller's whole transaction. Batch on a root handle, or give the driver adapter ` +
          `a 'savepoint' built from its own nesting API.`,
      ),
      { kind: "internal" as const },
    );
  }
  // `fn` MUST run on the handle the driver hands back: postgres.js scopes a savepoint to the connection
  // object it passes, so writes issued on the enclosing `tx` are outside it and abort the whole transaction.
  return await tx.savepoint((sp) => fn(sp));
}

/** Each row runs the full single-row write path (`perItem`) — a bulk is N framework writes sharing one
 *  boundary, never a set-based `UPDATE…WHERE` that would skip per-row autos + rowPolicy.
 *
 *  `edgeKeys` names every rollup/cascade edge the batch will touch, locked sorted before the first row so
 *  two batches naming the same parents in opposite caller order are not an AB-BA pair on the advisories.
 *  Which boundary the batch gets is decided by the handle, not by a flag: a ROOT handle opens the tx here;
 *  a handle with no `.transaction` IS a caller's open tx (an op handler, a relay consumer, a task run), so
 *  the batch joins it under savepoints instead of opening a tx Postgres would refuse to nest. */
async function runBulk(
  count: number,
  db: Db,
  opts: BulkOpts | undefined,
  edgeKeys: (tx: Db) => Promise<readonly string[]>,
  perItem: (i: number, tx: Db) => Promise<string>,
): Promise<Result<BulkOutcome>> {
  if (count === 0) return ok({ succeeded: [], failed: [] });
  if (count > BULK_MAX) {
    return err(
      "validation",
      `bulk exceeds the ${BULK_MAX}-row limit (got ${count}) — chunk the request into smaller batches`,
    );
  }
  if (!isTransactor(db)) {
    return runBulkInCallerTx(count, db, opts, edgeKeys, perItem);
  }
  if ((opts?.mode ?? "atomic") === "atomic") {
    try {
      const succeeded = await db.transaction(async (tx) => {
        await lockEdgeKeys(tx, await edgeKeys(tx));
        const ids: string[] = [];
        for (let i = 0; i < count; i++) ids.push(await perItem(i, tx));
        return ids;
      });
      return ok({ succeeded, failed: [] });
    } catch (e) {
      const ev = bulkErrValue(e); // the whole batch rolled back — surface the first failure as the Result err
      return err(ev.kind, ev.message);
    }
  }
  const succeeded: string[] = [];
  const failed: BulkFailure[] = [];
  for (let i = 0; i < count; i++) {
    try {
      succeeded.push(await db.transaction((tx) => perItem(i, tx)));
    } catch (e) {
      failed.push({ index: i, error: bulkErrValue(e) });
    }
  }
  return ok({ succeeded, failed });
}

/**
 * The batch on a caller's OPEN tx (03-api-shape.md §bulk). Both modes take the whole batch's edge keys
 * sorted first: unlike the own-tx `continue`, every row here shares ONE transaction, so that transaction
 * really does hold N edges at once and has the ordering hazard the prelude exists for.
 *
 * `atomic` bounds the batch in one savepoint — a failure unwinds the batch and the caller's tx lives on to
 * see the `err`. `continue` gives each row its own savepoint, so a bad row is isolated into `failed[]`; what
 * it cannot give is an independent COMMIT — the survivors commit with the caller's transaction or not at all.
 */
async function runBulkInCallerTx(
  count: number,
  tx: Db,
  opts: BulkOpts | undefined,
  edgeKeys: (tx: Db) => Promise<readonly string[]>,
  perItem: (i: number, tx: Db) => Promise<string>,
): Promise<Result<BulkOutcome>> {
  try {
    await lockEdgeKeys(tx, await edgeKeys(tx));
  } catch (e) {
    const ev = bulkErrValue(e); // an out-of-order edge refusal is `conflict`, not a redacted internal
    return err(ev.kind, ev.message);
  }
  if ((opts?.mode ?? "atomic") === "atomic") {
    try {
      const succeeded = await inSavepoint(tx, async (sp) => {
        const ids: string[] = [];
        for (let i = 0; i < count; i++) ids.push(await perItem(i, sp));
        return ids;
      });
      return ok({ succeeded, failed: [] });
    } catch (e) {
      const ev = bulkErrValue(e);
      return err(ev.kind, ev.message);
    }
  }
  const succeeded: string[] = [];
  const failed: BulkFailure[] = [];
  for (let i = 0; i < count; i++) {
    try {
      succeeded.push(await inSavepoint(tx, (sp) => perItem(i, sp)));
    } catch (e) {
      failed.push({ index: i, error: bulkErrValue(e) });
    }
  }
  return ok({ succeeded, failed });
}

/** A set-based (by-filter) bulk-write outcome (03-api-shape.md §bulk P2) — the affected row count only; one
 *  `UPDATE…WHERE`/`DELETE` is atomic by nature, so there are no per-row ids/failures, unlike `BulkOutcome`. */
export interface BulkWhereOutcome {
  readonly affected: number;
}

/** The set-based-bulk safety gate (03-api-shape.md §bulk P2): a set-based `UPDATE…WHERE`/`DELETE` bypasses
 *  the per-row write weave, so it only allows a resource with no declared per-row guarantee. */
function setBasedBulkBlocker(
  m: ResourceModel,
  patchKeys: readonly string[],
): string | null {
  const f = m.features;
  if (f.versioning) {
    return "versioning (a set-based statement carries no per-row optimistic CAS)";
  }
  if (tamperEvidentOn(f)) {
    return "tamperEvident (the per-row hash chain would not be re-stamped)";
  }
  if (m.encrypted.length > 0) {
    return "encrypted (a set-based SET writes the value in plaintext, not the at-rest envelope)";
  }
  if (f.audit) return "audit (no per-row before/after _audit row is written)";
  if (m.rollupOwnCols.length > 0) {
    return "rollups (its framework-maintained aggregate columns)";
  }
  if (m.rollupTargets.length > 0) {
    return "a parent rollup this resource feeds (the aggregate would drift)";
  }
  if (m.vector) return "vector (the semantic re-embedding job is not enqueued)";
  if (m.readModelSinks.length > 0) {
    return "a read-model projection this resource feeds (it would drift)";
  }
  if (m.passwords.length > 0) {
    return "password (a set-based SET stores the value unhashed)";
  }
  const imm = f.immutable;
  if (imm === true) return "immutable (rows are write-once)";
  const frozen = imm && typeof imm === "object"
    ? (imm.fields ?? []).filter((c) => patchKeys.includes(c))
    : [];
  if (frozen.length > 0) {
    return `the set-once field(s) ${
      frozen.join(", ")
    } (immutable, cannot be re-set in bulk)`;
  }
  if (patchKeys.includes("status") && Object.keys(m.transitions).length > 0) {
    return "transitions (a status change must ride the FSM path, not a raw SET)";
  }
  return null;
}

/**
 * The `ctx.data` verbs that hand a handler ANOTHER row's stored contents — the read-door set the row-visibility
 * boot guard covers (`core/model-guards.ts §policyReadLeak`). Classified here because this facade is where a
 * new verb lands: `count`/`exists`/`depth` return an aggregate and `related` returns ids, so neither carries a
 * row; every write verb reads back only the row it addressed. Its complement is PARTITIONED against the live
 * facade keys (`policy-door-parity.test.ts`), so a new verb is classified or RED.
 */
export const DATA_ROW_READ_VERBS = [
  "ancestors",
  "byIds",
  "children",
  "descendants",
  "find",
  "findForUpdate",
  "findOrFail",
  "list",
  "listPage",
  "search",
] as const;

/**
 * The `ctx.data` verbs that mutate a PRE-EXISTING row — the write-door set `policy/write-protected` covers
 * (`core/model-guards.ts §policyWriteLeak`), the twin of `DATA_ROW_READ_VERBS`. Membership is an EFFECT, not a
 * category: each one narrows by the resource's rowPolicy (`link`/`unlink` gate BOTH endpoints' visibility
 * first), so demanding a policy of a resource an exposed op writes really does block the cross-owner patch.
 * `create`/`createMany` mint a row — there is no pre-existing row for a WHERE to narrow, so a demand there
 * would read as satisfied and enforce nothing. Aggregates and the reads are the rest of the partition.
 */
export const DATA_ROW_WRITE_VERBS = [
  "delete",
  "deleteMany",
  "deleteWhere",
  "link",
  "move",
  "rectify",
  "restore",
  "unlink",
  "update",
  "updateMany",
  "updateWhere",
] as const;

/** The `ctx.config` verbs onto a `singleton` resource's row — the same two doors under a second facade name.
 *  `getOrSeedConfig` returns the stored row and `replace` rewrites it, and BOTH run the rowPolicy conjunct
 *  (`repo-config.ts §readSingletonRow`, and `replace` writes through `update`), so a singleton's op door
 *  obliges exactly as `http.find`/`http.update` on the same resource already does. */
export const CONFIG_ROW_READ_VERBS = ["getOrSeedConfig"] as const;
export const CONFIG_ROW_WRITE_VERBS = ["replace"] as const;

export interface ResourceData {
  /** `create(values)` → `ok(createdRow)` (03-api-shape.md §2 `create(Insertable)→Result<R>`); a unique
   *  clash surfaces `err("conflict")` (03-api-shape.md §6), never a raw throw across this facade. */
  create(values: Row): Promise<Result<Row>>;
  /** `find(id)` → `ok(row | null)` — a soft-deleted / out-of-scope / expired / rowPolicy-excluded row is
   *  invisible to the stack, so it reads as `ok(null)`. */
  find(id: string): Promise<Result<Row | null>>;
  /** `findOrFail(id)` → `ok(row)` or `err("notFound", …)` — "not found is an error" (05-runtime.md). */
  findOrFail(id: string): Promise<Result<Row>>;
  /** `findForUpdate(id)` → `ok(row)` — the same read as `findOrFail` plus `FOR UPDATE`: inside the op's
   *  write tx the row is held to commit, so the `version` it hands back is still current when the CAS
   *  update that follows runs. Not stack-visible → `err("notFound")` (a row you cannot see, you cannot lock). */
  findForUpdate(id: string): Promise<Result<Row>>;
  /** `list(q?)` → `ok(rows)` over the canon Query (`where`/`limit`/`offset`/`asOf` — 03-api-shape.md §2). */
  list(q?: DataQuery): Promise<Result<Row[]>>;
  /** `count(q?)` → `ok(n)` stack-visible rows matching `q.where` (`limit`/`offset` ignored — a count is
   *  over the whole matching set); runs through `list` so it respects the stack. */
  count(q?: DataQuery): Promise<Result<number>>;
  /** `exists(id)` → `ok(bool)` whether a stack-visible row with that id exists (a soft-deleted one does not). */
  exists(id: string): Promise<Result<boolean>>;
  /** `update(id, patch, expectedVersion?)` → `ok(updatedRow)`; a versioning CAS miss → `err("stale")`
   *  (retryable, distinct from conflict); a patch touching a field-level `immutable` frozen field →
   *  `err("conflict")` (no write, no audit — 04-features.md §immutable); no stack-visible row → `err("notFound")`.
   *  On a `versioning` resource `expectedVersion` is MANDATORY (the typed face requires it, the repo throws
   *  `validation` without it) and a vanished row reports `stale`, not `notFound` — one CAS statement cannot
   *  tell a deleted row from a moved one, exactly as `delete`'s pre-check reports it. */
  update(
    id: string,
    patch: Row,
    expectedVersion?: number,
  ): Promise<Result<Row>>;
  /** `delete(id, expectedVersion?)` → `ok(void)` (03-api-shape.md §2 — soft when `softDelete` is declared,
   *  hard otherwise); no stack-visible row to delete → `err("notFound")`. On a `versioning` resource
   *  `expectedVersion` is MANDATORY on exactly the terms `update`'s is (the typed face requires it, the repo
   *  throws `validation` without it) and a CAS miss → `err("stale")` — never a delete of a version nobody read. */
  delete(id: string, expectedVersion?: number): Promise<Result<void>>;
  /** `createMany(rows, opts?)` → `ok({succeeded, failed})` — bulk insert by-row (03-api-shape.md §bulk): each row
   *  through the full create path (autos + rowPolicy preserved), bounded at `BULK_MAX`. `atomic` (default) errs the
   *  whole batch on any failure; `continue` isolates + reports per-row failures. */
  createMany(
    rows: readonly Row[],
    opts?: BulkOpts,
  ): Promise<Result<BulkOutcome>>;
  /** `updateMany([{id,patch,expectedVersion?}], opts?)` → `ok({succeeded, failed})` — bulk update by-ids, each
   *  through the full update path (version CAS + immutable-field guard + rowPolicy, per row). Modes as `createMany`. */
  updateMany(
    items: readonly {
      readonly id: string;
      readonly patch: Row;
      readonly expectedVersion?: number;
    }[],
    opts?: BulkOpts,
  ): Promise<Result<BulkOutcome>>;
  /** `deleteMany([{id, expectedVersion?}], opts?)` → `ok({succeeded, failed})` — bulk delete by-ids (soft/hard
   *  per `softDelete`), each through the full remove path (cascade + rollup + version CAS + rowPolicy, per row).
   *  Modes as `createMany`. One item shape, not a bare id list, because a versioning row states its own version
   *  here exactly as it does in `updateMany` — one precondition cannot address N rows. */
  deleteMany(
    items: readonly {
      readonly id: string;
      readonly expectedVersion?: number;
    }[],
    opts?: BulkOpts,
  ): Promise<Result<BulkOutcome>>;
  /** `updateWhere(filter, patch)` → `ok({affected})` — set-based bulk update (03-api-shape.md §bulk P2):
   *  one `UPDATE…SET…WHERE` over every row the actor may read, gated to a set-based-safe resource (no
   *  per-row guarantee); a per-row feature returns `err` naming it — use `updateMany` (by-IDs) instead. */
  updateWhere(
    filter: Where<Row>,
    patch: Row,
  ): Promise<Result<BulkWhereOutcome>>;
  /** `deleteWhere(filter)` → `ok({affected})` — set-based bulk delete (soft `deleted_at` when `softDelete`,
   *  else a hard `DELETE`), same read-stack + safety gate as `updateWhere`. */
  deleteWhere(filter: Where<Row>): Promise<Result<BulkWhereOutcome>>;
  /** `restore(id)` → `ok(restoredRow)`; nothing restorable → `err("notFound")`. Exists iff `softDelete`
   *  on the typed face (mechanism 4); the runtime binding stays uniform. */
  restore(id: string): Promise<Result<Row>>;
  /** `rectify(id, corrections)` → `ok(correctingRow)` — GDPR Art. 16 on an append-only resource
   *  (04-features.md §immutable `rectifiable`): the original row stays, the correction is a new row
   *  stamped `superseded_by`; already superseded → `err("conflict")` (rectify the chain head). Exists
   *  iff `immutable:{rectifiable:true}` on the typed face. */
  rectify(id: string, corrections: Partial<Row>): Promise<Result<Row>>;
  // ── documented extensions beyond the canon BaseRepo (typed as `RepoExtensions`, faces-ctx.ts) ──
  /** `listPage({after?, limit?, orderBy?}, where?)` — keyset (cursor) pagination over the same WHERE-stack
   *  as `list` (05-runtime.md §ctx): page rows + an opaque `nextCursor` (absent on the last page) + `hasMore`;
   *  a foreign-scope / soft-deleted / rowPolicy-excluded row never appears on any page. */
  listPage(page: Page, where?: Where<Row>): Promise<CursorPage<Row>>;
  /** `byIds(ids)` → `ok(rows)` — batches the per-row find loop into one `id IN (ids)` read through the same
   *  WHERE-stack as `list`/`find`; an excluded id is absent (never a leak). Empty `ids` short-circuits to
   *  `ok([])` with no query; rows return in DB order — order/dedup is the caller's concern. */
  byIds(ids: string[]): Promise<Result<Row[]>>;
  /** `children(parentId)` → `ok(rows)` — the owned-child read (`parent:` relation), stack-injected. */
  children(parentId: string): Promise<Result<Row[]>>;
  // ── many-to-many (relates) junction runtime (02-dsl.md §relates; features/relate.ts) ──
  /** `link(relName, id, otherId)` → `ok(void)` — idempotent link over the derived junction (a concurrent
   *  duplicate is a no-op in `features/relate.ts`). Both endpoints must be stack-visible in the caller's
   *  scope (no cross-scope link) else `err("notFound")`; an unknown relation → `err("validation")`. */
  link(relName: string, id: string, otherId: string): Promise<Result<void>>;
  /** `unlink(relName, id, otherId)` → `ok(void)` — remove the pair (a missing pair is a no-op). */
  unlink(relName: string, id: string, otherId: string): Promise<Result<void>>;
  /** `related(relName, id)` → `ok(ids)` — the opposite side's ids, filtered through the target resource's
   *  read-stack (scope ∧ softDelete ∧ rowPolicy), so an excluded related row never leaks; an anchor invisible
   *  to the caller reads as `ok([])`. */
  related(relName: string, id: string): Promise<Result<string[]>>;
  // ── feature methods (typed-face-gated: search ⟺ searchable, tree set ⟺ tree — mechanism 4) ──
  /** `search(query)` → `ok(rows)` — full-text over the derived tsvector, and'd with the full WHERE-stack. */
  search(query: string): Promise<Result<Row[]>>;
  /** `move(id, parentId)` → `ok(movedRow)` — the no-cycle-guarded re-parent (04-features.md §tree); a
   *  cycle → `err("conflict")`. On a `treeClosure` resource it also rewrites the subtree's closure rows. */
  move(id: string, parentId: string | null): Promise<Result<Row>>;
  /** `ancestors(id)` → `ok(rows)` — root-first chain of parents above the node (excluding it). */
  ancestors(id: string): Promise<Result<Row[]>>;
  /** `descendants(id)` → `ok(rows)` — every node in the subtree below `id` (excluding it). */
  descendants(id: string): Promise<Result<Row[]>>;
  /** `depth(id)` → `ok(n)` — edge count from the node up to its root (a root = 0). */
  depth(id: string): Promise<Result<number>>;
}

/** The `ctx.data` facade — binds every resource's repo functions to (model, db, ctx), so a handler writes
 *  `ctx.data.order.create(...)` instead of threading model/db/ctx by hand. `onlyModule` scopes it to one
 *  module's resources (05-runtime.md §ctx: cross-module data is never `ctx.data`, always `ctx.modules`);
 *  absent, every resource binds. */
export function dataOf(
  app: App,
  db: Db,
  ctx: ReadCtx,
  kms?: Kms,
  onlyModule?: string,
): Record<string, ResourceData> {
  const out: Record<string, ResourceData> = {};
  for (const m of app.model) {
    if (onlyModule !== undefined && m.module !== onlyModule) continue; // ctx.data is this module only
    // every read on this facade applies the resource's declared rowPolicy (no per-call override door);
    // absent one, the vacuous all() — the scope/softDelete/expiry/temporal conjuncts still ride the stack.
    const declared: RowPolicy<Row> = (m.rowPolicy as RowPolicy<Row> | null) ??
      (() => all<Row>());
    // write read-back (create/update/restore/move → the settled row) re-reads via the same site with an
    // all() self-read policy, skipping only the declared rowPolicy for the just-written id (see interface doc).
    const readBack = async (id: string, verb: string): Promise<Result<Row>> => {
      const row = (await list<Row>(
        db,
        m,
        ctx,
        () => all<Row>(),
        { id } as Where<Row>,
        kms,
      ))[0];
      return row
        ? ok(row)
        : err("notFound", `${m.name} '${id}' not visible after ${verb}`);
    };
    out[m.name] = {
      // canon create (03-api-shape.md §2): writes then hands back the settled row (autos included); a unique
      // clash maps to the canon conflict Result (§6) — the message stays generic (PG detail can echo row values).
      create: async (values) => {
        try {
          const id = await create(db, m, ctx, values, kms);
          return await readBack(id, "create");
        } catch (e) {
          if (isUniqueViolation(e)) {
            return err("conflict", `${m.name}: unique constraint violated`);
          }
          if (isExclusionViolation(e)) {
            return err(
              "conflict",
              `${m.name}: validity windows overlap — a same-key row already holds an overlapping window (temporal noOverlap)`,
            );
          }
          throw e;
        }
      },
      // all reads go through the one read site (`list` → `buildReadWhere`); `find`-by-id is `list(..,{id})`,
      // so scope/softDelete/expiry/temporal/rowPolicy all apply and the WHERE-stack is never bypassed.
      find: async (id) =>
        ok(
          (await list<Row>(db, m, ctx, declared, { id } as Where<Row>, kms))[
            0
          ] ?? null,
        ),
      findOrFail: async (id) => {
        const row =
          (await list<Row>(db, m, ctx, declared, { id } as Where<Row>, kms))[0];
        return row ? ok(row) : err("notFound", `${m.name} '${id}' not found`);
      },
      // the locking read: same stack + rowPolicy as findOrFail, `FOR UPDATE` held to the op tx's commit,
      // so the version it returns cannot go stale before the CAS update the caller writes next.
      findForUpdate: async (id) => {
        const row = await findForUpdate<Row>(db, m, ctx, declared, id, kms);
        return row ? ok(row) : err("notFound", `${m.name} '${id}' not found`);
      },
      // canon Query (where/limit/offset/asOf): limit/offset lower to SQL after the stack (repo-read
      // pageClause); asOf threads to buildReadWhere's temporal conjunct (ignored on non-temporal).
      list: async (q) =>
        ok(
          await list<Row>(
            db,
            m,
            ctx,
            declared,
            q?.where ?? all<Row>(),
            kms,
            pageOf(q),
            q?.asOf,
          ),
        ),
      // keyset (cursor) pagination over the same read site (listPage → list → buildReadWhere) — never a bypass.
      listPage: (page, caller = all<Row>()) =>
        listPage<Row>(db, m, ctx, declared, caller, page, kms),
      // byIds: one read of `id IN (ids)` through the same stack as find/list — never a raw `WHERE id = ANY()`
      // door. Empty ids short-circuit (inArray([]) lowers to false, but skip the round-trip entirely).
      byIds: async (ids) => {
        if (ids.length === 0) {
          return ok([]);
        }
        return ok(await list<Row>(db, m, ctx, declared, idIn<Row>(ids), kms));
      },
      count: async (q) =>
        ok(
          (await list<Row>(
            db,
            m,
            ctx,
            declared,
            q?.where ?? all<Row>(),
            kms,
            undefined,
            q?.asOf,
          )).length,
        ),
      exists: async (id) =>
        ok(
          (await list<Row>(db, m, ctx, declared, { id } as Where<Row>, kms))
            .length > 0,
        ),
      // canon update (03-api-shape.md §2): the raw CAS shape maps to the canon err kinds — stale (version
      // miss, retryable), frozen (immutable field → conflict), not-updated (→ notFound) — then reads back settled.
      update: async (id, patch, expectedVersion) => {
        const r = await update(db, m, ctx, id, patch, expectedVersion, kms);
        if (r.stale) {
          return err(
            "stale",
            `${m.name} '${id}': version check failed`,
          );
        }
        if (r.frozen) {
          return err(
            "conflict",
            `${m.name} '${id}': patch touches immutable field(s)`,
          );
        }
        if (!r.updated) return err("notFound", `${m.name} '${id}' not found`);
        return readBack(id, "update");
      },
      // canon delete (soft when softDelete is declared, hard otherwise — the raw remove routes both). A CAS
      // miss is `stale` (retryable), never `notFound`: the row is there, the version under it moved.
      delete: async (id, expectedVersion) => {
        const r = await remove(db, m, ctx, id, undefined, expectedVersion);
        if (r.stale) {
          return err("stale", `${m.name} '${id}': version check failed`);
        }
        return r.deleted
          ? ok(undefined)
          : err("notFound", `${m.name} '${id}' not found`);
      },
      // bulk by-ids (03-api-shape.md §bulk): each row runs the same single-row write path through `runBulk`,
      // preserving every per-row auto + rowPolicy; a bad outcome throws `BulkItemError` so atomic aborts / continue records it.
      createMany: (rows, opts) =>
        runBulk(
          rows.length,
          db,
          opts,
          // the create-side keys are pure — the pending values name the parents, no read needed.
          () =>
            Promise.resolve(
              rollupEdgeKeysOnValues(
                m,
                rows as ReadonlyArray<Record<string, unknown>>,
              ),
            ),
          (i, tx) =>
            create(tx, m, ctx, rows[i] as Record<string, unknown>, kms),
        ),
      updateMany: (items, opts) =>
        runBulk(
          items.length,
          db,
          opts,
          (tx) =>
            rollupEdgeKeysById(
              tx,
              m,
              items.map((it) => it.id),
              false, // update touches no cascade sweep — the same flag its own `update.lockRollupEdges` passes
            ),
          async (i, tx) => {
            const it = items[i]!;
            const r = await update(
              tx,
              m,
              ctx,
              it.id,
              it.patch as Record<string, unknown>,
              it.expectedVersion,
              kms,
            );
            if (r.stale) {
              throw new BulkItemError(
                "stale",
                `${m.name} '${it.id}': version check failed`,
              );
            }
            if (r.frozen) {
              throw new BulkItemError(
                "conflict",
                `${m.name} '${it.id}': patch touches immutable field(s)`,
              );
            }
            if (!r.updated) {
              throw new BulkItemError(
                "notFound",
                `${m.name} '${it.id}' not found`,
              );
            }
            return it.id;
          },
        ),
      deleteMany: (items, opts) =>
        runBulk(
          items.length,
          db,
          opts,
          (tx) =>
            rollupEdgeKeysById(
              tx,
              m,
              items.map((it) => it.id),
              true, // a delete sweeps its own cascade edge — the same flag `remove.lockRollupEdges` passes
            ),
          async (i, tx) => {
            const it = items[i]!;
            const r = await remove(
              tx,
              m,
              ctx,
              it.id,
              undefined,
              it.expectedVersion,
            );
            if (r.stale) {
              throw new BulkItemError(
                "stale",
                `${m.name} '${it.id}': version check failed`,
              );
            }
            if (!r.deleted) {
              throw new BulkItemError(
                "notFound",
                `${m.name} '${it.id}' not found`,
              );
            }
            return it.id;
          },
        ),
      // set-based by-filter (03-api-shape.md §bulk P2): one `UPDATE…WHERE`/`DELETE` bypasses the per-row weave,
      // so it's gated (`setBasedBulkBlocker`) to a set-based-safe resource and runs through the same read-stack.
      updateWhere: async (filter, patch) => {
        const blocked = setBasedBulkBlocker(
          m,
          Object.keys(patch as Record<string, unknown>),
        );
        if (blocked) {
          return err(
            "validation",
            `${m.name}: set-based updateWhere is unsafe — the resource declares ${blocked}; use updateMany (by-IDs), which preserves the per-row guarantee`,
          );
        }
        return ok({
          affected: await updateWhere<Row>(
            db,
            m,
            ctx,
            patch as Record<string, unknown>,
            declared,
            filter,
            kms,
          ),
        });
      },
      deleteWhere: async (filter) => {
        const blocked = setBasedBulkBlocker(m, []);
        if (blocked) {
          return err(
            "validation",
            `${m.name}: set-based deleteWhere is unsafe — the resource declares ${blocked}; use deleteMany (by-IDs)`,
          );
        }
        return ok({
          affected: await deleteWhere<Row>(db, m, ctx, declared, filter, kms),
        });
      },
      restore: async (id) => {
        const r = await restore(db, m, ctx, id);
        return r.restored
          ? readBack(id, "restore")
          : err("notFound", `${m.name} '${id}' not found or not deleted`);
      },
      // GDPR Art. 16 rectify (04-features.md §immutable rectifiable): atomic — the correction insert + the
      // superseded stamp + the rollup re-balance ride one tx (opened here when the caller is outside the op tx).
      rectify: async (id, corrections) => {
        const run = (tx: Db) =>
          rectify(tx, m, ctx, id, corrections as Record<string, unknown>, kms);
        const r = typeof (db as Db & Transactor).transaction === "function"
          ? await (db as Db & Transactor).transaction(run)
          : await run(db);
        if (r.unknownField !== undefined) {
          return err(
            "validation",
            `${m.name}.rectify: '${r.unknownField}' is not a schema field`,
          );
        }
        if (r.conflict) {
          return err(
            "conflict",
            `${m.name} '${id}' is already superseded — rectify the chain head`,
          );
        }
        if (!r.rectified || r.supersededBy === undefined) {
          return err("notFound", `${m.name} '${id}' not found`);
        }
        return readBack(r.supersededBy, "rectify");
      },
      // children + search are ctx.data reads too — they apply the declared rowPolicy like every read above
      // (the sibling tree reads too), never all()/TRUE.
      children: async (parentId) =>
        ok(await children<Row>(db, m, ctx, parentId, declared, kms)),
      search: async (query) =>
        ok(await search<Row>(db, m, ctx, query, declared, all<Row>(), kms)), // + kms so an encrypted field decrypts
      // tree autos (04-features.md §tree): move is the no-cycle-guarded re-parent (+closure rewrite) → a
      // cycle is `conflict`; ancestors/descendants/depth are stack-injected reads on every binding.
      move: async (id, parentId) => {
        const r = await move(db, m, ctx, id, parentId);
        if (r.cycle) {
          return err(
            "conflict",
            `${m.name} '${id}': move would create a cycle`,
          );
        }
        if (!r.updated) {
          return err("notFound", `${m.name} '${id}' not found`);
        }
        return readBack(id, "move");
      },
      // tree reads run through the same read WHERE-stack as list/find (live ctx scope + declared rowPolicy),
      // so a soft-deleted / out-of-scope / rowPolicy-excluded ancestor or descendant is never leaked.
      ancestors: async (id) =>
        ok(
          await treeAncestors<Row>(
            db,
            m,
            id,
            ctx,
            (m.rowPolicy as RowPolicy<Row> | null) ?? undefined,
            kms,
          ),
        ),
      descendants: async (id) =>
        ok(
          await treeDescendants<Row>(
            db,
            m,
            id,
            ctx,
            (m.rowPolicy as RowPolicy<Row> | null) ?? undefined,
            kms,
          ),
        ),
      // depth derives from ancestors, so it carries the same read WHERE-stack: depth counts only
      // the visible ancestors and can never disagree with `ancestors(id)`.
      depth: async (id) =>
        ok(
          await treeDepth<Row>(
            db,
            m,
            id,
            ctx,
            (m.rowPolicy as RowPolicy<Row> | null) ?? undefined,
          ),
        ),
      // many-to-many (relates, features/relate.ts): junctionFor resolves the junction; unknown relation errs loud.
      // link/unlink require both endpoints stack-visible (no cross-scope link); related filters by the target's read-stack.
      link: async (relName, id, otherId) => {
        const rel = m.relates[relName];
        if (!rel) {
          return err(
            "validation",
            `${m.name}.link: no relation '${relName}' (declare relates:{ ${relName}: manyToMany(...) })`,
          );
        }
        if (
          (await list<Row>(db, m, ctx, declared, { id } as Where<Row>, kms))
            .length === 0
        ) {
          return err("notFound", `${m.name} '${id}' not found`);
        }
        const target = app.model.find((x) => x.name === rel.to)!; // same-module by boot guard (relates/same-module)
        const tgtPolicy: RowPolicy<Row> =
          (target.rowPolicy as RowPolicy<Row> | null) ?? (() => all<Row>());
        if (
          (await list<Row>(
            db,
            target,
            ctx,
            tgtPolicy,
            { id: otherId } as Where<Row>,
            kms,
          )).length === 0
        ) return err("notFound", `${rel.to} '${otherId}' not found`);
        try {
          await link(
            db,
            junctionFor(app, m.name, rel.to),
            m.name,
            id,
            rel.to,
            otherId,
          );
        } catch (e) {
          // TOCTOU: an endpoint hard-deleted between the visibility check and the cascade-FK INSERT throws a raw
          // 23503 — map it to notFound (the target vanished) so `link` keeps its Result contract (mirrors create).
          if (isForeignKeyViolation(e)) {
            return err(
              "notFound",
              `${rel.to} '${otherId}' not found`,
            );
          }
          throw e;
        }
        return ok(undefined);
      },
      unlink: async (relName, id, otherId) => {
        const rel = m.relates[relName];
        if (!rel) {
          return err(
            "validation",
            `${m.name}.unlink: no relation '${relName}'`,
          );
        }
        // mirrors link: both endpoints must be stack-visible — the junction carries no scope_key, so this
        // facade is the ONLY enforcement site against severing a cross-scope association the actor can't see.
        if (
          (await list<Row>(db, m, ctx, declared, { id } as Where<Row>, kms))
            .length === 0
        ) return err("notFound", `${m.name} '${id}' not found`);
        const target = app.model.find((x) => x.name === rel.to)!;
        const tgtPolicy: RowPolicy<Row> =
          (target.rowPolicy as RowPolicy<Row> | null) ?? (() => all<Row>());
        if (
          (await list<Row>(
            db,
            target,
            ctx,
            tgtPolicy,
            { id: otherId } as Where<Row>,
            kms,
          )).length === 0
        ) return err("notFound", `${rel.to} '${otherId}' not found`);
        await unlink(
          db,
          junctionFor(app, m.name, rel.to),
          m.name,
          id,
          rel.to,
          otherId,
        );
        return ok(undefined);
      },
      related: async (relName, id) => {
        const rel = m.relates[relName];
        if (!rel) {
          return err(
            "validation",
            `${m.name}.related: no relation '${relName}'`,
          );
        }
        if (
          (await list<Row>(db, m, ctx, declared, { id } as Where<Row>, kms))
            .length === 0
        ) return ok([]); // anchor invisible ⇒ no visible relations
        const raw = await relatedIds(
          db,
          junctionFor(app, m.name, rel.to),
          m.name,
          id,
        );
        if (raw.length === 0) return ok([]);
        const target = app.model.find((x) => x.name === rel.to)!;
        const tgtPolicy: RowPolicy<Row> =
          (target.rowPolicy as RowPolicy<Row> | null) ?? (() => all<Row>());
        const visible = await list<Row>(
          db,
          target,
          ctx,
          tgtPolicy,
          idIn<Row>(raw),
          kms,
        ); // scope/softDelete/rowPolicy filter
        return ok(visible.map((r) => String((r as Row).id)));
      },
    };
  }
  return out;
}

/** Lower a `DataQuery`'s offset half to the raw read's `Page` — only when the caller actually paginates
 *  (a bare `where`/`asOf` query appends no LIMIT/OFFSET clause at all). */
function pageOf(q?: DataQuery): Page | undefined {
  if (!q || (q.limit === undefined && q.offset === undefined)) return undefined;
  return {
    ...(q.limit !== undefined ? { limit: q.limit } : {}),
    ...(q.offset !== undefined ? { offset: q.offset } : {}),
  };
}

/** `ctx.config.<r>` for a `singleton` resource (04-features.md §singleton-marker). `getOrSeedConfig()` is the
 *  sanctioned read (seeds the row from the schema's `.default(…)` when unseeded, so a first read never returns
 *  nothing — `.get()` is the forbidden bypass); `replace(patch)` full-replace upserts as `schema-defaults ⊕
 *  patch`, so an omitted field resets to default (not a partial patch — that's `ctx.data.update`). */
export interface ConfigData {
  getOrSeedConfig(): Promise<Row>;
  /** `expectedVersion` is REQUIRED at runtime on a `versioning` singleton — a full replace overwrites every
   *  column, so an omitted token is the widest blind write there is (`ctx.config` is an untyped
   *  `Record<string, ConfigData>`, so the requirement is enforced by a kinded throw, not by the type). */
  replace(patch: Row, expectedVersion?: number): Promise<Row>;
}

/** `ctx.config` — binds every `singleton` resource's read-or-seed / full-replace surface, mirroring
 *  `dataOf`. Only `singleton`-marked resources appear; `onlyModule` scopes it like `dataOf`. */
export function configOf(
  app: App,
  db: Db,
  ctx: ReadCtx,
  kms?: Kms,
  onlyModule?: string,
): Record<string, ConfigData> {
  const out: Record<string, ConfigData> = {};
  for (const m of app.model) {
    if (!m.features.singleton) continue; // ctx.config.<r> exists iff the resource declares `singleton`
    if (onlyModule !== undefined && m.module !== onlyModule) continue;
    out[m.name] = {
      getOrSeedConfig: () => getOrSeedConfig(db, m, ctx, kms),
      replace: (patch, expectedVersion) =>
        replaceConfig(db, m, ctx, patch, kms, expectedVersion),
    };
  }
  return out;
}

/** `ctx.modules` — the sole sanctioned cross-module synchronous channel (05-runtime.md §ctx): module A
 *  reaches sibling B only as `ctx.modules.B.<op>`, only for an op B `exposes` that A declared as a `dep`
 *  (an undeclared dep / non-exposed op fails to compile). Each call dispatches the target's full op-pipeline
 *  on the base db — the dep's own independent tx, never folded into the caller's tx. */
export type ModulesFacade = Record<
  string,
  Record<
    string,
    (input: unknown, idempotencyKey?: string) => Promise<Result<unknown>>
  >
>;

// roster/engine extracted into cohesive submodules, re-exported so importers stay stable.
