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
  const token = opts.token ?? Deno.env.get("HAZELNUT_MCP_TOKEN") ?? undefined;
  for await (const line of lines(input)) {
    const res = await app.fetch(
      new Request("http://mcp.stdio.local/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: line,
      }),
    );
    if (res.status === 202) {
      await res.body?.cancel();
      continue; // a notification expects no response line
    }
    // stdout carries JSON-RPC and nothing else. The /mcp HANDLER answers in that shape, but everything
    // upstream of it — authn, throttle, a transport fault — answers with the HTTP envelope
    // (`{"error":{"kind":…}}`), and writing that verbatim hands an MCP host a line it cannot parse. Wrap
    // anything that is not already an envelope, keeping the request's id so the host can match it.
    const body = await res.text();
    await write(asJsonRpc(body, res.status, line));
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
  const kind = (parsed as { error?: { kind?: string; message?: string } })
    ?.error;
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: {
      code: MCP_INVALID_REQUEST,
      message: kind?.message ??
        `the app answered ${status} outside the JSON-RPC channel`,
      ...(kind?.kind
        ? { data: { kind: kind.kind, status } }
        : { data: { status } }),
    },
  });
}
