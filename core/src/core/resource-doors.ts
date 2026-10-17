import { CRUD_VERB_SET } from "../authz/auth-core.ts";

/** Extra data doors do not create new permission seeds. An existing same-named custom op wins. */
export function isBuiltinDataDoor(
  model: { readonly operations: Readonly<Record<string, unknown>> },
  verb: string,
): boolean {
  return CRUD_VERB_SET.has(verb) ||
    ((verb === "count" || verb === "restore") &&
      !Object.hasOwn(model.operations, verb));
}
