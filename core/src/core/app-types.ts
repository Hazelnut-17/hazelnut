// Barrel re-exports keep import sites stable.
import type { ColSpec, IdStrategy } from "../data/schema.ts";
import type { EncryptedConfig, KeySource } from "../features/encrypt.ts";
import type { VectorConfig } from "../features/embed.ts";
import type { MaskStyle } from "../features/redact.ts";
import type { ReadModelDef } from "../features/readmodel.ts";
import type {
  Cardinality,
  HttpRoute,
  McpCuration,
  OwnsSpec,
  RefSpec,
  RelateSpec,
  RollupSpec,
  UniqueSpec,
} from "./app-refs.ts";
import type { Features, RollupKind } from "./faces.ts";
import type { Node } from "./where.ts";
import type { z } from "zod";

/** The `transitions` edge object form (04-features.md §transitions edge form) — a plain string target with
 *  per-edge behavior: `guard` is a domain precondition (false/throw ⇒ a fail-closed `business` refuse);
 *  `onExit`/`onEnter` are same-tx follow-ups run only after the CAS wins, so a losing concurrent transition
 *  never fires them. Hooks get the row image + a narrow hctx, no raw db (heavy follow-ups belong to a subscriber). */
export interface TransitionEdge {
  readonly to: string;
  readonly guard?: (
    row: Readonly<Record<string, unknown>>,
    ctx: TransitionHookCtx,
  ) => boolean | Promise<boolean>;
  readonly onExit?: (
    row: Readonly<Record<string, unknown>>,
    ctx: TransitionHookCtx,
  ) => void | Promise<void>;
  readonly onEnter?: (
    row: Readonly<Record<string, unknown>>,
    ctx: TransitionHookCtx,
  ) => void | Promise<void>;
}
/** What a transition guard/hook may see: the principal, the edge, and the row id — deliberately no db handle
 *  (a hook that needs writes reacts to the `<module>.<resource>.transitioned` event in a subscriber). */
export interface TransitionHookCtx {
  readonly actor: unknown;
  readonly scope: string;
  readonly id: string;
  readonly from: string;
  readonly to: string;
}

export interface ResourceDecl {
  readonly name: string;
  // HTTP path segment override (02-dsl.md): mounts at `/${path}` instead of the default `/${name}s`.
  // `name` stays the DB/perm/MCP identity — URL is not forced to mechanical pluralization.
  readonly path?: string;
  // PK type config (02-dsl.md §id): `"uuidv7"` (default)/`"serial"`/`"uuidv4"`, a per-resource override of
  // the app default (the PK itself is by-construction, only its type is config). An unknown value loud-fails.
  readonly id?: IdStrategy;
  readonly schema: z.ZodObject<z.ZodRawShape>;
  readonly features?: Features;
  readonly operations?: Readonly<Record<string, unknown>>;
  readonly rowPolicy?: unknown;
  readonly http?: Readonly<Record<string, HttpRoute>>;
  readonly mcp?: McpCuration;
  readonly transitions?: Readonly<
    Record<string, readonly (string | TransitionEdge)[]>
  >;
  readonly unique?: readonly (readonly string[] | UniqueSpec)[]; // a plain `string[]` = full unique; a `{cols,where}` = partial (04-features.md §unique)
  // field names stored as the `bytea` envelope at rest (04-features.md §encrypted): the 90% list form
  // `["ssn"]`, or the object `{ fields, table?, key?, equality? }` (whole-row mode, a KMS key namespace,
  // and the blind-index equality subset).
  readonly encrypted?: readonly string[] | {
    readonly fields: readonly string[];
    readonly table?: boolean;
    readonly key?: string;
    readonly equality?: readonly string[];
  };
  readonly references?: Readonly<Record<string, RefSpec>>; // field → FK target
  // owned children (02-dsl.md §owns): `owns: { gallery: hasMany(child) }`. The relation key names the typed
  // eager-load accessor; createApp mints `<parent>_id` on the child and fills `ResourceModel.parent`/`parentFk`.
  readonly owns?: Readonly<Record<string, OwnsSpec>>;
  readonly rollups?: Readonly<Record<string, RollupSpec>>; // a maintained aggregate over a child (name → count(<child>))
  readonly relates?: Readonly<Record<string, RelateSpec>>; // many-to-many (a junction table is derived per pair)
  readonly searchable?: readonly string[]; // text fields indexed for full-text search (a tsvector + GIN are derived)
  // a semantic-vector field (04-features.md §vector): `field`/`source`/`dims` mint the embedding column,
  // source text, and width (vector(N)/halfvec(N) + HNSW). Lands async via the outbox re-embed job.
  readonly vector?: {
    readonly field: string;
    readonly source: string;
    readonly dims: number;
    readonly model?: string; // embedding model id — the staleness/migrate discriminator
  };
  readonly i18n?: readonly string[]; // translatable fields (a `<r>_i18n` sidecar table holds per-locale values)
  // the app-declared i18n fallback chain (04-features.md §i18n — `fallback:["zh-HK","en"]`, never a framework
  // default): the per-field resolution order `ctx.i18n.resolve` walks after the requested locale.
  readonly i18nFallback?: readonly string[];
  // PII fields to redact (04-features.md §sensitive): the list form `["phone"]`, or the object card
  // `{ fields, mask? }` (`mask: "full" (****) | "partial" (***-1234)`, default "full") selecting the log-mask style.
  readonly sensitive?: readonly string[] | {
    readonly fields: readonly string[];
    readonly mask?: MaskStyle;
  };
  // special (non-CRUD) permission keys into the typed vocabulary (13-authz.md §2, e.g. `viewInactive`);
  // CRUD keys derive from ops — these are the explicit extras.
  readonly capabilities?: readonly string[];
}

/** A derived many-to-many junction table for an (unordered) pair of resources. */
export interface JunctionModel {
  readonly name: string; // `<left>_<right>` (names sorted, so one junction per pair)
  readonly pgSchema: string;
  readonly left: string;
  readonly right: string;
  readonly leftFk: string; // `<left>_id`
  readonly rightFk: string; // `<right>_id`
  readonly ddl: string;
}

export interface ResourceModel {
  readonly name: string;
  // Declared HTTP path segment (02-dsl.md); absent ⇒ routeBase falls back to `/${name}s`.
  readonly path?: string;
  readonly module: string; // the owning module ("app" for the flat, module-less path)
  readonly moduleDeps: readonly string[]; // the owning module's declared `deps` (boundary/declared-deps source); [] for flat apps
  // the owning module's declared `exposes` — the public op surface a dependent may call via
  // `ctx.modules.<this module>.<op>` (05-runtime.md §ctx); [] for flat apps and modules exposing nothing.
  readonly moduleExposes: readonly string[];
  // the module's declared `exposesRead` — the read surface (view names) `ctx.modules.<this>.<view>` reads
  // (10-invariants.md §boundary); a cross-module read MUST go through a view, never the raw Row.
  readonly moduleExposesRead: readonly string[];
  // the module's declared `emits` — event topics it publishes (10-invariants.md §event). The verifier's
  // `event/subscribe-declared` reads the union across modules: a subscriber on an unemitted topic is dangling.
  readonly moduleEmits: readonly string[];
  readonly pgSchema: string; // the Postgres schema this resource's table lives in (= module name; "public" when flat)
  readonly schema: z.ZodObject<z.ZodRawShape>; // the runtime validator (the source the faces/DDL derive from)
  readonly features: Features;
  readonly idStrategy: IdStrategy; // the resolved PK type (02-dsl.md §id) — drives the PK DDL + the repo mint
  readonly columns: Record<string, ColSpec>;
  readonly ddl: string;
  readonly hasRowPolicy: boolean;
  readonly rowPolicy: unknown; // the declared `(actor) => Where` narrowing policy (or null); applied on `policy` reads
  // a verb absent from the declaration is a verb absent from this map — `Partial` says so; `StrictSurfaceKeys`
  // (app-define.ts) is the authoring-side door that already rejects an invented verb at `deno check`.
  readonly http: Readonly<Partial<Record<string, HttpRoute>>>;
  readonly mcp: McpCuration; // the curated agent surface — only these ops/reads project as MCP tools
  readonly transitions: Readonly<Record<string, readonly string[]>>;
  /** The per-edge guard/hook records (04-features.md §transitions edge form), keyed `from → to`. The plain
   *  string-target map above stays the one shape every legality/reachability reader walks; an edge object
   *  contributes its `to` there and its behavior here. Empty when every edge is the plain string form. */
  readonly transitionEdges: Readonly<
    Record<string, Readonly<Record<string, TransitionEdge>>>
  >;
  // all unique col-lists (plain + a partial's cols) — the cols-only readers (verify/metadata) ride this
  readonly unique: readonly (readonly string[])[];
  // the partial-unique predicates (04-features.md §unique) — a subset of `unique`, carrying the boot-validated
  // local `where` Node the index emitter lowers into `WHERE <predicate>`. Empty when none declared.
  readonly uniquePartial: readonly {
    readonly cols: readonly string[];
    readonly where: Node;
  }[];
  // the encrypted field list (bytea envelope at rest) — the flat list repo/verify read (parsed card:
  // `encryptedConfig` below)
  readonly encrypted: readonly string[];
  // the fully-parsed encrypted card (fields + table + key namespace) — 04-features.md §encrypted
  readonly encryptedConfig: EncryptedConfig;
  // where the master key was sourced (04-features.md §encrypted): `"config"` (via defineConfig) or `"none"`
  // (boot guard refuses). No branded env var read; `encrypted/key-source` advisory reads this single source.
  readonly encryptedKeySource: KeySource;
  readonly references: Readonly<Record<string, RefSpec>>;
  // the reverse-reference sweep index (03-api-shape.md §onDelete): children whose declared `onDelete` the DB
  // clause can't honestly honor (a soft-deleting parent, or an audited/soft-deleting child); the repo sweeps
  // them in-tx (cascade/set-null follow their own semantics, restrict pre-checks and aborts). [] when the DB clause suffices.
  readonly onDeleteSweeps: ReadonlyArray<
    {
      readonly child: ResourceModel;
      readonly fk: string;
      readonly onDelete: "cascade" | "set-null" | "restrict";
    }
  >;
  // the forward-reference index (03-api-shape.md §onDelete): modeled FKs pointing at a soft-deleting parent.
  // Write path refuses an FK on a tombstoned parent via a `FOR SHARE` probe (race-safe against the remover's
  // FOR UPDATE); `self` marks the tree self-FK.
  readonly softDeleteParentRefs: ReadonlyArray<
    {
      readonly fk: string;
      readonly parentTable: string;
      readonly parentName: string;
      readonly self?: true;
    }
  >;
  readonly parent: string | null; // the owning parent resource (child relation), or null
  readonly parentFk: string | null; // the minted FK column to the parent (`<parent>_id`), or null
  // the parent-side named owned-child relations (02-dsl.md §owns) — relation-name → { child resource, cardinality }.
  // The runtime `with: { <name>: true }` eager-load surface and verify read this; {} when the resource owns nothing.
  readonly owns: Readonly<
    Record<
      string,
      { readonly child: string; readonly cardinality: Cardinality }
    >
  >;
  // the declared many-to-many relations (02-dsl.md §relates) — relation-name → { to: target resource }. Only
  // the declaring side carries names; junctions are symmetric, derived per sorted pair on `app.junctions`.
  readonly relates: Readonly<Record<string, { readonly to: string }>>;
  readonly operations: Readonly<Record<string, unknown>>; // declared ops (each a `defineOp({...})`), dispatched by name
  // rollups this resource's writes maintain on its parent (03-api-shape.md §8). `count`/`sum` ride an atomic
  // `± delta`; `avg`/`min`/`max` recompute the column over the surviving child set (NULL on empty) instead.
  readonly rollupTargets: ReadonlyArray<
    {
      readonly parentTable: string;
      readonly parentFk: string;
      readonly column: string;
      readonly kind: RollupKind;
      readonly field?: string;
    }
  >;
  // the owner-side maintained aggregate column names (`decl.rollups` keys) — framework-maintained by the
  // children's writes, never caller-written. The write-plan's `rollups` card reads this.
  readonly rollupOwnCols: readonly string[];
  // columns a `tamperEvident` hash must exclude (`encrypted` envelopes, vector embedding cols, own rollup cols) —
  // hashing them would false-flag `verifyHashChain` on the next maintenance write. Derived via `volatileColsOf`; read only by tamper.ts.
  readonly tamperVolatileCols: readonly string[];
  readonly searchable: readonly string[]; // full-text-indexed fields
  // the parsed semantic-vector card (04-features.md §vector) — the field/source/dims/model the DDL mints,
  // the repo embeds (async via outbox), and the verifier's vector/* invariants read. null when no vector.
  readonly vector: VectorConfig | null;
  readonly i18n: readonly string[]; // translatable fields (sidecar `<name>_i18n`)
  // the derived `<name>_i18n` sidecar DDL (null when no translatable fields) — the single source migrate
  // applies and verify checks
  readonly i18nDdl: string | null;
  // `file()` fields holding an opaque off-box storage key — the marker the StorageDriver Port and the
  // `file/*` invariants read
  readonly files: readonly string[];
  // `password()` fields holding a salted slow-KDF hash (13-authz §password-auth-recipe) — hashed on write,
  // auto-sensitive; the marker the `password/*` invariants read
  readonly passwords: readonly string[];
  // the app-declared i18n fallback chain (04-features.md §i18n), threaded from the decl — the per-field
  // resolution order `translate` walks after the requested locale. [] when none declared.
  readonly i18nFallback: readonly string[];
  readonly sensitive: readonly string[]; // PII fields to redact in logs/errors
  // Did the DECLARATION carry a `sensitive` key at all (either form, `[]` included)? `sensitive` alone cannot
  // answer that — an absent card and `sensitive: []` both normalize to the same set — and
  // `audit/sensitive-declared` refuses the first while accepting the second as the explicit "no PII here".
  readonly sensitiveDeclared: boolean;
  // the log-mask style for this resource's `sensitive` fields (04-features.md §sensitive — `"full"`/`"partial"`),
  // threaded from `sensitive:{ mask }`. Default `"full"` (fail-safe — a leaked tail is still PII).
  readonly maskStyle: MaskStyle;
  // the declared special (non-CRUD) permission keys — [] when none; the model field a capability invariant reads
  readonly capabilities: readonly string[];
  // the auto-seeded permission vocabulary (13-authz.md §authz-seam): `<name>:<key>` wire strings for the five
  // CRUD verbs ∪ the `read` alias ∪ every custom op ∪ every capability, derived by `derivePerms(decl)`.
  // Sorted; unioned into `app.perms`. HTTP GET is not gated on `read` — list/find stay row-policy-gated.
  readonly perms: readonly string[];
  // the materialized read-models this resource is a source of — names of `defineReadModel` projections to
  // enqueue an outbox-fenced re-projection job on every create/update/remove.
  readonly readModelSinks: readonly string[];
}

/** A module groups resources under one pg schema (the monolithic-modular boundary). */
export interface ModuleDecl {
  readonly name: string;
  readonly resources: ReadonlyArray<ResourceDecl>;
  readonly deps?: readonly string[]; // declared module dependencies (boundary — enforced in a later phase)
  readonly exposes?: readonly string[]; // ops exposed to dependents — the cross-module call surface (ctx.modules.<this>.<op>)
  // the read-side public surface (10-invariants.md §boundary) — names of `defineView` projections this module
  // exposes for cross-module reads. Must resolve to a declared narrowing view (never the producer's raw Row,
  // `boundary/cross-read-narrowed`); an unresolvable name is a loud boot fail.
  readonly exposesRead?: readonly string[];
  /** Event topics this module publishes, each with its payload contract (05-runtime.md §event-surface-lock):
   *  the shape enters the committed `event-surface.lock` and is strict-parsed at `ctx.emit`, so a wrong-shaped
   *  payload errs and the op rolls back. There is no contract-free spelling — a topic with no shape armed
   *  neither protection while reading as a complete declaration. */
  readonly emits?: Readonly<Record<string, z.ZodType>>;
  /** Materialized `defineReadModel` projections over THIS module's resources. A read model projects exactly
   *  one `source` resource, so it belongs to the module that owns that resource — declaring it here is what
   *  lets `Ctx<typeof thisModule>` type `ctx.readModels.<name>`, on the same boundary `ctx.data` already has.
   *  A source outside this module is a loud boot fail (`readmodel/source-in-module`). */
  readonly readModels?: ReadonlyArray<ReadModelDef>;
}

/** Normalize a module's `emits` declaration (either form) to its topic names — the list `moduleEmits` carries
 *  and `event/subscribe-declared` reads; the typed form's schemas travel separately on `App.emitSchemas`. */
export function emitTopics(
  emits: readonly string[] | Readonly<Record<string, z.ZodType>> | undefined,
): readonly string[] {
  if (emits === undefined) return [];
  return Array.isArray(emits) ? emits : Object.keys(emits);
}
