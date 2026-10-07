import type { Db } from "./db.ts";
import type { SequenceConfig } from "./schema.ts";

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
  if (legacy.length > 0) {
    const bumped = await db.query<{ val: number }>(
      `UPDATE "_seq_counters" SET val = val + 1
        WHERE resource = $1 AND scope_key = $2 AND period_key = $3
        RETURNING val`,
      [resource, scope, periodKey],
    );
    if (bumped.rows[0]) return Number(bumped.rows[0].val);
  }
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
}

export function seqPartition(
  model: {
    readonly name: string;
    readonly pgSchema: string;
    readonly features: { readonly scope?: unknown };
  },
  cfg: SequenceConfig,
  ctxScope: string,
  values: Readonly<Record<string, unknown>>,
): SeqPartition {
  const resource = model.pgSchema === "public"
    ? model.name
    : `${model.pgSchema}.${model.name}`;
  const moved = resource !== model.name;
  const column = cfg.scope !== undefined && values[cfg.scope] != null
    ? String(values[cfg.scope])
    : undefined;
  if (model.features.scope) {
    return column === undefined
      ? {
        resource,
        key: ctxScope,
        legacy: moved ? [{ resource: model.name, key: ctxScope }] : [],
      }
      : {
        resource,
        key: JSON.stringify([ctxScope, column]),
        legacy: [{ resource: model.name, key: column }],
      };
  }
  return column === undefined
    ? { resource, key: "", legacy: [{ resource: model.name, key: null }] }
    : {
      resource,
      key: column,
      legacy: moved ? [{ resource: model.name, key: column }] : [],
    };
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
