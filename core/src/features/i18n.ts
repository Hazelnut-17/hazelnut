import type { Db } from "../data/db.ts";
import type { ResourceModel } from "../core/app.ts";
import { list, type ReadCtx, type RowPolicy } from "../data/repo.ts";
import { all, type Where } from "../core/where.ts";
import type { Kms } from "./encrypt.ts";
import { err, ok, type Result } from "../core/result.ts";
import { uuidv7 } from "../core/id.ts";

/** `i18n` translations over the `<r>_i18n` sidecar (04-features.md §i18n), which cascades with the row —
 *  a deleted row drops its translations. `setTranslation` upserts one (row,locale,field) value;
 *  `translate` overlays the locale on a base row fetched through the same read site as every other read,
 *  so it inherits the parent's row visibility, never a second policy surface. */
const sidecar = (m: ResourceModel) => `"${m.pgSchema}"."${m.name}_i18n"`;

/** Normalize a locale tag to BCP-47 canonical form (04-features.md §i18n): the (row,locale,field) PK is
 *  a string equality, so `zh-HK`/`zh_hk`/`ZH-HK` must collapse to one key or a write and read miss each
 *  other. Language subtag lower-cased, 2-letter region upper-cased, 4-letter script title-cased, rest
 *  lower-cased. Applied on both write and read. An empty/whitespace tag is a loud boundary error, never the `""` key. */
export function normalizeLocale(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new Error(
      "i18n: empty locale tag (a BCP-47 tag is required — never an empty key)",
    );
  }
  return trimmed.split(/[-_]/).map((part, i) => {
    if (i === 0) return part.toLowerCase(); // language subtag (always lower)
    if (part.length === 2) return part.toUpperCase(); // region (alpha-2): zh-HK
    if (part.length === 4) {
      return part[0]!.toUpperCase() + part.slice(1).toLowerCase(); // script: zh-Hant
    }
    return part.toLowerCase();
  }).join("-");
}

/** Upsert one translation (idempotent on the (row, locale, field) PK). The locale is BCP-47-normalized so a
 *  later read under any equivalent casing (`zh_hk` vs `zh-HK`) resolves the same row — never a fragmented PK. */
export async function setTranslation(
  db: Db,
  model: ResourceModel,
  id: string,
  locale: string,
  field: string,
  value: string,
): Promise<void> {
  if (!model.i18n.includes(field)) {
    throw new Error(`field '${field}' is not declared i18n on '${model.name}'`);
  }
  await db.query(
    `INSERT INTO ${
      sidecar(model)
    } (entity_id, locale, field, value) VALUES ($1, $2, $3, $4)
       ON CONFLICT (entity_id, locale, field) DO UPDATE SET value = EXCLUDED.value`,
    [id, normalizeLocale(locale), field, value],
  );
}

/** Read a row with translatable fields overlaid for `locale`, walking an app-declared `fallback` chain
 *  per field (04-features.md §i18n — never a framework default). The base row rides `list` narrowed to
 *  `{id}`, so the full WHERE-stack gates visibility before any overlay; a hidden row returns null, the
 *  sidecar unread. "Untranslated" is a missing sidecar row, not a falsy value — a present `""` wins over
 *  fallback. The chain is walked per field; the first locale with a row wins; exhausting the chain
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
  const rowPolicy =
    (opts.rowPolicy as RowPolicy<Record<string, unknown>> | undefined) ??
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
    const norm = normalizeLocale(l);
    if (!chain.includes(norm)) chain.push(norm);
  }

  // one sidecar read over the whole chain; pick the highest-priority locale that HAS a row for each field.
  const tr = await db.query<{ field: string; locale: string; value: string }>(
    `SELECT field, locale, value FROM ${
      sidecar(model)
    } WHERE entity_id = $1 AND locale = ANY($2)`,
    [id, chain],
  );
  const priority = (loc: string) => chain.indexOf(loc); // lower index = higher priority
  const best = new Map<string, { rank: number; value: string }>();
  for (const { field, locale: loc, value } of tr.rows) {
    if (!model.i18n.includes(field)) continue;
    const rank = priority(loc);
    if (rank < 0) continue;
    const cur = best.get(field);
    if (!cur || rank < cur.rank) best.set(field, { rank, value }); // first-hit (highest priority) wins; "" is a valid hit
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

/** The parent scope/visibility gate the write side reuses (04-features.md §i18n): fetches the base row
 *  through the same single read site (`list` → `buildReadWhere`, narrowed to `{id}`), so the full read
 *  WHERE-stack gates the parent before any sidecar write. A row the caller cannot see cannot be
 *  translated — a hidden parent matches 0 rows → `notFound`, no sidecar row injected. */
async function readVisibleParent(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  id: string,
  kms?: Kms,
): Promise<Record<string, unknown> | null> {
  const rowPolicy =
    ((model.rowPolicy as RowPolicy<Record<string, unknown>> | null) ??
      (() => all())) as RowPolicy<Record<string, unknown>>;
  const rows = await list<Record<string, unknown>>(
    db,
    model,
    ctx,
    rowPolicy,
    { id } as Where<Record<string, unknown>>,
    kms,
  );
  return rows[0] ?? null;
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
  const r = await db.query<{ value: string }>(
    `SELECT value FROM ${
      sidecar(model)
    } WHERE entity_id = $1 AND locale = $2 AND field = $3`,
    [id, locale, field],
  );
  return r.rows[0]?.value ?? null;
}

/** `ctx.i18n.set(resource, id, locale, {field: value})` — the write-twin of resolve (04-features.md §i18n):
 *  the parent is scope/visibility-checked before any write (a hidden parent → `notFound`, no injection);
 *  each field upserts on the canonical (entity_id,locale,field) PK; if the parent declares `audit`, one
 *  `_audit` row records the change with diff key `"<field>@<locale>": {from,to}`. Idempotent — a no-change
 *  set emits no audit row. Rides the caller's op tx (not its own), so sidecar + audit commit/roll back
 *  together with the op. Returns the visible row, or `notFound`. */
export async function i18nSet(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  id: string,
  locale: string,
  fields: Record<string, string>,
  kms?: Kms,
): Promise<Result<Record<string, unknown>>> {
  const norm = normalizeLocale(locale); // loud boundary error on an empty tag (never the "" PK)
  for (const field of Object.keys(fields)) {
    if (!model.i18n.includes(field)) {
      return err(
        "validation",
        `field '${field}' is not declared i18n on '${model.name}'`,
      );
    }
  }
  // SCOPE/VISIBILITY GATE — the parent must be visible to THIS caller (scope ∧ softDelete ∧ expiry ∧ temporal ∧
  // rowPolicy) before any sidecar write; a cross-scope / hidden parent is `notFound` (no cross-scope injection).
  const parent = await readVisibleParent(db, model, ctx, id, kms);
  if (!parent) return err("notFound", `${model.name} '${id}' not found`);

  // the locale-qualified audit diff (04-features.md §i18n: diff key `"title@zh-HK": {from,to}`), captured
  // before the upsert so `from` is the prior translation, not the new one.
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const [field, value] of Object.entries(fields)) {
    const from = await currentTranslation(db, model, id, norm, field);
    await db.query(
      `INSERT INTO ${
        sidecar(model)
      } (entity_id, locale, field, value) VALUES ($1, $2, $3, $4)
         ON CONFLICT (entity_id, locale, field) DO UPDATE SET value = EXCLUDED.value`,
      [id, norm, field, value],
    );
    if (from !== value) diff[`${field}@${norm}`] = { from, to: value }; // only a real change emits a diff key
  }

  // a translation write records to the parent's `_audit` stream only when the parent declares `audit`,
  // with op:'update' and the locale-qualified diff key. Rides the caller's tx; no-change set ⇒ no row.
  if (model.features.audit && Object.keys(diff).length > 0) {
    await db.query(
      // `$7/$8::text::jsonb` — bind the pre-stringified on_behalf_of/diff AS TEXT, parse server-side
      // (outbox-emit.ts `emit` has the rationale; repo-audit.ts casts the same columns).
      `INSERT INTO "_audit" (id, module, resource, row_id, op, actor_type, actor_id, on_behalf_of, diff, snapshot, scope)
       VALUES ($1, $2, $3, $4, 'update', $5, $6, $7::text::jsonb, $8::text::jsonb, NULL, $9)`,
      [
        uuidv7(),
        model.module,
        model.name,
        id,
        ctx.actor?.type ?? null,
        ctx.actor?.id ?? null,
        ctx.actor?.onBehalfOf === undefined
          ? null
          : JSON.stringify(ctx.actor?.onBehalfOf),
        JSON.stringify(diff),
        model.features.scope ? ctx.scope : null,
      ],
    );
  }
  return ok(parent);
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
  /** `ctx.i18n.resolve(resource, id, locale)` — the row with `locale` overlaid (null if the parent is hidden). */
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
