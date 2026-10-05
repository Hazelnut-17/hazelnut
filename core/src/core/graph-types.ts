import type { ResourceDecl } from "./app-types.ts";
import type { DeclRow, PhantomOf } from "./faces-ctx.ts";
import type { TemporalOn } from "./faces.ts";
import type { Result } from "./result.ts";
import type { Condition, Shorthand, Where } from "./where.ts";

type Declarations<T> = T extends
  { readonly resources: infer R extends readonly ResourceDecl[] } ? R[number]
  : T extends readonly ResourceDecl[] ? T[number]
  : T extends ResourceDecl ? T
  : never;
type Target<T, N> = string extends N ? never
  : Extract<Declarations<T>, { readonly name: N }>;
type OwnEdges<D> = D extends { readonly owns: infer E } ? E
  : Record<never, never>;
type RefEdges<D> = D extends { readonly references: infer E } ? {
    [K in keyof E as E[K] extends { readonly external: true } ? never : K]:
      & E[K]
      & { readonly cardinality: "one" };
  }
  : Record<never, never>;
type ManyEdges<D> = D extends { readonly relates: infer E } ? {
    [K in keyof E]: E[K] & { readonly cardinality: "many" };
  }
  : Record<never, never>;
type Ambiguous<D> =
  | (keyof OwnEdges<D> & keyof RefEdges<D>)
  | (keyof OwnEdges<D> & keyof ManyEdges<D>)
  | (keyof RefEdges<D> & keyof ManyEdges<D>);
type Edges<D> = Omit<OwnEdges<D> & RefEdges<D> & ManyEdges<D>, Ambiguous<D>>;
type EdgeKinds<D> = {
  owns: OwnEdges<D>;
  ref: RefEdges<D>;
  manyToMany: ManyEdges<D>;
};
type Choice<D> = {
  [K in keyof EdgeKinds<D>]: {
    readonly kind: K;
    readonly name: keyof EdgeKinds<D>[K] & string;
  };
}[keyof EdgeKinds<D>];
type Chosen<D, K, S> = S extends {
  readonly relation: { readonly kind: infer Kind; readonly name: infer Name };
}
  ? Kind extends keyof EdgeKinds<D>
    ? Name extends keyof EdgeKinds<D>[Kind] ? EdgeKinds<D>[Kind][Name] : never
  : never
  : K extends keyof Edges<D> ? Edges<D>[K]
  : never;
type ChosenTarget<D, T, K, S> = Chosen<D, K, S> extends { readonly to: infer N }
  ? Target<T, N>
  : never;
type EdgeTarget<D, T, K extends keyof Edges<D>> = Edges<D>[K] extends
  { readonly to: infer N } ? Target<T, N> : never;
type At<D extends ResourceDecl> = TemporalOn<PhantomOf<D>> extends true
  ? { readonly asOf?: Date }
  : Record<never, never>;

/** Every node is positive selection over its declaration witness, never an ORM table. */
export type GraphOptions<
  D extends ResourceDecl,
  T = D,
  Depth extends readonly unknown[] = [],
> = {
  readonly columns?: readonly (keyof DeclRow<D, T> & string)[];
  readonly with?: Depth["length"] extends 8 ? never : {
    readonly [
      K in keyof Edges<D> as [EdgeTarget<D, T, K>] extends [never] ? never
        : K
    ]?: GraphOptions<EdgeTarget<D, T, K>, T, [...Depth, unknown]>;
  };
  readonly where?: Where<DeclRow<D, T>>;
  readonly orderBy?: readonly (keyof DeclRow<D, T> & string)[];
  readonly dir?: "asc" | "desc";
  readonly limit?: number;
  readonly offset?: number;
} & At<D>;
type PointOptions<D extends ResourceDecl, T> =
  & Pick<GraphOptions<D, T>, "columns" | "with">
  & At<D>;
type Projection<D extends ResourceDecl, T, Q> = Q extends
  { readonly columns: infer C extends readonly (keyof DeclRow<D, T>)[] }
  ? Pick<DeclRow<D, T>, C[number]>
  : DeclRow<D, T>;
type CheckedWhere<Row, W> = W extends Condition<Row> ? Condition<Row>
  : W extends object ? {
      readonly [K in keyof W]: K extends keyof Shorthand<Row>
        ? Shorthand<Row>[K]
        : never;
    }
  : Where<Row>;
/** Singular visibility is nullable even when the stored FK is NOT NULL. */
export type GraphRow<D extends ResourceDecl, T, Q> = Q extends
  { readonly with: infer W extends object } ?
    & Omit<Projection<D, T, Q>, keyof W>
    & {
      readonly [K in keyof W]: Chosen<D, K, W[K]> extends
        { readonly cardinality: "many" }
        ? GraphRow<ChosenTarget<D, T, K, W[K]>, T, W[K]>[]
        : GraphRow<ChosenTarget<D, T, K, W[K]>, T, W[K]> | null;
    }
  : Projection<D, T, Q>;

// Validate the finite selection actually supplied, not every possible path in a
// cyclic declaration graph. This keeps self-relations out of the inference cost.
type Checked<
  D extends ResourceDecl,
  T,
  Q,
  Point extends boolean = false,
  Depth extends readonly unknown[] = [],
> = {
  readonly [K in keyof Q]: K extends "where"
    ? Point extends true ? never : CheckedWhere<DeclRow<D, T>, Q[K]>
    : K extends "with"
      ? Depth["length"] extends 8 ? never : Q[K] extends object ? {
          readonly [E in keyof Q[K]]: [ChosenTarget<D, T, E, Q[K][E]>] extends
            [never] ? never
            : Q[K][E] extends object ?
                & Q[K][E]
                & Checked<
                  ChosenTarget<D, T, E, Q[K][E]>,
                  T,
                  Omit<Q[K][E], "relation">,
                  false,
                  [...Depth, unknown]
                >
                & (Q[K][E] extends { readonly relation: unknown }
                  ? { readonly relation: Choice<D> }
                  : Record<never, never>)
            : never;
        }
      : never
    : K extends keyof (Point extends true ? PointOptions<D, T>
      : Omit<GraphOptions<D, T>, "with">)
      ? (Point extends true ? PointOptions<D, T>
        : Omit<GraphOptions<D, T>, "with">)[K]
    : never;
};

/** Existing methods grow additive options; absent selection returns the unchanged full row. */
export interface GraphReadRepo<D extends ResourceDecl, T = D> {
  list(): Promise<Result<DeclRow<D, T>[]>>;
  list<const Q extends object = Record<never, never>>(
    query?: Q & Checked<D, T, Q>,
  ): Promise<Result<GraphRow<D, T, Q>[]>>;
  find(id: string): Promise<Result<DeclRow<D, T> | null>>;
  find<const Q extends object = Record<never, never>>(
    id: string,
    options?: Q & Checked<D, T, Q, true>,
  ): Promise<Result<GraphRow<D, T, Q> | null>>;
  findOrFail(id: string): Promise<Result<DeclRow<D, T>>>;
  findOrFail<const Q extends object = Record<never, never>>(
    id: string,
    options?: Q & Checked<D, T, Q, true>,
  ): Promise<Result<GraphRow<D, T, Q>>>;
}
