import { type DefaultSpec, unwrap, type ZType } from "./schema-zod.ts";
import { isSafeStorageKey } from "./storage.ts";
import { z } from "zod";

/** The pinned z.*→pg column mapping (03-api-shape.md §4) — the no-codegen spine: the DB shape is a
 *  pure function of the Zod declaration. Zod-4 internals are read only through the narrow `ZType` view. */

/** Reject unknown keys at the external (mcp + http) boundary (`mcp/strict-input`, 12-mcp §171):
 *  permissive parsing silently drops a stale/renamed arg into a confident wrong answer; `.strict()`
 *  turns it into a loud structured error instead. Peels `optional`/`nullable`/`default`/`pipe` (transform)
 *  wrappers so a refine-or-transform-wrapped object still rejects invent keys; a non-object leaf passes
 *  through unchanged. */
export function strictify(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodObject) return schema.strict();
  const def = (schema as unknown as {
    readonly def?: {
      readonly type?: string;
      readonly innerType?: z.ZodType;
      readonly defaultValue?: unknown;
      readonly in?: z.ZodType;
      readonly out?: z.ZodType;
    };
  }).def;
  if (def?.type === "optional" && def.innerType) {
    return strictify(def.innerType).optional();
  }
  if (def?.type === "nullable" && def.innerType) {
    return strictify(def.innerType).nullable();
  }
  if (def?.type === "default" && def.innerType) {
    return strictify(def.innerType).default(
      def.defaultValue as never,
    );
  }
  if (def?.type === "pipe" && def.in && def.out) {
    // Strict the INPUT side only — invent keys must fail before transform/pipe out runs.
    return strictify(def.in).pipe(def.out as never);
  }
  return schema;
}

/** Parse a partial write patch (http PATCH / bulk update / mcp update): strict-parse against
 *  `.partial()`, then keep only the caller-sent keys. Zod still runs `.default()` on an absent key
 *  under `.partial()` — unfiltered, a single-field PATCH would silently re-stamp every sibling default. */
export function parsePatch(
  schema: z.ZodType,
  raw: unknown,
): { success: true; data: Record<string, unknown> } | {
  success: false;
  error: z.ZodError;
} {
  const parsed = strictify(
    schema instanceof z.ZodObject ? schema.partial() : schema,
  ).safeParse(raw);
  if (!parsed.success) return { success: false, error: parsed.error };
  const sent = raw !== null && typeof raw === "object"
    ? (raw as Record<string, unknown>)
    : {};
  return {
    success: true,
    data: Object.fromEntries(
      Object.entries(parsed.data as Record<string, unknown>).filter(([k]) =>
        k in sent
      ),
    ),
  };
}

/** The `_workflow_journal` framework table DDL (05-runtime.md §workflow durable steps) — the step
 *  replay store `ctx.step` writes through, keyed `(workflow_id, step_id)`; a resume short-circuits a
 *  done step to its stored result instead of re-running it. `locked_at` is a crash-reclaim lease a
 *  concurrent runner backs off from (409) instead of double-running a step. */
export function workflowJournalDDL(): string {
  return `CREATE TABLE "_workflow_journal" (
     workflow_id text NOT NULL, step_id text NOT NULL, result jsonb,
     status text NOT NULL DEFAULT 'running', locked_at timestamptz NOT NULL DEFAULT now(),
     attempts int NOT NULL DEFAULT 0, last_error text, last_error_kind text,
     created_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (workflow_id, step_id))`;
}

/** The `_workflow_progress` framework table DDL (05-runtime.md §workflow durable steps) — one
 *  out-of-band row per `(workflow_id, step_id)`, separate from `_workflow_journal` so a step's
 *  failure record (attempts / last_error / actor / trace_id) can commit on a fresh connection while
 *  the calling op's own transaction rolls the journal back. Mirrors `_task_progress`. */
export function workflowProgressDDL(): string {
  return `CREATE TABLE "_workflow_progress" (
     workflow_id text NOT NULL, step_id text NOT NULL,
     attempts int NOT NULL DEFAULT 0, last_error text, last_error_kind text,
     actor text, trace_id text,
     updated_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (workflow_id, step_id))`;
}

/** The `_tasks` framework table DDL (05-runtime.md §task) — the status/result store `defineTask`
 *  writes and polls; `status` advances inside a worker tx (a throw rolls the claim back), and `failed`
 *  is derived from `_outbox_dead` at poll time, never stored, so a rollback never leaves a false failed.
 *  Live progress lives separately in `_task_progress` (row-lock contention). */
export function tasksTableDDL(): string {
  return `CREATE TABLE "_tasks" (
     id uuid PRIMARY KEY, name text NOT NULL, status text NOT NULL DEFAULT 'queued',
     input jsonb NOT NULL DEFAULT '{}'::jsonb, result jsonb, scope_key text NOT NULL DEFAULT '',
     created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
     completed_at timestamptz)`;
}

/** The `_task_progress` framework table DDL (05-runtime.md §task) — one out-of-band row per task,
 *  separate from `_tasks` so progress/cancel/error writes never block on the running-claim row lock. */
export function taskProgressTableDDL(): string {
  return `CREATE TABLE "_task_progress" (
     task_id uuid PRIMARY KEY, progress double precision NOT NULL DEFAULT 0, message text,
     cancel_requested boolean NOT NULL DEFAULT false, error text, error_kind text,
     updated_at timestamptz NOT NULL DEFAULT now())`;
}

export type PgType =
  | "text"
  | "integer"
  | "double precision"
  | "bigint"
  | "boolean"
  | "timestamptz"
  | "jsonb"
  | "numeric"
  | "uuid"
  | "bytea";

export interface ColSpec {
  readonly pg: PgType | string; // a structural PgType, or a raw dbType() native-type string (`numeric(12,2)`, …)
  readonly nullable: boolean;
  readonly check?: readonly string[]; // enum allowed-values → a CHECK constraint
  readonly default?: DefaultSpec; // a `.default(<static>)` literal/sentinel → a DDL `DEFAULT` clause (03-api-shape.md §4)
}

/** A SQL string literal — single-quoted, `'` doubled. The one quote-escape every DDL CHECK / DEFAULT
 *  string rides, so an enum value `O'Reilly` cannot close the quote early. */
export function sqlStringLit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** Postgres NAMEDATALEN-1: identifiers longer than this are silently truncated, so two names that
 *  differ only past byte 63 become the same index and `IF NOT EXISTS` keeps the first. */
export const PG_IDENT_MAX = 63;

/** Fold an identifier into ≤63 bytes. Short names pass through (existing DDL stays byte-equal);
 *  longer ones keep a prefix plus an FNV-1a digest so two long names cannot collide after truncate. */
export function pgIdent(name: string): string {
  if (name.length <= PG_IDENT_MAX) return name;
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const digest = (h >>> 0).toString(16).padStart(8, "0");
  return `${name.slice(0, PG_IDENT_MAX - 1 - digest.length)}_${digest}`;
}

/** Render a captured default as the SQL fragment after `DEFAULT` — a raw sentinel verbatim, else a
 *  typed literal (single-quoted + quote-escaped for strings; bare for number/boolean). */
export function defaultClause(d: DefaultSpec): string {
  if (d.kind === "raw") return d.sql;
  if (typeof d.value === "string") return sqlStringLit(d.value);
  return String(d.value); // number / boolean — bare
}

/** The `dbType("<pg type>")` native-type seam (02-dsl.md §Helpers; 03-api-shape.md §pg-mapping): pin a
 *  column's Postgres type as a raw string for the long tail the structural z.*→pg map won't guess. Rides
 *  a WeakMap keyed on the Zod instance — invisible to the type-deriver, no value-validation promise.
 *  Legality (`dbtype/legal-target`, 10-invariants.md) is enforced at verify time, not here. */
export const dbTypeRegistry: WeakMap<object, string> = new WeakMap<
  object,
  string
>();

export function dbType<T extends z.ZodType>(schema: T, pg: string): T {
  dbTypeRegistry.set(schema as object, pg);
  return schema;
}

/** The raw `dbType()` annotation on a Zod field instance, walking the `nullable`/`optional`/`default`
 *  wrapper chain (the helper may be applied before or after a wrapper, e.g. `money().nullable()`), or
 *  `undefined` when the field carries no annotation. Same wrapper-robust probe as `collectI18nFields`. */
export function dbTypeOf(field: unknown): string | undefined {
  let cur: { def?: { innerType?: unknown } } | undefined = field as {
    def?: { innerType?: unknown };
  };
  while (cur && typeof cur === "object") {
    const hit = dbTypeRegistry.get(cur as object);
    if (hit !== undefined) return hit;
    cur = cur.def?.innerType as { def?: { innerType?: unknown } } | undefined;
  }
  return undefined;
}

/** The whitelist of native pg types a `dbType()` may name (03-api-shape.md §4, `dbtype/legal-target`) —
 *  free text is a rejected god-knob. `numeric(p,s)` is the parametrized blessed form; a bare base name
 *  (e.g. `numeric`, `varchar`) matches too, so an unparametrized declaration is still legal. */
const DBTYPE_WHITELIST: ReadonlySet<string> = new Set([
  "numeric",
  "decimal",
  "money", // exact decimal / currency (numeric(p,s) is the canonical money form)
  "inet",
  "cidr",
  "macaddr",
  "macaddr8", // network address family
  "point",
  "line",
  "lseg",
  "box",
  "path",
  "polygon",
  "circle", // geometric family
  "interval",
  "tsvector",
  "tsquery",
  "bit",
  "varbit",
  "citext",
  "ltree",
  "uuid",
  "char",
  "varchar",
  "bpchar", // explicit char-family pins (the structural map already covers varchar(n) via .max)
  "bytea",
  "xml",
]);

/** Is a `dbType()` value drawn from the known-mapping whitelist? Matches the base type word before any
 *  `(p,s)`/`[]`/whitespace suffix, case-insensitively — `numeric(12,2)` ⇒ `numeric` ✓, a free string like
 *  `"text; DROP TABLE"` ⇒ rejected. */
export function dbTypeOnWhitelist(pg: string): boolean {
  const base = pg.trim().toLowerCase().match(/^[a-z_][a-z0-9_]*/)?.[0];
  return base !== undefined && DBTYPE_WHITELIST.has(base);
}

/** Every field carrying a `dbType()` annotation, with its raw pg string and whether the underlying Zod
 *  type is string-backed (the seam is for string-backed fields only). The verifier reads this to enforce
 *  the `dbtype/legal-target` legality rules; nothing here is codegen'd. */
export function collectDbTypeFields(
  schema: z.ZodObject<z.ZodRawShape>,
): Record<string, { readonly pg: string; readonly stringBacked: boolean }> {
  const out: Record<string, { pg: string; stringBacked: boolean }> = {};
  for (const [name, field] of Object.entries(schema.shape)) {
    const pg = dbTypeOf(field);
    if (pg === undefined) continue;
    const { inner } = unwrap(field as unknown as ZType);
    out[name] = { pg, stringBacked: inner.def.type === "string" };
  }
  return out;
}

/** `money(p=12, s=2)` — exact decimal: a branded string + `numeric(p,s)`. A JS `z.number()` (double) can't
 *  hold cents without float error, so money is the JS-faithful string the pg driver returns. The brand
 *  survives type-derivation (Zod-side); the `.regex` enforces ≤(p−s) integer + ≤s fractional digits. */
const decimalRegex = (p: number, s: number): RegExp => {
  const intDigits = Math.max(1, p - s); // the integer part has at least the leading digit (handles p===s, e.g. numeric(2,2))
  // scale 0 (whole-number currencies like JPY) has no fractional part — `\d{1,0}` would be an invalid quantifier
  return s > 0
    ? new RegExp(`^-?\\d{1,${intDigits}}(\\.\\d{1,${s}})?$`)
    : new RegExp(`^-?\\d{1,${p}}$`);
};
export const money = (p = 12, s = 2): z.ZodType =>
  dbType(
    z.string().regex(decimalRegex(p, s)).brand("decimal"),
    `numeric(${p},${s})`,
  );

/** `translatable(zStr)` — mark a text field for the `<r>_i18n` per-locale sidecar (04-features.md
 *  §translatable). Transparent to `z.infer` (returns a wrapper whose infer is still T, so `Row` stays a
 *  plain string); `createApp` collects tagged fields into `model.i18n`, the single source the sidecar reads.
 *  The mark is a NEW instance — sharing `const t = z.string()` across fields must not tag siblings. */
const i18nRegistry = new WeakMap<object, true>();
export function translatable<T extends z.ZodType>(zStr: T): T {
  const marked = zStr.describe(zStr.description ?? "translatable");
  i18nRegistry.set(marked as object, true);
  return marked as T;
}

/** Field names whose schema instance was tagged `translatable()` — createApp unions these into model.i18n.
 *  Walks the wrapper chain (`.def.innerType`), so `translatable(z.string()).optional()` still registers even
 *  though `.optional()` wraps the tagged instance in a new one (robust to helper-vs-wrapper application order). */
export function collectI18nFields(
  schema: z.ZodObject<z.ZodRawShape>,
): string[] {
  const tagged = (field: unknown): boolean => {
    let cur: { def?: { innerType?: unknown } } | undefined = field as {
      def?: { innerType?: unknown };
    };
    while (cur && typeof cur === "object") {
      if (i18nRegistry.has(cur as object)) return true;
      cur = cur.def?.innerType as { def?: { innerType?: unknown } } | undefined;
    }
    return false;
  };
  return Object.entries(schema.shape).filter(([, f]) => tagged(f)).map(([n]) =>
    n
  );
}

/** `file()` — a field holding an opaque storage key (`text`), never the bytes: bytes live off-box behind
 *  the `StorageDriver` Port. Mirrors `translatable()` — a WeakMap tags the instance, `createApp` unions
 *  tagged names into `model.files`; the column is ordinary `text`. Deliberately not `blob()` — a SQL
 *  BLOB is bytes-in-DB, the opposite of off-box. */
const fileRegistry = new WeakMap<object, true>();
export function file(): z.ZodType {
  // The key is client-controlled; refuse a path-traversal key (`..`/absolute/NUL/backslash) at this input
  // boundary (400) — `localDriver` re-guards the same check at the sink (storage.ts `isSafeStorageKey`).
  const z_ = z.string().refine(isSafeStorageKey, {
    message:
      "invalid storage key — must be a relative path with no '..'/'.' segments, no leading '/', no backslash, and no NUL byte (path-traversal guard)",
  });
  fileRegistry.set(z_ as object, true);
  return z_; // the opaque key (z.infer = string); the marker, not the type, drives file behavior
}

/** Field names whose schema instance was tagged `file()` — createApp unions these into `model.files`. Walks the
 *  `.def.innerType` wrapper chain (so `file().optional()` still registers), identical to `collectI18nFields`. */
export function collectFileFields(
  schema: z.ZodObject<z.ZodRawShape>,
): string[] {
  const tagged = (field: unknown): boolean => {
    let cur: { def?: { innerType?: unknown } } | undefined = field as {
      def?: { innerType?: unknown };
    };
    while (cur && typeof cur === "object") {
      if (fileRegistry.has(cur as object)) return true;
      cur = cur.def?.innerType as { def?: { innerType?: unknown } } | undefined;
    }
    return false;
  };
  return Object.entries(schema.shape).filter(([, f]) => tagged(f)).map(([n]) =>
    n
  );
}

/** `password()` — a field holding a salted slow-KDF hash (13-authz.md §password-auth-recipe), never the
 *  plaintext. Mirrors `file()`: `createApp` unions tagged names into `model.passwords`, auto-adds them to
 *  `model.sensitive`, and the repo hashes the value on write via the framework KDF (`hashCode`,
 *  PBKDF2-SHA256, 600k iters, per-row salt). */
const passwordRegistry = new WeakMap<object, true>();
export function password(): z.ZodString {
  const z_ = z.string();
  passwordRegistry.set(z_ as object, true);
  return z_; // a plain string (the hash at rest); the marker, not the type, drives password behaviour
}

/** Field names whose schema instance was tagged `password()` — createApp unions these into `model.passwords`
 *  (and into `model.sensitive`). Walks the `.def.innerType` wrapper chain, identical to `collectFileFields`. */
export function collectPasswordFields(
  schema: z.ZodObject<z.ZodRawShape>,
): string[] {
  const tagged = (field: unknown): boolean => {
    let cur: { def?: { innerType?: unknown } } | undefined = field as {
      def?: { innerType?: unknown };
    };
    while (cur && typeof cur === "object") {
      if (passwordRegistry.has(cur as object)) return true;
      cur = cur.def?.innerType as { def?: { innerType?: unknown } } | undefined;
    }
    return false;
  };
  return Object.entries(schema.shape).filter(([, f]) => tagged(f)).map(([n]) =>
    n
  );
}

// roster/engine extracted into cohesive submodules, re-exported so importers stay stable.
