import type { z, ZodType } from "zod";
import type { ViewDecl } from "../features/view.ts";
import type { ResourceDecl } from "./app-types.ts";
import type { DeclRow } from "./faces-ctx.ts";

/** Declaration-backed relational expressions, not SQL strings or ORM handles. */
export type ReadNode =
  | {
    readonly kind: "column";
    readonly source: string;
    readonly column: string;
  }
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "input"; readonly key: string }
  | {
    readonly kind: "compare";
    readonly op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte";
    readonly left: ReadNode;
    readonly right: ReadNode;
  }
  | { readonly kind: "and" | "or"; readonly nodes: readonly ReadNode[] }
  | { readonly kind: "not" | "isNull"; readonly node: ReadNode }
  | {
    readonly kind: "aggregate";
    readonly op: "count" | "sum" | "avg" | "min" | "max";
    readonly node: ReadNode;
  }
  | { readonly kind: "exists"; readonly query: ReadSubquery }
  | {
    readonly kind: "scalar";
    readonly query: ReadSubquery;
    readonly select: ReadNode;
  };

export interface ReadExpression<T = unknown, A extends string = string> {
  readonly node: ReadNode;
  /** Type witnesses only; neither values nor caller predicates are cached here. */
  readonly __value?: T;
  readonly __aliases?: A;
}
type ExpressionValue<E> = E extends ReadExpression<infer V> ? V : never;
type ExpressionAliases<E> = E extends ReadExpression<unknown, infer A> ? A
  : never;
type BooleanValue<V> = null extends V ? boolean | null : boolean;
type ReadPredicate = ReadExpression<boolean | null>;
type ScalarParameter = string | number | boolean | null;
type InputParameterKey<I> = {
  [K in keyof I & string]: Exclude<I[K], undefined> extends ScalarParameter ? K
    : never;
}[keyof I & string];
export type ReadSource = ResourceDecl | ViewDecl;
type SourceRow<D, S> = D extends ResourceDecl ? DeclRow<D, S>
  : D extends ViewDecl<infer R> ? R
  : never;
type SourceColumns<D, R> = D extends ResourceDecl ? keyof R & string
  : D extends { readonly columns: readonly (infer C extends string)[] } ? C
  : keyof R & string;
type SourceFields<S extends Readonly<Record<string, ReadSource>>> = {
  readonly [A in keyof S & string]: {
    readonly [C in SourceColumns<S[A], SourceRow<S[A], readonly S[keyof S][]>>]:
      ReadExpression<
        C extends keyof SourceRow<S[A], readonly S[keyof S][]>
          ? SourceRow<S[A], readonly S[keyof S][]>[C]
          : unknown,
        A
      >;
  };
};
export interface ReadJoin<A extends string = string> {
  readonly source: A;
  readonly kind: "inner" | "left";
  readonly on: ReadPredicate;
}
export interface ReadSubquery {
  readonly from: string;
  readonly joins?: readonly ReadJoin[];
  readonly where?: ReadPredicate;
  readonly groupBy?: readonly ReadExpression[];
  readonly having?: ReadPredicate;
}
export interface ReadSpec<A extends string = string> extends ReadSubquery {
  readonly from: A;
  readonly joins?: readonly ReadJoin<A>[];
  readonly select: Readonly<Record<string, ReadExpression>>;
  readonly orderBy?: readonly {
    readonly by: ReadExpression;
    readonly dir?: "asc" | "desc";
  }[];
  readonly limit?: number;
  readonly offset?: number;
}
export interface DeclaredRead<
  S extends Readonly<Record<string, ReadSource>> = Readonly<
    Record<string, ReadSource>
  >,
  Q extends ReadSpec = ReadSpec,
> {
  readonly sources: S;
  readonly input?: ZodType;
  readonly spec: Q;
}
type LeftAliases<Q> = Q extends { readonly joins: readonly (infer J)[] }
  ? J extends { readonly kind: "left"; readonly source: infer A } ? A : never
  : never;
export type DeclaredReadRow<P extends DeclaredRead> = {
  -readonly [K in keyof P["spec"]["select"]]: P["spec"]["select"][K] extends
    ReadExpression<infer V, infer A>
    ? V | ([Extract<A, LeftAliases<P["spec"]>>] extends [never] ? never : null)
    : never;
};

function expr<T, A extends string = never>(
  node: ReadNode,
): ReadExpression<T, A> {
  return { node };
}
/** The closed expression vocabulary supplied to a readQuery builder. */
export interface ReadOperators<I = Record<never, never>> {
  /** SQL scalar parameters, not an arbitrary JavaScript value codec. */
  value<T>(value: T & ScalarParameter): ReadExpression<T, never>;
  input<K extends InputParameterKey<I>>(
    key: K,
  ): ReadExpression<Exclude<I[K], undefined>, never>;
  eq<T, A extends string, B extends string>(
    left: ReadExpression<T, A>,
    right: ReadExpression<NoInfer<T>, B>,
  ): ReadExpression<BooleanValue<T>, A | B>;
  ne<T, A extends string, B extends string>(
    left: ReadExpression<T, A>,
    right: ReadExpression<NoInfer<T>, B>,
  ): ReadExpression<BooleanValue<T>, A | B>;
  gt<T, A extends string, B extends string>(
    left: ReadExpression<T, A>,
    right: ReadExpression<NoInfer<T>, B>,
  ): ReadExpression<BooleanValue<T>, A | B>;
  gte<T, A extends string, B extends string>(
    left: ReadExpression<T, A>,
    right: ReadExpression<NoInfer<T>, B>,
  ): ReadExpression<BooleanValue<T>, A | B>;
  lt<T, A extends string, B extends string>(
    left: ReadExpression<T, A>,
    right: ReadExpression<NoInfer<T>, B>,
  ): ReadExpression<BooleanValue<T>, A | B>;
  lte<T, A extends string, B extends string>(
    left: ReadExpression<T, A>,
    right: ReadExpression<NoInfer<T>, B>,
  ): ReadExpression<BooleanValue<T>, A | B>;
  and<const N extends readonly ReadPredicate[]>(
    ...nodes: N
  ): ReadExpression<
    BooleanValue<ExpressionValue<N[number]>>,
    ExpressionAliases<N[number]>
  >;
  or<const N extends readonly ReadPredicate[]>(
    ...nodes: N
  ): ReadExpression<
    BooleanValue<ExpressionValue<N[number]>>,
    ExpressionAliases<N[number]>
  >;
  not<V extends boolean | null, A extends string>(
    node: ReadExpression<V, A>,
  ): ReadExpression<BooleanValue<V>, A>;
  isNull(node: ReadExpression): ReadExpression<boolean, never>;
  count(node: ReadExpression): ReadExpression<string, never>;
  sum(
    node: ReadExpression<number | bigint | string | null>,
  ): ReadExpression<string | null, never>;
  avg(
    node: ReadExpression<number | bigint | string | null>,
  ): ReadExpression<string | null, never>;
  min<T>(node: ReadExpression<T>): ReadExpression<T | null, never>;
  max<T>(node: ReadExpression<T>): ReadExpression<T | null, never>;
  exists(query: ReadSubquery): ReadExpression<boolean, never>;
  scalar<T>(
    query: ReadSubquery & { readonly select: ReadExpression<T> },
  ): ReadExpression<T | null, never>;
}
function operators<I>(): ReadOperators<I> {
  const compare =
    (op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte") =>
    <T, A extends string, B extends string>(
      left: ReadExpression<T, A>,
      right: ReadExpression<NoInfer<T>, B>,
    ) =>
      expr<BooleanValue<T>, A | B>({
        kind: "compare",
        op,
        left: left.node,
        right: right.node,
      });
  const aggregate = <T>(
    op: "count" | "sum" | "avg" | "min" | "max",
    node: ReadExpression,
  ) => expr<T>({ kind: "aggregate", op, node: node.node });
  return {
    value: (value) => expr({ kind: "value", value }),
    input: (key) => expr({ kind: "input", key }),
    eq: compare("eq"),
    ne: compare("ne"),
    gt: compare("gt"),
    gte: compare("gte"),
    lt: compare("lt"),
    lte: compare("lte"),
    and: (...nodes) => expr({ kind: "and", nodes: nodes.map((n) => n.node) }),
    or: (...nodes) => expr({ kind: "or", nodes: nodes.map((n) => n.node) }),
    not: (node) => expr({ kind: "not", node: node.node }),
    isNull: (node) => expr({ kind: "isNull", node: node.node }),
    count: (node) => aggregate("count", node),
    sum: (node) => aggregate("sum", node),
    avg: (node) => aggregate("avg", node),
    min: (node) => aggregate("min", node),
    max: (node) => aggregate("max", node),
    exists: (query) => expr({ kind: "exists", query }),
    scalar: ({ select, ...query }) =>
      expr({ kind: "scalar", query, select: select.node }),
  };
}

/** Build once from declaration values. Execution always resolves current actor visibility. */
export function readQuery<
  const S extends Readonly<Record<string, ReadSource>>,
  const Q extends ReadSpec<keyof S & string>,
  I extends ZodType | undefined = undefined,
>(
  config: { readonly sources: S; readonly input?: I },
  build: (
    sources: SourceFields<S>,
    q: ReadOperators<I extends ZodType ? z.output<I> : Record<never, never>>,
  ) => Q & Record<Exclude<keyof Q, keyof ReadSpec>, never>,
): DeclaredRead<S, Q> {
  const fields: Record<string, unknown> = {};
  for (const source of Object.keys(config.sources)) {
    Object.defineProperty(fields, source, {
      enumerable: true,
      value: new Proxy({}, {
        get: (_, column) => {
          if (typeof column !== "string") {
            throw new Error("read-query/column: use a string column");
          }
          return expr({ kind: "column", source, column });
        },
      }),
    });
  }
  // The proxy creates only column witnesses; the compiler checks every physical
  // column and source against the composed app before this plan can be served.
  const spec = build(fields as SourceFields<S>, operators());
  return snapshotDeclaredRead({
    sources: config.sources,
    input: config.input,
    spec,
  });
}

/** Freeze owned plan structure, not resource/schema witnesses or user parameter values. */
export function snapshotDeclaredRead<P extends DeclaredRead>(plan: P): P {
  let seen = 0;
  const node = (n: ReadNode, depth = 0): ReadNode => {
    if (++seen > 1024 || depth > 32) {
      throw new Error("view/query: expression snapshot exceeds bounds");
    }
    switch (n.kind) {
      case "compare":
        return Object.freeze({
          ...n,
          left: node(n.left, depth + 1),
          right: node(n.right, depth + 1),
        });
      case "and":
      case "or":
        return Object.freeze({
          ...n,
          nodes: Object.freeze(n.nodes.map((v) => node(v, depth + 1))),
        });
      case "not":
      case "isNull":
      case "aggregate":
        return Object.freeze({ ...n, node: node(n.node, depth + 1) });
      case "exists":
        return Object.freeze({ ...n, query: query(n.query, depth + 1) });
      case "scalar":
        return Object.freeze({
          ...n,
          query: query(n.query, depth + 1),
          select: node(n.select, depth + 1),
        });
      default:
        return Object.freeze({ ...n });
    }
  };
  const expression = (e: ReadExpression, depth: number): ReadExpression =>
    Object.freeze({ ...e, node: node(e.node, depth) });
  const query = <Q extends ReadSubquery>(q: Q, depth: number): Q =>
    Object.freeze({
      ...q,
      ...(q.joins
        ? {
          joins: Object.freeze(q.joins.map((j) =>
            Object.freeze({ ...j, on: expression(j.on, depth) })
          )),
        }
        : {}),
      ...(q.where ? { where: expression(q.where, depth) } : {}),
      ...(q.groupBy
        ? { groupBy: Object.freeze(q.groupBy.map((g) => expression(g, depth))) }
        : {}),
      ...(q.having ? { having: expression(q.having, depth) } : {}),
    });
  const spec = query(plan.spec, 0);
  return Object.freeze({
    ...plan,
    sources: Object.freeze({ ...plan.sources }),
    spec: Object.freeze({
      ...spec,
      select: Object.freeze(
        Object.fromEntries(
          Object.entries(spec.select).map(([k, e]) => [k, expression(e, 0)]),
        ),
      ),
      ...(spec.orderBy
        ? {
          orderBy: Object.freeze(spec.orderBy.map((o) =>
            Object.freeze({ ...o, by: expression(o.by, 0) })
          )),
        }
        : {}),
    }),
  }) as P;
}
