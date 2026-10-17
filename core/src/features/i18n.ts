import { type Db, isTransactor, isUniqueViolation } from "../data/db.ts";
import { inTxSavepoint } from "../data/tx-locks.ts";
import { findForUpdate } from "../data/repo-list.ts";
import type { ResourceModel } from "../core/app.ts";
import {
  auditConfig,
  auditRow,
  list,
  type ReadCtx,
  type RowPolicy,
} from "../data/repo.ts";
import { all, type Where } from "../core/where.ts";
import type { Kms } from "./encrypt.ts";
import { immutableForm } from "../data/repo-audit.ts";
import { rectifiableOn } from "../data/schema.ts";
import { appendTranslation } from "../data/repo-i18n.ts";
import { err, ok, type Result, resultError } from "../core/result.ts";
import { sql } from "drizzle-orm/sql";
import { z } from "zod";
import { querySql } from "../data/read-compiler.ts";

/** `i18n` translations over the `<r>_i18n` sidecar (04-features.md §i18n), which cascades with the row —
 *  a deleted row drops its translations. `i18nSet` writes values through the parent's visibility;
 *  `translate` overlays the locale on a base row fetched through the same read site as every other read,
 *  so it inherits the parent's row visibility, never a second policy surface. */
const sidecar = (m: ResourceModel) => `"${m.pgSchema}"."${m.name}_i18n"`;

export { normalizeLocale } from "./locale.ts";
import { normalizeLocale } from "./locale.ts";

function localeOrErr(raw: string): Result<string> {
  try {
    return ok(normalizeLocale(raw));
  } catch (e) {
    if (
      typeof e === "object" && e !== null &&
      (e as { kind?: string }).kind === "validation"
    ) {
      return err("validation", e instanceof Error ? e.message : String(e));
    }
    throw e;
  }
}

/** Read a row with translatable fields overlaid for `locale`, walking an app-declared `i18nFallback`
 *  chain per field (04-features.md §i18n — never a framework default). The base row rides `list` narrowed to
 *  `{id}`, so the full WHERE-stack gates visibility before any overlay; a hidden row returns null, the
 *  sidecar unread. An empty/whitespace locale is a loud `validation` boundary (same as `i18nSet`), never
 *  folded into that null. "Untranslated" is a missing sidecar row, not a falsy value — a present `""` wins
 *  over fallback. The chain is walked per field; the first locale with a row wins; exhausting the chain
 *  returns base (possibly null). Locales are BCP-47-normalized so the lookup matches any casing. */
export async function translate<Row extends Record<string, unknown>>(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  id: string,
  locale: string,
  opts: {
    rowPolicy?: RowPolicy<Row>;
    kms?: Kms;
    fallback?: readonly string[];
  } = {},
): Promise<Row | null> {
  // Empty/whitespace locale is a loud boundary (same as `i18nSet` / `normalizeLocale`) —
  // never folded into "parent hidden" null.
  locale = normalizeLocale(locale);
  const rowPolicy =
    (opts.rowPolicy as RowPolicy<Record<string, unknown>> | undefined) ??
      (model.rowPolicy as RowPolicy<Record<string, unknown>> | null) ??
      (() => all());
  const rows = await list<Record<string, unknown>>(
    db,
    model,
    ctx,
    rowPolicy,
    { id } as Where<Record<string, unknown>>,
    opts.kms,
  );
  const base = rows[0];
  if (!base) return null; // hidden by the read stack (out-of-scope / soft-deleted / expired / policy) → no overlay

  // the resolution chain: the requested locale first, then the app-declared fallback chain, normalized +
  // de-duplicated (a repeated/aliased tag would re-scan the same rows). PER-FIELD first-hit wins.
  const chain: string[] = [];
  for (const l of [locale, ...(opts.fallback ?? [])]) {
    const n = normalizeLocale(l);
    if (!chain.includes(n)) chain.push(n);
  }

  // one sidecar read over the whole chain; pick the highest-priority locale that HAS a row for each field.
  const tr = await querySql<{ field: string; locale: string; value: string }>(
    db,
    sql`SELECT field, locale, value FROM ${sql.identifier(model.pgSchema)}.${
      sql.identifier(`${model.name}_i18n`)
    } WHERE entity_id = ${id} AND lower(locale) = ANY(${
      sql.param(chain.map((l) => l.toLowerCase()))
    }) ORDER BY locale`,
  );
  const priority = (loc: string) => chain.indexOf(normalizeLocale(loc)); // lower index = higher priority
  const best = new Map<
    string,
    { rank: number; canonical: boolean; value: string }
  >();
  for (const { field, locale: loc, value } of tr.rows) {
    if (!model.i18n.includes(field)) continue;
    const rank = priority(loc);
    if (rank < 0) continue;
    const cur = best.get(field);
    const canonical = loc === chain[rank];
    if (
      !cur || rank < cur.rank ||
      (rank === cur.rank && canonical && !cur.canonical)
    ) best.set(field, { rank, canonical, value }); // first-hit (highest priority) wins; "" is a valid hit
  }
  for (const [field, { value }] of best) base[field] = value;
  return base as Row;
}

// ── the canon `ctx.i18n` surface (04-features.md §i18n) ──────────────────────────────────
// `resolve`/`set` are the sanctioned i18n path the `i18n/no-bypass-resolve` lint enforces — the ONLY legal
// way `logic/` touches a translation. Both derive over the same read/write stack the resource's own repo
// uses, so a translation inherits the parent's row visibility, never a second policy surface.

/** Resolve the model a resource NAME identifies — the i18n surface is keyed by resource name (like `ctx.data`),
 *  so a `set`/`resolve` for a name no resource declares is a loud config error, never a silent miss. */
function modelByName(
  models: readonly ResourceModel[],
  resource: string,
): ResourceModel {
  const m = models.find((x) => x.name === resource);
  if (!m) throw new Error(`ctx.i18n: no resource '${resource}'`);
  return m;
}

/** Read the current translation value of one (row,locale,field) — the audit `from` for the locale-qualified
 *  diff key. A missing sidecar row is null (matches resolve's "missing, not falsy" semantics); a present
 *  `""` is a real prior value. */
async function currentTranslation(
  db: Db,
  model: ResourceModel,
  id: string,
  locale: string,
  field: string,
): Promise<string | null> {
  const r = await querySql<{ value: string }>(
    db,
    sql`SELECT value FROM ${sql.identifier(model.pgSchema)}.${
      sql.identifier(`${model.name}_i18n`)
    } WHERE entity_id = ${id} AND lower(locale) = ${locale.toLowerCase()} AND field = ${field} ORDER BY (locale = ${locale}) DESC, locale LIMIT 1`,
  );
  return r.rows[0]?.value ?? null;
}

/** `ctx.i18n.set(resource, id, locale, {field: value})` — the write-twin of resolve (04-features.md §i18n):
 *  the parent is scope/visibility-checked before any write (a hidden parent → `notFound`, no injection);
 *  each field upserts on the canonical (entity_id,locale,field) PK; if the parent declares `audit`, one
 *  `_audit` row records the change with diff key `"<field>@<locale>": {from,to}`. Idempotent — a no-change
 *  set emits no audit row. Uses a transaction or driver savepoint, so sidecar + audit commit/roll back
 *  together. Returns the translated visible row, or `notFound`. */
async function i18nSetInTx(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  id: string,
  locale: string,
  fields: Record<string, string>,
  kms?: Kms,
): Promise<Result<Record<string, unknown>>> {
  const norm = locale;
  // SCOPE/VISIBILITY GATE — the parent must be visible to THIS caller (scope ∧ softDelete ∧ expiry ∧ temporal ∧
  // rowPolicy) before any sidecar write; a cross-scope / hidden parent is `notFound` (no cross-scope injection).
  const parent = await findForUpdate<Record<string, unknown>>(
    db,
    model,
    ctx,
    (model.rowPolicy as RowPolicy<Record<string, unknown>> | null) ??
      (() => all()),
    id,
    kms,
  );
  if (!parent) return err("notFound", `${model.name} '${id}' not found`);

  // the locale-qualified audit diff (04-features.md §i18n: diff key `"title@zh-HK": {from,to}`), captured
  // before the upsert so `from` is the prior translation, not the new one.
  // A translation of a frozen field is set once per (locale, field): an immutable or tamperEvident resource
  // freezes every translatable field, a field-level `immutable.fields` entry freezes that field. Every refusal
  // is decided before the first write, so a refused call writes nothing.
  const im = immutableForm(model);
  const frozen = (field: string) =>
    im !== null && (im.whole || im.fields.includes(field));
  const prior = new Map<string, unknown>();
  for (const [field, value] of Object.entries(fields)) {
    const from = await currentTranslation(db, model, id, norm, field);
    prior.set(field, from);
    if (frozen(field) && from != null && from !== value) {
      return err(
        "conflict",
        `${model.name}.${field}@${norm} is set once — ${field} is immutable, so its translation cannot be rewritten${
          rectifiableOn(model.features)
            ? "; correct the row with ctx.data.<resource>.rectify inside a producer operation"
            : ""
        }`,
      );
    }
  }
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const [field, value] of Object.entries(fields)) {
    const from = prior.get(field);
    if (from === value) continue;
    if (frozen(field)) {
      await appendTranslation(db, model, id, norm, field, value);
    } else if (from != null) {
      // Preserve a legacy locale's key while updating its mutable value. Inserting a second canonical
      // key would retain an obsolete translation and make case aliases disagree.
      await db.query(
        `UPDATE ${
          sidecar(model)
        } SET value = $4 WHERE entity_id = $1 AND lower(locale) = $2 AND field = $3`,
        [id, norm.toLowerCase(), field, value],
      );
    } else {
      await db.query(
        `INSERT INTO ${
          sidecar(model)
        } (entity_id, locale, field, value) VALUES ($1, $2, $3, $4)
           ON CONFLICT (entity_id, locale, field) DO UPDATE SET value = EXCLUDED.value`,
        [id, norm, field, value],
      );
    }
    diff[`${field}@${norm}`] = { from, to: value };
  }

  // a translation write records to the parent's `_audit` stream only when the parent declares `audit`,
  // with op:'update' and the locale-qualified diff key. Rides the caller's tx; no-change set ⇒ no row.
  // `audit: { fields }` must constrain this door the same way CRUD/transition do — a PII-excluding list
  // that omits `title` must not still record `title@zh-HK` via a raw auditRow bypass.
  if (model.features.audit && Object.keys(diff).length > 0) {
    const cfg = auditConfig(model);
    const restrict = cfg?.fields && cfg.fields.length > 0
      ? new Set(cfg.fields)
      : null;
    const gated = restrict
      ? Object.fromEntries(
        Object.entries(diff).filter(([k]) =>
          restrict.has(k.slice(0, k.indexOf("@")))
        ),
      )
      : diff;
    if (Object.keys(gated).length > 0) {
      await auditRow(db, model, ctx, id, "update", gated);
    }
  }
  const translated = await i18nResolve<Record<string, unknown>>(
    db,
    model,
    ctx,
    id,
    norm,
    kms,
  );
  return translated
    ? ok(translated)
    : err("notFound", `${model.name} '${id}' not found`);
}

/** Validate the entire locale patch before any write. A root Transactor owns the transaction;
 * an existing transaction uses the driver's savepoint so a returned failure cannot commit a prefix. */
export async function i18nSet(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  id: string,
  locale: string,
  fields: Record<string, string>,
  kms?: Kms,
): Promise<Result<Record<string, unknown>>> {
  const loc = localeOrErr(locale);
  if (!loc.ok) return loc;
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
    return err("validation", "i18n fields must be an object");
  }
  const parsed: Record<string, string> = {};
  for (const [field, value] of Object.entries(fields)) {
    if (!model.i18n.includes(field) || typeof value !== "string") {
      return err(
        "validation",
        `field '${field}' must be a declared i18n string on '${model.name}'`,
      );
    }
    const schema = model.schema.shape[field];
    if (!schema) {
      return err("validation", `field '${field}' has no declared schema`);
    }
    const checked = await z.safeParseAsync(schema, value);
    if (!checked.success || typeof checked.data !== "string") {
      return err(
        "validation",
        `invalid translation for '${model.name}.${field}'`,
      );
    }
    parsed[field] = checked.data;
  }
  if (!isTransactor(db) && !db.savepoint) {
    return err(
      "internal",
      "i18n/atomic-write: set requires a Transactor or a transaction handle with driver savepoints",
    );
  }
  class AbortedTranslation extends Error {
    constructor(readonly result: Result<Record<string, unknown>>) {
      super("i18n set rolled back");
    }
  }
  const apply = async (tx: Db) => {
    const result = await i18nSetInTx(
      tx,
      model,
      ctx,
      id,
      loc.value,
      parsed,
      kms,
    );
    if (!result.ok) throw new AbortedTranslation(result);
    return result;
  };
  try {
    return isTransactor(db)
      ? await db.transaction(apply)
      : await inTxSavepoint(db, apply);
  } catch (e) {
    if (e instanceof AbortedTranslation) return e.result;
    if (isUniqueViolation(e)) {
      return err(
        "conflict",
        "translation was set concurrently; re-read the current locale",
      );
    }
    return { ok: false, error: resultError(e) };
  }
}

/** `ctx.i18n.resolve(resource, id, locale)` — read a row with translatable fields overlaid for `locale`
 *  (04-features.md §i18n). Routes through `translate` (the single read site), so the parent's full read
 *  WHERE-stack gates visibility before overlay — a hidden parent returns null, never base-with-overlay. */
export function i18nResolve<Row extends Record<string, unknown>>(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  id: string,
  locale: string,
  kms?: Kms,
): Promise<Row | null> {
  const rowPolicy = (model.rowPolicy as RowPolicy<Row> | null) ?? undefined;
  return translate<Row>(db, model, ctx, id, locale, {
    ...(rowPolicy !== undefined ? { rowPolicy } : {}),
    ...(kms !== undefined ? { kms } : {}),
    fallback: model.i18nFallback, // the app-declared chain threaded onto the model (never a framework default)
  });
}

/** The `ctx.i18n` surface — `{resolve, set}` keyed by resource name, bound to the live tx db + caller ctx,
 *  mirroring `ctx.data`. The sanctioned path the `i18n/no-bypass-resolve` lint mandates (04-features.md §i18n). */
export interface I18nSurface {
  /** `ctx.i18n.resolve(resource, id, locale)` — the row with `locale` overlaid (null if the parent is
   *  hidden). An empty/whitespace locale is a loud `validation` boundary, never null. */
  resolve(
    resource: string,
    id: string,
    locale: string,
  ): Promise<Record<string, unknown> | null>;
  /** `ctx.i18n.set(resource, id, locale, {field: value})` — write a translation through the scope/audit path. */
  set(
    resource: string,
    id: string,
    locale: string,
    fields: Record<string, string>,
  ): Promise<Result<Record<string, unknown>>>;
}

/** Build the `ctx.i18n` surface bound to the composed models + the live (tx) db + caller ctx. The op-pipeline's
 *  ctx factory composes this onto the handler ctx so a handler reaches i18n only through `resolve`/`set`. */
export function buildI18nSurface(
  models: readonly ResourceModel[],
  db: Db,
  ctx: ReadCtx,
  kms?: Kms,
): I18nSurface {
  return {
    resolve: (resource, id, locale) =>
      i18nResolve(db, modelByName(models, resource), ctx, id, locale, kms),
    set: (resource, id, locale, fields) =>
      i18nSet(db, modelByName(models, resource), ctx, id, locale, fields, kms),
  };
}
