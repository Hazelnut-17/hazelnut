// Extracted from src/data/schema.ts by extract.ts — barrel re-exports keep import sites stable.
import type { Features, RollupKind } from "../core/faces.ts";
import { lowerStatic } from "../core/lower.ts";
import type { Node } from "../core/where.ts";
import {
  vectorColumnType,
  type VectorConfig,
  vectorOpClass,
} from "../features/embed.ts";
import {
  DEFAULT_ID_STRATEGY,
  deriveColumns,
  idPkDdl,
  type IdStrategy,
  normalizeSequence,
  PG_DDL,
  sequenceColumnType,
  sequenceObjectName,
  SINGLETON_SENTINEL_ID,
} from "./schema-derive.ts";
import {
  durationToInterval,
  encryptedEnvelopeColumn,
  normalizeColumnGate,
  normalizeExpiry,
  rectifiableOn,
  tamperEvidentOn,
  temporalNoOverlap,
} from "./schema-normalize.ts";
import { defaultClause, type PgType } from "./schema-types.ts";
import type { z } from "zod";

/**
 * Derive the `CREATE TABLE` DDL from one declaration — schema columns (the z.*→pg mapping) plus
 * the framework-managed feature columns. The DB shape is a pure function of the declaration; the
 * framework owns the DDL, never a hand-edited migration (single source of truth).
 */
export function deriveDDL(
  name: string,
  pgSchema: string,
  schema: z.ZodObject<z.ZodRawShape>,
  features: Features,
  references: Readonly<
    Record<
      string,
      {
        readonly to: string;
        readonly onDelete?: "restrict" | "cascade" | "set-null";
        readonly external?: true;
      }
    >
  > = {},
  unique: readonly (readonly string[])[] = [],
  parent: { readonly fk: string; readonly to: string } | null = null,
  searchable: readonly string[] = [],
  rollupCols: readonly { readonly name: string; readonly kind: RollupKind }[] =
    [],
  encrypted: readonly string[] = [],
  idStrategy: IdStrategy = DEFAULT_ID_STRATEGY,
  vector: VectorConfig | null = null,
  uniquePartial: readonly {
    readonly cols: readonly string[];
    readonly where: Node;
  }[] = [],
  encryptedEquality: readonly string[] = [],
): string {
  const q = `"${pgSchema}"."${name}"`; // schema-qualified table
  const enc = new Set(encrypted); // fields stored as the `bytea` envelope, not their structural type (04-features.md §encrypted)
  // PK DDL follows the declared id strategy (02-dsl.md §id): uuidv7 text (app-minted), uuidv4/serial DB-allocated.
  // A `singleton`'s PK CHECK-pins the fixed sentinel id (see SINGLETON_SENTINEL_ID); `create` mints it, not a random uuidv7.
  const singletonSentinel = Boolean(features.singleton);
  // a scoped singleton is one row per scope — each scope's row keeps a normal unique id (not a shared sentinel);
  // "one per scope" rides the UNIQUE(scope_key) index below, so every id-FK to it (i18n/parent_id/junction) works.
  const scopedSingleton = singletonSentinel && Boolean(features.scope);
  const idDdl = idPkDdl(idStrategy);
  const lines: string[] = [
    // scoped singleton: normal uuidv7 PK (UNIQUE(scope_key) below); global singleton: fixed-sentinel CHECK.
    scopedSingleton
      ? idDdl
      : singletonSentinel
      ? `${idDdl} CHECK (id = '${SINGLETON_SENTINEL_ID}')`
      : idDdl,
  ];
  for (const [field, spec] of Object.entries(deriveColumns(schema))) {
    // an `encrypted` field is a `bytea` envelope `[key_id|iv|wrapped_dek|ciphertext]` — its declared
    // structural type (and any CHECK over the plaintext shape) is replaced (03-api-shape.md §4; 04-features.md §encrypted).
    if (enc.has(field)) {
      lines.push(encryptedEnvelopeColumn(field, spec.nullable));
      continue;
    }
    // a structural PgType resolves through PG_DDL (so a bare `numeric` keeps the numeric(19,4) default);
    // a raw dbType() native-type string (`numeric(12,2)`) passes through verbatim.
    const ddl = spec.pg in PG_DDL ? PG_DDL[spec.pg as PgType] : spec.pg;
    let line = `"${field}" ${ddl}`;
    if (!spec.nullable) line += " NOT NULL";
    if (spec.check && spec.check.length > 0) {
      line += ` CHECK ("${field}" IN (${
        spec.check.map((v) => `'${v}'`).join(", ")
      }))`;
    }
    if (spec.default) line += ` DEFAULT ${defaultClause(spec.default)}`; // a captured static `.default(v)` (03-api-shape.md §4)
    lines.push(line);
  }
  if (features.scope) lines.push("scope_key text NOT NULL");
  // timestamps (04-features.md §timestamps): `created`/`updated` gate independently ({created:true} mints only
  // created_at, {updated:true} only updated_at; bare `true` ≡ both); each defaults `now()` so it's a safe add.
  const ts = normalizeColumnGate(
    features.timestamps as Parameters<typeof normalizeColumnGate>[0],
    `timestamps on '${name}'`,
  );
  if (ts?.created) lines.push("created_at timestamptz NOT NULL DEFAULT now()");
  if (ts?.updated) lines.push("updated_at timestamptz NOT NULL DEFAULT now()");
  if (features.versioning) lines.push("version integer NOT NULL DEFAULT 1");
  if (features.softDelete) lines.push("deleted_at timestamptz");
  // rectifiable (GDPR Art. 16 — 04-features.md §immutable): `superseded_by` points at the correcting row (same
  // table, deliberately no self-FK — the rectify door is its only writer); `deleted_at` doubles as the superseded stamp.
  if (rectifiableOn(features)) {
    if (!features.softDelete) lines.push("deleted_at timestamptz");
    lines.push(`superseded_by ${idStrategy === "serial" ? "bigint" : "uuid"}`);
  }
  // tamper-evidence (tamper.ts, opt-in): hash-chain columns. `row_hash` = H(row bytes || prev_hash) over stored
  // (ciphertext) columns; `chain_seq` (bigserial, minted under the `tamper:` lock) orders by commit, not by id.
  if (tamperEvidentOn(features)) {
    lines.push("prev_hash text", "row_hash text", "chain_seq bigserial");
  }
  // expiry (04-features.md §expiry): expires_at is NULL = never expires. `after` mode auto-stamps
  // `created_at + after` via a DEFAULT, making the TTL by-construction; per-row mode leaves it caller-writable.
  const expiry = normalizeExpiry(
    features.expiry as Parameters<typeof normalizeExpiry>[0],
  );
  if (expiry) {
    lines.push(
      `expires_at timestamptz${
        expiry.after !== undefined
          ? ` DEFAULT now() + ${durationToInterval(expiry.after)}`
          : ""
      }`,
    );
  }
  if (features.temporal) {
    lines.push(
      "valid_from timestamptz NOT NULL DEFAULT now()",
      "valid_to timestamptz",
    );
  }
  // temporal no-overlap (04-features.md §temporal migrate): opt-in `EXCLUDE USING gist` constraint; `scope_key`
  // auto-joins the equality set on a scoped resource. tstzrange is closed-open; NULL valid_to is unbounded.
  const noOverlapConstraint = temporalExcludeConstraintSql(name, features);
  if (noOverlapConstraint) lines.push(noOverlapConstraint);
  // encrypted equality (04-features.md §encrypted equality): each field mints a `<f>_bidx` blind-index column —
  // keyed MAC of the plaintext, NULL iff the value is NULL; equality search rides this sidecar + its btree index.
  for (const f of encryptedEquality) lines.push(`"${f}_bidx" text`);
  // sequence# (04-features.md §sequence#): the column is named by `field`, typed text when prefix/pad format it
  // (else int/bigint); `native-sequence` also owns a CREATE SEQUENCE object. Bare `sequence: { field: "seq", strategy: "locked-row" }` → `seq integer`.
  const sequence = normalizeSequence(
    features.sequence as Parameters<typeof normalizeSequence>[0],
  );
  if (sequence) {
    const seqType = sequenceColumnType(sequence);
    // a native-sequence column allocates at the DB via `DEFAULT nextval(<obj>)` (lock-free, gaps-ok) — no repo
    // write-auto; a formatted (prefix/pad → text) value is composed in the allocation seam instead.
    const seqDefault =
      sequence.strategy === "native-sequence" && seqType !== "text"
        ? ` DEFAULT nextval('"${pgSchema}"."${
          sequenceObjectName(name, sequence)
        }"')`
        : "";
    lines.push(`"${sequence.field}" ${seqType} NOT NULL${seqDefault}`);
  }
  // maintained aggregate columns (03-api-shape.md §8): count/sum default 0; avg/min/max are nullable double
  // precision — NULL on the empty set (never a fabricated 0), since a fractional avg/exact min/max needs float.
  for (const col of rollupCols) {
    lines.push(
      col.kind === "avg" || col.kind === "min" || col.kind === "max"
        ? `"${col.name}" double precision`
        : `"${col.name}" integer NOT NULL DEFAULT 0`,
    );
  }
  // singleton (04-features.md §singleton-marker; 10-invariants.md singleton/single-row): the single-row
  // guarantee is the PK-sentinel CHECK minted above — no separate guard column.
  // audit onRow: opaque polymorphic actor stamps (no FK, nullable). created_by_*/updated_by_* gate independently,
  // mirroring timestamps (04-features.md §audit onRow); deleted_by_* gates purely on softDelete.
  const onRow = normalizeColumnGate(
    features.onRow as Parameters<typeof normalizeColumnGate>[0],
    `onRow on '${name}'`,
  );
  if (onRow) {
    if (onRow.created) lines.push("created_by_type text", "created_by_id text");
    if (onRow.updated) lines.push("updated_by_type text", "updated_by_id text");
    if (features.softDelete) {
      lines.push("deleted_by_type text", "deleted_by_id text");
    }
  }
  // searchable — a STORED generated tsvector over the declared text fields (kept in sync by Postgres).
  if (searchable.length > 0) {
    const expr = searchable.map((f) => `coalesce("${f}", '')`).join(
      ` || ' ' || `,
    );
    lines.push(
      `search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', ${expr})) STORED`,
    );
  }
  // vector: `vector(N)`/`halfvec(N)` embedding column (nullable — embeds land async via the outbox, repo.ts).
  // Shadow columns `_embedded_at`/`_source_hash`/`_model` are the staleness lie-detector (vector/possibly-stale).
  if (vector) {
    lines.push(`"${vector.field}" ${vectorColumnType(vector.dims)}`);
    lines.push(`"${vector.field}_embedded_at" timestamptz`);
    lines.push(`"${vector.field}_source_hash" text`);
    lines.push(`"${vector.field}_model" text`);
  }
  // child relation — a minted FK column to the owning parent, ON DELETE CASCADE (children die with the parent).
  if (parent) {
    lines.push(`"${parent.fk}" text NOT NULL`);
    lines.push(
      `FOREIGN KEY ("${parent.fk}") REFERENCES "${pgSchema}"."${parent.to}" (id) ON DELETE CASCADE`,
    );
  }
  // foreign keys: an undeclared onDelete emits a bare REFERENCES (NO ACTION). `cascade`/`set-null` land here
  // only where honest — a dishonest ref is pre-pass-stripped (core/app.ts) to the repo sweep instead (03-api-shape.md §onDelete).
  for (const [field, ref] of Object.entries(references)) {
    if (ref.external) continue; // refById: an unmodeled by-id target has no in-schema table to REFERENCE — emit no FK
    const clause = ref.onDelete === "cascade"
      ? " ON DELETE CASCADE"
      : ref.onDelete === "set-null"
      ? " ON DELETE SET NULL"
      : "";
    lines.push(
      `FOREIGN KEY ("${field}") REFERENCES "${pgSchema}"."${ref.to}" (id)${clause}`,
    ); // intra-module FK qualifies to the table's schema
  }
  // tree self-FK (04-features.md §tree; 03-api-shape.md §4): nullable `REFERENCES <self>(id)` (null = root),
  // minted by-construction; does not prevent cycles (a runtime guard does). Skip if `references` already declared it.
  if (
    features.tree && "parent_id" in deriveColumns(schema) &&
    !("parent_id" in references)
  ) {
    // ON DELETE routes per `onParentDelete` (04-features.md §tree): restrict (default) blocks a parent with
    // children, cascade/set-null delete or reparent on hard delete; a soft-delete tree never fires this clause.
    const opd = typeof features.tree === "object"
      ? features.tree.onParentDelete ?? "restrict"
      : "restrict";
    const treeClause = opd === "cascade"
      ? "ON DELETE CASCADE"
      : opd === "set-null"
      ? "ON DELETE SET NULL"
      : "ON DELETE RESTRICT";
    lines.push(
      `FOREIGN KEY ("parent_id") REFERENCES "${pgSchema}"."${name}" (id) ${treeClause}`,
    );
  }
  // A schema key that collides with a framework-minted column is a DECLARATION fault. Left to the driver it
  // surfaces as PG's `column "created_at" specified more than once` — no resource, no feature, no fix. The
  // check folds over the emitted column lines, so a column minted by a feature added later is covered too.
  const emitted = new Map<string, number>();
  for (const line of lines) {
    const col = /^"?([a-z_][a-z0-9_]*)"?\s/.exec(line)?.[1]; // constraint lines (FOREIGN KEY / CONSTRAINT) start uppercase
    if (col) emitted.set(col, (emitted.get(col) ?? 0) + 1);
  }
  const collisions = [...emitted].filter(([, n]) => n > 1).map(([c]) => c);
  if (collisions.length > 0) {
    const declared = new Set(Object.keys(deriveColumns(schema)));
    const fromSchema = collisions.filter((c) => declared.has(c));
    throw new Error(
      fromSchema.length > 0
        ? `resource '${name}': schema field(s) ${
          fromSchema.map((c) => `'${c}'`).join(", ")
        } collide with a column the framework mints for you — 'id' and the columns its declared features add (timestamps → created_at/updated_at, versioning → version, softDelete → deleted_at, scope → scope_key, …). Drop the field from \`schema\`; the framework writes it.`
        : `resource '${name}': the framework minted the column(s) ${
          collisions.map((c) => `'${c}'`).join(", ")
        } twice — two declared features mint the same name`,
    );
  }
  const table = `CREATE TABLE ${q} (\n  ${lines.join(",\n  ")}\n)`;
  // unique constraints → unique indexes; partial (excluding soft-deleted rows) when softDelete, so a
  // deleted row's key frees up for reuse (03-api-shape.md: `… ON post(slug) WHERE deleted_at IS NULL`).
  const partial = features.softDelete ? " WHERE deleted_at IS NULL" : "";
  // scope folds `scope_key` into every composite unique (03-api-shape.md §scope; the same prepend `owns`-unique
  // uses for the parent FK) — else the index is global and a 23505 discloses cross-tenant existence.
  const partialByKey = new Map(
    uniquePartial.map((u) => [u.cols.join(" "), u.where]),
  );
  const eqSet = new Set(encryptedEquality);
  const indexes = unique.map((cols) => {
    // an equality-encrypted col rides its `<f>_bidx` sidecar (04-features.md §encrypted equality): the keyed
    // MAC is deterministic per key, so MAC-uniqueness IS plaintext-uniqueness — the envelope never indexes.
    const indexCols = (features.scope ? ["scope_key", ...cols] : cols).map(
      (c) => eqSet.has(c) ? `${c}_bidx` : c,
    );
    // the index WHERE = the declared partial predicate (if any) and softDelete's live-rows conjunct (if any): a
    // `{cols,where}` restricts uniqueness to the admitted rows, softDelete frees a deleted key for reuse; both compose.
    const pred = partialByKey.get(cols.join(" "));
    const conjuncts = [
      ...(pred ? [lowerStatic(pred)] : []),
      ...(features.softDelete ? ["deleted_at IS NULL"] : []),
    ];
    const where = conjuncts.length ? ` WHERE ${conjuncts.join(" AND ")}` : "";
    return `CREATE UNIQUE INDEX IF NOT EXISTS "${name}_${
      cols.join("_")
    }_uniq" ON ${q} (${indexCols.map((c) => `"${c}"`).join(", ")})${where}`;
  });
  // the "one row per scope" guarantee for a scoped singleton — a UNIQUE(scope_key) index, partial on softDelete
  // so a purged config frees the scope to re-seed. The row keeps a normal unique id; this index owns per-scope uniqueness.
  const singletonScopeUniq = scopedSingleton
    ? [
      `CREATE UNIQUE INDEX IF NOT EXISTS "${name}_scope_singleton_uniq" ON ${q} ("scope_key")${partial}`,
    ]
    : [];
  // a GIN index over the tsvector — what makes full-text search fast.
  const gin = searchable.length > 0
    ? [
      `CREATE INDEX IF NOT EXISTS "${name}_search_gin" ON ${q} USING GIN (search_vector)`,
    ]
    : [];
  // the HNSW index over the embedding column speeds the approximate-nearest-neighbour (semanticSearch) read; its
  // opclass matches the column type — `vector_cosine_ops` for `vector(N)`, `halfvec_cosine_ops` for `halfvec(N)`.
  const hnsw = vector
    ? [
      `CREATE INDEX IF NOT EXISTS "${name}_${vector.field}_hnsw" ON ${q} USING hnsw ("${vector.field}" ${
        vectorOpClass(vector.dims)
      })`,
    ]
    : [];
  // expiry perf index (04-features.md §expiry migrate): partial over expires_at (never-expiring rows stay out),
  // so the purge sweep's `expires_at <= now()` scan is cheap. Correctness rides the read-time filter, not this index.
  const expiryIdx = expiry
    ? [
      `CREATE INDEX IF NOT EXISTS "${name}_expires_at_idx" ON ${q} (expires_at) WHERE expires_at IS NOT NULL`,
    ]
    : [];
  // temporal perf index (04-features.md §temporal migrate): a plain btree over (valid_from, valid_to), what
  // makes the by-construction as-of window predicate cheap; the GiST/tstzrange EXCLUDE-overlap index is opt-in.
  const temporalIdx = features.temporal
    ? [
      `CREATE INDEX IF NOT EXISTS "${name}_valid_idx" ON ${q} (valid_from, valid_to)`,
    ]
    : [];
  // the blind-index btree — equality probes (`bidx IN (…)`) must not table-scan (04-features.md §encrypted equality)
  const bidxIdx = encryptedEquality.map((f) =>
    `CREATE INDEX IF NOT EXISTS "${name}_${f}_bidx_idx" ON ${q} ("${f}_bidx")`
  );
  // native-sequence object (04-features.md §sequence# migrate): CREATE SEQUENCE the column owns; `nextval` is
  // the lock-free gaps-ok allocator (`start` seeds it). locked-row uses no sequence object — it rides `_seq_counters`.
  const seqObj = sequence && sequence.strategy === "native-sequence"
    ? [
      `CREATE SEQUENCE IF NOT EXISTS "${pgSchema}"."${
        sequenceObjectName(name, sequence)
      }"${sequence.start !== undefined ? ` START ${sequence.start}` : ""}`,
    ]
    : [];
  return [
    ...seqObj,
    table,
    ...indexes,
    ...singletonScopeUniq,
    ...gin,
    ...hnsw,
    ...expiryIdx,
    ...temporalIdx,
    ...bidxIdx,
  ].join(";\n");
}

/** The `<r>_tree` closure table — one row per ancestor→descendant pair (incl. self, depth 0); both
 *  endpoints cascade with their node, so deleting a node drops all of its closure rows. */
export function deriveTreeDDL(name: string, pgSchema: string): string {
  return `CREATE TABLE "${pgSchema}"."${name}_tree" (
  ancestor text NOT NULL REFERENCES "${pgSchema}"."${name}" (id) ON DELETE CASCADE,
  descendant text NOT NULL REFERENCES "${pgSchema}"."${name}" (id) ON DELETE CASCADE,
  depth integer NOT NULL,
  PRIMARY KEY (ancestor, descendant)
)`;
}

/** The `<r>_i18n` translations sidecar — one row per (row, locale, field); cascades with the row. FK on `id`
 *  alone works because every base row's id is unique (even a scoped singleton's), so translations stay per-row. */
export function deriveI18nDDL(name: string, pgSchema: string): string {
  return `CREATE TABLE "${pgSchema}"."${name}_i18n" (
  entity_id text NOT NULL REFERENCES "${pgSchema}"."${name}" (id) ON DELETE CASCADE,
  locale text NOT NULL,
  field text NOT NULL,
  value text NOT NULL,
  PRIMARY KEY (entity_id, locale, field)
)`;
}

/** A many-to-many junction: two cascade FKs + a composite PK (so a pair links at most once). */
export function deriveJunctionDDL(
  name: string,
  pgSchema: string,
  left: string,
  right: string,
): string {
  const q = `"${pgSchema}"."${name}"`;
  return `CREATE TABLE ${q} (
  "${left}_id" text NOT NULL REFERENCES "${pgSchema}"."${left}" (id) ON DELETE CASCADE,
  "${right}_id" text NOT NULL REFERENCES "${pgSchema}"."${right}" (id) ON DELETE CASCADE,
  PRIMARY KEY ("${left}_id", "${right}_id")
)`;
}

/** The temporal no-overlap EXCLUDE constraint body (04-features.md §temporal migrate) — the single source that
 *  raw CREATE TABLE, drizzle-generate, and `checkBaseline` all derive from. `null` when the resource opts out. */
export function temporalExcludeConstraintSql(
  name: string,
  features: Features,
): string | null {
  const noOverlap = temporalNoOverlap(features.temporal);
  if (!noOverlap) return null;
  const keys = [...(features.scope ? ["scope_key"] : []), ...noOverlap];
  return `CONSTRAINT "${name}_no_overlap_excl" EXCLUDE USING gist (${
    keys.map((k) => `"${k}" WITH =`).join(", ")
  }, tstzrange(valid_from, valid_to) WITH &&)`;
}
