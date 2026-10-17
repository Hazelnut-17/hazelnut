import type { Db } from "./db.ts";
import type { SequenceConfig } from "./schema.ts";
import { sequenceObjectName } from "./schema-derive.ts";

/** Gap-free sequence# allocation — the locked-counter form (04-features.md §sequence#): an atomic
 *  `ON CONFLICT … DO UPDATE … RETURNING` upsert against `_seq_counters`, keyed on `(resource, scope_key,
 *  period_key)`, is gap-free under concurrency because the row lock is held to commit. `period_key` is
 *  part of that key, so a new period seeds a fresh `val = 1` row while the prior period's counter stays
 *  intact and independent; `periodKey:""` is the no-period bucket for a bare `sequence: { field: "seq", strategy: "locked-row" }`. */
export async function nextSeq(
  db: Db,
  resource: string,
  scope: string,
  periodKey = "",
  legacy: readonly LegacyCounter[] = [],
): Promise<number> {
  // A first allocation in a partition continues past the counters earlier releases kept these numbers in.
  const params: unknown[] = [resource, scope, periodKey];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const covers = legacy.map((l) =>
    l.key === null
      ? `resource = ${p(l.resource)}`
      : `(resource = ${p(l.resource)} AND scope_key = ${p(l.key)})`
  );
  const seed = covers.length === 0
    ? "0"
    : `(SELECT max(val) FROM "_seq_counters" WHERE period_key = $3 AND NOT (resource = $1 AND scope_key = $2) AND (${
      covers.join(" OR ")
    }))`;
  if (legacy.length > 0) {
    // This partition's row may itself predate the repartition (an unscoped resource's '' key was one caller
    // scope among many), so an existing row also lifts past the legacy maximum, not only a seeded one.
    const inherited = legacy.some((l) =>
      l.resource === resource && (l.key === null || l.key === scope)
    );
    const bumped = await db.query<{ val: number }>(
      `UPDATE "_seq_counters" SET val = ${
        inherited ? `GREATEST(val, COALESCE(${seed}, 0))` : "val"
      } + 1
        WHERE resource = $1 AND scope_key = $2 AND period_key = $3
        RETURNING val`,
      inherited ? params : params.slice(0, 3),
    );
    if (bumped.rows[0]) return Number(bumped.rows[0].val);
  }
  const r = await db.query<{ val: number }>(
    `INSERT INTO "_seq_counters" (resource, scope_key, period_key, val)
       VALUES ($1, $2, $3, 1 + COALESCE(${seed}, 0))
       ON CONFLICT (resource, scope_key, period_key) DO UPDATE
         SET val = "_seq_counters".val + 1
     RETURNING val`,
    params,
  );
  return Number(r.rows[0]?.val);
}

/** A counter an earlier release kept the same numbers in; `key: null` covers every scope of that resource. */
export interface LegacyCounter {
  readonly resource: string;
  readonly key: string | null;
}

/** The `_seq_counters` partition one create allocates from (04-features.md §sequence#). A module's resource is
 *  keyed by schema, a scoped resource never shares a counter across scopes, and an unscoped one never splits a
 *  counter by caller scope. */
export interface SeqPartition {
  readonly resource: string;
  readonly key: string;
  readonly legacy: readonly LegacyCounter[];
  readonly cutover?: {
    readonly control: string;
    readonly signature: string;
    readonly snapshot: string;
    readonly sources: readonly string[];
    readonly pgSchema: string;
    readonly sequenceName: string;
  };
}

export function seqPartition(
  model: {
    readonly name: string;
    readonly pgSchema: string;
    readonly features: { readonly scope?: unknown };
    readonly columns?: Readonly<Record<string, { readonly pg: string }>>;
  },
  cfg: SequenceConfig,
  ctxScope: string,
  values: Readonly<Record<string, unknown>>,
): SeqPartition {
  const resource = model.pgSchema === "public"
    ? model.name
    : `${model.pgSchema}.${model.name}`;
  const moved = resource !== model.name;
  if (cfg.scope !== undefined) {
    const value = values[cfg.scope] ?? null;
    const pg = model.columns?.[cfg.scope]?.pg;
    const canonical =
      value != null && pg === "uuid" && typeof value === "string"
        ? value.toLowerCase()
        : value != null && pg === "timestamptz" &&
            (typeof value === "string" || value instanceof Date)
        ? (value instanceof Date
          ? value.toISOString()
          : new Date(value).toISOString())
        : value;
    const typed = partitionValue(canonical);
    const snapshot = JSON.stringify([
      "sequence:legacy:v2",
      model.pgSchema,
      model.name,
    ]);
    const sources = [...new Set([resource, model.name])];
    const oldKeys = value === null
      ? (model.features.scope ? [ctxScope] : null)
      : [
        ...new Set([
          String(value),
          ...(model.features.scope
            ? [JSON.stringify([ctxScope, String(value)])]
            : []),
        ]),
      ];
    return {
      resource: JSON.stringify(["sequence:v2", model.pgSchema, model.name]),
      key: JSON.stringify([model.features.scope ? ctxScope : null, ...typed]),
      legacy: oldKeys === null
        ? [{ resource: snapshot, key: null }]
        : sources.flatMap((source) =>
          oldKeys.map((key) => ({
            resource: snapshot,
            key: JSON.stringify([source, key]),
          }))
        ),
      cutover: {
        control: JSON.stringify([
          "sequence:cutover:v2",
          model.pgSchema,
          model.name,
        ]),
        signature: JSON.stringify([cfg.scope, cfg.field, cfg.strategy]),
        snapshot,
        sources,
        pgSchema: model.pgSchema,
        sequenceName: sequenceObjectName(model.name, cfg),
      },
    };
  }
  if (model.features.scope) {
    return {
      resource,
      key: ctxScope,
      legacy: moved ? [{ resource: model.name, key: ctxScope }] : [],
    };
  }
  return { resource, key: "", legacy: [{ resource: model.name, key: null }] };
}

/** Typed tuples keep NULL, empty text and a caller scope distinct. Structured/unstable values
 * cannot identify a durable counter bucket. The declaration guard checks the corresponding column. */
function partitionValue(
  value: unknown,
): readonly [string, string | boolean | number | null] {
  if (value === null) return ["null", null];
  if (typeof value === "string") return ["string", value];
  if (typeof value === "boolean") return ["boolean", value];
  if (typeof value === "bigint") return ["bigint", String(value)];
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return ["number", value];
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return ["date", value.toISOString()];
  }
  throw Object.assign(
    new Error(
      "sequence/partition-value: sequence.scope must be a stable scalar value",
    ),
    { kind: "validation" as const },
  );
}

const sqlText = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const sqlIdent = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const CUTOVER_PERIOD = "sequence:cutover:v2";
const NATIVE_WATERMARK = JSON.stringify(["native-object"]);

/** One-time compatibility carry-forward. Deployment must stop and drain every old writer before
 * first use: no runtime lock can fence a binary that never participates in the new protocol. New
 * replicas serialize initialization, lock the existing legacy rows and freeze all historical periods.
 * Future partitions consult only this snapshot, including numbers burned by the old native sequence. */
async function freezeLegacyCounters(
  db: Db,
  partition: SeqPartition,
  independent = false,
): Promise<void> {
  const cutover = partition.cutover;
  if (!cutover) return;
  const query = independent && db.autocommitQuery
    ? db.autocommitQuery.bind(db)
    : db.query.bind(db);
  const markers = await query<{ scope_key: string }>(
    `SELECT scope_key FROM "_seq_counters" WHERE resource = $1 AND period_key = $2`,
    [cutover.control, CUTOVER_PERIOD],
  );
  if (markers.rows.length > 0) {
    if (
      markers.rows.length === 1 &&
      markers.rows[0]!.scope_key === cutover.signature
    ) return;
    throw Object.assign(
      new Error(
        "sequence/partition-change: partition column, number field or strategy changed after cutover; perform an explicitly reviewed counter migration before writing",
      ),
      { kind: "conflict" as const },
    );
  }
  const sourceList = cutover.sources.map(sqlText).join(", ");
  const object = sqlText(
    `${sqlIdent(cutover.pgSchema)}.${sqlIdent(cutover.sequenceName)}`,
  );
  await query(`DO $hz_sequence_cutover$
DECLARE existing text; native_max bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(${sqlText(cutover.control)}));
  SELECT scope_key INTO existing FROM "_seq_counters" WHERE resource = ${
    sqlText(cutover.control)
  } AND period_key = ${sqlText(CUTOVER_PERIOD)} LIMIT 1;
  IF existing IS NOT NULL THEN
    IF existing <> ${
    sqlText(cutover.signature)
  } THEN RAISE EXCEPTION 'sequence/partition-change: reviewed counter migration required'; END IF;
    RETURN;
  END IF;
  PERFORM 1 FROM "_seq_counters" WHERE resource IN (${sourceList}) FOR UPDATE;
  INSERT INTO "_seq_counters" (resource, scope_key, period_key, val)
    SELECT ${
    sqlText(cutover.snapshot)
  }, '[' || to_json(resource)::text || ',' || to_json(scope_key)::text || ']', period_key, val
    FROM "_seq_counters" WHERE resource IN (${sourceList})
    ON CONFLICT (resource, scope_key, period_key) DO NOTHING;
  native_max := pg_sequence_last_value(to_regclass(${object}));
  IF native_max IS NOT NULL THEN
    INSERT INTO "_seq_counters" (resource, scope_key, period_key, val)
      VALUES (${sqlText(cutover.snapshot)}, ${
    sqlText(NATIVE_WATERMARK)
  }, 'native-sequence', native_max)
      ON CONFLICT (resource, scope_key, period_key) DO NOTHING;
  END IF;
  INSERT INTO "_seq_counters" (resource, scope_key, period_key, val)
    VALUES (${sqlText(cutover.control)}, ${sqlText(cutover.signature)}, ${
    sqlText(CUTOVER_PERIOD)
  }, 0);
END $hz_sequence_cutover$`);
}

/** A partitioned native sequence uses the same declared partitions as locked-row allocation. A bare,
 *  unscoped native sequence keeps its PostgreSQL nextval DEFAULT. */
export function nativeSeqIsPartitioned(
  model: { readonly features: { readonly scope?: unknown } },
  cfg: SequenceConfig,
): boolean {
  return cfg.strategy === "native-sequence" &&
    (Boolean(model.features.scope) || cfg.scope !== undefined);
}

/** Gaps-ok allocation for a partitioned native sequence. Each increment commits independently of the
 *  operation, so it holds the counter lock for one statement and rollback burns the allocated number.
 *  PGlite has only one connection and explicitly falls back to the current transaction; its dev numbers
 *  may therefore be reused after rollback. A live adapter without an independent connection refuses.
 *
 *  The separate period bucket stores actual native values (not locked-row's start-relative offsets).
 *  A first allocation continues past rows written by the earlier global nextval allocator. */
export async function allocateNativeSeq(
  db: Db,
  model: {
    readonly name: string;
    readonly pgSchema: string;
    readonly features: { readonly scope?: unknown };
  },
  cfg: SequenceConfig,
  partition: SeqPartition,
  ctxScope: string,
  values: Readonly<Record<string, unknown>>,
): Promise<string> {
  if (!db.autocommitQuery && db.concurrent !== false) {
    throw new Error(
      "sequence/independent-connection: partitioned native-sequence needs an independent autocommit connection; use postgresDb(sql) or supply Db.autocommitQuery",
    );
  }
  await freezeLegacyCounters(db, partition, true);
  const params: unknown[] = [partition.resource, partition.key, cfg.start ?? 1];
  const where: string[] = [];
  if (model.features.scope) {
    params.push(ctxScope);
    where.push(`scope_key = $${params.length}`);
  }
  if (cfg.scope !== undefined) {
    params.push(values[cfg.scope] ?? null);
    where.push(`"${cfg.scope}" IS NOT DISTINCT FROM $${params.length}`);
  }
  const seedTerms: string[] = [];
  for (const counter of partition.legacy) {
    params.push(counter.resource);
    const resourceParam = `$${params.length}`;
    if (counter.key === null) seedTerms.push(`resource = ${resourceParam}`);
    else {
      params.push(counter.key);
      seedTerms.push(
        `(resource = ${resourceParam} AND scope_key = $${params.length})`,
      );
    }
  }
  if (partition.cutover) {
    params.push(partition.cutover.snapshot, NATIVE_WATERMARK);
    seedTerms.push(
      `(resource = $${params.length - 1} AND scope_key = $${params.length})`,
    );
  }
  const frozenSeed = seedTerms.length === 0
    ? "0"
    : `(SELECT max(val) FROM "_seq_counters" WHERE period_key = 'native-sequence' AND (${
      seedTerms.join(" OR ")
    }))`;
  const table = `"${model.pgSchema}"."${model.name}"`;
  const query = db.autocommitQuery?.bind(db) ?? db.query.bind(db);
  const result = await query<{ val: string }>(
    `INSERT INTO "_seq_counters" (resource, scope_key, period_key, val)
       VALUES ($1, $2, 'native-sequence', COALESCE(
         (SELECT val + 1 FROM "_seq_counters"
           WHERE resource = $1 AND scope_key = $2 AND period_key = 'native-sequence'),
         GREATEST($3::bigint, COALESCE(${frozenSeed}, $3::bigint - 1) + 1,
         COALESCE((SELECT max("${cfg.field}") FROM ${table}${
      where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""
    }), $3::bigint - 1) + 1)))
       ON CONFLICT (resource, scope_key, period_key) DO UPDATE
         SET val = "_seq_counters".val + 1
       RETURNING val`,
    params,
  );
  return String(result.rows[0]!.val);
}

/** The date-token bucket a `prefix` resolves to at instant `now` — the `period_key` value that, when it
 *  changes, resets the counter (04-features.md §sequence#). No date token (or no prefix) ⇒ `""` (the
 *  no-period bucket); UTC, so the bucket is stable across replicas. Tokens: `{YYYY}`, `{YY}`, `{MM}`;
 *  several tokens concatenate, so any one rolling forces a reset. */
export function periodKeyOf(
  prefix: string | undefined,
  now: Date = new Date(),
): string {
  if (!prefix) return "";
  const yyyy = String(now.getUTCFullYear());
  const yy = yyyy.slice(-2);
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const parts: string[] = [];
  // order matters: {YYYY} must be tested before {YY} (a naive {YY} match would also fire inside {YYYY}).
  if (prefix.includes("{YYYY}")) parts.push(yyyy);
  else if (prefix.includes("{YY}")) parts.push(yy);
  if (prefix.includes("{MM}")) parts.push(mm);
  return parts.join("-"); // "" when the prefix is a literal with no date token
}

/** Substitute a prefix's date tokens (`{YYYY}`/`{YY}`/`{MM}`) with their values at `now` (UTC). A literal
 *  prefix (no tokens) passes through unchanged. The rendered prefix is what the human number carries. */
export function renderPrefix(prefix: string, now: Date = new Date()): string {
  const yyyy = String(now.getUTCFullYear());
  return prefix
    .replaceAll("{YYYY}", yyyy)
    .replaceAll("{YY}", yyyy.slice(-2))
    .replaceAll("{MM}", String(now.getUTCMonth() + 1).padStart(2, "0"));
}

/** Render the allocated counter `n` into the human-facing string the `text` column stores: the rendered
 *  `prefix` (date tokens resolved) followed by the zero-padded number (`pad` width). With neither prefix
 *  nor pad the column is numeric and this is never called (the raw `n` is written). */
export function formatSeq(
  cfg: SequenceConfig,
  n: number,
  now: Date = new Date(),
): string {
  const body = cfg.pad !== undefined
    ? String(n).padStart(cfg.pad, "0")
    : String(n);
  return cfg.prefix !== undefined ? renderPrefix(cfg.prefix, now) + body : body;
}

/** The locked-row allocation seam the create write-auto calls (repo.ts): allocate the next counter and
 *  return the column value — the formatted string when `prefix`/`pad` make the column `text`, else the
 *  raw integer. Used only for `locked-row`; `native-sequence` allocates at the DB via `nextval` DEFAULT
 *  and never reaches this seam (04-features.md §sequence# runtime). */
export async function allocateSeq(
  db: Db,
  cfg: SequenceConfig,
  partition: SeqPartition,
  now: Date = new Date(),
): Promise<string | number> {
  await freezeLegacyCounters(db, partition);
  const period = periodKeyOf(cfg.prefix, now);
  const n = (cfg.start !== undefined ? cfg.start - 1 : 0) +
    await nextSeq(
      db,
      partition.resource,
      partition.key,
      period,
      partition.legacy,
    );
  // `start` seeds the first value (start:1000 ⇒ first allocation is 1000): the counter still returns
  // 1,2,3… and we offset by start-1 so #1 maps to `start`.
  return (cfg.prefix !== undefined || cfg.pad !== undefined)
    ? formatSeq(cfg, n, now)
    : n;
}
