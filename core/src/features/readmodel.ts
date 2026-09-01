import type { App, ResourceModel } from "../core/app.ts";
import { tableOf } from "../core/app-define.ts";
import type { NoUnknownKeys } from "../core/config.ts";
import type { Actor } from "../authz/auth.ts";
import type { Db, Transactor } from "../data/db.ts";
import { actorGateDenies } from "../data/actor-gate.ts";
import type { ReadCtx, RowPolicy } from "../data/repo.ts";
import { lifecycleLiveFrags } from "../data/repo-read.ts";
import { egress } from "./redact.ts";
import { enqueue, retryOrDeadLetterFrameworkJob } from "../runtime/outbox.ts";

/**
 * A materialized read-model kept fresh via the outbox — the counterpart to `defineView`'s live query. A
 * source write enqueues a re-projection job in the same tx; the drain applies it, so a stalled job is
 * eventual staleness, never a silent permanent skew. 03-api-shape.md.
 */
export interface ReadModelDef<Row = Record<string, unknown>> {
  readonly name: string; // the materialized read-model table name (lives unqualified, like the framework `_*` tables)
  readonly source: string; // the SOURCE resource whose writes drive re-projection (the resource `name`)
  /**
   * Whether the source resource is scoped (derived by `composeReadModelScopes`, never author-set).
   * A scoped read-model fails closed to zero rows without `{ scope }`. 13-authz.md §scope/injected.
   */
  readonly scoped?: boolean;
  /**
   * The projection's OWN actor gate — `(actor) => can(actor, …) ? all() : none()`, evaluated on the read
   * (`none()` ⇒ zero rows). A materialized row is actor-independent, so the source's per-actor `rowPolicy`
   * cannot be re-run on it; `readmodel/rowpolicy-required` refuses a projection over a row-protected source
   * that writes no gate here. Absent ⇒ the source had no policy to lose. 13-authz.md §authz-seam.
   */
  readonly rowPolicy?: RowPolicy<Row>;
  /**
   * The pure source-row → read-model-row projection. Total and side-effect-free (no ctx/db/actor), and
   * runs only in the drain — never in the write tx. It receives the source row already through `egress`,
   * so the `sensitive ∪ encrypted` set is absent from its input and cannot be materialized.
   */
  readonly project: (row: Record<string, unknown>) => Row;
}

/**
 * The `ctx.readModels.<name>` verbs that hand a handler the projection's STORED rows — the read-door set the
 * projection's own gate covers (`core/model-guards.ts §opReadModelDoor`). Classified here because this facade
 * is where a new verb lands, and pinned as a partition against the live `ctx.readModels` keys
 * so a hand-carried door list cannot go stale.
 */
export const READMODEL_ROW_READ_VERBS = ["read"] as const;

/** The write twin, and its EMPTINESS is the classification: the outbox drain (`runReadModelMaintain`) is the
 *  projection table's only writer, so the facade binds no mutating verb. A verb landing on the surface is RED
 *  at the partition until someone classifies it. */
export const READMODEL_ROW_WRITE_VERBS: readonly string[] = [];

/** `const D` is what carries the declaration's LITERAL shape out — returning the widened `ReadModelDef<Row>`
 *  threw away the `name` literal, and `Ctx<typeof module>` cannot key a face on `string`. `Row` stays the
 *  first parameter so an explicit `defineReadModel<MyRow>({…})` binds it exactly as before. */
export function defineReadModel<
  Row = Record<string, unknown>,
  const D extends ReadModelDef<Row> = ReadModelDef<Row>,
>(decl: NoUnknownKeys<D, ReadModelDef<Row>>): D {
  return decl; // pure data; createApp composes it onto App.readModels + each source model's readModelSinks
}

/**
 * Derive each read-model's `scoped` flag from its source resource at `createApp` boot, mirroring the
 * drain-side derivation in `runReadModelMaintain`. An unknown source leaves `scoped` unset.
 */
export function composeReadModelScopes(
  readModels: ReadonlyArray<ReadModelDef>,
  models: ReadonlyArray<ResourceModel>,
): ReadModelDef[] {
  return readModels.map((rm) => {
    const src = models.find((m) => m.name === rm.source);
    return { ...rm, scoped: Boolean(src?.features.scope) };
  });
}

/** The fixed outbox topic the read-model maintenance jobs ride (mirrors repo.ts §REEMBED_TOPIC). The drain
 *  handler `runReadModelMaintain` is the matching consumer; the payload names the read-model + the source row. */
export const READMODEL_TOPIC = "_readmodel_maintain";

/** The maintenance job payload — enough for the drain to find the changed source row, the read-model to
 *  re-project into, and whether the row was removed (a delete drops the projection, not re-projects it). */
interface ReadModelJob {
  readonly readModel: string; // the ReadModelDef.name to re-project into
  readonly source: string; // the source resource name (resolves the model + read-back table)
  readonly module: string; // the source resource's module (disambiguates same-named resources across modules)
  readonly id: string; // the changed source row id
  readonly op: "upsert" | "delete"; // create/update → upsert; remove → drop the projection row
}

/**
 * Materialized read-model table DDL, keyed by source row id with a jsonb `data` payload (no migration on
 * a projection-shape change). `scoped` adds a `scope_key` column for `readReadModel`'s partition filter.
 * 13-authz.md §scope-key.
 */
export function readModelDDL(rm: ReadModelDef, scoped = false): string {
  return `CREATE TABLE IF NOT EXISTS "${rm.name}" (
    source_id text PRIMARY KEY,${scoped ? "\n    scope_key text," : ""}
    data jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`;
}

/**
 * Enqueue a read-model maintenance job in the same tx as the source write, so it commits/rolls back with
 * the mutation. The projection itself runs later, in the drain — never computed here.
 */
export async function enqueueReadModelMaintain(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  id: string,
  op: "upsert" | "delete",
): Promise<void> {
  for (const rmName of model.readModelSinks) {
    const job: ReadModelJob = {
      readModel: rmName,
      source: model.name,
      module: model.module,
      id,
      op,
    };
    await enqueue(db, READMODEL_TOPIC, job, {
      scope: model.features.scope ? ctx.scope : undefined,
    });
  }
}

/**
 * The read-model maintenance drain handler: re-reads the changed source row and re-projects it (upsert for
 * create/update, keyed delete for remove) outside the write tx. A vanished source row downgrades to a
 * projection delete, never a stale image. Returns whether a projection row was written or dropped.
 */
export async function runReadModelMaintain(
  db: Db,
  app: App,
  payload: unknown,
  scope?: string,
): Promise<boolean> {
  const job = payload as ReadModelJob;
  const rm = (app.readModels ?? []).find((r) => r.name === job.readModel);
  if (!rm) {
    throw new Error(`runReadModelMaintain: no read-model '${job.readModel}'`);
  }
  const model = app.model.find((m) =>
    m.name === job.source && m.module === job.module
  );
  if (!model) {
    throw new Error(
      `runReadModelMaintain: no source resource '${job.module}.${job.source}'`,
    );
  }
  // a scoped source's projection rows carry the source row's scope (stamped from `ctx.scope` at enqueue),
  // so `readReadModel` can later filter to one partition.
  const scoped = Boolean(model.features.scope);

  // ONE source-row fence for BOTH branches (canon §8). The lock is taken by `id` alone and liveness is
  // decided from the locked row, never folded into the WHERE: a lifecycle conjunct in the WHERE matches no
  // row on a soft-deleted source, so it locks NOTHING — which is exactly how the delete branch used to race.
  // Two drainers can hold a `delete` (from remove) and a later `upsert` (from restore) at once; unfenced,
  // the delete lands after the upsert and leaves a LIVE row with no projection, nothing pending and nothing
  // dead-lettered — the silent permanent skew, not eventual staleness.
  const liveFrags = lifecycleLiveFrags(model.features);
  const liveExpr = liveFrags.length === 0 ? "TRUE" : liveFrags.join(" AND ");
  const src = await db.query<Record<string, unknown>>(
    `SELECT *, (${liveExpr}) AS "__hz_live" FROM ${
      tableOf(model)
    } WHERE id = $1 FOR UPDATE`,
    [job.id],
  );
  const row = src.rows[0];
  const live = row !== undefined && row["__hz_live"] === true;

  if (job.op === "delete") {
    // the source came back (restore) before this job ran — the peer's upsert owns the projection now, and
    // re-ordering heals instead of skewing. Symmetric with the upsert branch's own downgrade below.
    if (live) return false;
    const r = await db.query(
      `DELETE FROM "${rm.name}" WHERE source_id = $1 RETURNING source_id`,
      [job.id],
    );
    return r.rows.length > 0;
  }
  // upsert: re-project the locked row; a vanished or lifecycle-absent source drops the projection instead.
  if (!live) {
    await db.query(`DELETE FROM "${rm.name}" WHERE source_id = $1`, [job.id]);
    return false;
  }
  delete row["__hz_live"]; // the liveness flag is this function's, never an input to project()
  // A projection is a SECOND egress onto the source row, and a STORED one — so it passes the same
  // `sensitive ∪ encrypted` chokepoint the served read passes (features/redact.ts owns the set), on the way
  // in so author code never holds the plaintext, and on the way out so a projection cannot re-introduce a
  // redaction-set name. Applied here, at the projection table's only writer: every door into that table —
  // `readReadModel`, raw SQL, drizzle — then reads a row the set was never written into.
  const projected = egress(
    model,
    rm.project(egress(model, row)),
  ) as Record<string, unknown>;
  if (scoped) {
    await db.query(
      `INSERT INTO "${rm.name}" (source_id, scope_key, data, updated_at) VALUES ($1, $2, $3::text::jsonb, now())
       ON CONFLICT (source_id) DO UPDATE SET scope_key = EXCLUDED.scope_key, data = EXCLUDED.data, updated_at = now()`,
      [job.id, scope ?? null, JSON.stringify(projected)],
    );
    return true;
  }
  await db.query(
    `INSERT INTO "${rm.name}" (source_id, data, updated_at) VALUES ($1, $2::text::jsonb, now())
     ON CONFLICT (source_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [job.id, JSON.stringify(projected)],
  );
  return true;
}

/**
 * Drain pending `_readmodel_maintain` jobs. Mirrors `drainReEmbed`/`drainFileGc` (topic-scoped, `FOR UPDATE
 * SKIP LOCKED` backlog partition), but wraps each job in its own tx: `runReadModelMaintain`'s source-row
 * `FOR UPDATE` must be held across the read→project write-back so the projection and `processed_at` mark
 * commit atomically. Returns the count of jobs drained.
 */
export async function drainReadModelMaintain(
  db: Db & Transactor,
  app: App,
): Promise<number> {
  const { rows } = await db.query<
    { id: string; payload: unknown; scope: string | null }
  >(
    `SELECT id, payload, scope FROM "_outbox" WHERE topic = $1 AND processed_at IS NULL AND next_retry_at <= now() ORDER BY seq LIMIT 200 FOR UPDATE SKIP LOCKED`,
    [READMODEL_TOPIC],
  );
  let processed = 0;
  for (const r of rows) {
    try {
      // the drain SELECT's lock releases at statement end, so a peer drainer could grab the same row —
      // re-claim under the per-job tx on `processed_at IS NULL`.
      let claimed = false;
      await db.transaction(async (tx) => {
        const claim = await tx.query(
          `UPDATE "_outbox" SET processed_at = now() WHERE id = $1 AND processed_at IS NULL RETURNING id`,
          [r.id],
        );
        if (claim.rows.length === 0) return; // already processed by a peer drainer — skip
        claimed = true;
        await runReadModelMaintain(tx, app, r.payload, r.scope ?? undefined);
      });
      if (claimed) processed += 1;
    } catch (e) {
      // a poison job (throwing project(), malformed payload, unknown read-model) retries with backoff then
      // dead-letters; it never aborts the drain.
      await retryOrDeadLetterFrameworkJob(db, r.id, e, "_readmodel_maintain");
    }
  }
  return processed;
}

/**
 * Read the materialized read-model: a bare call returns every row's `data`, `id` narrows to one source
 * row's projection. A scoped read-model fails closed — omitting `{ scope }` returns zero rows, never
 * every partition's projections. 13-authz.md §scope/injected.
 */
export async function readReadModel(
  db: Db,
  rm: ReadModelDef,
  opts: {
    readonly id?: string;
    readonly scope?: string;
    readonly actor?: Actor | null;
  } = {},
): Promise<Array<Record<string, unknown>>> {
  const { id, scope } = opts;
  // the projection's own actor gate, when one is declared. Declared exactly when the source is row-protected
  // (`readmodel/rowpolicy-required` holds that at boot), so an absent gate means there was no policy to lose;
  // a deny — or a throwing gate — yields zero rows, the same fail-closed shape the scope gate below has.
  if (
    rm.rowPolicy !== undefined &&
    actorGateDenies(rm.rowPolicy, opts.actor ?? null)
  ) return [];
  // a scoped read without `{ scope }` fails closed to zero rows rather than falling through to a scope-less
  // SELECT that returns every partition's projections; the gate rides `rm.scoped`, so it is not caller-
  // optional. Mirrors buildReadWhere. 13-authz.md §scope/injected.
  if (rm.scoped && scope === undefined) return [];
  const conds: string[] = [];
  const params: unknown[] = [];
  // the scope conjunct, when present, goes first so it can never be bypassed by the id/ordering that follows.
  if (scope !== undefined) {
    params.push(scope);
    conds.push(`scope_key = $${params.length}`);
  }
  if (id !== undefined) {
    params.push(id);
    conds.push(`source_id = $${params.length}`);
  }
  const where = conds.length > 0 ? ` WHERE ${conds.join(" AND ")}` : "";
  const r = await db.query<{ data: Record<string, unknown> }>(
    `SELECT data FROM "${rm.name}"${where} ORDER BY updated_at`,
    params,
  );
  return r.rows.map((row) => row.data);
}
