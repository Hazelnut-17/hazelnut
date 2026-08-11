// `mcp.ts` is a PURE BARREL — every definition lives in a sibling leaf, so a leaf may reach
// another leaf directly instead of routing back through here (which is what made this a cycle).
// Consumers keep importing this path; the surface is unchanged.
export * from "./mcp-wire.ts";
export * from "./mcp-tooldefs.ts";
export * from "./mcp-call.ts";
export * from "./mcp-resource.ts";
