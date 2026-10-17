import type { App } from "../core/app.ts";
import { mcpToolDefs } from "./mcp.ts";

/** Projects the MCP `initialize` server-`instructions` (12-mcp.md §instructions) from framework
 *  constants and the visible-tool set — never hand-authored, so it cannot drift from the tool list.
 *  The mechanism preamble is row- and actor-data-free by construction; the surface roll-up states the
 *  visibility RULE, never a concrete perm, so it can never become an enumeration oracle. */
export function projectMcpInstructions(
  app: App,
  opts: {
    readonly instructions?: string;
    readonly visibleTools?: readonly string[];
  } = {},
): string {
  const preamble = [
    "Tools are named `<module>__<resource>__<op>` — injective and `__`-reversible; `__` never appears inside a segment.",
    "Tool execution errors from `tools/call` are structured next-actions, not prose. Their `kind` is one of exactly eight: " +
    "notFound, forbidden, conflict, validation, business, internal, timeout, stale. " +
    "For `tools/call`, retry only internal / timeout / stale (transient); the other five are deterministic — fix the call, do not retry.",
    "`resources/read` uses the JSON-RPC error channel, not the `tools/call` result envelope. " +
    "`-32002 resource not found` means absent or not permitted; those cases are deliberately indistinguishable. " +
    "Treat the resource as unavailable. Do not enumerate ids or re-list to distinguish them.",
    "A list-change signal means a caller-visible MCP list moved. Refresh `tools/list` and, when you use resources, " +
    "refresh `resources/list` and `resources/templates/list` too.",
    "A `tools/call` validation error that names an offending field and says the surface may have changed is a STEER: " +
    "the tool list you cached is stale. Call `tools/list` to re-fetch the current surface, then retry " +
    "(a `validation` error rolls the op back before any write, so the corrected retry is safe). This per-call tools/call error is authoritative on drift; " +
    "this orientation is only a boot-time snapshot.",
    "Transport admission 429 carries a RateLimit-* quartet (limit / remaining / reset) plus Retry-After — back off by Retry-After; `remaining` lets you pace before you trip. " +
    "Password credential admission instead reports code `auth/throttled`: HTTP uses 429, while tools/call uses kind `forbidden` with retryAfter. Honor that delay before retrying. " +
    "A thrown auth resolver is HTTP 503 with body.error.kind `auth_unavailable` (also transport, not one of the eight kinds); stdio wraps it as JSON-RPC error, the gateway forwards the HTTP envelope.",
    "Custom write ops declared `idempotent: true` accept `_idempotencyKey` — mint one value and resend it on a retry to reuse its settled execution with the current MCP redaction. Auto-CRUD writes have no claim; lean on unique/version guards. Of the eight `tools/call` kinds only internal/timeout/stale are retry-safe.",
    'The four standard tool annotations describe effects and retries; optional `_meta["hazelnut/confirmHint"]` is a cooperative confirmation hint. ' +
    "Soft deletion is recoverable, while hard deletion is destructive. An optional idempotency key does not make a keyless custom write idempotent. " +
    "Hosts may ignore vendor metadata: there is no server approval receipt, and the hint does not control HTTP bulk writes. Check the actual action with the user when needed; annotations do not grant permission.",
    "Versioned resources are optimistic-locked: pass the loaded version; a `stale` (409) means re-read and re-apply.",
  ].join("\n");

  const visible = opts.visibleTools ?? mcpToolDefs(app).map((t) => t.name);
  const surface = visible.length > 0
    ? `You see only the tools your identity may use. Available now:\n${
      visible.map((n) => `- ${n}`).join("\n")
    }`
    : "You see only the tools your identity may use. None are available to you right now.";

  const authored = opts.instructions?.trim();
  return [authored, preamble, surface].filter((p): p is string =>
    Boolean(p && p.length > 0)
  ).join("\n\n");
}
