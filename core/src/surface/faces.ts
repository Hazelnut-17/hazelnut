// `hazelnut/faces` — the projected faces of one declaration — the MCP tool surface, the OpenAPI document, the typed client, the observability seams.
//
// A CONCERN BARREL, and its membership is not written here: `scripts/surface-groups.ts` declares which
// symbols belong to this group as an equality, so a symbol
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
export { setLogSink } from "../core/ctx-provenance.ts";
export type { LogSink, ProvenanceRecord } from "../core/ctx-provenance.ts";
export { setAlarmSink } from "../runtime/alarm.ts";
export type { Alarm, AlarmSink } from "../runtime/alarm.ts";
export { setTracer } from "../core/tracing.ts";
export type { Tracer } from "../core/tracing.ts";
export type {
  OtlpConfig,
  OtlpObservability,
  OtlpStats,
} from "../runtime/otel-otlp.ts";
export type { ServeConfig } from "../runtime/serve-helpers.ts";
