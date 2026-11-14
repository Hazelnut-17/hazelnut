import type { App } from "../core/app.ts";
import { globalSingletonIncarnationOn } from "./schema-normalize.ts";

/** Check the final updated row, including changes made by other BEFORE triggers. */
export const SINGLETON_CAS_GUARD_DDL =
  `CREATE OR REPLACE FUNCTION public."_hazelnut_singleton_cas_guard_v1"() RETURNS trigger
LANGUAGE plpgsql AS $hz_singleton_cas$
BEGIN
  IF OLD.cas_incarnation IS DISTINCT FROM NEW.cas_incarnation THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='singleton/cas-incarnation-immutable';
  END IF;
  RETURN NEW;
END
$hz_singleton_cas$`;

/** Only this exact body is exempted from generic procedural SQL refusal. */
export function isSingletonCasGuardFunction(statement: string): boolean {
  return statement.trim().replace(/;$/, "") === SINGLETON_CAS_GUARD_DDL;
}

export function singletonCasGuardStatements(app: App): string[] {
  const targets = app.model.filter((model) =>
    globalSingletonIncarnationOn(model.features)
  );
  if (targets.length === 0) return [];
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  return [
    SINGLETON_CAS_GUARD_DDL,
    ...targets.map((model) =>
      `CREATE OR REPLACE TRIGGER "_hazelnut_singleton_cas_guard" AFTER UPDATE ON ${
        quote(model.pgSchema)
      }.${
        quote(model.name)
      } FOR EACH ROW EXECUTE FUNCTION public."_hazelnut_singleton_cas_guard_v1"()`
    ),
  ];
}
