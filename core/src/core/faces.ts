/**
 * The four type faces, derived from one `defineResource` by composition (03-api-shape.md §2):
 * `Row`, `Insertable`, `Updatable`, `ScopedRepo`. Conditional types over the schema + declared
 * features — the no-codegen spine, never generated to disk.
 */

/** The declared feature flags that shape the faces (the phantom carrier). */
export interface Features {
  readonly softDelete?: boolean;
  readonly timestamps?: boolean;
  readonly audit?: boolean;
  readonly onRow?: boolean; // audit sub-option: stamp created_by/updated_by on the resource's own table
  // `sequence#` (04-features.md §sequence#): the object card's `field` names the minted column
  // (`invoiceNo`); bare `true` is refused (TD-1 — no boolean alias).
  readonly sequence?: { readonly field?: string };
  // `immutable` (04-features.md §immutable / 03-api-shape.md §2 mech 3): `true` removes update/delete
  // wholesale; `{ fields }` freezes just those. `tamperEvident` hash-chains each row; `rectifiable`
  // (GDPR Art. 16) corrects via a new row + `superseded_by` pointer instead of rewriting. Composable.
  readonly immutable?: boolean | {
    readonly fields?: readonly string[];
    readonly tamperEvident?: boolean;
    readonly rectifiable?: boolean;
  };
  // `tree` (04-features.md §tree): self-FK with a configurable `onParentDelete` (default `restrict` —
  // a parent with children cannot be deleted). `parentField` renames the self-reference column
  // (default `parent_id`); either form keeps the `tree`-method block present.
  readonly tree?: boolean | {
    readonly onParentDelete?: "cascade" | "set-null" | "restrict";
    readonly parentField?: string;
  };
  // tree sub-option: maintain a `<r>_tree` closure table for fast ancestor/descendant queries.
  readonly treeClosure?: boolean;
  readonly versioning?: boolean;
  readonly expiry?: boolean;
  readonly temporal?: boolean | { readonly noOverlap?: readonly string[] };
  readonly scope?: boolean;
  readonly searchable?: boolean;
  // `singleton` (04-features.md §singleton-marker; 10-invariants.md §by-construction): DDL emits a
  // single-row guard so a second row cannot be written — exactly-one-row by construction.
  readonly singleton?: boolean;
  // `transitions` (03-api-shape.md §2 mech 2/3 + 06-generators.md §2a): the phantom carrier so the
  // faces subtract `status` from both write faces — the sole status writer is `ctx.transition(to)`.
  readonly transitions?: boolean;
  // `rollups` (03-api-shape.md §8): carrier holds the column names so the faces add them to `Row`,
  // framework-maintained. The kinded record form splits `count`/`sum` (`number`) from `avg`/`min`/`max`
  // (`number | null`, NULL on the empty set); the bare-name array form types every column as `count`.
  readonly rollups?: readonly string[] | Readonly<Record<string, RollupKind>>;
  // `vector` (04-features.md §vector): carrier holds the field name so the faces propagate the
  // framework-minted embedding column + its `_embedded_at`/`_source_hash`/`_model` shadow columns —
  // async-computed, never caller-written.
  readonly vector?: { readonly field: string };
}

/** The five maintained-aggregate kinds (03-api-shape.md §rollups; 02-dsl.md §rollup) — the type-level twin
 *  of repo.ts's `RollupKind` runtime union. `count`/`sum` are non-null (`number`, default 0); `avg`/`min`/
 *  `max` are `number | null` (NULL on the empty set). */
export type RollupKind = "count" | "sum" | "avg" | "min" | "max";

/** Kinds whose aggregate is NULL on the empty set → the column reads `number | null` in `Row`. */
export type NullableRollupKind = "avg" | "min" | "max";

/** Is feature K switched on in F? Robust to F omitting the key (an off feature). Needs literal `true`. */
export type On<F, K extends keyof Features> = K extends keyof F
  ? (F[K] extends true ? true : false)
  : false;

/** `temporal` accepts `true` or its option card (`{ noOverlap }`), so the plain `On<>`'s `extends true` cannot
 *  see the object form — the temporal-aware ON (the `immutable` frozen-fields precedent: option cards must not
 *  erase the feature's type faces). */
export type TemporalOn<F> = "temporal" extends keyof F
  ? (F["temporal"] extends false | undefined ? false : true)
  : false;

/** The frozen-field name union from a field-level `immutable:{fields:[…]}` carrier; `never` for the
 *  whole-resource `immutable:true` form (no field-level subtraction) and for no immutable at all. */
export type ImmutableFields<F> = F extends
  { immutable: { fields: infer Cols extends readonly string[] } } ? Cols[number]
  : never;

/** The rollup column-name union carried in `F` (both carrier forms: the bare-name array's element union,
 *  or the kinded record's key union); `never` when no `rollups` carrier is present. */
export type RollupCols<F> = F extends { rollups: infer R }
  ? (R extends readonly string[] ? R[number]
    : R extends Readonly<Record<infer K extends string, RollupKind>> ? K
    : never)
  : never;

/** The declared kind of rollup column `K` in `F` — the record carrier's value at `K`, else `"count"`
 *  (the bare-name array form types every column as a count). Drives the `number` vs `number | null` split. */
export type RollupKindOf<F, K extends string> = F extends { rollups: infer R }
  ? (R extends Readonly<Record<string, RollupKind>>
    ? (K extends keyof R ? R[K] : "count")
    : "count")
  : "count";

/** Is `sequence#` switched on in F? Unlike the generic `On`, this is true for both the bare boolean
 *  `true` and the object card `{ field, … }` — both mint the column (04-features.md §sequence#). The
 *  generic `On` only matches literal `true`, so the object form would be silently dropped without this. */
export type SeqOn<F> = F extends { sequence: infer S }
  ? ([S] extends [false | undefined] ? false : true)
  : false;

/** Is `tree` switched on in F? Like `SeqOn`, true for both the bare boolean `true` and the object card
 *  `{ onParentDelete?, parentField? }` — both make a tree resource (04-features.md §tree). The generic `On`
 *  only matches literal `true`, so the object form would silently drop the tree methods without this. */
export type TreeOn<F> = F extends { tree: infer T }
  ? ([T] extends [false | undefined] ? false : true)
  : false;

/** The sequence# column name carried in `F` (04-features.md §sequence# type-propagation): the object
 *  card's literal `field` when present, else `"seq"`. The single source the faces key on, so a
 *  renamed sequence (`field:"invoiceNo"`) propagates by name with zero hardcoding. */
export type SequenceField<F> = F extends
  { sequence: { field: infer N extends string } } ? N : "seq";

// Per-feature field additions to Row (non-optional when the framework guarantees the write;
// nullable when it is a lifecycle marker).
export type IdField = { readonly id: string };
export type Timestamps<F> = On<F, "timestamps"> extends true
  ? { readonly created_at: Date; readonly updated_at: Date }
  : Record<never, never>;
export type SoftDelete<F> = On<F, "softDelete"> extends true
  ? { readonly deleted_at: Date | null }
  : Record<never, never>;
/** `immutable:{rectifiable}` → the correction-chain lifecycle markers appear on `Row` (04-features.md §immutable):
 *  `superseded_by` points at the correcting row; `deleted_at` is the superseded stamp (the softDelete slot). */
export type Rectifiable<F> = F extends { immutable: { rectifiable: true } }
  ? { readonly superseded_by: string | null; readonly deleted_at: Date | null }
  : Record<never, never>;
export type Versioning<F> = On<F, "versioning"> extends true
  ? { readonly version: number }
  : Record<never, never>;
export type Expiry<F> = On<F, "expiry"> extends true
  ? { readonly expires_at: Date | null }
  : Record<never, never>;
export type Temporal<F> = TemporalOn<F> extends true
  ? { readonly valid_from: Date; readonly valid_to: Date | null }
  : Record<never, never>;
export type Scope<F> = On<F, "scope"> extends true
  ? { readonly scope_key: string }
  : Record<never, never>;
// `sequence#` adds the generated column (named by `field`, default `seq`), non-optional (04-features.md
// §sequence#). Reads as `number | string`: formatted (prefix/pad) is text, a bare counter is an integer.
export type Sequence<F> = SeqOn<F> extends true
  ? { readonly [K in SequenceField<F>]: number | string }
  : Record<never, never>;

// audit `onRow` — actor-pair stamps on the resource's own table (04-features.md §audit onRow):
// `created_by_*`/`updated_by_*` always, `deleted_by_*` iff `softDelete`. Subtracted from write faces.
type OnRowDeleted<F> = On<F, "softDelete"> extends true ? {
    readonly deleted_by_type: string | null;
    readonly deleted_by_id: string | null;
  }
  : Record<never, never>;
export type OnRow<F> = On<F, "onRow"> extends true ?
    & {
      readonly created_by_type: string | null;
      readonly created_by_id: string | null;
      readonly updated_by_type: string | null;
      readonly updated_by_id: string | null;
    }
    & OnRowDeleted<F>
  : Record<never, never>;

// roster/engine extracted into cohesive submodules, re-exported so importers stay stable.
export * from "./faces-shapes.ts";
