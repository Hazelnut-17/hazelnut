// Barrel re-exports keep import sites stable.
import type {
  Expiry,
  Features,
  IdField,
  ImmutableFields,
  NullableRollupKind,
  On,
  OnRow,
  Rectifiable,
  RollupCols,
  RollupKindOf,
  Scope,
  SeqOn,
  Sequence,
  SequenceField,
  SoftDelete,
  Temporal,
  TemporalOn,
  Timestamps,
  TreeOn,
  Versioning,
} from "./faces.ts";
import type { Result } from "./pipeline.ts";
import type { Where } from "./where.ts";
import type { z } from "zod";

// `rollups` — maintained aggregate columns (03-api-shape.md §8): `count`/`sum` mint a non-null number
// (`DEFAULT 0`); `avg`/`min`/`max` are `number | null` (null on the empty set).
type Rollups<F> = [RollupCols<F>] extends [never] ? Record<never, never>
  : {
    readonly [K in RollupCols<F>]: RollupKindOf<F, K> extends NullableRollupKind
      ? number | null
      : number;
  };

// `vector` — the framework-minted embedding column + honesty shadow columns (04-features.md §vector):
// embedding is `number[] | null` until the async re-embed lands; shadows are framework-stamped and read-only.
type VectorField<F> = F extends { vector: { field: infer N extends string } }
  ? N
  : never;
type Vector<F> = [VectorField<F>] extends [never] ? Record<never, never>
  :
    & { readonly [K in VectorField<F>]: number[] | null }
    & { readonly [K in VectorField<F> as `${K}_embedded_at`]: Date | null }
    & { readonly [K in VectorField<F> as `${K}_source_hash`]: string | null }
    & { readonly [K in VectorField<F> as `${K}_model`]: string | null };

/** Row: the read shape returned by find/list. */
export type Row<R, F extends Features> =
  & R
  & IdField
  & Timestamps<F>
  & SoftDelete<F>
  & Versioning<F>
  & Expiry<F>
  & Temporal<F>
  & Scope<F>
  & Sequence<F>
  & OnRow<F>
  & Rollups<F>
  & Vector<F>
  & Rectifiable<F>;

// The `onRow` actor-pair keys — subtracted from both write faces (read-never-write; the repo write
// path stamps them from `ctx.actor`). `deleted_by_*` is only present when softDelete is also on.
type OnRowKeys<F> = On<F, "onRow"> extends true ?
    | "created_by_type"
    | "created_by_id"
    | "updated_by_type"
    | "updated_by_id"
    | (On<F, "softDelete"> extends true ? "deleted_by_type" | "deleted_by_id"
      : never)
  : never;

// Fields the framework auto-writes — hard-subtracted from Insertable. `status` drops when `transitions`
// is declared; `expires_at`/`valid_from`/`valid_to` stay optional instead (see `InsertableOptionalKeys`).
type AutoWriteKeys<F> =
  | "id"
  | (On<F, "timestamps"> extends true ? "created_at" | "updated_at" : never)
  | (On<F, "softDelete"> extends true ? "deleted_at" : never)
  | (On<F, "versioning"> extends true ? "version" : never)
  | (SeqOn<F> extends true ? SequenceField<F> : never)
  | (On<F, "scope"> extends true ? "scope_key" : never)
  | (On<F, "transitions"> extends true ? "status" : never)
  | RollupCols<F>
  | VectorKeys<F>
  | OnRowKeys<F>;

// The framework-minted vector column + its shadow columns — subtracted from both write faces (the embedding
// is async-computed by the re-embed job, the shadows framework-stamped; a caller never writes any of them).
type VectorKeys<F> = [VectorField<F>] extends [never] ? never
  :
    | VectorField<F>
    | `${VectorField<F>}_embedded_at`
    | `${VectorField<F>}_source_hash`
    | `${VectorField<F>}_model`;

// Caller-suppliable lifecycle markers that stay optional in Insertable rather than being hard-subtracted
// (03-api-shape.md §2 mech 2 + 06-generators.md §2a): `expiry.expires_at?`, `temporal.valid_from?/valid_to?`.
type InsertableOptionalKeys<F> =
  | (On<F, "expiry"> extends true ? "expires_at" : never)
  | (TemporalOn<F> extends true ? "valid_from" | "valid_to" : never);

/** Insertable: Row minus the auto-write set, with the caller-suppliable lifecycle fields re-added as
 *  optional (`expires_at?`, `valid_from?`, `valid_to?`) rather than required (what `create` accepts). */
export type Insertable<R, F extends Features> =
  & Omit<Row<R, F>, AutoWriteKeys<F> | InsertableOptionalKeys<F>>
  & Partial<
    Pick<Row<R, F>, Extract<InsertableOptionalKeys<F>, keyof Row<R, F>>>
  >;

/** The test-fixture face (05-runtime.md §testctx — `testCtx.arb.<r>` / `build`): a produced fixture is
 *  exactly an `Insertable<R,F>`, so the `testctx-arb` deriver's return type reads as the face it is, never
 *  a bare `Record`. Framework test tooling only. */
export type InsertableFixture<R, F extends Features = Features> = Insertable<
  R,
  F
>;

// Fields removed from the update surface (lifecycle/framework-managed): `status` when `transitions` is
// declared; field-level `immutable:{fields}` locks those fields too (03-api-shape.md §2 mech 3).
type LockedKeys<F> =
  | "id"
  | (On<F, "timestamps"> extends true ? "created_at" | "updated_at" : never)
  | (On<F, "softDelete"> extends true ? "deleted_at" : never)
  | (On<F, "versioning"> extends true ? "version" : never)
  | (TemporalOn<F> extends true ? "valid_from" : never)
  | (SeqOn<F> extends true ? SequenceField<F> : never)
  | (On<F, "scope"> extends true ? "scope_key" : never)
  | (On<F, "transitions"> extends true ? "status" : never)
  | ImmutableFields<F>
  | RollupCols<F>
  | VectorKeys<F>
  | OnRowKeys<F>;

/** Updatable: a partial patch over Row minus the locked set. */
export type Updatable<R, F extends Features> = Partial<
  Omit<Row<R, F>, LockedKeys<F>>
>;

/** Infer the base record type from a Zod object schema. */
export type Infer<S extends z.ZodType> = z.infer<S>;

// ─────────────────────────────────────────────────────────────────────────────
// Face 4 — ScopedRepo<R,F>: the typed per-resource repo (03-api-shape.md §2), the contract every
// `ctx.data.<r>.*` call programs against.
// ─────────────────────────────────────────────────────────────────────────────

/** A read query: the caller `where` over the read shape, offset pagination (`limit?`/`offset?`,
 *  03-api-shape.md §pagination; cursor is a future ceiling), plus temporal `asOf?` when declared
 *  (mechanism 4, absent on a non-temporal resource). `limit`/`offset` never bypass the where-stack. */
export type Query<R, F extends Features> =
  & {
    readonly where?: Where<Row<R, F>>;
    readonly limit?: number;
    readonly offset?: number;
  }
  & (TemporalOn<F> extends true ? { readonly asOf?: Date }
    : Record<never, never>);

/** BaseRepo — always present. The eight canonical methods (03-api-shape.md §"BaseRepo<R,F>"),
 *  each returning `Result<…>`. Reads inject the canonical where-stack at one site; `update`/`delete`
 *  live in the write half so `immutable` can subtract them (mechanism 5). */
export interface ReadRepo<R, F extends Features> {
  find(id: string): Promise<Result<Row<R, F> | null>>;
  findOrFail(id: string): Promise<Result<Row<R, F>>>;
  list(q?: Query<R, F>): Promise<Result<Row<R, F>[]>>;
  count(q?: Query<R, F>): Promise<Result<number>>;
  exists(id: string): Promise<Result<boolean>>;
  create(values: Insertable<R, F>): Promise<Result<Row<R, F>>>;
}

/** `versioning` → the CAS argument is REQUIRED on BOTH write doors (04-features.md §versioning); without
 *  the feature there is no `version` to compare, so neither slot exists. One conditional carries the pair,
 *  so neither door can be hardened alone — and an optional slot would make the racy form the short one. */
type CasWrites<R, F extends Features> = On<F, "versioning"> extends true ? {
    update(
      id: string,
      patch: Updatable<R, F>,
      expectedVersion: number,
    ): Promise<Result<Row<R, F>>>;
    delete(id: string, expectedVersion: number): Promise<Result<void>>;
  }
  : {
    update(id: string, patch: Updatable<R, F>): Promise<Result<Row<R, F>>>;
    delete(id: string): Promise<Result<void>>;
  };

/** The mutating half — removed wholesale when `immutable` is declared (mechanism 5, append-only). */
export type MutateRepo<R, F extends Features> =
  & CasWrites<R, F>
  & {
    /** The locking read (`SELECT … FOR UPDATE`) through the same WHERE-stack as `find`, held to commit
     *  inside the op's tx — so the `version` it returns is still current when the CAS lands. A row that
     *  cannot be locked because it is not stack-visible is `err("notFound")`, like `findOrFail`. */
    findForUpdate(id: string): Promise<Result<Row<R, F>>>;
  };

/** `softDelete` → `restore()` appears (mechanism 4): `restore()` exists iff `softDelete`
 *  is declared (03-api-shape.md §2) — present here only under that flag, absent otherwise. */
type RestoreMethod<R, F extends Features> = On<F, "softDelete"> extends true
  ? { restore(id: string): Promise<Result<Row<R, F>>> }
  : Record<never, never>;

/** `immutable:{rectifiable}` → `rectify()` appears (mechanism 4) — the GDPR Art. 16 correction door on an
 *  append-only resource (04-features.md §immutable): the original row stays, the correction is a new row,
 *  reads resolve to the chain head. Present ONLY under the object form's `rectifiable:true`. */
type RectifyMethod<R, F extends Features> = F extends
  { immutable: { rectifiable: true } }
  ? { rectify(id: string, corrections: Partial<R>): Promise<Result<Row<R, F>>> }
  : Record<never, never>;

/** `tree` → `move/ancestors/descendants/depth` appear (mechanism 4); absent on a non-tree resource. */
type TreeMethods<R, F extends Features> = TreeOn<F> extends true ? {
    move(id: string, parentId: string | null): Promise<Result<Row<R, F>>>;
    ancestors(id: string): Promise<Result<Row<R, F>[]>>;
    descendants(id: string): Promise<Result<Row<R, F>[]>>;
    depth(id: string): Promise<Result<number>>;
  }
  : Record<never, never>;

/** `searchable` → `search(query)` appears (mechanism 4) — full-text over the derived tsvector,
 *  and'd with the full read where-stack; absent on a non-searchable resource. */
type SearchMethod<R, F extends Features> = On<F, "searchable"> extends true
  ? { search(query: string): Promise<Result<Row<R, F>[]>> }
  : Record<never, never>;

/**
 * Face 4 — ScopedRepo<R,F>. The typed per-resource repo: BaseRepo's reads, the mutating half
 * (present unless `immutable`), and the per-feature method additions (restore/tree/search). The
 * single type the op-handler's `ctx.data.<r>` is checked against.
 */
export type ScopedRepo<R, F extends Features> =
  & ReadRepo<R, F>
  & (On<F, "immutable"> extends true ? Record<never, never> : MutateRepo<R, F>)
  & RestoreMethod<R, F>
  & RectifyMethod<R, F>
  & TreeMethods<R, F>
  & SearchMethod<R, F>;

/**
 * `ctx.config.<r>` — the singleton config surface (04-features.md §singleton-marker), a separate
 * channel from `ctx.data`. `getOrSeedConfig()` seeds the row from the schema's typed defaults when
 * unseeded. `replace(patch)` is a full-replace upsert, not a partial patch — an omitted field resets
 * to default. A raw `.get()` is the deliberately-absent forbidden bypass.
 */
export interface ConfigRepo<R, F extends Features> {
  getOrSeedConfig(): Promise<Row<R, F>>;
  replace(patch: R): Promise<Row<R, F>>;
}

/** `ctx.config` — only `singleton`-marked resources surface a `ConfigRepo` (mechanism 4, gated on the
 *  marker): present iff the resource declared `singleton:true`, mirroring `restore()`'s softDelete gate. */
export type ConfigSurface<R, F extends Features> = On<F, "singleton"> extends
  true ? ConfigRepo<R, F> : Record<never, never>;
