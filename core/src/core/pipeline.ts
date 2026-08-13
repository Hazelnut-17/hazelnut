// `pipeline.ts` is a PURE BARREL — every definition lives in a sibling leaf, so a leaf may reach
// another leaf directly instead of routing back through here (which is what made this a cycle).
// Consumers keep importing this path; the surface is unchanged.
export * from "./pipeline-defs.ts";
export * from "./result.ts";
export { defineOp } from "./faces-ctx.ts";
export * from "./pipeline-run.ts";
