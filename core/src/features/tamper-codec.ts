/** Canonical stored-value SQL for the typed chain format. Catalog facts select
 * explicit reviewed families; callers defer unsupported-column refusal until
 * the authenticated manifest actually selects that column. */
export interface TamperScalarType {
  readonly namespace: string;
  readonly name: string;
  readonly extension?: string;
}
export interface TamperStorageType extends TamperScalarType {
  readonly modifier: number;
  /** Derived from the actual array category/handler, never from typelem alone. */
  readonly kind: "scalar" | "array" | "unsupported";
  readonly element?: TamperScalarType;
}

const BINARY_SENDERS: Readonly<Record<string, string>> = {
  bool: "boolsend",
  int2: "int2send",
  int4: "int4send",
  int8: "int8send",
  float4: "float4send",
  float8: "float8send",
  numeric: "numeric_send",
  money: "cash_send",
  uuid: "uuid_send",
  date: "date_send",
  time: "time_send",
  timetz: "timetz_send",
  timestamp: "timestamp_send",
  timestamptz: "timestamptz_send",
  interval: "interval_send",
  inet: "inet_send",
  cidr: "cidr_send",
  macaddr: "macaddr_send",
  macaddr8: "macaddr8_send",
  point: "point_send",
  line: "line_send",
  lseg: "lseg_send",
  box: "box_send",
  path: "path_send",
  polygon: "poly_send",
  circle: "circle_send",
  bit: "bit_send",
  varbit: "varbit_send",
};
const UTF8_TEXT = new Set([
  "text",
  "varchar",
  "json",
  "jsonb",
  "xml",
  "tsvector",
  "tsquery",
]);
function scalarBytes(
  type: TamperScalarType,
  value: string,
): string | undefined {
  if (type.namespace === "pg_catalog") {
    if (type.name === "bytea") return value;
    const sender = Object.hasOwn(BINARY_SENDERS, type.name)
      ? BINARY_SENDERS[type.name]
      : undefined;
    if (sender) return `pg_catalog.${sender}(${value})`;
    // bpchar->text casts trim padding. Its output cstring and text input keep it.
    if (type.name === "bpchar") {
      return `pg_catalog.convert_to(pg_catalog.textin(pg_catalog.bpcharout(${value})), 'UTF8')`;
    }
    if (UTF8_TEXT.has(type.name)) {
      return `pg_catalog.convert_to(${value}::pg_catalog.text, 'UTF8')`;
    }
  }
  if (
    (type.name === "citext" && type.extension === "citext") ||
    (type.name === "ltree" && type.extension === "ltree")
  ) return `pg_catalog.convert_to(${value}::pg_catalog.text, 'UTF8')`;
  return undefined;
}
function scalarHex(type: TamperScalarType, value: string): string | undefined {
  const bytes = scalarBytes(type, value);
  return bytes === undefined
    ? undefined
    : `CASE WHEN ${value} IS NULL THEN NULL ELSE pg_catalog.encode(${bytes}, 'hex') END`;
}
/** Scalars are ASCII hex; arrays are JSON values containing shape and ordered
 * NULL-preserving scalar hex, independent of element OIDs or physical bitmaps.
 * SQL expressions originate in the framework's quoted catalog-column projection. */
export function canonicalTamperSql(
  type: TamperStorageType,
  value: string,
): string | undefined {
  if (type.kind === "unsupported") return undefined;
  if (type.kind === "scalar") return scalarHex(type, value);
  if (!type.element) return undefined;
  const leaf = scalarHex(type.element, '"__hz_element"."value"');
  if (leaf === undefined) return undefined;
  return `CASE WHEN ${value} IS NULL THEN NULL ELSE pg_catalog.jsonb_build_array(
    'array-v1', pg_catalog.array_dims(${value}),
    COALESCE((SELECT pg_catalog.jsonb_agg(${leaf} ORDER BY "__hz_element"."ordinal")
      FROM pg_catalog.unnest(${value}) WITH ORDINALITY AS "__hz_element"("value", "ordinal")),
      '[]'::pg_catalog.jsonb)) END`;
}
/** OID-free identity survives ordinary dump/restore; typmod remains authenticated. */
export function tamperStorageIdentity(type: TamperStorageType): string {
  const identity = (scalar: TamperScalarType) => [
    scalar.namespace,
    scalar.name,
    scalar.extension ?? null,
  ];
  return JSON.stringify([
    type.kind,
    ...identity(type),
    type.modifier,
    type.kind === "array" && type.element ? identity(type.element) : null,
  ]);
}
