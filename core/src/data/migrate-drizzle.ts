// Barrel re-exports keep import sites stable.
import type { App } from "../core/app.ts";
import type { RefSpec } from "../core/app-refs.ts";
import type { ResourceModel } from "../core/app-types.ts";
import type { RollupKind } from "../core/faces.ts";
import { lowerStatic } from "../core/lower.ts";
import { vectorColumnType, vectorOpClass } from "../features/embed.ts";
import type { Db } from "./db.ts";
import { resetDropStatements } from "./migrate-derive.ts";
import { applySchema, topoSortModels } from "./migrate-apply.ts";
import {
  durationToInterval,
  normalizeColumnGate,
  normalizeExpiry,
  normalizeSequence,
  rectifiableOn,
  sequenceColumnType,
  sequenceObjectName,
  SINGLETON_SENTINEL_ID,
  tamperEvidentOn,
} from "./schema.ts";
import type { ColSpec, DefaultSpec, IdStrategy, PgType } from "./schema.ts";

/**
 * `hazelnut migrate reset` dev engine (cli/migrate.md §reset): drop-first (partitioned, `_audit`-preserving)
 * → re-derive from the live model → push. Re-derives from the current declarations, never replays history.
 * Idempotent on a crash: every DROP is `IF EXISTS CASCADE`, the derive is pure, the push is convergent. The
 * prod flat-refuse + advisory-lock are the caller's (cli.ts `cliMigrate`); this is the orchestration body.
 */
export async function resetSchema(
  db: Db,
  app: App,
  opts: { includeAudit?: boolean } = {},
): Promise<{ dropped: number }> {
  const drops = resetDropStatements(app, opts);
  for (const stmt of drops) await db.exec(stmt);
  // re-derive + push the whole schema from the current declarations (the dev throwaway path). `applySchema`
  // is the convergent push — it (re)creates the module schemas, framework `_*` tables, and resource tables.
  await applySchema(db, app);
  return { dropped: drops.length };
}

// ══ drizzle-kit GENERATE bridge (cli/migrate.md "the engine IS drizzle-kit") ═════════════════════════════
//
// `migrate generate` never writes SQL itself: it maps the `defineResource` Zod source into a drizzle `pgTable`
// schema module drizzle-kit diffs into `migration.sql` + `snapshot.json` — a transient input, never codegen-to-disk.
// Mirrors `deriveDDL` completely, pinned equal to the raw-SQL path by `migrate-parity.test.ts` — a dropped shape goes RED.

/** Quote a drizzle `pgTable`/column name as a JS double-quoted string literal (the name is a plain identifier
 *  the framework controls — `post`, `created_at`, `_audit` — so a simple JSON-string encode is total + safe). */
const jsStr = (s: string): string => JSON.stringify(s);

/** Map a captured `DefaultSpec` to the drizzle `.default(...)`/`.defaultNow()` suffix: a raw `now()` sentinel
 *  → `.defaultNow()`; a raw `gen_random_uuid()` → `.default(sql\`…\`)`; a static literal → `.default(<js value>)`.
 *  Returns "" for a column with no static default. */
function drizzleDefaultSuffix(d: DefaultSpec | undefined): string {
  if (!d) return "";
  if (d.kind === "raw") {
    if (d.sql === "now()") return ".defaultNow()";
    return `.default(sql\`${d.sql}\`)`; // gen_random_uuid() etc. — a verbatim SQL default
  }
  if (typeof d.value === "string") return `.default(${jsStr(d.value)})`;
  return `.default(${String(d.value)})`; // number / boolean — bare JS literal
}

/** The drizzle-orm/pg-core column-builder expression for one `ColSpec` (the structural PgType faces + a raw
 *  `dbType()` native-type string). Mirrors `mapType` (schema.ts) one-for-one so raw-SQL and drizzle derive the
 *  same column from the same `ColSpec`; an unmapped raw `dbType()` string (`numeric(12,2)` / `inet`) rides
 *  drizzle's `customType` escape, which emits the verbatim `dataType()` into the migration SQL. not-null + default suffixes append. */
function drizzleColumnExpr(name: string, spec: ColSpec): string {
  const n = jsStr(name);
  const notNull = spec.nullable ? "" : ".notNull()";
  const dflt = drizzleDefaultSuffix(spec.default);
  // A structural PgType → its drizzle builder; anything else is a raw dbType() native string → customType.
  const structural: Record<PgType, string> = {
    "text": `text(${n})`,
    "integer": `integer(${n})`,
    "double precision": `doublePrecision(${n})`,
    "bigint": `bigint(${n}, { mode: "bigint" })`,
    "boolean": `boolean(${n})`,
    "timestamptz": `timestamp(${n}, { withTimezone: true })`,
    "jsonb": `jsonb(${n})`,
    "numeric": `numeric(${n})`,
    "uuid": `uuid(${n})`,
    "bytea": `bytea(${n})`,
  };
  const builder = (spec.pg as PgType) in structural
    ? structural[spec.pg as PgType]
    // raw dbType() native string → a per-column customType carrying the verbatim Postgres type
    : `customType<{ data: unknown }>({ dataType() { return ${
      jsStr(spec.pg)
    }; } })(${n})`;
  return `${builder}${notNull}${dflt}`;
}

/** The drizzle `pgTable(...)` PK column line for an `idStrategy` (mirrors `idPkDdl`, schema.ts): each of the
 *  three strategies maps to its drizzle PK builder, named `id`, so the drizzle PK matches raw-SQL byte-for-byte. */
function drizzleIdColumn(strategy: IdStrategy): string {
  switch (strategy) {
    case "uuidv4":
      return `id: uuid("id").primaryKey().default(sql\`gen_random_uuid()\`)`;
    case "serial":
      return `id: bigint("id", { mode: "bigint" }).generatedAlwaysAsIdentity().primaryKey()`;
    case "uuidv7":
      return `id: text("id").primaryKey()`;
  }
}

/** An inline drizzle `customType` column carrying a verbatim Postgres type (the same escape `drizzleColumnExpr`
 *  uses) — for `tsvector`/`vector(N)`/`halfvec(N)`/`bytea` faces the structural builder map does not name. */
function drizzleRawCol(pgType: string, name: string): string {
  return `customType<{ data: unknown }>({ dataType() { return ${
    jsStr(pgType)
  }; } })(${jsStr(name)})`;
}

/**
 * The framework-minted resource columns `deriveDDL` (schema-ddl.ts) emits from the features — none ride
 * `model.columns` (the zod shape only). Omitting one here → `migrate generate` authors a table missing that
 * column, and the app's first write hits `column "…" does not exist` on prod. Mirrors `deriveDDL` line-for-line,
 * pinned equal by the parity ratchet. FK/CHECK/tree constraints ride the pgTable third-arg instead.
 */
function drizzleFeatureColumnLines(m: ResourceModel, app: App): string[] {
  const f = m.features;
  const out: string[] = [];
  const tsCol = (n: string, notNull: boolean, now = false) =>
    out.push(
      `  ${jsStr(n)}: timestamp(${jsStr(n)}, { withTimezone: true })${
        notNull ? ".notNull()" : ""
      }${now ? ".defaultNow()" : ""},`,
    );
  const textCol = (n: string) => out.push(`  ${jsStr(n)}: text(${jsStr(n)}),`);

  if (f.scope) {
    out.push(`  ${jsStr("scope_key")}: text("scope_key").notNull(),`);
  }
  const ts = normalizeColumnGate(
    f.timestamps as Parameters<typeof normalizeColumnGate>[0],
    `timestamps on '${m.name}'`,
  );
  if (ts?.created) tsCol("created_at", true, true);
  if (ts?.updated) tsCol("updated_at", true, true);
  if (f.versioning) {
    out.push(`  ${jsStr("version")}: integer("version").notNull().default(1),`);
  }
  if (f.softDelete) tsCol("deleted_at", false);
  if (rectifiableOn(f)) {
    if (!f.softDelete) tsCol("deleted_at", false);
    out.push(
      `  ${jsStr("superseded_by")}: ${
        m.idStrategy === "serial"
          ? `bigint("superseded_by", { mode: "bigint" })`
          : `uuid("superseded_by")`
      },`,
    );
  }
  if (tamperEvidentOn(f)) {
    textCol("prev_hash");
    textCol("row_hash");
    out.push(
      `  ${jsStr("chain_seq")}: bigserial("chain_seq", { mode: "bigint" }),`,
    );
  }
  const expiry = normalizeExpiry(
    f.expiry as Parameters<typeof normalizeExpiry>[0],
  );
  if (expiry) {
    const dflt = expiry.after !== undefined
      ? `.default(sql\`now() + ${durationToInterval(expiry.after)}\`)`
      : "";
    out.push(
      `  ${
        jsStr("expires_at")
      }: timestamp("expires_at", { withTimezone: true })${dflt},`,
    );
  }
  if (f.temporal) {
    tsCol("valid_from", true, true);
    tsCol("valid_to", false);
  }
  const sequence = normalizeSequence(
    f.sequence as Parameters<typeof normalizeSequence>[0],
  );
  if (sequence) {
    const seqType = sequenceColumnType(sequence);
    const builder = seqType === "text"
      ? `text(${jsStr(sequence.field)})`
      : seqType === "bigint"
      ? `bigint(${jsStr(sequence.field)}, { mode: "bigint" })`
      : `integer(${jsStr(sequence.field)})`;
    const seqDefault =
      sequence.strategy === "native-sequence" && seqType !== "text"
        ? `.default(sql\`nextval('"${m.pgSchema}"."${
          sequenceObjectName(m.name, sequence)
        }"')\`)`
        : "";
    out.push(`  ${jsStr(sequence.field)}: ${builder}.notNull()${seqDefault},`);
  }
  // rollup own columns — the aggregate kind (count/sum → integer NOT NULL DEFAULT 0; avg/min/max → double
  // precision NULL) lives on the children's rollupTargets (app-boot-derive.ts), keyed by the parent's qualified table.
  const rollupKind = new Map<string, RollupKind>();
  for (const c of app.model) {
    for (const rt of c.rollupTargets) {
      if (rt.parentTable === `"${m.pgSchema}"."${m.name}"`) {
        rollupKind.set(rt.column, rt.kind);
      }
    }
  }
  for (const col of m.rollupOwnCols) {
    const k = rollupKind.get(col);
    out.push(
      k === "avg" || k === "min" || k === "max"
        ? `  ${jsStr(col)}: doublePrecision(${jsStr(col)}),`
        : `  ${jsStr(col)}: integer(${jsStr(col)}).notNull().default(0),`,
    );
  }
  const onRow = normalizeColumnGate(
    f.onRow as Parameters<typeof normalizeColumnGate>[0],
    `onRow on '${m.name}'`,
  );
  if (onRow) {
    if (onRow.created) {
      textCol("created_by_type");
      textCol("created_by_id");
    }
    if (onRow.updated) {
      textCol("updated_by_type");
      textCol("updated_by_id");
    }
    if (f.softDelete) {
      textCol("deleted_by_type");
      textCol("deleted_by_id");
    }
  }
  if (m.searchable.length > 0) {
    const expr = m.searchable.map((x) => `coalesce("${x}", '')`).join(
      " || ' ' || ",
    );
    out.push(
      `  ${jsStr("search_vector")}: ${
        drizzleRawCol("tsvector", "search_vector")
      }.generatedAlwaysAs(sql\`to_tsvector('english', ${expr})\`),`,
    );
  }
  if (m.vector) {
    out.push(
      `  ${jsStr(m.vector.field)}: ${
        drizzleRawCol(vectorColumnType(m.vector.dims), m.vector.field)
      },`,
    );
    tsCol(`${m.vector.field}_embedded_at`, false);
    textCol(`${m.vector.field}_source_hash`);
    textCol(`${m.vector.field}_model`);
  }
  if (m.parentFk) {
    out.push(`  ${jsStr(m.parentFk)}: text(${jsStr(m.parentFk)}).notNull(),`);
  }
  return out;
}

/** The drizzle export name for a resource's `pgTable` (`t_<schema>_<name>`, non-identifier chars → `_`). FK
 *  `foreignColumns` reference it lazily (inside the `(t) => [...]` callback), so declaration order doesn't matter. */
function drizzleExportName(pgSchema: string, name: string): string {
  return `t_${pgSchema}_${name}`.replace(/[^A-Za-z0-9_]/g, "_");
}

/**
 * The table constraints `deriveDDL` emits — CHECK (enum + singleton sentinel) and FK (parent cascade +
 * `references` + tree self-FK) — as drizzle third-arg (`(t) => [...]`) expressions, pinned equal by the
 * parity ratchet. The `references` onDelete clause mirrors `ddlReferences`: a ref whose DB clause the honesty
 * pre-pass stripped (03-api-shape.md §onDelete) appears in the target's `onDeleteSweeps`, emitting a bare FK here.
 */
function drizzleResourceConstraints(m: ResourceModel, app: App): string[] {
  const cons: string[] = [];
  const t = (col: string) => `t[${jsStr(col)}]`;
  const fk = (
    col: string,
    targetName: string,
    name: string,
    onDelete: string,
  ) =>
    `foreignKey({ columns: [${t(col)}], foreignColumns: [${
      drizzleExportName(m.pgSchema, targetName)
    }.id], name: ${jsStr(name)} })${onDelete}`;
  const odClause = (od: RefSpec["onDelete"]) =>
    od === "cascade"
      ? `.onDelete("cascade")`
      : od === "set-null"
      ? `.onDelete("set null")`
      : "";

  // enum CHECK per zod column (deriveDDL inline `CHECK ("field" IN (...))`); an encrypted field's plaintext CHECK
  // is dropped (its column is a bytea envelope), matching deriveDDL's `continue` on the encrypted branch.
  for (const [name, spec] of Object.entries(m.columns)) {
    if (m.encrypted.includes(name)) continue;
    if (spec.check && spec.check.length > 0) {
      const vals = spec.check.map((v) => `'${v}'`).join(", ");
      // the column ref is a verbatim quoted identifier in the sql template (drizzle emits it as-is) — a
      // `${t[...]}` interpolation would need escaping through this generated-source layer; the raw name is simpler.
      cons.push(
        `check(${
          jsStr(`${m.name}_${name}_check`)
        }, sql\`"${name}" in (${vals})\`)`,
      );
    }
  }
  // global singleton sentinel CHECK (a scoped singleton rides UNIQUE(scope_key) instead — no sentinel).
  if (m.features.singleton && !m.features.scope) {
    cons.push(
      `check(${
        jsStr(`${m.name}_singleton`)
      }, sql\`"id" = '${SINGLETON_SENTINEL_ID}'\`)`,
    );
  }
  // child-relation parent FK — ON DELETE CASCADE, unconditional (deriveDDL:§child relation).
  if (m.parent && m.parentFk) {
    cons.push(
      fk(
        m.parentFk,
        m.parent,
        `${m.name}_${m.parentFk}_fk`,
        `.onDelete("cascade")`,
      ),
    );
  }
  // the honesty-swept fields of this resource: a ref whose DB clause was stripped shows up in the target's onDeleteSweeps.
  const sweptFks = new Set<string>();
  for (const other of app.model) {
    for (const s of other.onDeleteSweeps) {
      if (s.child.name === m.name) sweptFks.add(s.fk);
    }
  }
  for (const [field, ref] of Object.entries(m.references)) {
    if (ref.external) continue; // refById: no in-schema table to REFERENCE
    cons.push(
      fk(
        field,
        ref.to,
        `${m.name}_${field}_fk`,
        sweptFks.has(field) ? "" : odClause(ref.onDelete),
      ),
    );
  }
  // tree self-FK (only when `parent_id` is a column and not already declared in references) — ON DELETE per the
  // tree card's onParentDelete (restrict default), mirroring deriveDDL's tree branch.
  if (
    m.features.tree && "parent_id" in m.columns &&
    !("parent_id" in m.references)
  ) {
    const opd = typeof m.features.tree === "object"
      ? (m.features.tree as { onParentDelete?: string }).onParentDelete ??
        "restrict"
      : "restrict";
    const od = opd === "cascade"
      ? `.onDelete("cascade")`
      : opd === "set-null"
      ? `.onDelete("set null")`
      : `.onDelete("restrict")`;
    cons.push(fk("parent_id", m.name, `${m.name}_parent_id_fk`, od));
  }
  return cons;
}

/**
 * The indexes `deriveDDL` emits (unique scope-folded + softDelete-partial, scoped-singleton, search GIN,
 * HNSW, partial expiry, temporal btree) as drizzle third-arg expressions, pinned equal by the parity ratchet.
 * A missing unique index is not a perf gap — it's a data-integrity divergence (prod admits a duplicate dev
 * rejects), so this rides the same fail-closed fidelity as the columns.
 */
function drizzleResourceIndexes(m: ResourceModel): string[] {
  const idx: string[] = [];
  const tcol = (c: string) => `t[${jsStr(c)}]`;
  const partial = m.features.softDelete
    ? ".where(sql`deleted_at IS NULL`)"
    : ""; // partial on softDelete (a deleted key frees for reuse)
  const partialByKey = new Map(
    m.uniquePartial.map((u) => [u.cols.join(" "), u.where]),
  );
  const escTmpl = (s: string) =>
    s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${"); // safe-embed the lowered predicate in the emitted sql`` template
  for (const cols of m.unique) {
    // the index name keeps the declared cols (stable across the scope-fold, for drift detection); the column list
    // gains a leading scope_key on a scoped resource (uniqueness per scope — 03-api-shape.md §scope).
    // An equality-encrypted col rides its `<f>_bidx` sidecar (04-features.md §encrypted equality): the keyed
    // MAC is deterministic per key, so MAC-uniqueness IS plaintext-uniqueness — the envelope never indexes.
    const physical = (c: string): string =>
      m.encryptedConfig.equality.includes(c) ? `${c}_bidx` : c;
    const indexCols = (m.features.scope ? ["scope_key", ...cols] : cols).map(
      physical,
    );
    // the where clause mirrors deriveDDL: the declared partial predicate (if any) and softDelete's live-rows
    // conjunct, via the same `lowerStatic` — so raw-SQL and drizzle emit an identical predicate (parity ratchet-backed).
    const pred = partialByKey.get(cols.join(" "));
    const conjuncts = [
      ...(pred ? [lowerStatic(pred)] : []),
      ...(m.features.softDelete ? ["deleted_at IS NULL"] : []),
    ];
    const where = conjuncts.length
      ? `.where(sql\`${escTmpl(conjuncts.join(" AND "))}\`)`
      : "";
    idx.push(
      `uniqueIndex(${jsStr(`${m.name}_${cols.join("_")}_uniq`)}).on(${
        indexCols.map(tcol).join(", ")
      })${where}`,
    );
  }
  if (m.features.singleton && m.features.scope) { // scoped singleton — one row per scope (replaces the sentinel CHECK)
    idx.push(
      `uniqueIndex(${jsStr(`${m.name}_scope_singleton_uniq`)}).on(${
        tcol("scope_key")
      })${partial}`,
    );
  }
  if (m.searchable.length > 0) {
    idx.push(
      `index(${jsStr(`${m.name}_search_gin`)}).using("gin", ${
        tcol("search_vector")
      })`,
    );
  }
  if (m.vector) {
    idx.push(
      `index(${jsStr(`${m.name}_${m.vector.field}_hnsw`)}).using("hnsw", ${
        tcol(m.vector.field)
      }.op(${jsStr(vectorOpClass(m.vector.dims))}))`,
    );
  }
  if (
    normalizeExpiry(m.features.expiry as Parameters<typeof normalizeExpiry>[0])
  ) {
    idx.push(
      "index(" + jsStr(`${m.name}_expires_at_idx`) + ").on(" +
        tcol("expires_at") + ").where(sql`expires_at IS NOT NULL`)",
    );
  }
  if (m.features.temporal) {
    idx.push(
      `index(${jsStr(`${m.name}_valid_idx`)}).on(${tcol("valid_from")}, ${
        tcol("valid_to")
      })`,
    );
  }
  for (const f of m.encryptedConfig.equality) {
    idx.push(
      `index(${jsStr(`${m.name}_${f}_bidx_idx`)}).on(${tcol(`${f}_bidx`)})`,
    ); // the blind-index btree (equality probes must not scan)
  }
  return idx;
}

/**
 * The per-resource sidecar tables `deriveDDL`'s siblings emit (`deriveTreeDDL`/`deriveI18nDDL`) — fixed-shape
 * framework tables with a cascade FK to the parent `id` and a composite PK. Omitting one → runtime
 * `relation "<r>_tree"/"<r>_i18n" does not exist` on the first tree/translation op. Junctions are emitted
 * once from `app.junctions` at the call site (they span a resource pair, not a single resource).
 */
function drizzleSidecarTables(
  m: ResourceModel,
  schemaVar: (x: string) => string,
): string[] {
  const out: string[] = [];
  const parentExport = drizzleExportName(m.pgSchema, m.name);
  const tbl = (name: string) =>
    m.pgSchema === "public"
      ? `pgTable(${jsStr(name)}, `
      : `${schemaVar(m.pgSchema)}.table(${jsStr(name)}, `;
  const casc = (target: string) =>
    `.references(() => ${target}.id, { onDelete: "cascade" })`;
  if (m.features.tree && m.features.treeClosure) {
    out.push(
      `export const ${drizzleExportName(m.pgSchema, `${m.name}_tree`)} = ${
        tbl(`${m.name}_tree`)
      }{
  ancestor: text("ancestor").notNull()${casc(parentExport)},
  descendant: text("descendant").notNull()${casc(parentExport)},
  depth: integer("depth").notNull(),
}, (t) => [primaryKey({ columns: [t.ancestor, t.descendant] })]);`,
    );
  }
  if (m.i18nDdl) {
    out.push(
      `export const ${drizzleExportName(m.pgSchema, `${m.name}_i18n`)} = ${
        tbl(`${m.name}_i18n`)
      }{
  entity_id: text("entity_id").notNull()${casc(parentExport)},
  locale: text("locale").notNull(),
  field: text("field").notNull(),
  value: text("value").notNull(),
}, (t) => [primaryKey({ columns: [t.entity_id, t.locale, t.field] })]);`,
    );
  }
  return out;
}

/** The eight framework `_*` tables as drizzle `pgTable` source (mirrors `frameworkTableDDL` — same shapes,
 *  same columns), so `generate` diffs them into the same migration stream the runtime applies (one source, no drift). */
function frameworkTablesDrizzle(app?: App): string {
  const tz = (n: string) => `timestamp(${jsStr(n)}, { withTimezone: true })`;
  const tables: string[] = [
    `export const _audit = pgTable("_audit", {
  id: text("id").primaryKey(),
  module: text("module").notNull().default("app"),
  resource: text("resource").notNull(),
  row_id: text("row_id").notNull(),
  op: text("op").notNull(),
  actor_type: text("actor_type"),
  actor_id: text("actor_id"),
  on_behalf_of: jsonb("on_behalf_of"),
  diff: jsonb("diff"),
  snapshot: jsonb("snapshot"),
  scope: text("scope"),
  origin: text("origin"),
  at: ${tz("at")}.notNull().defaultNow(),
});`,
    `export const _seq_counters = pgTable("_seq_counters", {
  resource: text("resource").notNull(),
  scope_key: text("scope_key").notNull().default(""),
  period_key: text("period_key").notNull().default(""),
  val: bigint("val", { mode: "bigint" }).notNull().default(0n),
}, (t) => [primaryKey({ columns: [t.resource, t.scope_key, t.period_key] })]);`,
    `export const _idempotency = pgTable("_idempotency", {
  key: text("key").primaryKey(),
  result: jsonb("result"),
  created_at: ${tz("created_at")}.notNull().defaultNow(),
  locked_at: ${tz("locked_at")}.notNull().defaultNow(),
});`,
    `export const _outbox = pgTable("_outbox", {
  id: text("id").primaryKey(),
  seq: bigserial("seq", { mode: "bigint" }),
  aggregate_type: text("aggregate_type").notNull(),
  aggregate_id: text("aggregate_id").notNull(),
  topic: text("topic").notNull(),
  payload: jsonb("payload").notNull(),
  kind: text("kind").notNull().default("event"),
  trace_context: jsonb("trace_context"),
  scope: text("scope"),
  schema_version: integer("schema_version").notNull().default(1),
  scheduled_time: ${tz("scheduled_time")},
  attempts: integer("attempts").notNull().default(0),
  next_retry_at: ${tz("next_retry_at")}.notNull().defaultNow(),
  created_at: ${tz("created_at")}.notNull().defaultNow(),
  processed_at: ${tz("processed_at")},
  last_error: text("last_error"),
  last_error_kind: text("last_error_kind"),
  _fw_schema_version: integer("_fw_schema_version").notNull().default(1),
}, (t) => [
  uniqueIndex("_outbox_cron_once").on(t.topic, t.scheduled_time, sql\`md5(payload::text)\`).where(sql\`kind = 'queue' AND scheduled_time IS NOT NULL\`),
  index("_outbox_drain").on(t.aggregate_type, t.aggregate_id, t.seq).where(sql\`processed_at IS NULL\`),
]);`,
    `export const _processed = pgTable("_processed", {
  msg_id: text("msg_id").notNull(),
  consumer: text("consumer").notNull().default("_relay"),
  processed_at: ${tz("processed_at")}.notNull().defaultNow(),
  _fw_schema_version: integer("_fw_schema_version").notNull().default(1),
}, (t) => [primaryKey({ columns: [t.consumer, t.msg_id] })]);`,
    `export const _outbox_retry = pgTable("_outbox_retry", {
  msg_id: text("msg_id").notNull(),
  consumer: text("consumer").notNull(),
  attempts: integer("attempts").notNull().default(0),
}, (t) => [primaryKey({ columns: [t.consumer, t.msg_id] })]);`,
    `export const _rate_limit = pgTable("_rate_limit", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  window_start: doublePrecision("window_start").notNull(),
  window_sec: doublePrecision("window_sec").notNull().default(0),
});`,
    // the CHECK rides the prod form too — a provisioned DB without it accepts the ambiguous lever rows the
    // dev DB refuses, which is the dev-green/prod-broken drift in its most dangerous direction (a lever that
    // reads as set and does nothing).
    `export const _ops_control = pgTable("_ops_control", {
  lever: text("lever").notNull(),
  key: text("key").notNull().default(""),
  value: doublePrecision("value"),
  reason: text("reason"),
  set_at: ${tz("set_at")}.notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.lever, t.key] }),
  check("_ops_control_lever_shape", sql\`(lever = 'relay-drain' AND key = '' AND value IS NULL) OR (lever = 'rate-limit' AND value IS NOT NULL AND value > 0)\`),
]);`,
    `export const _outbox_dead = pgTable("_outbox_dead", {
  id: text("id").primaryKey(),
  aggregate_type: text("aggregate_type"),
  aggregate_id: text("aggregate_id"),
  topic: text("topic"),
  payload: jsonb("payload"),
  kind: text("kind"),
  trace_context: jsonb("trace_context"),
  scope: text("scope"),
  schema_version: integer("schema_version"),
  attempts: integer("attempts"),
  error: text("error"),
  final_error_kind: text("final_error_kind"),
  dead_at: ${tz("dead_at")}.notNull().defaultNow(),
  _fw_schema_version: integer("_fw_schema_version").notNull().default(1),
});`,
  ];
  // Feature-gated: created only when the app declares the feature, mirroring applySchema — an omission here
  // surfaces as `relation "…" does not exist` on first use. Columns are pinned by framework-table-parity.test.ts.
  if (app?.workflows?.length) {
    tables.push(`export const _workflow_journal = pgTable("_workflow_journal", {
  workflow_id: text("workflow_id").notNull(),
  step_id: text("step_id").notNull(),
  result: jsonb("result"),
  status: text("status").notNull().default("running"),
  locked_at: ${tz("locked_at")}.notNull().defaultNow(),
  attempts: integer("attempts").notNull().default(0),
  last_error: text("last_error"),
  last_error_kind: text("last_error_kind"),
  created_at: ${tz("created_at")}.notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.workflow_id, t.step_id] })]);`);
    tables.push(
      `export const _workflow_progress = pgTable("_workflow_progress", {
  workflow_id: text("workflow_id").notNull(),
  step_id: text("step_id").notNull(),
  attempts: integer("attempts").notNull().default(0),
  last_error: text("last_error"),
  last_error_kind: text("last_error_kind"),
  actor: text("actor"),
  trace_id: text("trace_id"),
  updated_at: ${tz("updated_at")}.notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.workflow_id, t.step_id] })]);`,
    );
  }
  if (app?.tasks?.length) {
    tables.push(`export const _tasks = pgTable("_tasks", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status").notNull().default("queued"),
  input: jsonb("input").notNull().default({}),
  result: jsonb("result"),
  scope_key: text("scope_key").notNull().default(""),
  created_at: ${tz("created_at")}.notNull().defaultNow(),
  updated_at: ${tz("updated_at")}.notNull().defaultNow(),
  completed_at: ${tz("completed_at")},
});`);
    tables.push(`export const _task_progress = pgTable("_task_progress", {
  task_id: uuid("task_id").primaryKey(),
  progress: doublePrecision("progress").notNull().default(0),
  message: text("message"),
  cancel_requested: boolean("cancel_requested").notNull().default(false),
  error: text("error"),
  error_kind: text("error_kind"),
  updated_at: ${tz("updated_at")}.notNull().defaultNow(),
});`);
  }
  if (app?.model.some((m) => m.passwords.length > 0)) {
    tables.push(`export const _password_refresh = pgTable("_password_refresh", {
  id: text("id").primaryKey(),
  token_hash: text("token_hash").notNull(),
  subject: text("subject").notNull(),
  expires_at: ${tz("expires_at")}.notNull(),
  revoked: boolean("revoked").notNull().default(false),
  created_at: ${tz("created_at")}.notNull().defaultNow(),
});`);
    tables.push(
      `export const _password_login_attempt = pgTable("_password_login_attempt", {
  identifier: text("identifier").primaryKey(),
  count: integer("count").notNull(),
  window_start: doublePrecision("window_start").notNull(),
  window_sec: doublePrecision("window_sec").notNull().default(0),
});`,
    );
  }
  if (app?.schedulingCap != null) {
    tables.push(`export const _schedule_quota = pgTable("_schedule_quota", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  window_start: doublePrecision("window_start").notNull(),
  window_sec: doublePrecision("window_sec").notNull().default(0),
});`);
  }
  return tables.join("\n");
}

/**
 * `deriveDrizzleSchemaModule(app)` — the schema-from-declarations bridge: composes the `defineResource`
 * source into a drizzle `pgTable` schema module (a TS string) drizzle-kit's `generate` diffs, from
 * `model.columns` + `idStrategy` — the same source `deriveDDL` reads, never codegen-to-disk of types. Imports
 * by bare specifier since the `npm:`-prefixed Deno specifier is invisible to the spawned Node process.
 */
export function deriveDrizzleSchemaModule(app: App): string {
  const header =
    `import { check, foreignKey, index, pgSchema, pgSequence, pgTable, primaryKey, text, integer, doublePrecision, bigint, bigserial, boolean, timestamp, jsonb, numeric, uuid, uniqueIndex, customType } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
`;
  const tables: string[] = [frameworkTablesDrizzle(app)];
  // read-model projection tables (author-named, feature-gated on defineReadModel), emitted so the prod
  // generate path materializes them too — mirrors readModelDDL's shape 1:1, pinned by migrate-parity.test.ts.
  for (const rm of app.readModels ?? []) {
    // `rm_`-prefixed const so the JS identifier stays valid + collision-free with a resource const
    // (`t_<schema>_<name>`); the pgTable arg keeps the real unqualified table name. Boot already refuses clashes.
    tables.push(`export const rm_${rm.name} = pgTable(${jsStr(rm.name)}, {
  source_id: text("source_id").primaryKey(),${
      rm.scoped ? `\n  scope_key: text("scope_key"),` : ""
    }
  data: jsonb("data").notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});`);
  }
  // Multi-schema (cli/migrate.md §who-writes-what): a module resource's table lives in its module's pg schema —
  // drizzle expresses that via `pgSchema("<name>").table(...)`, so drizzle-kit's generate authors `CREATE SCHEMA` too.
  const schemas = [
    ...new Set(app.model.map((m) => m.pgSchema).filter((x) => x !== "public")),
  ].sort();
  const schemaVar = (x: string) => `s_${x}`.replace(/[^A-Za-z0-9_]/g, "_");
  for (const x of schemas) {
    tables.push(`export const ${schemaVar(x)} = pgSchema(${jsStr(x)});`);
  }
  for (const m of topoSortModels(app.model)) {
    const cols: string[] = [`  ${drizzleIdColumn(m.idStrategy)},`];
    for (const [name, spec] of Object.entries(m.columns)) {
      if (name === "id") continue; // the PK is emitted from idStrategy above, never doubly from columns
      // an encrypted field is stored as a `bytea` envelope [key_id|iv|wrapped_dek|ciphertext] — its declared
      // structural type is replaced (03-api-shape.md §4; deriveDDL `encryptedEnvelopeColumn`), so mirror the bytea here.
      if (m.encrypted.includes(name)) {
        cols.push(
          `  ${jsStr(name)}: ${drizzleRawCol("bytea", name)}${
            spec.nullable ? "" : ".notNull()"
          },`,
        );
        continue;
      }
      cols.push(`  ${jsStr(name)}: ${drizzleColumnExpr(name, spec)},`);
    }
    // encrypted equality blind-index sidecars (04-features.md §encrypted equality) — mirror deriveDDL's
    // `<f>_bidx text` (nullable; NULL iff the value is NULL). Beside the envelope, before the feature mints.
    for (const f of m.encryptedConfig.equality) {
      cols.push(`  ${jsStr(`${f}_bidx`)}: text(${jsStr(`${f}_bidx`)}),`);
    }
    cols.push(...drizzleFeatureColumnLines(m, app)); // the framework-MINTED feature columns (not in m.columns)
    // A drizzle export name must be a valid JS identifier; the table name itself rides the pgTable() string arg.
    const exportName = drizzleExportName(m.pgSchema, m.name);
    const builder = m.pgSchema === "public"
      ? "pgTable("
      : `${schemaVar(m.pgSchema)}.table(`;
    // native-sequence object (deriveDDL seqObj) — the standalone Postgres SEQUENCE the column's nextval() default owns.
    const seq = normalizeSequence(
      m.features.sequence as Parameters<typeof normalizeSequence>[0],
    );
    if (seq && seq.strategy === "native-sequence") {
      const seqName = sequenceObjectName(m.name, seq);
      const start = seq.start !== undefined
        ? `, { startWith: ${seq.start} }`
        : "";
      const seqBuilder = m.pgSchema === "public"
        ? `pgSequence(${jsStr(seqName)}${start})`
        : `${schemaVar(m.pgSchema)}.sequence(${jsStr(seqName)}${start})`;
      tables.push(
        `export const ${
          drizzleExportName(m.pgSchema, seqName)
        } = ${seqBuilder};`,
      );
    }
    // CHECK + FK constraints and indexes ride the same third-arg `(t) => [...]` (deriveDDL parity).
    const extras = [
      ...drizzleResourceConstraints(m, app),
      ...drizzleResourceIndexes(m),
    ];
    const thirdArg = extras.length > 0
      ? `, (t) => [\n  ${extras.join(",\n  ")},\n]`
      : "";
    tables.push(
      `export const ${exportName} = ${builder}${jsStr(m.name)}, {\n${
        cols.join("\n")
      }\n}${thirdArg});`,
    );
    tables.push(...drizzleSidecarTables(m, schemaVar)); // <r>_tree / <r>_i18n sidecars
  }
  // junction tables (deriveJunctionDDL) — two cascade FKs + a composite PK, one per resource pair (app.junctions).
  for (const j of app.junctions) {
    const jb = j.pgSchema === "public"
      ? "pgTable("
      : `${schemaVar(j.pgSchema)}.table(`;
    tables.push(
      `export const ${drizzleExportName(j.pgSchema, j.name)} = ${jb}${
        jsStr(j.name)
      }, {
  ${jsStr(j.leftFk)}: text(${jsStr(j.leftFk)}).notNull().references(() => ${
        drizzleExportName(j.pgSchema, j.left)
      }.id, { onDelete: "cascade" }),
  ${jsStr(j.rightFk)}: text(${jsStr(j.rightFk)}).notNull().references(() => ${
        drizzleExportName(j.pgSchema, j.right)
      }.id, { onDelete: "cascade" }),
}, (t) => [primaryKey({ columns: [t[${jsStr(j.leftFk)}], t[${
        jsStr(j.rightFk)
      }]] })]);`,
    );
  }
  return `${header}\n${tables.join("\n\n")}\n`;
}
