// `hazelnut/faces` — the projected faces of one declaration — the MCP tool surface, the OpenAPI document, the typed client, the OTLP seam.
//
// A CONCERN BARREL, and its membership is not written here: `scripts/surface-groups.ts` declares which
// symbols belong to this group and holds the two as an equality, so a symbol
// cannot be reachable from two paths or from none. Re-exports point at the CONCRETE home, never at the
// root barrel — that is what keeps the group importable without pulling the whole surface in.

export { mcpToolDefs } from "../mcp/mcp-tooldefs.ts";
export { definePrompt } from "../mcp/prompt.ts";
export { hazelnutClient } from "../runtime/client.ts";
export type {
  ClientOptions,
  HazelnutClient,
  ListQuery,
} from "../runtime/client.ts";
export { deriveOpenApi } from "../runtime/openapi.ts";
export { installOtlp } from "../runtime/otel-otlp.ts";
export type {
  OtlpConfig,
  OtlpObservability,
  OtlpStats,
} from "../runtime/otel-otlp.ts";
export type { ServeConfig } from "../runtime/serve-helpers.ts";
