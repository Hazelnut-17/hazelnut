// `auth.ts` is a PURE BARREL — every definition lives in a sibling leaf, so a leaf may reach
// another leaf directly instead of routing back through here (which is what made this a cycle).
// Consumers keep importing this path; the surface is unchanged.
export * from "./auth-core.ts";
export * from "./auth-perms.ts";
