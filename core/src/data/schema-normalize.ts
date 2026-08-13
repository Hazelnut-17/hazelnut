// Barrel re-exports keep import sites stable.
import type { Features } from "../core/faces.ts";

// ── timestamps / onRow granularity (04-features.md §timestamps · §audit onRow) ────────────────────
//
// `created`/`updated` gate independently (bare `true` = both); both-false loud-fails at normalize
// time — a gate that mints no column and stamps nothing is a silent no-op.

/** A two-column gate: which of `created`/`updated` this provenance feature mints + stamps. */
export interface ColumnGate {
  readonly created: boolean;
  readonly updated: boolean;
}

/** A narrow structural view of a `timestamps`/`onRow` runtime value (object card or bare boolean). */
type ColumnGateInput = boolean | {
  readonly created?: boolean;
  readonly updated?: boolean;
};

/** Normalize a `timestamps`/`onRow` value to a `{created, updated}` gate, or `null` when off. Bare
 *  `true` enables both; in object form an absent key means off. Both false throws, named by `where`,
 *  since a gate that mints and stamps nothing is a silent no-op. */
export function normalizeColumnGate(
  value: ColumnGateInput | undefined,
  where: string,
): ColumnGate | null {
  if (!value) return null;
  if (value === true) return { created: true, updated: true };
  const created = value.created === true; // object form: an absent key means off
  const updated = value.updated === true;
  if (!created && !updated) {
    throw new Error(
      `invalid ${where} — the object form gates both 'created' and 'updated' off, which mints no column and stamps nothing (use \`true\` for both)`,
    );
  }
  return { created, updated };
}

// ── expiry config (04-features.md §expiry) ────────────────────────────────────────────────────────
//
// `after` auto-stamps `expires_at` via a DDL DEFAULT (composition, not codegen); `purge:false` means
// the column is filtered but never reaped (the scheduler skips the purge job).

/** The expiry card (04-features.md §expiry). `after` set ⇒ uniform TTL (auto-stamped, framework-written);
 *  omitted ⇒ per-row TTL (caller-writable). `purge:false` ⇒ filter-only, never reaped. */
export interface ExpiryConfig {
  readonly after?: string; // Duration token ("30m"|"1h"|"7d"|"90d"); auto-computes expires_at = created_at + after
  readonly purge: boolean; // false ⇒ soft expiry: filtered forever, never reaped (default true)
}

/** A narrow structural view of the runtime `features.expiry` value (object card or bare boolean). */
type ExpiryInput = boolean | {
  readonly after?: string;
  readonly purge?: boolean | { readonly schedule?: string };
};

/** Normalize `features.expiry` to the `ExpiryConfig` card, or `null` when off. Bare `true` means
 *  per-row mode with `purge` defaulting true; `purge` may also carry `{schedule}`, but only its
 *  on/off bit reaches the DDL — the schedule string is the scheduler's concern. */
export function normalizeExpiry(
  exp: ExpiryInput | undefined,
): ExpiryConfig | null {
  if (!exp) return null;
  if (exp === true) return { purge: true };
  const purge = exp.purge === false ? false : true; // false | {schedule} | undefined → true unless explicit false
  return { ...(exp.after !== undefined ? { after: exp.after } : {}), purge };
}

/** Render a Duration token (`"30m"`|`"1h"`|`"7d"`|`"90d"`) as a Postgres interval literal — only a
 *  validated integer plus a whitelisted unit word reach the SQL, never a raw caller string. A
 *  malformed token throws at boot. */
const DURATION_UNITS: Record<string, string> = {
  s: "seconds",
  m: "minutes",
  h: "hours",
  d: "days",
  w: "weeks",
};
export function durationToInterval(token: string): string {
  const match = /^(\d+)([smhdw])$/.exec(token.trim());
  if (!match) {
    throw new Error(
      `invalid expiry duration '${token}' — expected <number><unit> with unit ∈ s|m|h|d|w (e.g. '1h', '7d')`,
    );
  }
  const n = Number(match[1]);
  const unit = DURATION_UNITS[match[2]!]!;
  return `interval '${n} ${unit}'`; // n validated, unit whitelisted — no raw caller text reaches SQL
}

/** The on-disk column DDL for one `encrypted` field: always `bytea` (04-features.md §encrypted), never
 *  the field's declared type — so the on-disk type leaks neither the plaintext shape nor its size class.
 *  Nullability follows `.optional()`; there is no separate `_enc` table even in whole-row mode. */
export function encryptedEnvelopeColumn(
  field: string,
  nullable: boolean,
): string {
  return `"${field}" bytea${nullable ? "" : " NOT NULL"}`;
}

/** Is `immutable`'s opt-in `tamperEvident:true` sub-option set (tamper.ts)? Only the object form of
 *  `immutable` carries it — bare `true` is the whole-resource form. Zero-cost when absent: no columns,
 *  no chain compute, no read-path change. */
export function tamperEvidentOn(features: Features): boolean {
  const im = features.immutable as unknown;
  return im !== null && typeof im === "object" &&
    (im as { tamperEvident?: boolean }).tamperEvident === true;
}

/**
 * Is this resource WHOLE-resource immutable — i.e. has no update/delete path at all?
 *
 * `true` (the bare form), `{ tamperEvident: true }` (the write plan makes update `abstain`, so the path is
 * gone by construction), and the object form declaring no frozen `fields` all mean whole. A field-level
 * `immutable: { fields: [...] }` freezes columns and KEEPS update/delete, so it is not whole.
 *
 * ONE definition, because there were four that disagreed: two used `immutable !== true` and so read
 * `{ tamperEvident: true }` as mutable — silently passing PII that genuinely cannot be erased — while others
 * treated any truthy value as whole and so ship-blocked the legal `{ fields }` form.
 */
export function wholeImmutable(features: Features): boolean {
  const im = features.immutable as unknown;
  if (im === true) return true;
  if (im === null || typeof im !== "object") return false;
  if (tamperEvidentOn(features)) return true;
  return ((im as { fields?: readonly string[] }).fields?.length ?? 0) === 0;
}

/** Is `immutable`'s opt-in `rectifiable:true` sub-option set (GDPR Art. 16 — 04-features.md §immutable)?
 *  Only the object form carries it, exactly like `tamperEvident`. Zero-cost when absent: no columns, no
 *  read-path change, no rectify surface. */
export function rectifiableOn(features: Features): boolean {
  const im = features.immutable as unknown;
  return im !== null && typeof im === "object" &&
    (im as { rectifiable?: boolean }).rectifiable === true;
}

/** The `temporal` no-overlap option (04-features.md §temporal migrate): `{noOverlap:[cols]}` opts into
 *  an `EXCLUDE USING gist` refusal over (key cols, validity range); `true` or an absent flag keeps
 *  plain columns. Single source for the DDL emitter, boot guard, drizzle-generate, and `checkBaseline`. */
export function temporalNoOverlap(temporal: unknown): readonly string[] | null {
  if (typeof temporal !== "object" || temporal === null) return null;
  const cols = (temporal as { noOverlap?: unknown }).noOverlap;
  return Array.isArray(cols) && cols.length > 0 &&
      cols.every((c) => typeof c === "string")
    ? cols as string[]
    : null;
}
