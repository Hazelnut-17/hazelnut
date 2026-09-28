import type { Actor } from "../authz/auth.ts";
import type { App } from "../core/app.ts";
import { stableStringify } from "../core/version.ts";
import { resourceTemplates } from "./mcp-resource.ts";
import {
  type McpRuntimeConfig,
  runtimeResourceEntries,
} from "./mcp-runtime.ts";
import { capabilityFilter } from "./mcp-tooldefs.ts";

/** FNV-1a 64-bit over a string — tiny, dependency-free; stable across runs for a stable input. */
function fnv1a64(s: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

/** The stamp of every caller-visible, dynamic MCP list surface. It is derived from the same projections
 *  served at `tools/list`, `resources/templates/list`, and `resources/list` — never a hand-maintained
 *  approximation. `initialize` returns it as `Mcp-Session-Id`; when a later request carries a different
 *  stamp, the serve layer signals `Mcp-List-Changed` so the host can refresh the lists it consumes.
 *
 *  The actor matters: a permission change can move runtime resources without changing tools. A process
 *  restart that changes the composed app also changes the relevant projections and therefore the stamp. */
export function toolSurfaceStamp(
  app: App,
  actor: Actor | null,
  mcpRuntime?: McpRuntimeConfig,
): string {
  return fnv1a64(stableStringify({
    tools: capabilityFilter(app, actor),
    resourceTemplates: resourceTemplates(app, actor),
    runtimeResources: runtimeResourceEntries(mcpRuntime, actor),
  }));
}
