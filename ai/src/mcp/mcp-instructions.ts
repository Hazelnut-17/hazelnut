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
    "Errors are structured next-actions, not prose. The error kind is one of exactly eight: " +
    "notFound, forbidden, conflict, validation, business, internal, timeout, stale. " +
    "Retry only internal / timeout / stale (transient); the other five are deterministic — fix the call, do not retry.",
    "A `validation` error that names an offending field and says the surface may have changed is a STEER: " +
    "the tool list you cached is stale. Call `tools/list` to re-fetch the current surface, then retry " +
    "(a `validation` error rolls the op back before any write, so the corrected retry is safe). This per-call error is authoritative on drift; " +
    "this orientation is only a boot-time snapshot.",
    "A 429 carries a RateLimit-* quartet (limit / remaining / reset) plus Retry-After — back off by Retry-After. " +
    "Throttling is transport, never an error kind; `remaining` lets you pace before you trip.",
    "MCP write ops have NO idempotency-key channel (unlike the HTTP `Idempotency-Key` header), so never blindly retry a write whose outcome you did not observe. Lean on the op's own guards instead: a unique constraint rejects a duplicate as `conflict`, a versioned resource rejects a stale write as `stale`. Of the eight kinds only internal/timeout/stale are retry-safe.",
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
