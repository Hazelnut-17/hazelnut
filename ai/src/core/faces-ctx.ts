/**
 * The faces→ctx bridge (03-api-shape.md §2 + §6): the four type faces reach the op-handler's hands.
 * `ctx.data.<r>.*` typing derives from `defineResource`; op input derives from `input:` (`defineOp`).
 * Every import is `import type` — type-only, so the runtime `ctx.data` object is untouched.
 */
import type { Actor } from "../authz/auth.ts";
import type { CursorPage, Page } from "../data/repo.ts";
import type { RollupSpec } from "./app-refs.ts";
import type { ResourceDecl } from "./app-types.ts";
import type { OnlyKnownKeys } from "./config.ts";
import type { Features, RollupKind } from "./faces.ts";
import type { InsertableFixture, Row, ScopedRepo } from "./faces-shapes.ts";
import type { OpCtx, OpDecl, Result } from "./pipeline.ts";
import type { Where } from "./where.ts";
import type { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// The typed per-resource binding: the canon face + the documented runtime extensions.
// ─────────────────────────────────────────────────────────────────────────────

/** The documented `ctx.data.<r>` extensions beyond BaseRepo (05-runtime.md §ctx; data.ts): keyset
 *  pagination (`listPage`), the batched id read (`byIds`), and the owned-child read (`children`). */
export interface RepoExtensions<R, F extends Features> {
  listPage(
    page: Page,
    where?: Where<Row<R, F>>,
  ): Promise<CursorPage<Row<R, F>>>;
  byIds(ids: string[]): Promise<Result<Row<R, F>[]>>;
  children(parentId: string): Promise<Result<Row<R, F>[]>>;
}

/** The typed `ctx.data.<r>` binding: the canon `ScopedRepo` face (03-api-shape.md §2) intersected
 *  with the documented runtime extensions. Every field position is a face type, so a typo'd or
 *  framework-owned field (`id`, `status` under `transitions`, `scope_key`) does not compile. */
export type TypedResourceData<R, F extends Features> =
  & ScopedRepo<R, F>
  & RepoExtensions<R, F>;

// ─────────────────────────────────────────────────────────────────────────────
// Declaration → phantom Features: fold the top-level phantom inputs into the carrier.
// ─────────────────────────────────────────────────────────────────────────────

/** A `RollupSpec`'s declared kind — the literal `kind` when the spec carries one (the `count`/`sum`/
 *  `avg`/`min`/`max` helpers return it as a literal), else `"count"` (the bare shape). */
type RollupKindOfSpec<S> = S extends
  { readonly kind: infer K extends RollupKind } ? K : "count";

/**
 * The declaration's phantom `Features` carrier (03-api-shape.md §2): the declared `features` joined
 * with the top-level keys the faces key on (`transitions`, `rollups`, `vector`, `searchable`).
 */
export type PhantomOf<D extends ResourceDecl> =
  & (D extends { readonly features: infer F extends Features } ? F
    : Record<never, never>)
  & (D extends
    { readonly transitions: Readonly<Record<string, readonly unknown[]>> }
    ? { readonly transitions: true }
    : Record<never, never>)
  & (D extends
    { readonly rollups: infer RS extends Readonly<Record<string, RollupSpec>> }
    ? {
      readonly rollups: {
        readonly [K in keyof RS & string]: RollupKindOfSpec<RS[K]>;
      };
    }
    : Record<never, never>)
  & (D extends { readonly vector: { readonly field: infer VF extends string } }
    ? { readonly vector: { readonly field: VF } }
    : Record<never, never>)
  & (D extends { readonly searchable: readonly string[] }
    ? { readonly searchable: true }
    : Record<never, never>);

/** Normalize the `Ctx<T>` argument to a union of resource declarations: a module (its `resources`
 *  tuple), a decls array/tuple, or a bare decl/union of decls. */
type DeclUnion<T> = T extends
  { readonly resources: infer Rs extends readonly ResourceDecl[] } ? Rs[number]
  : T extends readonly ResourceDecl[] ? T[number]
  : T extends ResourceDecl ? T
  : never;

/** The parent resource name that `owns` this child inside witness `T` (02-dsl.md §owns). Empty when the
 *  parent (carrying `owns`) is not in the witness — expand `resources:` to include it so create is typed. */
type ParentNameOwning<T, Child extends string> = DeclUnion<T> extends infer D
  ? D extends {
    readonly name: infer N extends string;
    readonly owns?: infer O;
  } ? O extends Record<string, { readonly to: Child }> ? N
    : never
  : never
  : never;

/** Framework-minted FK column for an `owns` child (`<parent>_id`, app-boot.ts) — absent from the zod
 *  schema, so the faces add it when the owning parent is visible in `T`. */
type ParentFkFromOwns<T, Child extends string> =
  [ParentNameOwning<T, Child>] extends [never] ? Record<never, never>
    : { readonly [K in `${ParentNameOwning<T, Child>}_id`]: string };

/** The typed `relates` junction methods (02-dsl.md §relates), present only when the resource declared
 *  `relates`, with the declared relation names bound to `relName` — a typo'd name does not compile
 *  (mechanism 4). Ids are opaque PK strings; `related` returns the scope-visible opposite ids. */
type RelateMethods<D> = D extends {
  readonly relates: infer RS extends Readonly<
    Record<string, { readonly to: string }>
  >;
} ? {
    link(
      relName: keyof RS & string,
      id: string,
      otherId: string,
    ): Promise<Result<void>>;
    unlink(
      relName: keyof RS & string,
      id: string,
      otherId: string,
    ): Promise<Result<void>>;
    related(relName: keyof RS & string, id: string): Promise<Result<string[]>>;
  }
  : Record<never, never>;

/** One declaration → its typed `ctx.data.<r>` face: `R = z.infer<schema>` (+ the parent-FK column when
 *  an `owns` edge in witness `T` names this resource) + the phantom carrier + the `relates` methods. */
export type DeclData<D extends ResourceDecl, T = D> = PhantomOf<D> extends
  infer F extends Features ?
    & TypedResourceData<
      z.output<D["schema"]> & ParentFkFromOwns<T, D["name"] & string>,
      F
    >
    & RelateMethods<D>
  : never;

/** What a `resources:` witness may BE — exactly the three shapes `DeclUnion` normalizes. `defineOp`
 *  constrains its witness to this, so a mis-shaped value (the object form `{ note }` where the tuple form
 *  `[note]` belongs) is refused at the DECLARATION rather than surviving to a `DataOf<…>` dump at the
 *  first `ctx.data` access. */
export type ResourceWitness =
  | { readonly resources: readonly ResourceDecl[] }
  | readonly ResourceDecl[]
  | ResourceDecl;

/** The typed `ctx.data` map — resource name → its typed face. A wrong resource name is a compile error. */
export type DataOf<T> = {
  readonly [K in DeclUnion<T>["name"] & string]: DeclData<
    Extract<DeclUnion<T>, { readonly name: K }>,
    T
  >;
};

/** One declaration → its typed fixture value, off the SAME row + phantom `DeclData` derives its `create`
 *  from. Sharing the derivation is the point: a fixture the harness builds is assignable to the `create`
 *  of the resource it was built for, by construction rather than by two definitions agreeing. */
export type DeclFixture<D extends ResourceDecl, T = D> = PhantomOf<D> extends
  infer F extends Features ? InsertableFixture<
    z.output<D["schema"]> & ParentFkFromOwns<T, D["name"] & string>,
    F
  >
  : never;

/** The typed fixture map — resource name → its insertable, keyed exactly like `DataOf`. */
export type FixturesOf<T> = {
  readonly [K in DeclUnion<T>["name"] & string]: DeclFixture<
    Extract<DeclUnion<T>, { readonly name: K }>,
    T
  >;
};

// ─────────────────────────────────────────────────────────────────────────────
// Declaration → typed ctx.readModels (02-dsl.md §defineReadModel): the projections declared beside the
// resources they project, so the same anchor that types `ctx.data` types this face too.
// ─────────────────────────────────────────────────────────────────────────────

/** The `defineReadModel` declarations a `Ctx<T>` argument carries — a module's `readModels`, or a bare
 *  config's. Read models sit BESIDE the resources they project, so this reads the same level `DeclUnion`
 *  does and inherits the module boundary rather than reaching past it. */
type ReadModelUnion<T> = T extends {
  readonly readModels: infer RMs extends readonly { readonly name: string }[];
} ? RMs[number]
  : never;

/** One read-model declaration → its `read` face. The row stays the projection's own shape when the decl
 *  carries one (`defineReadModel<Row>`), so a field typo is a compile error too, not only a name typo. */
type ReadModelReaderOf<D> = {
  read(
    q?: { readonly id?: string },
  ): Promise<
    Array<
      D extends { readonly project: (row: never) => infer R } ? R
        : Record<string, unknown>
    >
  >;
};

/**
 * The typed `ctx.readModels` map — projection name → its reader. A name the module does not declare is a
 * compile error, where every op in the tree used to hold `Record<string, Reader | undefined>`: the `!` a
 * handler had to write was the tell that no anchor reached this face.
 *
 * A module declaring none keeps the base (untyped) member. That is not a hole left open — it is the honest
 * answer for a config whose read models the anchor cannot see, and it keeps a resource-only witness from
 * silently claiming a face it knows nothing about.
 */
export type ReadModelsOf<T> = [ReadModelUnion<T>] extends [never]
  ? Pick<OpCtx, "readModels">
  : {
    readonly readModels: {
      readonly [K in ReadModelUnion<T>["name"] & string]: ReadModelReaderOf<
        Extract<ReadModelUnion<T>, { readonly name: K }>
      >;
    };
  };

// ─────────────────────────────────────────────────────────────────────────────
// Declaration → typed ctx.modules / ctx.reads (05-runtime.md §ctx): the two cross-module doors, keyed on
// the deps a module DECLARES and on the surface each of those deps PUBLISHES.
// ─────────────────────────────────────────────────────────────────────────────

/** The dep declarations a `Ctx<T>` anchor carries. `defineModule` normalizes `deps` to names for the composed
 *  model and keeps the values here, because a name cannot carry a type: only the dep's own decl can. */
type DepUnion<T> = T extends
  { readonly depModules: infer Ds extends readonly unknown[] } ? Ds[number]
  : never;

/** One dep resource's custom-op names, distributed over the dep's resource tuple. A CRUD verb is NEVER among
 *  them, which is exactly why it is not cross-module callable (`data-ctx.ts §modulesOf` resolves an exposed
 *  name against a resource's `operations` and skips what it cannot find). */
type OpNamesOfResource<R> = R extends { readonly operations: infer Ops }
  ? keyof Ops & string
  : never;
type CustomOpNamesOf<D> = D extends
  { readonly resources: infer Rs extends readonly unknown[] }
  ? OpNamesOfResource<Rs[number]>
  : never;

/** The one op declaration a name resolves to inside a dep module — the type-level twin of `modulesOf`'s
 *  `depModels.find(m => opName in m.operations)`. */
type OpDeclOfResource<R, K extends string> = R extends
  { readonly operations: infer Ops } ? (K extends keyof Ops ? Ops[K] : never)
  : never;
type DepOpDecl<D, K extends string> = D extends
  { readonly resources: infer Rs extends readonly unknown[] }
  ? OpDeclOfResource<Rs[number], K>
  : never;

/** The un-narrowed cross-module call/read signatures, read off the runtime surface so this file mints no
 *  second copy of them and needs no import from the view layer. */
type CrossCallFn = NonNullable<NonNullable<OpCtx["modules"][string]>[string]>;
type CrossReadFn = NonNullable<NonNullable<OpCtx["reads"][string]>[string]>;

/** One exposed op → its call signature. The producer's `input:` schema types the argument and its handler the
 *  result, so a producer renaming an input field is a compile error at every consumer call site. */
type DepCallOf<T> = T extends {
  readonly handler: (
    input: infer I,
    ...rest: never[]
  ) => Promise<Result<infer O>>;
} ? (input: I, idempotencyKey?: string) => Promise<Result<O>>
  : CrossCallFn;

type ExposedOpsOf<D> = D extends
  { readonly exposes: infer E extends readonly string[] } ? E[number]
  : never;
type ExposedReadsOf<D> = D extends
  { readonly exposesRead: infer R extends readonly string[] } ? R[number]
  : never;

/** What a dep actually PUBLISHES: its `exposes` names ∩ its resources' custom ops — the same intersection
 *  `modulesOf` wires, so a CRUD verb left in `exposes` (declarable, but inert) is not claimed here either. */
type DepFacadeOf<D> = {
  readonly [K in Extract<ExposedOpsOf<D>, CustomOpNamesOf<D>>]: DepCallOf<
    DepOpDecl<D, K>
  >;
};

/** A dep's read surface — the view names it lists in `exposesRead`. The value stays OPTIONAL: a run-form view
 *  (no `over`) may be listed and is never wired (`data-ctx.ts §readsOf`), so absence must still be handled. */
type DepReadsOf<D> = { readonly [V in ExposedReadsOf<D>]?: CrossReadFn };

/** The no-face answers, written INLINE rather than behind an alias: TypeScript prints an alias by name and an
 *  anonymous object by its members, so the member key IS what the author reads (the `OpCtxOf` idiom). */
type NoModulesFace = {
  readonly [
    'no dep module VALUE reaches this ctx, so ctx.modules has no typed face — declare the dep as a value on the module that owns this op (`deps: [theDepModule]`, not `deps: ["theDep"]`) and annotate `ctx: Ctx<YourModule>`'
  ]: never;
};
type NoReadsFace = {
  readonly [
    'no dep module VALUE reaches this ctx, so ctx.reads has no typed face — declare the dep as a value on the module that owns this op (`deps: [theDepModule]`, not `deps: ["theDep"]`) and annotate `ctx: Ctx<YourModule>`'
  ]: never;
};

/** The typed `ctx.modules` map — dep name → the ops that dep exposes. An invented dep, an invented op, or an
 *  op the dep declares but does not expose is a compile error, where every op in the tree used to hold a
 *  string-keyed `Record` whose argument was `unknown`: the `!!` a handler had to write was the tell.
 *
 *  The facade is only as narrow as the anchor. A module built by `defineModule` with dep VALUES keys exactly;
 *  a dep named by string, or a hand-built `ModuleDecl` literal, keys nothing and says so. */
export type ModulesOf<T> = [DepUnion<T>] extends [never] ? NoModulesFace
  : {
    readonly [
      D in DepUnion<T> as D extends { readonly name: infer N extends string }
        ? N
        : never
    ]: DepFacadeOf<D>;
  };

/** The typed `ctx.reads` map — dep name → the views that dep lists in `exposesRead` (03-api-shape.md §2). */
export type ReadsOf<T> = [DepUnion<T>] extends [never] ? NoReadsFace
  : {
    readonly [
      D in DepUnion<T> as D extends { readonly name: infer N extends string }
        ? N
        : never
    ]: DepReadsOf<D>;
  };

// ─────────────────────────────────────────────────────────────────────────────
// Graph-typed ctx.transition (03-api-shape.md §2): typed against the declared graph.
// ─────────────────────────────────────────────────────────────────────────────

/** The status-node union of one declaration's transitions graph (every declared state is a key —
 *  terminal states carry `[]`), or `never` for a non-FSM resource. Distributes over a decl union. */
type StatusNodes<D> = D extends {
  readonly transitions: infer G extends Readonly<
    Record<string, readonly string[]>
  >;
} ? keyof G & string
  : never;

/** The module-wide declared status vocabulary — the single-arg `ctx.transition(to)` bound. The subject
 *  resource is a runtime binding, so the type bound is the union across the module's FSM resources; exact
 *  per-subject-graph checking is the 3-arg form's job (each overload pins one resource's own graph). */
type StatusesOf<T> = StatusNodes<DeclUnion<T>>;

/** One per-FSM-resource 3-arg overload — `transition(resource, id, to)` with `to` pinned to that
 *  resource's own graph nodes, so a legal-elsewhere status on the wrong resource does not compile. */
type ThreeArgOf<D> = D extends {
  readonly name: infer N extends string;
  readonly transitions: infer G extends Readonly<
    Record<string, readonly string[]>
  >;
} ? {
    transition(
      resource: N,
      id: string,
      to: keyof G & string,
    ): Promise<Result<{ id: string; status: string }>>;
  }
  : never;

type UnionToIntersection<U> =
  (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I
    : never;

/** The typed `ctx.transition` member: the module's status-vocabulary single-arg + one exact 3-arg
 *  overload per FSM resource. A module with no declared transitions keeps the base (untyped) member —
 *  nothing to check against, and the runtime already rejects a subject-less/graph-less call loud. */
type TypedTransition<T> = [StatusesOf<T>] extends [never]
  ? Pick<OpCtx, "transition">
  :
    & {
      transition(
        to: StatusesOf<T>,
      ): Promise<Result<{ id: string; status: string }>>;
    }
    & UnionToIntersection<
      ThreeArgOf<
        Extract<
          DeclUnion<T>,
          { readonly transitions: Readonly<Record<string, readonly string[]>> }
        >
      >
    >;

/**
 * The typed op-handler ctx (03-api-shape.md §6 — `ctx: Ctx<ThisModule>`, realized): `ctx.data` becomes
 * the per-resource typed map, `ctx.transition` checks against the declared status graphs, and the two
 * cross-module doors key on the module's declared deps. Type-only — at runtime the pipeline hands the
 * same composed surface it always did.
 */
export type Ctx<T> =
  & Omit<OpCtx, "data" | "transition" | "readModels" | "modules" | "reads">
  & { readonly data: DataOf<T> }
  & TypedTransition<T>
  & ReadModelsOf<T>
  & { readonly modules: ModulesOf<T>; readonly reads: ReadsOf<T> };

// ─────────────────────────────────────────────────────────────────────────────
// defineOp — the typed op declaration: input from the schema, ctx from Ctx<...>.
// ─────────────────────────────────────────────────────────────────────────────

/** `OpPolicy` with the input bound to the schema and the ctx parameter generic; `null` is the ungated
 *  door said out loud (a pre-auth login). */
type TypedPolicy<S extends z.ZodType, C> =
  | ((
    actor: Actor | null,
    input: z.output<S>,
    ctx: C,
  ) => boolean | Promise<boolean>)
  | null;

/** The tx↔policy↔idempotent triple `OpDef` splits, restated over the schema-bound input: every op writes its
 *  authorization decision and every write its retry verdict, so an op with either decision unmade does not
 *  compile. Only `tx:"read"` may omit the verdict — a read never consults the idempotency store. */
/** A compiler-message carrier: uninhabitable (its one property is `never`), so it never widens what a
 *  declaration may hold — the message exists only to be printed by the mismatch that reaches it. */
type TxHint<M extends string> = { readonly [K in M]: never };

type TypedTxDecisionSlot<S extends z.ZodType, C> =
  | {
    readonly tx: "read";
    readonly policy: TypedPolicy<S, C>;
    /** Branded, not `never`: the diagnostic is what the author acts on, and `never` made it name `tx`,
     *  whose stated fix — `tx: "write"` — compiles and silently turns a read into a write. The brand is an
     *  UNINHABITABLE object, so the message can never itself be written as a value. */
    readonly idempotent?: TxHint<
      'remove `idempotent` — a tx:"read" op never consults the idempotency store'
    >;
  }
  | {
    /** Branded for the same reason from the other side: reached with `tx: "read"`, the arm's own message is
     *  the diagnostic, so no ordering of the object literal can propose the semantics-changing edit. */
    readonly tx?:
      | "write"
      | TxHint<
        'a tx:"read" op takes no `idempotent` — remove that key, do not make this a write'
      >;
    readonly policy: TypedPolicy<S, C>;
    readonly idempotent: boolean;
  };

/** The `defineOp` fields minus the tx↔policy↔idempotent triple. `output` pins `O` at COMPILE time only —
 *  no runtime door reads it, and the op-door fold (03-api-shape.md §op-door-projection) subtracts by name
 *  from the handler's value whether or not it is declared here. */
interface TypedOpFields<S extends z.ZodType, O, C> {
  readonly input: S;
  readonly output?: z.ZodType<O>;
  readonly idempotencyLeaseMs?: number;
  readonly deadlineMs?: number;
  // op-deprecation metadata (RFC-9745; mirrors OpDef in pipeline.ts) — additive and inert on the MCP/logic
  // paths; surface-lock never treats marking-deprecated as a break. Preserved through defineOp's cast.
  readonly deprecated?: string;
  readonly sunset?: string;
  readonly replacedBy?: string;
  readonly before?: (
    input: z.output<S>,
    ctx: C,
  ) => Promise<Result<z.output<S> | void>> | Result<z.output<S> | void>;
  readonly after?: (
    input: z.output<S>,
    ctx: C,
  ) => Promise<Result<void>> | Result<void>;
  readonly handler: (input: z.output<S>, ctx: C) => Promise<Result<O>>;
  readonly replace?: (input: z.output<S>, ctx: C) => Promise<Result<O>>;
  readonly around?: (
    input: z.output<S>,
    ctx: C,
    next: () => Promise<Result<O>>,
  ) => Promise<Result<O>>;
}

/** The `defineOp` declaration shape — `OpDecl` with the input type bound to the schema (`z.output<S>`)
 *  and the ctx parameter generic (`C`), so annotating `ctx: Ctx<M>` face-checks every `ctx.data` access. */
export type TypedOpDecl<S extends z.ZodType, O, C> =
  & TypedOpFields<S, O, C>
  & TypedTxDecisionSlot<S, C>;

/** The op ctx a `resources:` VALUE WITNESS derives — `Ctx<M>`, so `ctx.data` and `ctx.transition` are both
 *  typed. No witness ⇒ every other member of `OpCtx` unchanged, but `data` carries a message instead of a
 *  face: reaching it is a compile error at the DECLARATION, and the message names both anchors. The shape
 *  is written inline rather than behind an alias on purpose — TypeScript prints an alias by name and an
 *  anonymous object by its members, so the member key IS what the author (or an agent) reads. An op that
 *  never touches `ctx.data` needs no witness and compiles untouched. */
export type OpCtxOf<M> = [M] extends [undefined] ? Omit<OpCtx, "data"> & {
    readonly data: {
      readonly [
        "this op declares no `resources:` witness and no `ctx:` annotation, so ctx.data has no typed face — add `resources: [<the decls this op touches>]`, or annotate `ctx: Ctx<YourModule>`"
      ]: never;
    };
  }
  : Ctx<M>;

/**
 * Declare a typed op. The input type derives from `input:`; the ctx derives from `resources:` — pass the
 * resource decls this op touches and every `ctx.data.<r>.*` call is checked against their faces, with no
 * annotation to forget. An op declared INLINE in its own module cannot name that module (it would be a type
 * cycle), which is exactly why the anchor is a value: the decls exist before the module does.
 *
 * An op in a SEPARATE file may instead annotate `ctx: Ctx<ThisModule>` and reach the whole module's faces;
 * the annotation wins over the witness. Reaching neither leaves `ctx.data` without a face, and touching it
 * is then a compile error carrying its own fix (`OpCtxOf`) — never a silently untyped Record.
 *
 * The witness slot takes a MODULE as readily as a decl tuple, and that is how an op reaches the cross-module
 * doors without an annotation: a module carries its `deps`, so `resources: thisModule` types `ctx.modules` /
 * `ctx.reads` too (§ModulesOf). A bare decl tuple names no module and so reaches no dep.
 *
 * `M` is CONSTRAINED to `ResourceWitness` so a mis-shaped witness — the object form `resources: { note }`
 * for the tuple form `resources: [note]` — is refused here rather than surfacing downstream as a `DataOf<…>`
 * dump at the first `ctx.data` access.
 *
 * The cast is the one sanctioned widening — safe by construction because the pipeline invokes every handler
 * with the same composed surface, whatever subset the declaration named.
 */
export function defineOp<
  S extends z.ZodType,
  O,
  const M extends ResourceWitness | undefined = undefined,
  C = OpCtxOf<M>,
  D = unknown,
>(
  decl:
    & TypedOpDecl<S, O, C>
    & { readonly resources?: M }
    & OnlyKnownKeys<D, TypedOpDecl<S, O, C> & { readonly resources?: M }>,
): OpDecl<z.output<S>, O> {
  return decl as unknown as OpDecl<z.output<S>, O>;
}
