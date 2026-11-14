import type { ResourceModel } from "../core/app.ts";
import { tableOf } from "../core/app-define.ts";
import { type Db, isTransactor } from "../data/db.ts";
import { sqlStringLit } from "../data/schema-types.ts";
import { hasTransactionRootRole } from "../data/transaction-scope.ts";

const GUARD_BODY = `
DECLARE before_value text; after_value text; payload bytea; key_bytes bytea;
        key_len integer; iv_len integer; wrapped_len integer; pos integer;
BEGIN
  after_value := to_jsonb(NEW)->>TG_ARGV[0];
  IF after_value IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' THEN
    before_value := to_jsonb(OLD)->>TG_ARGV[0];
    IF before_value IS NOT DISTINCT FROM after_value THEN RETURN NEW; END IF;
  END IF;
  IF left(after_value, 2) <> chr(92) || 'x' THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='encrypted/envelope-fence: invalid bytea representation';
  END IF;
  payload := decode(substring(after_value FROM 3), 'hex');
  key_bytes := decode(TG_ARGV[1], 'hex');
  IF octet_length(payload) < 2 THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='encrypted/envelope-fence: malformed envelope';
  END IF;
  key_len := get_byte(payload, 0);
  pos := 1 + key_len;
  IF octet_length(payload) <= pos THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='encrypted/envelope-fence: malformed envelope';
  END IF;
  iv_len := get_byte(payload, pos);
  pos := pos + 1 + iv_len;
  IF octet_length(payload) < pos + 2 THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='encrypted/envelope-fence: malformed envelope';
  END IF;
  wrapped_len := get_byte(payload, pos) * 256 + get_byte(payload, pos + 1);
  IF octet_length(payload) < pos + 2 + wrapped_len THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='encrypted/envelope-fence: malformed envelope';
  END IF;
  IF key_len = octet_length(key_bytes)
    AND substring(payload FROM 2 FOR octet_length(key_bytes)) = key_bytes THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='encrypted/envelope-key-fenced: this key version cannot be written';
  END IF;
  RETURN NEW;
END
`;
const GUARD =
  `CREATE FUNCTION public."_hazelnut_envelope_fence_v1"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog SET bytea_output = 'hex' AS $hz_envelope_fence$${GUARD_BODY}$hz_envelope_fence$`;

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;

/** Persistently refuse NEW writes under one old envelope key, including writes by older framework versions.
 * The caller needs table-owner/trigger and function DDL privileges; no key material is read or removed. */
export async function fenceEnvelopeWriters(
  db: Db,
  models: readonly ResourceModel[],
  keyId: string,
): Promise<number> {
  const keyBytes = new TextEncoder().encode(keyId);
  if (keyBytes.length > 255) {
    throw new Error(
      "encrypted/envelope-fence: key id exceeds the envelope's 255-byte limit",
    );
  }
  if (!isTransactor(db) || !hasTransactionRootRole(db)) {
    throw new Error(
      "encrypted/envelope-fence: a declared root transaction is required",
    );
  }
  const keyHex = hex(keyBytes);
  const targets = models.flatMap((model) =>
    model.encrypted.map((field) => ({ model, field }))
  ).sort((a, b) => {
    const left = JSON.stringify([a.model.pgSchema, a.model.name, a.field]);
    const right = JSON.stringify([b.model.pgSchema, b.model.name, b.field]);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  if (targets.length === 0) return 0;
  const entries = await Promise.all(targets.map(async ({ model, field }) => {
    const identity = JSON.stringify([
      model.pgSchema,
      model.name,
      field,
      keyHex,
    ]);
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity)),
    );
    return {
      model,
      field,
      trigger: `_hazelnut_ef_${hex(digest).slice(0, 40)}`,
    };
  }));
  await db.transaction(async (tx) => {
    // DDL takes conflicting table locks: acquire them all in a stable order before making any change.
    for (
      const table of [...new Set(entries.map(({ model }) => tableOf(model)))]
    ) {
      await tx.exec(`LOCK TABLE ${table} IN SHARE ROW EXCLUSIVE MODE`);
    }
    const functions = (await tx.query<{
      body: string;
      language: string;
      config: string | null;
      nargs: number;
      result: string;
      kind: string;
      security_definer: boolean;
      strict: boolean;
      leakproof: boolean;
      volatility: string;
      parallel: string;
      returns_set: boolean;
    }>(`SELECT p.prosrc AS body, l.lanname AS language,
               array_to_string(p.proconfig, ',') AS config, p.pronargs::integer AS nargs,
               p.prorettype::regtype::text AS result, p.prokind AS kind,
               p.prosecdef AS security_definer, p.proisstrict AS strict,
               p.proleakproof AS leakproof, p.provolatile AS volatility,
               p.proparallel AS parallel, p.proretset AS returns_set
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        JOIN pg_catalog.pg_language l ON l.oid=p.prolang
        WHERE n.nspname='public' AND p.proname='_hazelnut_envelope_fence_v1'`))
      .rows;
    if (functions.length === 0) await tx.exec(GUARD);
    else {
      const fn = functions[0]!;
      if (
        functions.length !== 1 || fn.body !== GUARD_BODY ||
        fn.language !== "plpgsql" ||
        fn.config !== "search_path=pg_catalog,bytea_output=hex" ||
        fn.nargs !== 0 || fn.result !== "trigger" ||
        fn.kind !== "f" || fn.security_definer || fn.strict || fn.leakproof ||
        fn.volatility !== "v" ||
        fn.parallel !== "u" || fn.returns_set
      ) {
        throw new Error(
          "encrypted/envelope-fence: existing guard function does not match the framework fence",
        );
      }
    }
    for (const { model, field, trigger } of entries) {
      const table = tableOf(model);
      const rows = (await tx.query<{
        args: string;
        name: string;
        schema: string;
        enabled: string;
        type: number;
        nargs: number;
      }>(
        `SELECT encode(t.tgargs, 'hex') AS args, p.proname AS name,
                 n.nspname AS schema, t.tgenabled AS enabled, t.tgtype::integer AS type,
                 t.tgnargs::integer AS nargs
          FROM pg_catalog.pg_trigger t
          JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          WHERE t.tgrelid = to_regclass($1) AND t.tgname = $2 AND NOT t.tgisinternal`,
        [table, trigger],
      )).rows;
      const args = hex(new TextEncoder().encode(`${field}\0${keyHex}\0`));
      if (rows.length > 0) {
        const row = rows[0]!;
        if (
          rows.length !== 1 || row.args !== args ||
          row.name !== "_hazelnut_envelope_fence_v1" ||
          row.schema !== "public" || row.enabled !== "O" || row.type !== 23 ||
          row.nargs !== 2
        ) {
          throw new Error(
            `encrypted/envelope-fence: existing trigger '${trigger}' does not match the active fence`,
          );
        }
        continue;
      }
      await tx.exec(
        `CREATE TRIGGER ${quote(trigger)} BEFORE INSERT OR UPDATE OF ${
          quote(field)
        } ON ${table}
        FOR EACH ROW EXECUTE FUNCTION public."_hazelnut_envelope_fence_v1"(${
          sqlStringLit(field)
        }, ${sqlStringLit(keyHex)})`,
      );
    }
  });
  return entries.length;
}
