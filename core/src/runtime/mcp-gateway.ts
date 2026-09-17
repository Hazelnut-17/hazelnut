// The hardened MCP gateway (12-mcp.md §transport): a CREDENTIAL-FREE separate process terminating agent
// traffic. It derives the tool catalog from the same pure declaration (one source, no drift), drops a
// tools/call naming an unknown tool before it ever reaches the app, and forwards everything else to the
// app's /mcp over one narrow channel. It holds no db, no KMS key — a compromised gateway can do only what
// the exposed op surface already allows.
// The JSON-RPC codes, from the one owner `serve.ts` and `mcp-stdio.ts` read. A local copy here is how
// this door answered a PARSE failure with `invalid params` while `/mcp` answered the same body -32700.
import {
  isJsonRpcId,
  MCP_INVALID_PARAMS,
  MCP_INVALID_REQUEST,
  MCP_PARSE_ERROR,
} from "../mcp/mcp-wire.ts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { App } from "../core/app.ts";
import { mcpToolDefs } from "../mcp/mcp.ts";
import { MAX_BODY_BYTES_DEFAULT } from "./serve-helpers.ts";

export interface McpGatewayOptions {
  /** The PURE composed declaration (`createApp(config)` — no db/boot arg), the catalog's single source. */
  readonly app: App;
  /** The app's internal base URL the gateway forwards to (e.g. `http://app:8000`). */
  readonly appUrl: string;
  /** Override the DNS-rebinding Origin allowlist. Defaults to `app.mcpAllowedOrigins` (the one source both
   *  transports read). The gateway is the trust boundary — it forwards to an app that no longer sees the
   *  `Origin`, so the check runs HERE. Absent both ⇒ no check — which the app itself cannot reach, since
   *  `launch` refuses an undeclared posture; a gateway pointed at a hand-built app is the remaining path. */
  readonly allowedOrigins?: readonly string[];
  /** Outbound fetch — injectable for tests; defaults to the global. */
  readonly fetchImpl?: (req: Request) => Promise<Response>;
}

/**
 * Build the gateway router: `POST /mcp` (validated forward) + `GET /health`. The identity-blind catalog
 * gate is a pre-filter — the app's own capability filter and policy still run behind it (defense-in-depth,
 * never a policy replacement); headers forwarded are exactly content-type / authorization / mcp-session-id.
 */
export function mcpGatewayRouter(opts: McpGatewayOptions): Hono {
  const known = new Set(mcpToolDefs(opts.app).map((t) => t.name));
  const allowedOrigins = opts.allowedOrigins ?? opts.app.mcpAllowedOrigins;
  const doFetch = opts.fetchImpl ?? ((req: Request) => fetch(req));
  const router = new Hono();
  // A gateway-local refusal never reaches serve's request middleware, but it is still an agent-visible
  // response that an operator must correlate. Mint its own wire id; forwarded app responses retain the
  // app's id below, which is the one that joins application provenance and outbox rows.
  router.use("*", async (c, next) => {
    c.header("Hazelnut-Trace-Id", crypto.randomUUID());
    await next();
  });
  router.get("/health", (c) => c.json({ status: "ok", role: "mcp-gateway" }));
  router.post(
    "/mcp",
    bodyLimit({ maxSize: MAX_BODY_BYTES_DEFAULT }),
    async (c) => {
      // DNS-rebinding defense (12-mcp §7): the gateway owns this check because it is the trust boundary —
      // once traffic forwards to the app, the `Origin` is gone. A cross-origin `Origin` under a configured
      // allowlist is refused; a headless agent (no `Origin`) passes, matching the served route's posture.
      const origin = c.req.header("origin");
      if (
        allowedOrigins && origin !== undefined &&
        !allowedOrigins.includes(origin)
      ) {
        return c.json({
          jsonrpc: "2.0",
          id: null,
          error: { code: MCP_INVALID_REQUEST, message: "origin not allowed" },
        }, 403);
      }
      const body = await c.req.text();
      let raw: unknown;
      try {
        raw = JSON.parse(body) as unknown;
      } catch {
        return c.json({
          jsonrpc: "2.0",
          id: null,
          error: { code: MCP_PARSE_ERROR, message: "body is not JSON" },
        }, 400);
      }
      const msg = raw !== null && typeof raw === "object" && !Array.isArray(raw)
        ? raw as { id?: unknown; method?: unknown; params?: { name?: unknown } }
        : undefined;
      if (msg && Object.hasOwn(msg, "id") && !isJsonRpcId(msg.id)) {
        return c.json({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: MCP_INVALID_REQUEST,
            message: "invalid request: `id` must be a string, number, or null",
          },
        }, 400);
      }
      // the catalog gate: an unknown tool name never crosses into the app network — the agent is steered
      // to re-read tools/list at the gateway, the same recovery the app itself teaches.
      if (
        msg?.method === "tools/call" && typeof msg.params?.name === "string" &&
        !known.has(msg.params.name)
      ) {
        return c.json({
          jsonrpc: "2.0",
          id: msg.id ?? null,
          error: {
            code: MCP_INVALID_PARAMS,
            message:
              `unknown tool '${msg.params.name}' — re-read tools/list and pick a listed tool`,
          },
        });
      }
      const fwdHeaders: Record<string, string> = {
        "content-type": "application/json",
      };
      for (const h of ["authorization", "mcp-session-id"]) {
        const v = c.req.header(h);
        if (v !== undefined) fwdHeaders[h] = v;
      }
      const res = await doFetch(
        new Request(`${opts.appUrl}/mcp`, {
          method: "POST",
          headers: fwdHeaders,
          body,
          // The gateway is a transport hop, not a new lifetime boundary. The
          // served app turns this into its work signal and cancels an abandoned
          // request's in-flight DB work before it can commit after a retry.
          signal: c.req.raw.signal,
        }),
      );
      // Pass the app's envelope through verbatim — and EVERY `Mcp-*` header with it, by prefix rather
      // than by name. A two-name allowlist forwarded `Mcp-Session-Id` and dropped `Mcp-List-Changed`, so
      // the surface stamp reached the agent and the signal telling it to re-read `tools/list` did not:
      // the whole mechanism was inert at the one door that faces the agent network. A prefix is the only
      // shape that survives the next header the app learns to set.
      const out = new Response(res.body, { status: res.status });
      const ct = res.headers.get("content-type");
      if (ct) out.headers.set("content-type", ct);
      for (const [k, v] of res.headers) {
        const lower = k.toLowerCase();
        // `Mcp-*` by prefix, the throttle quartet, and the framework's one wire-correlation header. The
        // app sets `RateLimit-*` / `Retry-After` on EVERY response as the pre-emptive lever — an agent
        // reads them to slow down before it is refused — and a gateway that dropped them made the 429 the
        // first signal an agent ever got. `Hazelnut-Trace-Id` is the caller-held join to the app's
        // provenance and durable outbox records; the gateway must not make its agent response unjoinable.
        // The body still carried `retryAfter`, so the throttle loss was invisible to a body-only test.
        if (
          lower.startsWith("mcp-") || lower.startsWith("ratelimit-") ||
          lower === "retry-after" || lower === "hazelnut-trace-id"
        ) out.headers.set(k, v);
      }
      return out;
    },
  );
  return router;
}
