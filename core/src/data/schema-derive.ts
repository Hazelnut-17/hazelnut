import { stringFormatOf, unwrap, type ZType } from "./schema-zod.ts";
// Barrel re-exports keep import sites stable.
import { type ColSpec, dbTypeRegistry, type PgType } from "./schema-types.ts";
import type { z } from "zod";

// A narrow view of the Zod-4 internal def shape (probed, not public API — guarded here only): a string
// `.max(n)` check is `_zod.def.{check:"max_length",maximum}`; `.int()` is a number check with `def.format:"safeint"`.

/** The declared upper bound of a `z.string().max(n)`, or undefined for a plain/min-only string. Reads the
 *  `max_length` check off the Zod-4 internal def; when several `.max()` apply, the tightest bound wins. */
function maxLength(s: ZType): number | undefined {
  let bound: number | undefined;
  for (const c of s.def.checks ?? []) {
    const d = c._zod?.def;
    if (d?.check === "max_length" && typeof d.maximum === "number") {
      bound = bound === undefined ? d.maximum : Math.min(bound, d.maximum);
    }
  }
  return bound;
}

/** Every zod string format that IS a uuid — `z.uuid()` plus the version-pinned factories. Derived as a set
 *  rather than an equality on "uuid" alone: `z.uuidv7()` is the framework's own default id strategy and its
 *  format string is `uuidv7`, so an equality test silently derived `text` for it. */
const UUID_FORMATS: ReadonlySet<string> = new Set([
  "uuid",
  "guid",
  "uuidv4",
  "uuidv6",
  "uuidv7",
]);

function mapType(s: ZType): { pg: PgType | string; check?: readonly string[] } {
  const hint = dbTypeRegistry.get(s as unknown as object); // the dbType() seam wins over the structural map
  if (hint) return { pg: hint }; // a raw native-type string (`numeric(12,2)`), emitted verbatim by deriveDDL
  switch (s.def.type) {
    case "string": {
      // A string subtype's format is the discriminator (03-api-shape.md §4): `z.uuid()` → real `uuid`,
      // `z.iso.datetime()` → `timestamptz` (never bare timestamp/lossy text) — else both fall through to
      // text. Read through `stringFormatOf`: the chained spelling carries its format in a check, and
      // reading only `def.format` derived `text` for it while every gate stayed green.
      const format = stringFormatOf(s);
      if (format !== undefined && UUID_FORMATS.has(format)) {
        return { pg: "uuid" };
      }
      if (format === "datetime") return { pg: "timestamptz" }; // ISO-datetime string → timestamptz, never bare timestamp
      const n = maxLength(s); // declared bound = truth (03-api-shape.md §4): a `.max(n)` becomes varchar(n)
      return { pg: n !== undefined ? `varchar(${n})` : "text" }; // plain/min-only string stays text
    }
    case "number": {
      const isInt = (s.def.checks ?? []).some((c) =>
        (c.def?.format ?? c._zod?.def?.format) === "safeint"
      );
      return { pg: isInt ? "integer" : "double precision" }; // never `real`; exact decimal uses dbType
    }
    case "bigint":
      return { pg: "bigint" };
    case "boolean":
      return { pg: "boolean" };
    case "date":
      return { pg: "timestamptz" }; // never bare `timestamp`
    case "enum":
      return {
        pg: "text",
        check: s.def.options ?? Object.values(s.def.entries ?? {}),
      }; // text + CHECK, NOT pgEnum
    case "object":
    case "array":
    case "record":
    case "map":
    case "set":
      return { pg: "jsonb" }; // never `json`
    default:
      return { pg: "text" }; // the dbType() seam owns the native-type long tail
  }
}

export function deriveColumns(
  schema: z.ZodObject<z.ZodRawShape>,
): Record<string, ColSpec> {
  const out: Record<string, ColSpec> = {};
  for (const [name, field] of Object.entries(schema.shape)) {
    const { inner, nullable, default: dflt } = unwrap(
      field as unknown as ZType,
    );
    const { pg, check } = mapType(inner);
    out[name] = {
      pg,
      nullable,
      ...(check ? { check } : {}),
      ...(dflt ? { default: dflt } : {}),
    };
  }
  return out;
}

// ── id PK-type config (02-dsl.md §id) ───────────────────────────────────
//
// PK type is config, not a feature: uuidv7 (default, app-minted `id text`), uuidv4 (DB `gen_random_uuid()`),
// serial (DB identity `bigint`) — all three keep literal PRIMARY KEY + column `id` (resource/has-id).

export type IdStrategy = "uuidv7" | "uuidv4" | "serial";
export const ID_STRATEGIES: ReadonlySet<string> = new Set<IdStrategy>([
  "uuidv7",
  "uuidv4",
  "serial",
]);
export const DEFAULT_ID_STRATEGY: IdStrategy = "uuidv7";

/** The fixed sentinel id every `singleton` row carries (04-features.md §singleton-marker). A global singleton
 *  pins `CHECK (id = '<sentinel>')` so `create` mints this constant and `getOrSeedConfig` addresses it by a known
 *  id, never a table scan. A scoped singleton does not use this — it mints a normal uuidv7 per scope instead. */
export const SINGLETON_SENTINEL_ID = "00000000-0000-0000-0000-000000000001";

/** Normalize a declared `id` value to an `IdStrategy` (app default, else `uuidv7`). An unknown value loud-fails
 *  here — the silent-swallow this closes (03-api-shape.md §firing-set decl/unknown-key inverse); `where` names
 *  the resource so a typo'd `id:"uuuidv4"` is a precise boot failure, never a no-op. */
export function resolveIdStrategy(
  declared: string | undefined,
  appDefault: string | undefined,
  where: string,
): IdStrategy {
  const v = declared ?? appDefault ?? DEFAULT_ID_STRATEGY;
  if (!ID_STRATEGIES.has(v)) {
    throw new Error(
      `invalid id strategy '${v}' on ${where} — expected one of: uuidv7 | uuidv4 | serial`,
    );
  }
  return v as IdStrategy;
}

/** The FK COLUMN type a minted reference to a `<strategy>` PK must carry — the mirror of `idPkDdl`'s type
 *  half. A hardcoded `text` FK against a serial `bigint` PK dies at CREATE TABLE with a raw driver error. */
export function idFkColType(strategy: IdStrategy): string {
  switch (strategy) {
    case "uuidv4":
      return "uuid";
    case "serial":
      return "bigint";
    case "uuidv7":
      return "text";
  }
}

/** The PK column DDL line for a strategy — the first line of the CREATE TABLE, always carrying the
 *  literal `PRIMARY KEY` and the column name `id` (so `resource/has-id` holds for all three). */
export function idPkDdl(strategy: IdStrategy): string {
  switch (strategy) {
    case "uuidv4":
      return "id uuid PRIMARY KEY DEFAULT gen_random_uuid()"; // DB-allocated v4 (full opacity)
    case "serial":
      return "id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY"; // DB-allocated identity integer
    case "uuidv7":
      return "id text PRIMARY KEY"; // app-minted time-ordered UUIDv7 (default)
  }
}

/** Does this strategy allocate the id at the DB (uuidv4 default / serial identity), so the repo omits
 *  `id` from the INSERT and reads it back via RETURNING? `uuidv7` is app-minted, so this is false. */
export function idIsDbAllocated(strategy: IdStrategy): boolean {
  return strategy !== "uuidv7";
}

export const PG_DDL: Record<PgType, string> = {
  "text": "text",
  "integer": "integer",
  "double precision": "double precision",
  "numeric": "numeric(19,4)",
  "bigint": "bigint",
  "boolean": "boolean",
  "timestamptz": "timestamptz",
  "jsonb": "jsonb",
  "uuid": "uuid",
  "bytea": "bytea",
};

// ── sequence# config (04-features.md §sequence#) ──────────────────────────────────────────────────
//
// `features.sequence` carries the object card `{field, strategy, scope?, prefix?, pad?, start?}`;
// bare `true` is refused at normalize (TD-1).

/** The sequence# card (04-features.md §sequence# config). */
export interface SequenceConfig {
  readonly field: string; // the generated column name (default "seq")
  readonly strategy: "locked-row" | "native-sequence"; // gap-free serialize-to-commit | lock-free nextval (gaps ok)
  readonly scope?: string; // counter partition key; omit = single global counter
  readonly prefix?: string; // literal + date tokens ({YYYY}/{YY}/{MM}); presence ⇒ the column is `text`
  readonly pad?: number; // zero-pad width; presence ⇒ the column is `text`
  readonly start?: number;
}

/** A narrow structural view of the runtime `features.sequence` value (object card or bare boolean). */
type SequenceInput = boolean | {
  readonly field?: string;
  readonly strategy?: "locked-row" | "native-sequence";
  readonly scope?: string;
  readonly prefix?: string;
  readonly pad?: number;
  readonly start?: number;
};

/** Normalize `features.sequence` to the `SequenceConfig` card, or `null` when off. Bare `true` is
 *  REMOVED (TD-1) — the object card is the only form; an upgrade reshape rewrites `true` →
 *  `{ field: "seq", strategy: "locked-row" }`. */
export function normalizeSequence(
  seq: SequenceInput | undefined,
): SequenceConfig | null {
  if (!seq) return null;
  if (seq === true) {
    throw new Error(
      `sequence: bare 'true' is removed — write sequence: { field: "seq", strategy: "locked-row" } (or name your field). There is no boolean shorthand: a deprecated-but-working alias trains the wrong answer.`,
    );
  }
  const strategy = seq.strategy ?? "locked-row";
  // `native-sequence` (DB-allocated integer nextval) is structurally incompatible with `pad`/`prefix` (which
  // format the column as text) — forbid the contradiction at declaration (fail-fast at boot); it would violate NOT NULL.
  if (
    strategy === "native-sequence" &&
    (seq.pad !== undefined || seq.prefix !== undefined)
  ) {
    throw new Error(
      `sequence: strategy 'native-sequence' cannot be formatted with pad/prefix — native allocation is integer-only. Use strategy 'locked-row' for a formatted id (e.g. 'INV-2026-0001').`,
    );
  }
  return {
    field: seq.field ?? "seq",
    strategy,
    ...(seq.scope !== undefined ? { scope: seq.scope } : {}),
    ...(seq.prefix !== undefined ? { prefix: seq.prefix } : {}),
    ...(seq.pad !== undefined ? { pad: seq.pad } : {}),
    ...(seq.start !== undefined ? { start: seq.start } : {}),
  };
}

/** The pg type of the sequence# column: `text` when a `prefix`/`pad` formats it into a human string
 *  (`INV-2026-0001`), else the dense integer the counter returns (04-features.md §sequence# runtime). */
export function sequenceColumnType(
  cfg: SequenceConfig,
): "text" | "bigint" | "integer" {
  if (cfg.prefix !== undefined || cfg.pad !== undefined) return "text";
  return cfg.strategy === "native-sequence" ? "bigint" : "integer"; // native nextval is bigint; locked-row is integer
}

/** The Postgres sequence object name a `native-sequence` strategy owns (`<table>_<field>_seq`). The DDL
 *  emits a `CREATE SEQUENCE` for it; `nextval('<this>')` is the lock-free (gaps-ok) allocator. */
export function sequenceObjectName(table: string, cfg: SequenceConfig): string {
  return `${table}_${cfg.field}_seq`;
}
