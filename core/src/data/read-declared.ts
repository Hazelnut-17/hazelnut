import { SQL, sql } from "drizzle-orm/sql";
import { z } from "zod";
import type {
  DeclaredRead,
  ReadNode,
  ReadSpec,
  ReadSubquery,
} from "../core/read-query.ts";
import type { ResourceModel } from "../core/app.ts";
import type { ResourceDecl } from "../core/app-types.ts";
import type { ViewDecl } from "../features/view.ts";
import { all, owned, type Where } from "../core/where.ts";
import { strictify } from "./schema.ts";
import {
  NonFiniteEgressError,
  unprojectableColumns,
} from "../features/redact.ts";
import type { Db } from "./db.ts";
import type { ReadCtx, RowPolicy } from "./repo.ts";
import { querySql, readMetadata } from "./read-compiler.ts";
import { compileSql } from "../core/lower-sql.ts";
import { readWhereSql } from "./read-sql.ts";
import { clampCount, PAGE_LIMIT_MAX, pagedLimit } from "./read-page.ts";

interface ReadApp {
  readonly model: readonly ResourceModel[];
  readonly views?: readonly ViewDecl[];
}
interface Source {
  readonly model: ResourceModel;
  readonly view?: ViewDecl;
  readonly columns: ReadonlySet<string>;
}
const viewOrigins = new WeakMap<ViewDecl, ViewDecl>();
const resourceOrigins = new WeakMap<ResourceModel, ResourceDecl>();
/** Keep the authored witness distinct from composition's immutable model snapshot. */
export function registerReadResourceSource(
  composed: ResourceModel,
  declaration: ResourceDecl,
): void {
  resourceOrigins.set(composed, declaration);
}
/** Composition may normalize an over-view's policy; preserve its declaration-value identity. */
export function registerReadViewSource(
  composed: ViewDecl,
  declaration: ViewDecl,
): void {
  viewOrigins.set(composed, declaration);
}
function refuse(message: string): never {
  throw new Error(`view/query: ${message}`);
}
function resolveSources(app: ReadApp, plan: DeclaredRead): Map<string, Source> {
  const out = new Map<string, Source>();
  for (const [alias, declaration] of Object.entries(plan.sources)) {
    if (!alias || alias.length > 63) {
      refuse("source aliases must have 1–63 characters");
    }
    let model: ResourceModel | undefined;
    let view: ViewDecl | undefined;
    if ("schema" in declaration) {
      const hits = app.model.filter((m) =>
        resourceOrigins.get(m) === declaration
      );
      if (hits.length !== 1) {
        refuse(`source '${alias}' must be one registered declaration value`);
      }
      model = hits[0];
    } else {
      view = app.views?.find((v) =>
        v === declaration || viewOrigins.get(v) === declaration
      );
      if (!view || !view.over || view.run || view.query) {
        refuse(`source '${alias}' must be a registered over-form view`);
      }
      const hits = app.model.filter((m) => m.name === view!.over);
      if (hits.length !== 1) {
        refuse(`view source '${alias}' has no unique resource`);
      }
      model = hits[0];
      if (!view.columns?.length) {
        refuse(`view source '${alias}' needs a positive columns projection`);
      }
    }
    const m = model!;
    const banned = unprojectableColumns(m);
    const available = readMetadata(m).columns;
    const columns = new Set(
      (view?.columns ?? [...available.keys()]).filter((c) => !banned.has(c)),
    );
    for (const c of columns) {
      if (!available.has(c)) refuse(`'${alias}.${c}' is not stored`);
    }
    out.set(alias, { model: m, view, columns });
  }
  if (!out.size || out.size > 64) refuse("declare 1–64 source aliases");
  for (const [alias, source] of out) {
    if (!source.columns.size) {
      refuse(`source '${alias}' needs a positive readable projection`);
    }
  }
  if (
    new Set(
      [...out.values()].map((s) => `${s.model.pgSchema}.${s.model.module}`),
    ).size !== 1
  ) {
    refuse(
      "joins stay within one module; use an exposed view or operation across modules",
    );
  }
  return out;
}
const OPS = {
  eq: sql`=`,
  ne: sql`<>`,
  gt: sql`>`,
  gte: sql`>=`,
  lt: sql`<`,
  lte: sql`<=`,
};
const AGGS = {
  count: sql`COUNT`,
  sum: sql`SUM`,
  avg: sql`AVG`,
  min: sql`MIN`,
  max: sql`MAX`,
};
const SPEC_KEYS: Record<keyof ReadSpec, true> = {
  from: true,
  joins: true,
  where: true,
  select: true,
  groupBy: true,
  having: true,
  orderBy: true,
  limit: true,
  offset: true,
};
const SUBQUERY_KEYS: Record<keyof ReadSubquery, true> = {
  from: true,
  joins: true,
  where: true,
  groupBy: true,
  having: true,
};
function knownKeys(value: object, keys: readonly string[]): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !keys.includes(key)) {
      refuse(`unknown key '${String(key)}'`);
    }
  }
}

/** Untyped PostgreSQL parameters default to text. Pin scalar semantics without
 * casting text inputs that need the opposing column/aggregate's native type. */
class CallerInputParameter {
  constructor(readonly key: string, readonly value: unknown) {}
}

/** A declared input failure, never SQL text, native diagnostics or parameter values. */
export class DeclaredInputError extends Error {
  readonly kind = "validation" as const;
  constructor(key: string) {
    super(
      `declared query input '${key}' is absent or incompatible with its SQL use; check the input schema and supply a required value or default`,
    );
    this.name = "DeclaredInputError";
  }
}

function parameter(value: unknown, callerKey?: string): SQL {
  const bound = callerKey === undefined
    ? value
    : new CallerInputParameter(callerKey, value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) refuse("numeric parameters must be finite");
    return sql`${sql.param(bound)}::double precision`;
  }
  if (typeof value === "boolean") return sql`${sql.param(bound)}::boolean`;
  if (typeof value === "string" || value === null) {
    return sql`${sql.param(bound)}`;
  }
  return refuse(
    "value/input parameters must be string, number, boolean or null",
  );
}

/** One compiler handles boot validation and execution; no sibling SQL bypass. */
function statement(
  app: ReadApp,
  plan: DeclaredRead,
  ctx?: ReadCtx,
  input?: Readonly<Record<string, unknown>>,
  mcpLookahead = false,
  callerKeys: ReadonlySet<string> = new Set(),
): SQL {
  const sources = resolveSources(app, plan);
  knownKeys(plan, ["sources", "input", "spec"]);
  knownKeys(plan.spec, Object.keys(SPEC_KEYS));
  let nodes = 0;
  const expr = (
    node: ReadNode,
    bound: ReadonlySet<string>,
    aggregate: boolean,
    depth: number,
  ): SQL => {
    if (++nodes > 1024 || depth > 8) {
      refuse("at most 1024 expressions and eight correlated subquery levels");
    }
    if (!node || typeof node !== "object") {
      refuse("expression must be built by readQuery");
    }
    const keys = {
      column: ["kind", "source", "column"],
      value: ["kind", "value"],
      input: ["kind", "key"],
      compare: ["kind", "op", "left", "right"],
      and: ["kind", "nodes"],
      or: ["kind", "nodes"],
      not: ["kind", "node"],
      isNull: ["kind", "node"],
      aggregate: ["kind", "op", "node"],
      exists: ["kind", "query"],
      scalar: ["kind", "query", "select"],
    } satisfies Record<ReadNode["kind"], readonly string[]>;
    if (!Object.hasOwn(keys, node.kind)) refuse("unknown expression kind");
    knownKeys(node, keys[node.kind]);
    switch (node.kind) {
      case "column": {
        const s = sources.get(node.source);
        if (!s || !bound.has(node.source)) {
          refuse(`unbound source '${node.source}'`);
        }
        if (!s.columns.has(node.column)) {
          refuse(
            `'${node.source}.${node.column}' is not a readable source column`,
          );
        }
        return sql`${sql.identifier(node.source)}.${
          sql.identifier(node.column)
        }`;
      }
      case "value":
        return parameter(node.value);
      case "input": {
        const shape = plan.input && "shape" in plan.input
          ? plan.input.shape
          : undefined;
        if (
          !shape || typeof shape !== "object" || !Object.hasOwn(shape, node.key)
        ) refuse(`input '${node.key}' is not in the declared input schema`);
        if (ctx && (!input || input[node.key] === undefined)) {
          throw new DeclaredInputError(node.key);
        }
        return ctx
          ? parameter(
            input?.[node.key],
            callerKeys.has(node.key) ? node.key : undefined,
          )
          : sql`${sql.param(null)}`;
      }
      case "compare": {
        if (!Object.hasOwn(OPS, node.op)) refuse("unknown comparison");
        return sql`(${expr(node.left, bound, aggregate, depth)} ${
          OPS[node.op]
        } ${expr(node.right, bound, aggregate, depth)})`;
      }
      case "and":
      case "or":
        return node.nodes.length
          ? sql`(${
            sql.join(
              node.nodes.map((n) => expr(n, bound, aggregate, depth)),
              node.kind === "and" ? sql` AND ` : sql` OR `,
            )
          })`
          : node.kind === "and"
          ? sql`TRUE`
          : sql`FALSE`;
      case "not":
        return sql`NOT (${expr(node.node, bound, aggregate, depth)})`;
      case "isNull":
        return sql`(${expr(node.node, bound, aggregate, depth)} IS NULL)`;
      case "aggregate": {
        if (!aggregate || !Object.hasOwn(AGGS, node.op)) {
          refuse("aggregate is not allowed in this clause");
        }
        return sql`${AGGS[node.op]}(${expr(node.node, bound, false, depth)})`;
      }
      case "exists":
        knownKeys(node.query, Object.keys(SUBQUERY_KEYS));
        return sql`EXISTS (${query(node.query, bound, depth + 1, sql`1`)})`;
      case "scalar":
        knownKeys(node.query, Object.keys(SUBQUERY_KEYS));
        return sql`(${query(node.query, bound, depth + 1, node.select)})`;
      default:
        return refuse("unknown expression kind");
    }
  };
  const sourceSql = (alias: string): SQL => {
    const source = sources.get(alias);
    if (!source) refuse(`source '${alias}' is not declared`);
    const { model, view, columns } = source;
    const table = readMetadata(model).table;
    if (!ctx) return sql`${table} AS ${sql.identifier(alias)}`;
    const nativeAlias = `_hz_source_${[...sources.keys()].indexOf(alias)}`;
    const bind = (v: unknown) => sql`${sql.param(v)}`;
    const policy = (model.rowPolicy ?? (() => all())) as RowPolicy<
      Record<string, unknown>
    >;
    let predicate = readWhereSql(
      model,
      ctx,
      policy,
      all(),
      bind,
      undefined,
      nativeAlias,
    );
    if (view) {
      const vp = typeof view.rowPolicy === "string"
        ? owned<Record<string, unknown>, string>({ __col: view.rowPolicy })
        : view.rowPolicy ?? (() => all());
      predicate = sql`(${predicate}) AND (${
        readWhereSql(
          model,
          ctx,
          vp as RowPolicy<Record<string, unknown>>,
          (view.where?.(ctx) ?? all()) as Where<Record<string, unknown>>,
          bind,
          undefined,
          nativeAlias,
        )
      })`;
    }
    const projection = sql.join(
      [...columns].map((c) => sql.identifier(c)),
      sql`, `,
    );
    return sql`(SELECT ${projection} FROM ${table} AS ${
      sql.identifier(nativeAlias)
    } WHERE ${predicate}) AS ${sql.identifier(alias)}`;
  };
  const query = (
    q: ReadSubquery,
    outer: ReadonlySet<string>,
    depth: number,
    selection: SQL | ReadNode,
  ): SQL => {
    const local = new Set<string>([q.from]);
    if (outer.has(q.from)) {
      refuse(
        `source '${q.from}' shadows an outer source; declare a separate alias for self/correlated reads`,
      );
    }
    let tail = sourceSql(q.from);
    for (const j of q.joins ?? []) {
      knownKeys(j, ["source", "kind", "on"]);
      if (local.has(j.source) || outer.has(j.source)) {
        refuse(
          `source '${j.source}' is repeated in one scope; declare a separate alias`,
        );
      }
      if (j.kind !== "left" && j.kind !== "inner") {
        refuse("join kind must be left or inner");
      }
      local.add(j.source);
      tail = sql`${tail}${
        j.kind === "left" ? sql` LEFT JOIN ` : sql` INNER JOIN `
      }${sourceSql(j.source)} ON ${
        expr(j.on.node, new Set([...outer, ...local]), false, depth)
      }`;
    }
    const bound = new Set([...outer, ...local]);
    const select = selection instanceof SQL
      ? selection
      : expr(selection, bound, true, depth);
    const result = sql`SELECT ${select} FROM ${tail}`;
    if (q.where) {
      result.append(sql` WHERE ${expr(q.where.node, bound, false, depth)}`);
    }
    if (q.groupBy?.length) {
      result.append(sql` GROUP BY ${
        sql.join(
          q.groupBy.map((g) => expr(g.node, bound, false, depth)),
          sql`, `,
        )
      }`);
    }
    if (q.having) {
      result.append(sql` HAVING ${expr(q.having.node, bound, true, depth)}`);
    }
    return result;
  };
  const q: ReadSpec = plan.spec;
  const bound = new Set([q.from, ...(q.joins ?? []).map((j) => j.source)]);
  const selected = Object.entries(q.select);
  if (!selected.length) refuse("select needs a positive projection");
  const isExactText = (n: ReadNode): boolean =>
    n.kind === "aggregate"
      ? ["count", "sum", "avg"].includes(n.op)
      : n.kind === "scalar" && isExactText(n.select);
  const selection = sql.join(
    selected.map(([name, e]) => {
      const value = expr(e.node, bound, true, 0);
      // Cast only the result face. HAVING/WHERE/ORDER keep numeric PostgreSQL
      // comparison, so a count of 2 does not compare lexically greater than 10.
      return sql`${isExactText(e.node) ? sql`(${value})::text` : value} AS ${
        sql.identifier(name)
      }`;
    }),
    sql`, `,
  );
  const result = query(q, new Set(), 0, selection);
  if (q.orderBy?.length) {
    result.append(sql` ORDER BY ${
      sql.join(
        q.orderBy.map((o) => {
          knownKeys(o, ["by", "dir"]);
          if (
            o.dir !== undefined && o.dir !== "asc" && o.dir !== "desc"
          ) refuse("order direction must be asc or desc");
          return sql`${expr(o.by.node, bound, true, 0)} ${
            o.dir === "desc" ? sql`DESC` : sql`ASC`
          }`;
        }),
        sql`, `,
      )
    }`);
  }
  // The author owns a smaller plan limit. Only the transport's default/cap
  // grows by one for MCP completeness signaling; direct/HTTP rows never do.
  const ceiling = PAGE_LIMIT_MAX + (mcpLookahead ? 1 : 0);
  result.append(
    sql` LIMIT ${pagedLimit(q.limit, ceiling, ceiling)} OFFSET ${
      clampCount(q.offset, "offset") ?? 0
    }`,
  );
  return result;
}

export function validateDeclaredRead(
  app: ReadApp,
  plan: DeclaredRead,
): string[] {
  try {
    statement(app, plan);
    return [];
  } catch (e) {
    return [e instanceof Error ? e.message : "view/query: invalid plan"];
  }
}
/** Execute on the supplied handle with native flat-row representations unchanged. */
export async function runDeclaredRead(
  db: Db,
  app: ReadApp,
  plan: DeclaredRead,
  ctx: ReadCtx,
  input?: unknown,
  mcpLookahead = false,
): Promise<Record<string, unknown>[]> {
  // Undefined takes the author's default/prefault path, just like omission.
  // Snapshot provenance before parsing: an authored transform may mutate input.
  const callerKeys = new Set(
    input && typeof input === "object" && !Array.isArray(input)
      ? Object.keys(input).filter((key) =>
        (input as Record<string, unknown>)[key] !== undefined
      )
      : [],
  );
  const validated = strictify(plan.input ?? z.object({})).parse(input ?? {});
  if (!validated || typeof validated !== "object" || Array.isArray(validated)) {
    refuse("input must be an object");
  }
  const compiled = compileSql(
    statement(
      app,
      plan,
      ctx,
      validated as Record<string, unknown>,
      mcpLookahead,
      callerKeys,
    ),
  );
  const inputParameters = new Map<number, string>();
  const params = compiled.params.map((value, index) => {
    if (!(value instanceof CallerInputParameter)) return value;
    inputParameters.set(index + 1, value.key);
    return value.value;
  });
  let rows: Record<string, unknown>[];
  try {
    rows = (await querySql<Record<string, unknown>>(
      db,
      sql.raw(compiled.sql),
      params,
    )).rows;
  } catch (error) {
    // SQLSTATE alone cannot distinguish a bad caller binding from an authored
    // constant, policy or aggregate. PostgreSQL's optional context is not a
    // structured/locale-independent index: only the exact known Bind context
    // is evidence; missing, translated or unrelated context remains native.
    const native = z.object({ code: z.string(), where: z.string() }).safeParse(
      error,
    );
    if (native.success && /^22[A-Z0-9]{3}$/.test(native.data.code)) {
      // Native type input can prepend a context frame (for example JSON), and
      // the quoted parameter can itself contain newlines. The Bind producer
      // also omits the value for binary input. Match the frame header, not its
      // value; multiple headers are ambiguous, including one embedded in a
      // submitted value. Never infer an index from arbitrary '$n' text.
      const binds = [...native.data.where.matchAll(
        /(?:^|\n)(?:unnamed portal|portal "[^"\r\n]+") parameter \$([1-9][0-9]*)(?: = |(?=\r?$))/gm,
      )];
      const [bind] = binds;
      const key = binds.length === 1 && bind
        ? inputParameters.get(Number(bind[1]))
        : undefined;
      if (key !== undefined) throw new DeclaredInputError(key);
    }
    throw error;
  }
  // A sentinel proves another result exists; its fields are not wire output.
  // Validate the same visible result set as the ordinary execution mode.
  for (const row of rows.slice(0, PAGE_LIMIT_MAX)) {
    for (const [key, value] of Object.entries(row)) {
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new NonFiniteEgressError(
          `query output '${key}' is non-finite; JSON would silently encode null`,
        );
      }
    }
  }
  return rows;
}
