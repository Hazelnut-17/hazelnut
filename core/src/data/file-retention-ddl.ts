import type { App } from "../core/app.ts";
import { sqlStringLit } from "./schema-types.ts";

/** Durable retired objects remain owned by a soft-deletable row until its physical deletion. */
export const FILE_RETAINED_DDL = `CREATE TABLE IF NOT EXISTS "_file_retained" (
  pg_schema text NOT NULL, resource text NOT NULL, row_id text NOT NULL, object_key text NOT NULL,
  retired_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pg_schema, resource, row_id, object_key))`;

/** The body committed migrations still carry, from before the reference check.
 *  Exact text only: it has no `EXECUTE`. The current body is the one new
 *  migrations emit. */
const LEGACY_FILE_DELETE_FUNCTION =
  `CREATE OR REPLACE FUNCTION public."_hazelnut_file_delete"() RETURNS trigger
LANGUAGE plpgsql AS $hz_file_delete$
DECLARE keys text[] := ARRAY[]::text[]; field text; object_key text; stamp text; entropy text; job_id text;
BEGIN
  FOREACH field IN ARRAY TG_ARGV LOOP
    object_key := to_jsonb(OLD)->>field;
    IF object_key IS NOT NULL AND object_key<>'' THEN keys := array_append(keys,object_key); END IF;
  END LOOP;
  FOR object_key IN DELETE FROM public."_file_retained"
    WHERE pg_schema=TG_TABLE_SCHEMA AND resource=TG_TABLE_NAME AND row_id=OLD.id::text
    RETURNING "_file_retained".object_key LOOP
    keys := array_append(keys,object_key);
  END LOOP;
  SELECT array_agg(DISTINCT value) INTO keys FROM unnest(keys) AS value;
  IF cardinality(keys)>0 THEN
    stamp := lpad(to_hex(floor(extract(epoch FROM clock_timestamp())*1000)::bigint),12,'0');
    entropy := replace(gen_random_uuid()::text,'-','');
    job_id := substr(stamp,1,8)||'-'||substr(stamp,9,4)||'-7'||substr(entropy,14,3)||'-'||substr(entropy,17,4)||'-'||substr(entropy,21,12);
    INSERT INTO public."_outbox" (id,aggregate_type,aggregate_id,topic,payload,kind,scope)
      VALUES (job_id,'queue',job_id,'_file_gc',jsonb_build_object('keys',keys),'queue',to_jsonb(OLD)->>'scope_key');
  END IF;
  RETURN OLD;
END
$hz_file_delete$`;

export const FILE_DELETE_FUNCTION =
  `CREATE OR REPLACE FUNCTION public."_hazelnut_file_delete"() RETURNS trigger
LANGUAGE plpgsql AS $hz_file_delete$
DECLARE keys text[] := ARRAY[]::text[]; field text; object_key text; stamp text; entropy text; job_id text;
BEGIN
  FOREACH field IN ARRAY TG_ARGV LOOP
    object_key := to_jsonb(OLD)->>field;
    IF object_key IS NOT NULL AND object_key<>'' THEN keys := array_append(keys,object_key); END IF;
  END LOOP;
  FOR object_key IN DELETE FROM public."_file_retained"
    WHERE pg_schema=TG_TABLE_SCHEMA AND resource=TG_TABLE_NAME AND row_id=OLD.id::text
    RETURNING "_file_retained".object_key LOOP
    keys := array_append(keys,object_key);
  END LOOP;
  SELECT array_agg(DISTINCT value) INTO keys FROM unnest(keys) AS value;
  IF cardinality(keys)>0 THEN
    DECLARE kept text[] := ARRAY[]::text[]; object_key text; field text; referenced boolean;
    BEGIN
      FOREACH object_key IN ARRAY keys LOOP
        referenced := false;
        FOREACH field IN ARRAY TG_ARGV LOOP
          EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I WHERE id::text <> $1 AND %I = $2)', TG_TABLE_SCHEMA, TG_TABLE_NAME, field)
            INTO referenced USING OLD.id::text, object_key;
          IF referenced THEN EXIT; END IF;
        END LOOP;
        IF NOT referenced THEN kept := array_append(kept, object_key); END IF;
      END LOOP;
      keys := kept;
    END;
  END IF;
  IF cardinality(keys)>0 THEN
    stamp := lpad(to_hex(floor(extract(epoch FROM clock_timestamp())*1000)::bigint),12,'0');
    entropy := replace(gen_random_uuid()::text,'-','');
    job_id := substr(stamp,1,8)||'-'||substr(stamp,9,4)||'-7'||substr(entropy,14,3)||'-'||substr(entropy,17,4)||'-'||substr(entropy,21,12);
    INSERT INTO public."_outbox" (id,aggregate_type,aggregate_id,topic,payload,kind,scope)
      VALUES (job_id,'queue',job_id,'_file_gc',jsonb_build_object('keys',keys),'queue',to_jsonb(OLD)->>'scope_key');
  END IF;
  RETURN OLD;
END
$hz_file_delete$`;

/** Only an exact generated body is trusted by procedural migration checks.
 *  The current emitter and the previous committed body are both exact. A
 *  rewritten body matches neither. */
export function isFileRetentionFunction(statement: string): boolean {
  const body = statement.trim().replace(/;$/, "");
  return body === FILE_DELETE_FUNCTION || body === LEGACY_FILE_DELETE_FUNCTION;
}

/** Row DELETE triggers run for every FK-cascaded level and enqueue only when that deletion commits. */
export function fileRetentionStatements(app?: App): string[] {
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
  return [
    FILE_DELETE_FUNCTION,
    ...(app?.model ?? []).filter((model) => model.files.length > 0).map((
      model,
    ) =>
      `CREATE OR REPLACE TRIGGER "_hazelnut_file_delete" AFTER DELETE ON ${
        quote(model.pgSchema)
      }.${
        quote(model.name)
      } FOR EACH ROW EXECUTE FUNCTION public."_hazelnut_file_delete"(${
        model.files.map((field) => sqlStringLit(field)).join(
          ", ",
        )
      })`
    ),
  ];
}
