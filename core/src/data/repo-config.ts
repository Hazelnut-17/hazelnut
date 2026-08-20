// Barrel re-exports keep import sites stable.
import { tableOf } from "../core/app-define.ts";
import type { ResourceModel } from "../core/app.ts";
import { decryptRow, type Kms } from "../features/encrypt.ts";
import type { Db } from "./db.ts";
import { create } from "./repo-create.ts";
import { appendRowPolicyConjunct } from "./repo-read.ts";
import { NO_CAS, update } from "./repo-update.ts";
import type { ReadCtx } from "./repo.ts";
import { SINGLETON_SENTINEL_ID } from "./schema.ts";

/**
 * Read the singleton config row, seeding it from schema `.default(…)` values when unseeded
 * (04-features.md §singleton-marker). The single-row guarantee is `CHECK(id=sentinel)` (global) /
 * `UNIQUE(scope_key)` (scoped); `config/default-declared` requires a default so the seed stays deterministic.
 */
export async function getOrSeedConfig(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  kms?: Kms,
): Promise<Record<string, unknown>> {
  if (!model.features.singleton) {
    throw new Error(
      `resource '${model.name}' is not a singleton (declare \`features:{singleton:true}\`)`,
    );
  }
  const existing = await readSingletonRow(db, model, ctx, kms);
  if (existing) return existing;
  // seed from schema typed defaults: `parse({})` fills every `.default(v)`. A no-default required field
  // would throw here, but `config/default-declared` (static) catches that at verify, never silently seeds junk.
  const seed = model.schema.parse({}) as Record<string, unknown>;
  // seed via `INSERT … ON CONFLICT … DO NOTHING` (never raises, so it can't poison the open tx) — required
  // since the only caller runs in-tx. Re-read unconditionally after: ours or a peer's seed, the row now exists.
  await create(db, model, ctx, seed, kms, { onConflictDoNothing: true });
  const seeded = await readSingletonRow(db, model, ctx, kms);
  if (!seeded) {
    throw new Error(`singleton '${model.name}' seed did not materialize a row`);
  }
  return seeded;
}

/**
 * Full-replace the singleton config row (04-features.md §singleton-marker — `.replace(patch)` is full
 * replace, not a partial patch): re-derived as `schema-defaults ⊕ patch`, so an omitted field resets to
 * its schema default. Seeds first if unseeded, then writes through `update` (audit/timestamps compose).
 *
 * On a `versioning` singleton `expectedVersion` is REQUIRED, exactly as it is on `ctx.data.<r>.update`.
 * A full replace overwrites EVERY column, so it is the widest blind write in the surface: two admins
 * saving a settings page would otherwise have the second silently erase the first, with no `stale`.
 */
export async function replaceConfig(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  patch: Record<string, unknown>,
  kms?: Kms,
  expectedVersion?: number,
): Promise<Record<string, unknown>> {
  if (!model.features.singleton) {
    throw new Error(
      `resource '${model.name}' is not a singleton (declare \`features:{singleton:true}\`)`,
    );
  }
  if (model.features.versioning && expectedVersion === undefined) {
    throw Object.assign(
      new Error(
        `resource '${model.name}' declares versioning: replace requires the expected version — read the row (\`getOrSeedConfig()\`) and pass \`row.version\``,
      ),
      { kind: "validation" },
    );
  }
  const current = await getOrSeedConfig(db, model, ctx, kms); // guarantees the lone row exists before replace
  // full-replace: start from the schema defaults, overlay the patch — an omitted field resets to default.
  const defaults = model.schema.parse({}) as Record<string, unknown>;
  for (const k of Object.keys(patch)) {
    if (!(k in model.columns)) {
      throw Object.assign(
        new Error(
          `replaceConfig: unknown field '${k}' on '${model.name}'`,
        ),
        { kind: "validation" },
      );
    }
  }
  const next: Record<string, unknown> = {};
  for (const c of Object.keys(model.columns)) {
    next[c] = c in patch ? patch[c] : defaults[c];
  }
  // NO_CAS only where there is no version to compare: on a non-versioning singleton a full-replace has no
  // caller token and last-write-wins is the declared posture. A versioning one carries the caller's CAS.
  const r = await update(
    db,
    model,
    ctx,
    current.id as string,
    next,
    model.features.versioning ? expectedVersion! : NO_CAS,
    kms,
  ); // through the update write-auto
  if (r.stale) {
    throw Object.assign(
      new Error(
        `singleton '${model.name}' moved since you read it (expected version ${expectedVersion}) — re-read and re-apply`,
      ),
      { kind: "conflict" },
    );
  }
  const after = await readSingletonRow(db, model, ctx, kms);
  if (!after) {
    throw new Error(`singleton '${model.name}' row vanished during replace`);
  }
  return after;
}

/** Read the lone singleton row — `null` when unseeded. Addressed by the fixed sentinel id
 *  (`CHECK(id=sentinel)`, global) or `scope_key` (`UNIQUE(scope_key)`, scoped); softDelete adds `deleted_at IS NULL`. */
async function readSingletonRow(
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  kms?: Kms,
): Promise<Record<string, unknown> | null> {
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  // scope_key addresses a scoped singleton's row (not the shared sentinel); id addresses a global one.
  // `LIMIT 1` + the unique index/CHECK guarantee exactly one row.
  const conds: string[] = model.features.scope
    ? [`scope_key = ${p(ctx.scope)}`]
    : [`id = ${p(SINGLETON_SENTINEL_ID)}`];
  if (model.features.softDelete) conds.push("deleted_at IS NULL");
  // ands the resource's rowPolicy so a `{singleton, rowPolicy}` config row is never returned to an actor
  // the policy would deny — the same write-side conjunct update/remove use; a config-surface authz bypass otherwise.
  const where = conds.join(" AND ") +
    appendRowPolicyConjunct(model, ctx, p, undefined);
  const r = await db.query<Record<string, unknown>>(
    `SELECT * FROM ${tableOf(model)} WHERE ${where} LIMIT 1`,
    params,
  );
  const row = r.rows[0] ?? null;
  if (row && model.encrypted.length > 0) {
    if (!kms) {
      throw new Error(
        `resource '${model.name}' declares encrypted fields but no KMS is bound`,
      );
    }
    await decryptRow(kms, model.encrypted, row, {
      schema: model.pgSchema,
      table: model.name,
    });
  }
  return row;
}
