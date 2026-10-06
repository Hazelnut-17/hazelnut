import {
  type AnyRelation,
  defineRelations,
  DrizzleQueryError,
  getTableName,
  type Table,
} from "drizzle-orm";
import { sql } from "drizzle-orm/sql";
import {
  customType,
  type PgColumnBuilder,
  pgSchema,
  pgTable,
} from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pg-proxy";
import type { AnyDBQueryConfig } from "drizzle-orm/relations";
import type { App, ResourceModel } from "../core/app.ts";
import { all, type Where } from "../core/where.ts";
import { decryptRows, type Kms } from "../features/encrypt.ts";
import { junctionFor } from "../features/relate.ts";
import type { Db, NativeArrayRows } from "./db.ts";
import { parseCreateTables } from "./ddl-parse.ts";
import { equalityWhere } from "./repo-list.ts";
import { readWhereSql } from "./read-sql.ts";
import { clampCount, PAGE_LIMIT_MAX, pagedLimit } from "./read-page.ts";
import type { ReadCtx, RowPolicy } from "./repo.ts";

/** New graph reads are explicit and bounded; existing unpaged reads retain their contract. */
const GRAPH_DEPTH_MAX = 8;
const GRAPH_NODES_MAX = 64;

export interface GraphReadOptions {
  /** Select/rename an edge explicitly when different edge kinds reuse a key. */
  readonly relation?: {
    readonly kind: "owns" | "ref" | "manyToMany";
    readonly name: string;
  };
  readonly columns?: readonly string[];
  readonly with?: Readonly<Record<string, GraphReadOptions>>;
  readonly where?: Where<Record<string, unknown>>;
  readonly orderBy?: readonly string[];
  readonly dir?: "asc" | "desc";
  readonly limit?: number;
  readonly offset?: number;
  readonly asOf?: Date | string;
}

type DerivedTable = ReturnType<typeof makeTable>;
interface GraphEntry {
  readonly key: string;
  readonly model: ResourceModel;
  readonly columns: ReadonlyMap<string, string>;
  readonly types: ReadonlyMap<string, string>;
  readonly edges: Map<string, GraphEdge[]>;
}
interface GraphEdge {
  readonly target: GraphEntry;
  readonly many: boolean;
  readonly kind: "owns" | "ref" | "manyToMany";
  readonly from: string;
  readonly to: string;
  readonly junction?: {
    readonly key: string;
    readonly left: string;
    readonly right: string;
  };
}

function graphError(message: string): never {
  throw Object.assign(new Error(message), { kind: "validation" as const });
}

class NativeText {
  constructor(readonly type: string, readonly text: string) {}
}

/** Physical names remain unchanged. Only TS registry keys are private, reversible identities. */
function makeTable(schema: string, name: string, ddl: string) {
  const physical = parseCreateTables(ddl).find((t) =>
    t.schema === schema && t.table === name
  );
  if (!physical) {
    throw new Error(`graph/table-metadata: missing '${schema}.${name}'`);
  }
  const columns: Record<string, PgColumnBuilder> = {};
  const keys = new Map<string, string>();
  for (const [field, type] of physical.columns) {
    const key = `c${keys.size}`;
    keys.set(field, key);
    const column: PgColumnBuilder = customType<
      { data: unknown; driverData: unknown; jsonData: string }
    >({
      dataType: () => type,
      // A SQL cast to text is not the protocol's type output (boolean, inet,
      // bpchar and user-defined casts can differ). Use the same typoutput as
      // native text transport; format alone maps SQL NULL to an empty string.
      forJsonSelect: (identifier) =>
        sql`CASE WHEN ${identifier} IS NULL THEN NULL ELSE pg_catalog.format('%s', ${identifier}) END`,
      fromJson: (text) => new NativeText(type, text),
    })(field);
    columns[key] = column;
  }
  const table = schema === "public"
    ? pgTable(name, columns)
    : pgSchema(schema).table(name, columns);
  return { table, keys, types: physical.columns };
}

const registries = new WeakMap<App, ReturnType<typeof deriveRegistry>>();

function deriveRegistry(app: App) {
  const tables: Record<string, DerivedTable["table"]> = {};
  const entries = new Map<ResourceModel, GraphEntry>();
  const junctions = new Map<
    string,
    { key: string; columns: ReadonlyMap<string, string> }
  >();
  for (const model of app.model) {
    const derived = makeTable(model.pgSchema, model.name, model.ddl);
    const key = `t${entries.size}`;
    tables[key] = derived.table;
    entries.set(model, {
      key,
      model,
      columns: derived.keys,
      types: derived.types,
      edges: new Map(),
    });
  }
  for (const j of app.junctions) {
    const key = `j${junctions.size}`;
    const derived = makeTable(j.pgSchema, j.name, j.ddl);
    tables[key] = derived.table;
    junctions.set(`${j.pgSchema}.${j.name}`, { key, columns: derived.keys });
  }
  const targetOf = (source: ResourceModel, name: string) => {
    const targets = app.model.filter((m) =>
      m.pgSchema === source.pgSchema && m.module === source.module &&
      m.name === name
    );
    return targets.length === 1 ? entries.get(targets[0]!) : undefined;
  };
  for (const entry of entries.values()) {
    const m = entry.model;
    const add = (
      kind: GraphEdge["kind"],
      name: string,
      target: GraphEntry,
      many: boolean,
      from: string,
      to: string,
      junction?: { key: string; left: string; right: string },
    ) => {
      const candidates = entry.edges.get(name) ?? [];
      candidates.push({ target, many, kind, from, to, junction });
      entry.edges.set(name, candidates);
    };
    for (const [name, own] of Object.entries(m.owns)) {
      const target = targetOf(m, own.child);
      if (target) {
        add(
          "owns",
          name,
          target,
          own.cardinality === "many",
          "id",
          target.model.parentFk!,
        );
      }
    }
    for (const [name, ref] of Object.entries(m.references)) {
      const target = ref.external ? undefined : targetOf(m, ref.to);
      if (target) add("ref", name, target, false, name, "id");
    }
    for (const [name, rel] of Object.entries(m.relates)) {
      const target = targetOf(m, rel.to);
      if (!target) continue;
      const j = junctionFor(app, m.name, rel.to, m.pgSchema);
      const jt = junctions.get(`${j.pgSchema}.${j.name}`)!;
      const left = m.name === j.left ? j.leftFk : j.rightFk;
      const right = m.name === j.left ? j.rightFk : j.leftFk;
      add("manyToMany", name, target, true, "id", "id", {
        key: jt.key,
        left: jt.columns.get(left)!,
        right: jt.columns.get(right)!,
      });
    }
  }
  return { entries, tables };
}

function registryOf(app: App) {
  let registry = registries.get(app);
  if (!registry) {
    registry = deriveRegistry(app);
    registries.set(app, registry);
  }
  return registry;
}

const OPTION_KEYS: Record<keyof GraphReadOptions, true> = {
  relation: true,
  columns: true,
  with: true,
  where: true,
  orderBy: true,
  dir: true,
  limit: true,
  offset: true,
  asOf: true,
};
interface PreparedGraph {
  readonly entry: GraphEntry;
  readonly selected: readonly string[];
  readonly included: readonly {
    name: string;
    key: string;
    edge: GraphEdge;
    graph: PreparedGraph;
  }[];
  readonly config: AnyDBQueryConfig;
}

async function prepareGraph(
  db: Db,
  entry: GraphEntry,
  ctx: ReadCtx,
  opts: GraphReadOptions,
  kms: Kms | undefined,
  budget: { nodes: number },
  depth = 0,
  inheritedAt?: Date | string,
): Promise<PreparedGraph> {
  if (depth > GRAPH_DEPTH_MAX || ++budget.nodes > GRAPH_NODES_MAX) {
    graphError(
      "graph/bounds: select at most eight relation levels and 64 nodes; split this read into explicitly bounded operations",
    );
  }
  if (!opts || typeof opts !== "object" || Array.isArray(opts)) {
    graphError(
      "graph/options: each selected relation requires an options object",
    );
  }
  if (depth === 0 && opts.relation !== undefined) {
    graphError(
      "graph/relation: relation belongs to an included selection, not the root",
    );
  }
  for (const key of Reflect.ownKeys(opts)) {
    if (typeof key !== "string" || !Object.hasOwn(OPTION_KEYS, key)) {
      graphError(`graph/unknown-option: '${String(key)}'`);
    }
  }
  const included: {
    name: string;
    key: string;
    edge: GraphEdge;
    graph: PreparedGraph;
  }[] = [];
  const at = opts.asOf ?? inheritedAt;
  for (const [name, selection] of Object.entries(opts.with ?? {})) {
    const choice = selection?.relation;
    if (
      choice &&
      (Object.keys(choice).some((key) => key !== "name" && key !== "kind") ||
        !["owns", "ref", "manyToMany"].includes(choice.kind))
    ) graphError("graph/relation: use { kind, name } for a declared edge");
    const candidates = entry.edges.get(choice?.name ?? name)?.filter((edge) =>
      !choice || edge.kind === choice.kind
    ) ?? [];
    if (candidates.length > 1) {
      graphError(
        `graph/edge-ambiguous: '${name}' names more than one edge; select { relation: { kind, name } } under an output alias`,
      );
    }
    const edge = candidates[0];
    if (!edge) {
      graphError(
        `graph/edge-declared: '${entry.model.name}.${name}' is not a declared same-module relation`,
      );
    }
    included.push({
      name,
      key: `e${budget.nodes}`,
      edge,
      graph: await prepareGraph(
        db,
        edge.target,
        ctx,
        selection,
        kms,
        budget,
        depth + 1,
        at,
      ),
    });
  }
  const relationNames = new Set(included.map((i) => i.name));
  const selected = opts.columns ??
    [...entry.columns.keys()].filter((name) => !relationNames.has(name));
  if (!Array.isArray(selected) || new Set(selected).size !== selected.length) {
    graphError("graph/columns: select unique declared column names");
  }
  for (const name of selected) {
    if (!entry.columns.has(name)) {
      graphError(
        `graph/column-declared: '${entry.model.name}.${name}' is not stored`,
      );
    }
    if (relationNames.has(name)) {
      graphError(
        `graph/selection-collision: '${name}' selects both a scalar and relation; omit the scalar from columns`,
      );
    }
  }
  const columns: Record<string, boolean> = {};
  for (const name of selected) columns[entry.columns.get(name)!] = true;
  if (selected.some((name) => entry.model.encrypted.includes(name))) {
    columns[entry.columns.get("id")!] = true;
  }
  // A row identity is needed even for a relation-only projection; it is removed after decoding.
  if (!selected.length) columns[entry.columns.get("id")!] = true;
  const where = await equalityWhere(db, entry.model, opts.where ?? all(), kms);
  const policy: RowPolicy<Record<string, unknown>> =
    (entry.model.rowPolicy as RowPolicy<Record<string, unknown>> | null) ??
      (() => all());
  const order = opts.orderBy ?? ["id"];
  if (
    !Array.isArray(order) || !order.length ||
    new Set(order).size !== order.length ||
    order.some((name) => !entry.columns.has(name))
  ) graphError("graph/order: use a nonempty unique list of stored columns");
  // Ciphertext and equality MACs carry no plaintext ordering. Sensitive-only
  // fields remain queryable inside a trusted handler; cursor/report exclusions
  // do not define this internal graph face.
  const unordered = new Set([
    ...entry.model.encrypted,
    ...entry.model.encryptedConfig.equality.map((name) => `${name}_bidx`),
  ]);
  if (order.some((name) => unordered.has(name))) {
    graphError(
      `graph/order-encrypted: '${entry.model.name}' cannot order ciphertext or an equality blind index — order by a non-encrypted field`,
    );
  }
  if (opts.dir !== undefined && opts.dir !== "asc" && opts.dir !== "desc") {
    graphError("graph/direction: use asc or desc");
  }
  const orderBy: Record<string, "asc" | "desc"> = {};
  for (const name of order) {
    orderBy[entry.columns.get(name)!] = opts.dir ?? "asc";
  }
  if (!order.includes("id")) {
    orderBy[entry.columns.get("id")!] = opts.dir ?? "asc";
  }
  const config: AnyDBQueryConfig = {
    columns,
    with: Object.fromEntries(included.map((i) => [i.key, i.graph.config])),
    where: {
      RAW: (table: Table) =>
        readWhereSql(
          entry.model,
          ctx,
          policy,
          where,
          // Arrays are native parameter values, not Drizzle tuple fragments.
          (value) => sql`${sql.param(value)}`,
          at,
          getTableName(table),
        ),
      // Dynamic registry names erase the finite relation-key union. rc.4's broad
      // filter type then intersects RAW with a relation-name index signature;
      // the fixed public RAW callback above is the only translated filter form.
    } as unknown as AnyDBQueryConfig["where"],
    orderBy,
    limit: pagedLimit(opts.limit, 100, PAGE_LIMIT_MAX),
    offset: clampCount(opts.offset, "offset") ?? 0,
  };
  return { entry, selected, included, config };
}

async function decodeGraph(
  row: Record<string, unknown>,
  graph: PreparedGraph,
  native: (value: NativeText) => unknown,
  kms?: Kms,
): Promise<Record<string, unknown>> {
  const materialized: Record<string, unknown> = {};
  for (const [name, key] of graph.entry.columns) {
    if (Object.hasOwn(row, key)) {
      Object.defineProperty(materialized, name, {
        value: row[key] instanceof NativeText ? native(row[key]) : row[key],
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  const encrypted = graph.selected.filter((name) =>
    graph.entry.model.encrypted.includes(name)
  );
  if (encrypted.length) {
    if (!kms) {
      throw new Error(
        `resource '${graph.entry.model.name}' declares encrypted fields but no KMS is bound`,
      );
    }
    await decryptRows(kms, encrypted, [materialized], {
      schema: graph.entry.model.pgSchema,
      table: graph.entry.model.name,
    });
  }
  const output: Record<string, unknown> = {};
  for (const name of graph.selected) {
    Object.defineProperty(output, name, {
      value: materialized[name],
      enumerable: true,
      writable: true,
    });
  }
  for (const included of graph.included) {
    const value = row[included.key];
    let decoded: unknown;
    if (included.edge.many) {
      if (!Array.isArray(value)) {
        throw new Error("graph/decoder-shape: collection is not an array");
      }
      decoded = await Promise.all(
        value.map((item) =>
          decodeGraph(assertRow(item), included.graph, native, kms)
        ),
      );
    } else {decoded = value === null || value === undefined
        ? null
        : await decodeGraph(assertRow(value), included.graph, native, kms);}
    Object.defineProperty(output, included.name, {
      value: decoded,
      enumerable: true,
      writable: true,
    });
  }
  return output;
}

function assertRow(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("graph/decoder-shape: row is not an object");
  }
  return value as Record<string, unknown>;
}

/** RQB owns one statement and public decoding, never transactions or a second connection. */
export async function readGraph(
  app: App,
  db: Db,
  model: ResourceModel,
  ctx: ReadCtx,
  options: GraphReadOptions,
  kms?: Kms,
): Promise<Record<string, unknown>[]> {
  if (!db.queryArrays) {
    throw new Error(
      "graph/native-arrays-required: supply queryArrays on the bound Db; ordinary reads remain available",
    );
  }
  const registry = registryOf(app);
  const graph = await prepareGraph(
    db,
    registry.entries.get(model)!,
    ctx,
    options,
    kms,
    { nodes: 0 },
  );
  const typeLabels = new Map<string, string>();
  const collect = (g: PreparedGraph) => {
    const fields = [...g.selected];
    if (
      !fields.length || fields.some((f) => g.entry.model.encrypted.includes(f))
    ) fields.push("id");
    for (const field of fields) {
      const type = g.entry.types.get(field)!;
      if (!typeLabels.has(type)) {
        typeLabels.set(type, `hz_native_${typeLabels.size}`);
      }
    }
    for (const child of g.included) collect(child.graph);
  };
  collect(graph);
  // A declaration edge is not a selection identity. Repeated output aliases
  // need independent RQB relation keys/configs, even when they traverse the
  // same physical FK. Only physical metadata is cached between callers.
  const relations = defineRelations(registry.tables, (r) => {
    const out: Record<string, Record<string, AnyRelation>> = {};
    const visit = (g: PreparedGraph) => {
      const edges = out[g.entry.key] ??= {};
      for (const included of g.included) {
        const e = included.edge;
        const from = r[g.entry.key]![g.entry.columns.get(e.from)!]!;
        const to = r[e.target.key]![e.target.columns.get(e.to)!]!;
        const config = e.junction
          ? {
            from: from.through(r[e.junction.key]![e.junction.left]!),
            to: to.through(r[e.junction.key]![e.junction.right]!),
          }
          : { from, to };
        edges[included.key] = e.many
          ? r.many[e.target.key]!(config)
          : r.one[e.target.key]!({ ...config, optional: true });
        visit(included.graph);
      }
    };
    visit(graph);
    return out;
  });
  let native: NativeArrayRows["decoders"] | undefined;
  const arrayTypes = new Set<string>();
  const extras = Object.fromEntries([...typeLabels].flatMap(([type, label]) => {
    const witness = sql.raw(`NULL::${type}`);
    return [[label, witness.as(label)], [
      `${label}_array`,
      sql`(SELECT COALESCE(NULLIF(t.typelem, 0), b.typelem, 0) <> 0 FROM pg_catalog.pg_type t LEFT JOIN pg_catalog.pg_type b ON b.oid = t.typbasetype WHERE t.oid = pg_typeof(${witness})::oid)`
        .as(`${label}_array`),
    ]];
  }));
  const client = drizzle(async (query, params, method) => {
    if (method !== "all") {
      throw new Error(
        "graph/positional-mode-required: the graph compiler requested an unsupported execution mode; retain the supported dependency pins and report this compiler failure",
      );
    }
    const result = await db.queryArrays!(query, params);
    native = result.decoders;
    for (const [type, label] of typeLabels) {
      const index = result.columns.indexOf(`${label}_array`);
      if (index < 0) {
        throw new Error(
          "graph/native-type-witness-missing: a graph type-witness column is missing; forward queryArrays column labels and positional rows without dropping or renaming them",
        );
      }
      if (result.rows[0]?.[index] === true) arrayTypes.add(type);
    }
    if (
      !native || typeof native.get !== "function" ||
      [...typeLabels.values()].some((label) =>
        typeof native!.get(label) !== "function"
      )
    ) {
      throw new Error(
        "graph/native-codec-missing: positional transport must return native field decoders",
      );
    }
    if (
      !Array.isArray(result.rows) ||
      result.rows.some((row) => !Array.isArray(row))
    ) {
      throw new Error(
        "graph/positional-row-shape: queryArrays must return arrays of ordered values; forward native positional rows rather than reconstructing them from objects",
      );
    }
    return { rows: result.rows };
  }, {
    relations,
    logger: false,
    jit: false,
  });
  let rows: unknown;
  try {
    rows = await client.query[graph.entry.key]!.findMany(
      { ...graph.config, extras },
    );
  } catch (error) {
    // The ORM wrapper includes SQL and parameter values and hides the native
    // SQLSTATE. Keep the existing Db error contract and its owning redaction.
    if (error instanceof DrizzleQueryError) {
      throw error.cause ?? new Error(
        "graph/query-failed: the graph driver failed without a native cause; preserve the adapter's original error and inspect sanitized application diagnostics",
      );
    }
    throw error;
  }
  if (!Array.isArray(rows)) {
    throw new Error("graph/decoder-shape: result is not a row set");
  }
  return await Promise.all(
    rows.map((row) =>
      decodeGraph(
        assertRow(row),
        graph,
        (value) =>
          native!.get(typeLabels.get(value.type)!)!(
            value.text,
            arrayTypes.has(value.type),
          ),
        kms,
      )
    ),
  );
}
