import type { App } from "../core/app.ts";
import {
  lifecycleMarkerColumns,
  rectifiableOn,
  tamperEvidentOn,
  wholeImmutable,
} from "./schema-normalize.ts";

const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

// The stable authenticated bytes of a packed envelope. Invalid envelopes retain all their bytes;
// permissive parsing must never turn two malformed values into an equal permitted rewrite.
const ENVELOPE_PAYLOAD_DDL =
  `CREATE OR REPLACE FUNCTION public."_hazelnut_worm_envelope"(value bytea) RETURNS bytea
LANGUAGE plpgsql IMMUTABLE AS $hz_worm_envelope$
DECLARE p integer; n integer; iv bytea;
BEGIN
  IF value IS NULL OR octet_length(value)<2 THEN RETURN value; END IF;
  p := 1+get_byte(value,0);
  IF p+1>octet_length(value) THEN RETURN value; END IF;
  n := get_byte(value,p); p := p+1;
  IF n<>12 OR p+n+2>octet_length(value) THEN RETURN value; END IF;
  iv := substring(value FROM p+1 FOR n); p := p+n;
  n := get_byte(value,p)*256+get_byte(value,p+1); p := p+2+n;
  IF p+16>octet_length(value) THEN RETURN value; END IF;
  RETURN iv || substring(value FROM p+1);
END
$hz_worm_envelope$`;

const WORM_GUARD_DDL =
  `CREATE OR REPLACE FUNCTION public."_hazelnut_worm_guard_v2"() RETURNS trigger
LANGUAGE plpgsql SET bytea_output='hex' AS $hz_worm_guard$
DECLARE before_row jsonb; after_row jsonb; field text; markers text[];
BEGIN
  IF TG_OP='UPDATE' THEN
    before_row := to_jsonb(OLD); after_row := to_jsonb(NEW);
    FOREACH field IN ARRAY string_to_array(TG_ARGV[2], ',') LOOP
      IF before_row->>field IS NOT NULL AND after_row->>field IS NOT NULL THEN
        before_row := jsonb_set(before_row, ARRAY[field], to_jsonb(encode(public."_hazelnut_worm_envelope"(decode(substring(before_row->>field FROM 3),'hex')),'hex')));
        after_row := jsonb_set(after_row, ARRAY[field], to_jsonb(encode(public."_hazelnut_worm_envelope"(decode(substring(after_row->>field FROM 3),'hex')),'hex')));
      END IF;
    END LOOP;
    FOREACH field IN ARRAY string_to_array(TG_ARGV[3], ',') LOOP
      before_row := before_row-field; after_row := after_row-field;
    END LOOP;
    IF before_row=after_row THEN RETURN NEW; END IF;
    IF TG_ARGV[1]='tamper' AND before_row->>'row_hash' IS NULL AND after_row->>'row_hash' IS NOT NULL
      AND before_row-'row_hash'-'prev_hash'=after_row-'row_hash'-'prev_hash' THEN RETURN NEW; END IF;
    IF TG_ARGV[0]='rectifiable' THEN
      markers := ARRAY(SELECT jsonb_array_elements_text(TG_ARGV[4]::jsonb));
      IF before_row->>'deleted_at' IS NULL AND after_row->>'deleted_at' IS NOT NULL
        AND before_row->>'superseded_by' IS NULL AND after_row->>'superseded_by' IS NULL
        AND before_row-markers=after_row-markers
        AND (NOT ('version'=ANY(markers)) OR (after_row->>'version')::bigint=(before_row->>'version')::bigint+1)
        AND (NOT ('updated_at'=ANY(markers)) OR (after_row->>'updated_at' IS NOT NULL
          AND (after_row->>'updated_at')::timestamptz >= (before_row->>'updated_at')::timestamptz)) THEN RETURN NEW; END IF;
      IF before_row->>'deleted_at' IS NOT NULL AND before_row->'deleted_at'=after_row->'deleted_at'
        AND before_row->>'superseded_by' IS NULL AND after_row->>'superseded_by' IS NOT NULL
        AND before_row-'superseded_by'=after_row-'superseded_by' THEN RETURN NEW; END IF;
    END IF;
  END IF;
  RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='immutable/db-write: history rows cannot be updated, deleted or truncated';
END
$hz_worm_guard$`;

// The released four-argument helper remains a recognized historical migration.
// New triggers use a new function identity; other applications may still have old triggers.
const LEGACY_WORM_GUARD_DDL =
  `CREATE OR REPLACE FUNCTION public."_hazelnut_worm_guard"() RETURNS trigger
LANGUAGE plpgsql AS $hz_worm_guard$
DECLARE before_row jsonb; after_row jsonb; field text;
BEGIN
  IF TG_OP='UPDATE' THEN
    before_row := to_jsonb(OLD); after_row := to_jsonb(NEW);
    FOREACH field IN ARRAY string_to_array(TG_ARGV[2], ',') LOOP
      IF before_row->>field IS NOT NULL AND after_row->>field IS NOT NULL THEN
        before_row := jsonb_set(before_row, ARRAY[field], to_jsonb(encode(public."_hazelnut_worm_envelope"(decode(substring(before_row->>field FROM 3),'hex')),'hex')));
        after_row := jsonb_set(after_row, ARRAY[field], to_jsonb(encode(public."_hazelnut_worm_envelope"(decode(substring(after_row->>field FROM 3),'hex')),'hex')));
      END IF;
    END LOOP;
    FOREACH field IN ARRAY string_to_array(TG_ARGV[3], ',') LOOP
      before_row := before_row-field; after_row := after_row-field;
    END LOOP;
    IF before_row=after_row THEN RETURN NEW; END IF;
    IF TG_ARGV[1]='tamper' AND before_row->>'row_hash' IS NULL AND after_row->>'row_hash' IS NOT NULL
      AND before_row-'row_hash'-'prev_hash'=after_row-'row_hash'-'prev_hash' THEN RETURN NEW; END IF;
    IF TG_ARGV[0]='rectifiable' THEN
      IF before_row->>'deleted_at' IS NULL AND after_row->>'deleted_at' IS NOT NULL
        AND before_row->>'superseded_by' IS NULL AND after_row->>'superseded_by' IS NULL
        AND before_row-ARRAY['deleted_at','superseded_by','version','updated_at','deleted_by_type','deleted_by_id','updated_by_type','updated_by_id']
          =after_row-ARRAY['deleted_at','superseded_by','version','updated_at','deleted_by_type','deleted_by_id','updated_by_type','updated_by_id']
        AND (NOT (before_row ? 'version') OR (after_row->>'version')::bigint=(before_row->>'version')::bigint+1)
        AND (NOT (before_row ? 'updated_at') OR (after_row->>'updated_at' IS NOT NULL
          AND (after_row->>'updated_at')::timestamptz >= (before_row->>'updated_at')::timestamptz)) THEN RETURN NEW; END IF;
      IF before_row->>'deleted_at' IS NOT NULL AND before_row->'deleted_at'=after_row->'deleted_at'
        AND before_row->>'superseded_by' IS NULL AND after_row->>'superseded_by' IS NOT NULL
        AND before_row-'superseded_by'=after_row-'superseded_by' THEN RETURN NEW; END IF;
    END IF;
  END IF;
  RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='immutable/db-write: history rows cannot be updated, deleted or truncated';
END
$hz_worm_guard$`;

/** Exact framework function bodies only. A name, comment marker or altered procedural body grants no
 * safety waiver. Kept separate from migration parsing so this helper cannot pull tooling into serving. */
export function isImmutableGuardFunction(statement: string): boolean {
  return [ENVELOPE_PAYLOAD_DDL, LEGACY_WORM_GUARD_DDL, WORM_GUARD_DDL].some((
    body,
  ) => statement.trim().replace(/;$/, "") === body);
}

/** Database-level WORM: business bytes cannot change. The narrow structural exceptions retain the
 * existing initial HMAC stamp, monotonic rectification links and same-payload KMS rewrap behavior. */
export function immutableGuardStatements(app?: App): string[] {
  const targets = [{
    schema: "public",
    table: "_audit",
    rectifiable: false,
    tamper: false,
    encrypted: [] as readonly string[],
    maintenance: [] as readonly string[],
    markers: [] as readonly string[],
  }];
  for (const model of app?.model ?? []) {
    if (!wholeImmutable(model.features)) continue;
    const derived = new Set([
      ...model.rollupOwnCols,
      ...(model.vector
        ? [
          model.vector.field,
          `${model.vector.field}_embedded_at`,
          `${model.vector.field}_source_hash`,
          `${model.vector.field}_model`,
        ]
        : []),
    ]);
    const maintenance = model.tamperVolatileCols.filter((field) =>
      derived.has(field) && !(field in model.schema.shape) &&
      !model.encrypted.includes(field)
    );
    targets.push({
      schema: model.pgSchema,
      table: model.name,
      rectifiable: rectifiableOn(model.features),
      tamper: tamperEvidentOn(model.features),
      encrypted: model.encrypted,
      maintenance,
      markers: lifecycleMarkerColumns(model.features),
    });
    if (model.i18nDdl && tamperEvidentOn(model.features)) {
      targets.push({
        schema: model.pgSchema,
        table: `${model.name}_i18n`,
        rectifiable: false,
        tamper: true,
        encrypted: [],
        maintenance: [],
        markers: [],
      });
    }
  }
  return [
    ENVELOPE_PAYLOAD_DDL,
    WORM_GUARD_DDL,
    ...targets.flatMap((target) => {
      const table = `${quote(target.schema)}.${quote(target.table)}`;
      const args = `'${target.rectifiable ? "rectifiable" : ""}', '${
        target.tamper ? "tamper" : ""
      }', '${target.encrypted.join(",").replaceAll("'", "''")}', '${
        target.maintenance.join(",").replaceAll("'", "''")
      }', '${JSON.stringify(target.markers).replaceAll("'", "''")}'`;
      return [
        `CREATE OR REPLACE TRIGGER "_hazelnut_worm_rows" BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION public."_hazelnut_worm_guard_v2"(${args})`,
        `CREATE OR REPLACE TRIGGER "_hazelnut_worm_truncate" BEFORE TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION public."_hazelnut_worm_guard_v2"(${args})`,
      ];
    }),
  ];
}
