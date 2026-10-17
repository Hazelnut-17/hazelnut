// Barrel re-exports keep import sites stable.
import { wireJson } from "../core/wire-json.ts";
import type { ResourceModel } from "../core/app.ts";
import { uuidv7 } from "../core/id.ts";
import { maskValue, redactionSet } from "../features/redact.ts";
import type { Db } from "./db.ts";
import { wholeImmutable } from "./schema-normalize.ts";
import type { ReadCtx } from "./repo.ts";
import { type ColumnGate, normalizeColumnGate } from "./schema.ts";

/** The runtime shape of `features.audit` — `true` or `{fields, snapshot}` (04-features.md §audit). */
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
  readonly lifecycle?: boolean;
  readonly links?: {
    readonly originalId: string;
    readonly correctionId: string;
  };
  readonly relation?: {
    readonly name: string;
    readonly otherId: string;
    readonly op: "link" | "unlink";
  };
}

const LIFECYCLE_FIELDS = [
  "deleted_at",
  "deleted_by_type",
  "deleted_by_id",
] as const;
/** Keep full snapshot images while auditing only the real tombstone/restore marker change. */
export function auditLifecycleChange(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): AuditChange {
  return { before, after, lifecycle: true };
}

function auditValue(
  model: ResourceModel,
  field: string,
  value: unknown,
): unknown {
  if (model.encrypted.includes(field)) return "[encrypted]";
  return redactionSet(model).has(field)
    ? maskValue(value, model.maskStyle)
    : value;
}
function comparable(value: unknown): string | undefined {
  const sort = (node: unknown): unknown =>
    Array.isArray(node)
      ? node.map(sort)
      : node !== null && typeof node === "object"
      ? Object.fromEntries(
        Object.keys(node).sort().map((
          key,
        ) => [key, sort((node as Record<string, unknown>)[key])]),
      )
      : node;
  return JSON.stringify(sort(wireJson(value)));
}

// Excludes framework-stamped lifecycle columns (id/timestamps/version/scope/onRow/deleted_at) — only
// user columns are business changes; a redacted field keeps its changed signal but from/to are masked (04-features.md §audit).
function computeDiff(
  model: ResourceModel,
  change: AuditChange,
  restrict?: readonly string[],
): Record<string, unknown> {
  const cols = change.lifecycle
    ? [...LIFECYCLE_FIELDS]
    : restrict !== undefined
    ? restrict.filter((c) => c in model.columns)
    : [
      ...new Set([
        ...Object.keys(model.columns),
        ...(model.parentFk ? [model.parentFk] : []),
      ]),
    ];
  const before = change.before ?? {};
  const after = change.after ?? {};
  const diff: Record<string, unknown> = {};
  for (const c of cols) {
    const from = (change.before == null) ? null : (before[c] ?? null);
    const to = (change.after == null) ? null : (after[c] ?? null);
    // change-detection on the raw values (masking must not collapse two distinct secrets into one masked token)
    if (comparable(from) !== comparable(to)) {
      diff[c] = {
        from: auditValue(model, c, from),
        to: auditValue(model, c, to),
      };
    }
  }
  const relation = change.relation;
  if (
    relation && (restrict === undefined || restrict.includes(relation.name))
  ) {
    diff[relation.name] = relation.op === "link"
      ? { added: [relation.otherId], removed: [] }
      : { added: [], removed: [relation.otherId] };
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
  if (
    ["update", "transition", "link", "unlink"].includes(op) &&
    Object.keys(diff).length === 0 && !cfg.snapshot
  ) return;
  // the `fields` restriction also narrows the snapshot, so a PII-excluding `fields` list cannot leak through it.
  const restrict = cfg.fields !== undefined
    ? cfg.fields.filter((c) => c in model.columns)
    : null;
  // the snapshot masks the same `redactionSet` fields (= sensitive ∪ encrypted) the diff does, via
  // the resource log-mask — so neither the diff nor the snapshot carries a sensitive plaintext / encrypted value.
  // The image is the business row — the columns the diff walks, plus id. Framework-minted columns (an
  // equality MAC, a chain hash, vector shadows, lifecycle stamps) never enter `_audit`.
  const keys = restrict ??
    [
      "id",
      ...Object.keys(model.columns),
      ...(model.parentFk ? [model.parentFk] : []),
    ];
  const pick = (
    row: Record<string, unknown> | null | undefined,
  ): Record<string, unknown> | null => {
    if (row == null) return null;
    const out: Record<string, unknown> = {};
    for (const c of keys) if (c in row) out[c] = auditValue(model, c, row[c]);
    return out;
  };
  const snapshot = cfg.snapshot
    ? { before: pick(change.before), after: pick(change.after) }
    : null;
  await auditRow(
    db,
    model,
    ctx,
    rowId,
    op,
    change.links ? { ...diff, $rectification: change.links } : diff,
    snapshot,
  );
}

/** What an `_audit` row stamps from the caller's context — the narrow view the CRUD writer and each
 *  feature writer (transition, i18n) all satisfy, so none of them can reach the table without an `origin`. */
export interface AuditCtx {
  readonly scope: string;
  readonly actor?: {
    readonly type: string;
    readonly id: string;
    readonly onBehalfOf?: string;
  } | null;
  readonly origin?: string;
}

/** Append one `_audit` row — the SOLE writer of that table's column list; `diff`/`snapshot` arrive already
 *  masked. A second INSERT beside this one is how the transition and i18n doors came to record no `origin`. */
export async function auditRow(
  db: Db,
  model: ResourceModel,
  ctx: AuditCtx,
  rowId: string,
  op: string,
  diff: unknown,
  snapshot: unknown = null,
): Promise<void> {
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
      JSON.stringify(wireJson(diff)),
      snapshot === null ? null : JSON.stringify(wireJson(snapshot)),
      model.features.scope ? ctx.scope : null,
      ctx.origin ?? null,
    ],
  );
}

/** Resolve the runtime `immutable` config into its two forms (04-features.md §immutable): `true` is
 *  whole-resource (update/delete removed, append-only); `{fields:[…]}` is field-level (set-once, a patch
 *  touching one is rejected). `whole` delegates to `wholeImmutable` (schema-normalize.ts) — the ONE
 *  definition, so `{ fields:[…], tamperEvident:true }` reads as whole here exactly as it does at boot,
 *  never as a narrower field-level freeze that would leave update/delete open on a hash-chained ledger. */
export function immutableForm(
  model: ResourceModel,
): { whole: boolean; fields: readonly string[] } | null {
  const im = model.features.immutable as unknown;
  if (im === null || im === undefined || im === false) return null; // no immutable declared ⇒ fully mutable
  if (wholeImmutable(model.features)) return { whole: true, fields: [] };
  const f = (im as { fields?: readonly string[] }).fields ?? [];
  const fields = f.filter((c) => c in model.columns);
  return { whole: false, fields };
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

/** True when an empty caller patch still produces SET clauses — `update.stampUpdatedAt`,
 *  `update.updatedByColumns`, and `update.bumpVersion` run *before* `update.emptyPatchGuard`.
 *  Wire doors 400 `{}` only when this is false (the 404-on-a-live-row lie). A stamp/bump
 *  write stays 200: 200→400 is Breaking (`VERSIONING.md` HTTP status-code row). */
export function emptyPatchWouldWrite(model: ResourceModel): boolean {
  return Boolean(
    model.features.versioning ||
      timestampsGate(model)?.updated ||
      onRowGate(model)?.updated,
  );
}
