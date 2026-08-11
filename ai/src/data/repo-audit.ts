// Barrel re-exports keep import sites stable.
import type { ResourceModel } from "../core/app.ts";
import { uuidv7 } from "../core/id.ts";
import { maskValue, redactionSet } from "../features/redact.ts";
import type { Db } from "./db.ts";
import type { ReadCtx } from "./repo.ts";
import { type ColumnGate, normalizeColumnGate } from "./schema.ts";

/** The runtime shape of `features.audit` — `true` or `{fields, snapshot}` (04-features.md §audit). The
 *  shared `Features` type widens this to `boolean`; `createApp` keeps the object verbatim, so this reads it. */
type AuditConfig = {
  readonly fields?: readonly string[];
  readonly snapshot?: boolean;
};
export function auditConfig(model: ResourceModel): AuditConfig | null {
  const a = model.features.audit as unknown;
  if (a === true) return {};
  if (a !== null && typeof a === "object") return a as AuditConfig;
  return null; // false / undefined ⇒ no audit
}

/** The before/after row images of one write; `auditWrite` derives the `{from,to}` diff + optional snapshot. */
interface AuditChange {
  readonly before?: Record<string, unknown> | null; // null/absent ⇒ create (no prior state)
  readonly after?: Record<string, unknown> | null; // null/absent ⇒ delete (no post state)
}

// Excludes framework-stamped lifecycle columns (id/timestamps/version/scope/onRow/deleted_at) — only
// user columns are business changes; a redacted field keeps its changed signal but from/to are masked (04-features.md §audit).
function computeDiff(
  model: ResourceModel,
  change: AuditChange,
  restrict?: readonly string[],
): Record<string, { from: unknown; to: unknown }> {
  const cols = restrict && restrict.length > 0
    ? restrict.filter((c) => c in model.columns)
    : Object.keys(model.columns);
  const before = change.before ?? {};
  const after = change.after ?? {};
  const redacted = redactionSet(model); // sensitive ∪ encrypted — mirror the output serializer so both paths agree
  const mask = (c: string, v: unknown): unknown =>
    (v != null && redacted.has(c)) ? maskValue(v, model.maskStyle) : v;
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const c of cols) {
    const from = (change.before == null) ? null : (before[c] ?? null);
    const to = (change.after == null) ? null : (after[c] ?? null);
    // change-detection on the raw values (masking must not collapse two distinct secrets into one masked token)
    if (JSON.stringify(from) !== JSON.stringify(to)) {
      diff[c] = { from: mask(c, from), to: mask(c, to) };
    }
  }
  return diff;
}

/** Append one `_audit` row per write (create/update/delete/restore), actor-stamped from `ctx`, with a
 *  `{field:{from,to}}` diff and optional before/after `snapshot` — only when the resource declares `audit`
 *  (04-features.md §audit). The single audit trust anchor. */
export async function auditWrite(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  rowId: string,
  op: string,
  change: AuditChange = {},
): Promise<void> {
  const cfg = auditConfig(model);
  if (!cfg) return;
  const diff = computeDiff(model, change, cfg.fields);
  // snapshot:true stores the full before/after row image; the `fields` restriction also narrows it so a
  // PII-excluding `fields` list does not leak through the snapshot.
  const restrict = cfg.fields && cfg.fields.length > 0
    ? cfg.fields.filter((c) => c in model.columns)
    : null;
  // the snapshot masks the same `redactionSet` fields (= sensitive ∪ encrypted) the diff does, via
  // the resource log-mask — so neither the diff nor the snapshot carries a sensitive plaintext / encrypted value.
  const redacted = redactionSet(model);
  const maskField = (c: string, v: unknown): unknown =>
    (v != null && redacted.has(c)) ? maskValue(v, model.maskStyle) : v;
  const pick = (
    row: Record<string, unknown> | null | undefined,
  ): Record<string, unknown> | null => {
    if (row == null) return null;
    const out: Record<string, unknown> = {};
    const keys = restrict ?? Object.keys(row);
    for (const c of keys) if (c in row) out[c] = maskField(c, row[c]);
    return out;
  };
  const snapshot = cfg.snapshot
    ? { before: pick(change.before), after: pick(change.after) }
    : null;
  const onBehalfOf = ctx.actor?.onBehalfOf ?? null;
  await db.query(
    // `$8/$9/$10::text::jsonb` — bind the pre-stringified JSON as text, parse server-side (outbox-emit.ts `emit`
    // has the rationale: a by-OID-serializing driver double-encodes a string bound straight to a jsonb param).
    `INSERT INTO "_audit" (id, module, resource, row_id, op, actor_type, actor_id, on_behalf_of, diff, snapshot, scope, origin)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text::jsonb, $9::text::jsonb, $10::text::jsonb, $11, $12)`,
    [
      uuidv7(),
      model.module,
      model.name,
      rowId,
      op,
      ctx.actor?.type ?? null,
      ctx.actor?.id ?? null,
      onBehalfOf === null ? null : JSON.stringify(onBehalfOf),
      JSON.stringify(diff),
      snapshot === null ? null : JSON.stringify(snapshot),
      model.features.scope ? ctx.scope : null,
      ctx.origin ?? null,
    ],
  );
}

/** Resolve the runtime `immutable` config into its two forms (04-features.md §immutable): `true` is
 *  whole-resource (update/delete removed, append-only); `{fields:[…]}` is field-level (set-once, a patch
 *  touching one is rejected). Reads the declared object directly since `Features` widens it to `boolean`. */
export function immutableForm(
  model: ResourceModel,
): { whole: boolean; fields: readonly string[] } | null {
  const im = model.features.immutable as unknown;
  if (im === true) return { whole: true, fields: [] };
  if (im !== null && typeof im === "object") {
    const f = (im as { fields?: readonly string[] }).fields ?? [];
    const fields = f.filter((c) => c in model.columns);
    // an object form with no declared fields (e.g. `{ tamperEvident:true }`) is the whole-resource append-only
    // form — the canonical tamper-evident ledger: update/delete are removed, every row is an immutable append.
    if (fields.length === 0) return { whole: true, fields: [] };
    return { whole: false, fields };
  }
  return null; // false / undefined ⇒ fully mutable
}

/**
 * The `timestamps`/`onRow` two-column gate (04-features.md §timestamps · §audit onRow): `true` gates both
 * columns, `{created?, updated?}` gates each half — read through the same `normalizeColumnGate` view the
 * DDL uses. `null` means the feature is off, so the write-autos short-circuit cleanly.
 */
export const timestampsGate = (model: ResourceModel): ColumnGate | null =>
  normalizeColumnGate(
    model.features.timestamps as Parameters<typeof normalizeColumnGate>[0],
    `timestamps on '${model.name}'`,
  );
export const onRowGate = (model: ResourceModel): ColumnGate | null =>
  normalizeColumnGate(
    model.features.onRow as Parameters<typeof normalizeColumnGate>[0],
    `onRow on '${model.name}'`,
  );
