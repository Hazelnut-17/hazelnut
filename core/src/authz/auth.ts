// `auth.ts` is a PURE BARREL — every definition lives in a sibling leaf, so a leaf may reach
// another leaf directly instead of routing back through here (which is what made this a cycle).
// Consumers keep importing this path; the surface is unchanged.
export {
  ANON,
  can,
  CRUD_READ_ALIAS,
  CRUD_VERB_SET,
  CRUD_VERBS,
  definePerms,
  isAnonymous,
  isSystem,
  systemActor,
  tenantActor,
  tenantOf,
  userActor,
  withTenant,
} from "./auth-core.ts";
export type {
  Actor,
  CrudVerb,
  DerivedPerms,
  PermKey,
  PermSource,
} from "./auth-core.ts";
export * from "./auth-perms.ts";
