import { MCP_INVALID_REQUEST } from "../mcp/mcp-wire.ts";
// The stdio MCP transport (12-mcp.md §transport): newline-delimited JSON-RPC on stdin/stdout, each line
// forwarded to the SAME served /mcp door via in-process fetch — one dispatch, zero duplicated semantics
// (capability filter, list_changed stamp, strict-input all ride along). Credentials are transport-level:
// HAZELNUT_MCP_TOKEN becomes the Authorization bearer the app's ordinary auth seam resolves.

/** The served-app face the adapter drives — `createApp(config, { db, … }).fetch`. */
export interface McpStdioApp {
  fetch: (req: Request) => Response | Promise<Response>;
}

export interface McpStdioOptions {
  /** Message source (defaults to `Deno.stdin.readable`) — injectable for tests. */
  readonly input?: ReadableStream<Uint8Array>;
  /** Response sink, called once per non-empty response line (defaults to stdout) — injectable for tests. */
  readonly write?: (line: string) => void | Promise<void>;
  /** Bearer token override (defaults to the `HAZELNUT_MCP_TOKEN` env var; absent → anonymous). */
  readonly token?: string;
}

/** Split a byte stream into lines (LF or CRLF), yielding non-empty trimmed lines. */
async function* lines(
  input: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = input.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let at: number;
      while ((at = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, at).replace(/\r$/, "").trim();
        buf = buf.slice(at + 1);
        if (line.length > 0) yield line;
      }
    }
    const tail = buf.trim();
    if (tail.length > 0) yield tail;
  } finally {
    reader.releaseLock();
  }
}

const enc = new TextEncoder();

/**
 * Run the stdio loop until the input closes. Each stdin line POSTs to `/mcp` on the served app; a JSON
 * response line goes to stdout; a 202 (notification ack) writes nothing — the JSON-RPC notification
 * contract. A transport-level fault (unreadable response) is written as a JSON-RPC error line, loud.
 */
export async function runMcpStdio(
  app: McpStdioApp,
  opts: McpStdioOptions = {},
): Promise<void> {
  const input = opts.input ?? Deno.stdin.readable;
  const write = opts.write ??
    ((line: string) => void Deno.stdout.write(enc.encode(line + "\n")));
  // An empty `""` is not a bearer — it is what an unset variable interpolated into the launch command
  // leaves behind. Treated as absent (a falsy `token` below would silently drop the header either way),
  // but said out loud, because the operator who wrote it meant to authenticate.
  const rawToken = opts.token ?? Deno.env.get("HAZELNUT_MCP_TOKEN");
  if (rawToken === "") {
    console.error(
      "hazelnut mcp stdio: the HAZELNUT_MCP_TOKEN / token value is empty — ignoring it, connecting ANONYMOUSLY (an unset variable in the launch command?)",
    );
  }
  const token = rawToken === "" ? undefined : rawToken;
  // The session stamp, held for the life of the process. `/mcp` hands it out on `initialize` and detects a
  // STALE echo to signal that this caller's tool surface moved — but the check needs the echo, and this
  // loop never sent one, so the whole mechanism was inert on the door local agents actually use. A
  // long-lived process holding one string is the entire cost. (The HTTP door cannot: it is stateless per
  // request, which is why the header exists there at all.)
  let sessionId: string | undefined;
  for await (const line of lines(input)) {
    const res = await app.fetch(
      new Request("http://mcp.stdio.local/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        },
        body: line,
      }),
    );
    const handed = res.headers.get("mcp-session-id");
    if (handed !== null) sessionId = handed;
    // The surface this caller can see has moved. stdio is bidirectional — stdout is a real server→client
    // channel — so the signal is delivered in the spec's own shape rather than as a header no JSON-RPC
    // host reads. Written BEFORE the response so a host that re-reads on the notification has the fresh
    // list before it interprets the answer it was waiting for.
    if (res.headers.get("mcp-list-changed") === "true") {
      await write(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/tools/list_changed",
        }),
      );
    }
    if (res.status === 202) {
      await res.body?.cancel();
      continue; // a notification expects no response line
    }
    // stdout carries JSON-RPC and nothing else. The /mcp HANDLER answers in that shape, but everything
    // upstream of it — authn, throttle, a transport fault — answers with the HTTP envelope
    // (`{"error":{"kind":…}}`), and writing that verbatim hands an MCP host a line it cannot parse. Wrap
    // anything that is not already an envelope, keeping the request's id so the host can match it.
    const body = await res.text();
    await write(claimListChanged(asJsonRpc(body, res.status, line), line));
  }
}

/**
 * stdio ADVERTISES `tools.listChanged`, because stdio is what DELIVERS it.
 *
 * The served `/mcp` handler answers `listChanged: false` and is right to: it is request-response, it holds
 * no per-session channel, and a capability claimed with no delivery path leaves a host waiting for a
 * refresh that never arrives. That is a fact about THAT door, not about this one — stdout is a real
 * server→client channel and the loop above writes `notifications/tools/list_changed` onto it.
 *
 * So the claim is made by the component that keeps it, which is also the only place it CANNOT be forged.
 * The alternative — a header the transport sets and the handler trusts — is reachable by any HTTP client,
 * and a client that talks its way into `listChanged: true` on a door with no push channel has arranged for
 * itself precisely the stale-forever surface this capability exists to prevent.
 *
 * Rewrites nothing else: only a successful `initialize` result that already carries the `tools` capability
 * object the handler built. A malformed or error response passes through untouched — this promises delivery,
 * it does not invent structure.
 */
function claimListChanged(line: string, request: string): string {
  let method: unknown;
  try {
    method = (JSON.parse(request) as { method?: unknown }).method;
  } catch {
    return line;
  }
  if (method !== "initialize") return line;
  try {
    const msg = JSON.parse(line) as {
      result?: { capabilities?: { tools?: Record<string, unknown> } };
    };
    const tools = msg.result?.capabilities?.tools;
    if (tools === undefined || tools === null) return line;
    tools.listChanged = true;
    return JSON.stringify(msg);
  } catch {
    return line; // not JSON we own — leave it exactly as it was
  }
}

/** The line stdout may carry: `body` when it is already a JSON-RPC envelope, else a JSON-RPC error made
 *  from the HTTP one. A non-envelope reaching a host unwrapped is a parse failure at the far end, with
 *  the real reason (a 401, a 429) lost inside it. */
function asJsonRpc(body: string, status: number, request: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = null;
  }
  if (
    parsed !== null && typeof parsed === "object" &&
    "jsonrpc" in (parsed as Record<string, unknown>)
  ) return body;
  let id: unknown = null;
  try {
    const r = JSON.parse(request) as { id?: unknown };
    if (r && typeof r === "object" && "id" in r) id = r.id ?? null;
  } catch {
    /* an unparseable request line already answered with a parse error */
  }
  const wire = (parsed as {
    error?: {
      kind?: string;
      message?: string;
      // the throttle's error-as-next-action shape (12-mcp §8) — NOT the Error envelope: a 429 on this
      // channel carries the steer itself, so there is no `kind`/`message` to read.
      throttled?: boolean;
      retryAfter?: number;
      steer?: string;
    };
  })?.error;
  // `steer` before `message`: the throttle body is written FOR an MCP host — it is the sentence telling the
  // agent what to do next — and reading only `kind`/`message` dropped it on stdio, which is itself an MCP
  // channel. An empty message is treated as absent, so a blanked silent kind falls to the status line
  // rather than sending `""` as the whole explanation.
  const detail = wire?.steer ??
    (wire?.message !== "" ? wire?.message : undefined);
  const data: Record<string, unknown> = { status };
  if (wire?.kind) data.kind = wire.kind;
  if (wire?.throttled) data.throttled = true;
  if (typeof wire?.retryAfter === "number") data.retryAfter = wire.retryAfter;
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: {
      code: MCP_INVALID_REQUEST,
      message: detail ??
        `the app answered ${status} outside the JSON-RPC channel`,
      data,
    },
  });
}
