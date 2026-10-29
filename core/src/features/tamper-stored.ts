import type { Db } from "../data/db.ts";
import {
  canonicalTamperSql,
  tamperStorageIdentity,
  type TamperStorageType,
} from "./tamper-codec.ts";

export const LEGACY_TYPES = Symbol("tamper.legacyTypes");
export const TYPED_TYPES = Symbol("tamper.typedTypes");
export const TYPED_VALUES = Symbol("tamper.typedValues");
export type StoredRow = Record<string, unknown> & {
  [LEGACY_TYPES]?: Readonly<Record<string, string>>;
  [TYPED_TYPES]?: Readonly<Record<string, string>>;
  [TYPED_VALUES]?: Readonly<Record<string, unknown>>;
};
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
function fromHex(value: string): string {
  if (!/^(?:[a-f0-9]{2})*$/.test(value)) {
    throw new Error("tamper/codec: invalid ASCII transport");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Uint8Array.from(value.match(/../g) ?? [], (pair) => parseInt(pair, 16)),
  );
}
interface Column {
  name: string;
  legacy: string;
  timestampCompatible: boolean;
  type: TamperStorageType;
}
/** Both projections travel together. Legacy bytes remain untouched; v3 never
 * authenticates driver-decoded display text. Unsupported extra columns are
 * omitted from the typed sidecar and refused only if a signed manifest uses them. */
export async function storedRows(
  db: Db,
  table: string,
  suffix: string,
  params: unknown[] = [],
): Promise<StoredRow[]> {
  const encoding = (await db.query<{ encoding: string }>(
    "SELECT pg_catalog.current_setting('client_encoding') AS encoding",
  )).rows[0]?.encoding;
  if (encoding !== "UTF8") {
    throw new Error(
      "tamper/codec: UTF8 client_encoding is required; restore UTF8 before append or verification",
    );
  }
  // Catalog text is explicitly UTF8/hex, including non-ASCII identifiers and extension namespaces.
  const catalog = (await db.query<{ encoded: string }>(
    `WITH RECURSIVE ancestry(origin,current,next) AS (
      SELECT DISTINCT a.atttypid,t.oid,t.typbasetype FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_type t ON t.oid=a.atttypid
      WHERE a.attrelid=$1::pg_catalog.regclass AND a.attnum>0 AND NOT a.attisdropped
      UNION ALL SELECT ancestry.origin,t.oid,t.typbasetype FROM ancestry
      JOIN pg_catalog.pg_type t ON t.oid=ancestry.next
    ) SELECT pg_catalog.encode(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object('name',a.attname,'legacy',pg_catalog.format_type(a.atttypid,a.atttypmod),
      'timestampCompatible',(COALESCE(bt.typnamespace,t.typnamespace)='pg_catalog'::pg_catalog.regnamespace AND COALESCE(bt.typname,t.typname) IN ('date','timestamp','timestamptz','interval')),
      'type',pg_catalog.jsonb_build_object('namespace',n.nspname,'name',t.typname,'modifier',a.atttypmod,
        'kind',CASE WHEN t.typtype <> 'b' THEN 'unsupported'
          WHEN t.typcategory='A' AND p.proname='array_subscript_handler' AND e.typtype='b' THEN 'array'
          WHEN t.typcategory='A' THEN 'unsupported' ELSE 'scalar' END,
        'extension',x.extname,'element',CASE WHEN t.typcategory='A' THEN
          pg_catalog.jsonb_build_object('namespace',en.nspname,'name',e.typname,'extension',ex.extname) ELSE NULL END)
    )::pg_catalog.text,'UTF8'),'hex') AS encoded
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_type t ON t.oid=a.atttypid LEFT JOIN LATERAL (SELECT base.* FROM ancestry
      JOIN pg_catalog.pg_type base ON base.oid=ancestry.current
      WHERE ancestry.origin=t.oid AND base.typbasetype=0) bt ON true JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
    LEFT JOIN pg_catalog.pg_proc p ON p.oid=t.typsubscript
    LEFT JOIN pg_catalog.pg_type e ON e.oid=t.typelem LEFT JOIN pg_catalog.pg_namespace en ON en.oid=e.typnamespace
    LEFT JOIN pg_catalog.pg_depend d ON d.classid='pg_catalog.pg_type'::pg_catalog.regclass AND d.objid=t.oid AND d.refclassid='pg_catalog.pg_extension'::pg_catalog.regclass AND d.deptype='e'
    LEFT JOIN pg_catalog.pg_extension x ON x.oid=d.refobjid
    LEFT JOIN pg_catalog.pg_depend ed ON ed.classid='pg_catalog.pg_type'::pg_catalog.regclass AND ed.objid=e.oid AND ed.refclassid='pg_catalog.pg_extension'::pg_catalog.regclass AND ed.deptype='e'
    LEFT JOIN pg_catalog.pg_extension ex ON ex.oid=ed.refobjid
    WHERE a.attrelid=$1::pg_catalog.regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,
    [table],
  )).rows;
  const columns = catalog.map(({ encoded }) =>
    JSON.parse(fromHex(encoded)) as Column
  );
  const selection = columns.map(
    ({ name, legacy: type, timestampCompatible }) => {
      const col = quote(name);
      // The original v2 scalar projection is preserved, including its era/display limitations.
      const value = type === "bytea"
        ? `CASE WHEN ${col} IS NULL THEN NULL ELSE 'hex:' || pg_catalog.encode(${col}, 'hex') END`
        : type.startsWith("timestamp") && timestampCompatible
        ? `CASE WHEN pg_catalog.isfinite(${col}) THEN pg_catalog.to_char(${col}${
          type.includes("with time zone") ? " AT TIME ZONE 'UTC'" : ""
        }, 'YYYY-MM-DD"T"HH24:MI:SS.US${
          type.includes("with time zone") ? '"Z"' : ""
        }') ELSE ${col}::pg_catalog.text END`
        : type === "date"
        ? `CASE WHEN pg_catalog.isfinite(${col}) THEN pg_catalog.to_char(${col}, 'YYYY-MM-DD') ELSE ${col}::pg_catalog.text END`
        : `${col}::pg_catalog.text`;
      return `${value} AS ${col}`;
    },
  );
  let alias = "__hazelnut_tamper_values";
  while (columns.some((c) => c.name === alias)) alias += "_";
  const encodedValues = columns.flatMap(({ name, type }) => {
    const sql = canonicalTamperSql(type, quote(name));
    return sql === undefined
      ? []
      : [`(${literal(name)},pg_catalog.to_jsonb(${sql}))`];
  });
  const sidecar = encodedValues.length
    ? `(SELECT pg_catalog.jsonb_object_agg(k,v) FROM (VALUES ${
      encodedValues.join(",")
    }) AS __hz_values(k,v))`
    : "'{}'::pg_catalog.jsonb";
  selection.push(
    `pg_catalog.encode(pg_catalog.convert_to(${sidecar}::pg_catalog.text,'UTF8'),'hex') AS ${
      quote(alias)
    }`,
  );
  const rows = (await db.query<StoredRow>(
    `SELECT ${selection.join(",")} FROM ${table} ${suffix}`,
    params,
  )).rows;
  const legacyTypes = Object.fromEntries(
    columns.map((c) => [c.name, c.legacy]),
  );
  const typedTypes = Object.fromEntries(
    columns.map((c) => [c.name, tamperStorageIdentity(c.type)]),
  );
  for (const row of rows) {
    const values = JSON.parse(fromHex(String(row[alias]))) as Record<
      string,
      unknown
    >;
    delete row[alias];
    Object.defineProperties(row, {
      [LEGACY_TYPES]: { value: legacyTypes },
      [TYPED_TYPES]: { value: typedTypes },
      [TYPED_VALUES]: { value: values },
    });
  }
  return rows;
}
