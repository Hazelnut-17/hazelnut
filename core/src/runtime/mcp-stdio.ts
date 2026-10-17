import {
  isJsonRpcId,
  isJsonRpcResponse,
  MCP_INVALID_REQUEST,
  MCP_PARSE_ERROR,
  mcpTransportUnavailable,
} from "../mcp/mcp-wire.ts";
import { MAX_BODY_BYTES_DEFAULT } from "./serve-helpers.ts";
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

const utf8 = new TextEncoder();

/**
 * Split a byte stream into lines (LF or CRLF), yielding non-empty trimmed lines.
 *
 * `maxBytes` caps ONE line's bytes. The sibling arrival door caps the same bytes on the same dispatch
 * (`mcp-gateway.ts` — `bodyLimit`), so an unbounded accumulator here was that cap's missing half: a peer
 * that never sends `\n` grows the buffer without limit. BYTES, never the decoded length — a UTF-16 count
 * admits up to 4× the cap. An oversize line is REFUSED and the stream resynchronises at the next
 * terminator: one hostile line must not end a long-lived agent session.
 */
async function* lines(
  input: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal?: AbortSignal,
): AsyncGenerator<{ readonly line: string } | { readonly oversize: true }> {
  const reader = input.pipeThrough(new TextDecoderStream()).getReader();
  const cancel = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });
  let buf = "";
  let bytes = 0;
  let discarding = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let at: number;
      while ((at = buf.indexOf("\n")) !== -1) {
        const raw = buf.slice(0, at);
        buf = buf.slice(at + 1);
        if (discarding) {
          discarding = false; // the refused line ended here; the next one starts clean
          continue;
        }
        // Checked on the COMPLETE line, not only on a pending remainder: a terminator arriving in the
        // same chunk must not carry an oversize line past the cap.
        if (utf8.encode(raw).byteLength > maxBytes) {
          yield { oversize: true };
          continue;
        }
        const line = raw.replace(/\r$/, "").trim();
        if (line.length > 0) yield { line };
      }
      bytes = utf8.encode(buf).byteLength;
      if (!discarding && bytes > maxBytes) {
        discarding = true; // the terminator has not arrived and the buffer is already over
        buf = "";
        yield { oversize: true };
      }
      if (discarding) buf = "";
    }
    if (discarding) return; // the stream closed mid-refusal; nothing complete is pending
    if (utf8.encode(buf).byteLength > maxBytes) {
      yield { oversize: true };
      return;
    }
    const tail = buf.trim();
    if (tail.length > 0) yield { line: tail };
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

const enc = new TextEncoder();

/** Deno's stdout write may complete only part of a large buffer. Loop until the complete JSON-RPC line is
 *  accepted; the caller awaits this before advancing or exiting the stdio session. */
async function writeStdoutLine(line: string): Promise<void> {
  const bytes = enc.encode(line + "\n");
  let offset = 0;
  while (offset < bytes.length) {
    const written = await Deno.stdout.write(bytes.subarray(offset));
    if (!Number.isSafeInteger(written) || written <= 0) {
      throw new Error(
        `hazelnut mcp stdio: stdout made no progress after ${offset} of ${bytes.length} bytes`,
      );
    }
    offset += written;
  }
}

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
  const write = opts.write ?? writeStdoutLine;
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
  let sessionId: string | undefined;
  let adopted = -1;
  let ordinal = 0;
  let initialization: Promise<void> | undefined;
  const active = new Map<
    string | number | null,
    { controller: AbortController; cancelled: boolean; method: string }
  >();
  const controllers = new Set<AbortController>();
  const pending = new Set<Promise<void>>();
  let writeQueue = Promise.resolve();
  let outputStopped = false;
  let failure: unknown;
  const readController = new AbortController();
  const emit = (
    messages: readonly string[],
    visible = () => !outputStopped,
  ): Promise<void> => {
    const group = writeQueue.then(async () => {
      for (const message of messages) if (visible()) await write(message);
    });
    // Keep a failed sink from producing unhandled rejections; the owning dispatch records and reports it.
    writeQueue = group.catch(() => {});
    return group;
  };
  const stop = () => {
    outputStopped = true;
    readController.abort();
    for (const controller of controllers) {
      controller.abort(new DOMException("MCP transport closed", "AbortError"));
    }
  };
  const within = async (
    work: Promise<unknown>,
    milliseconds: number,
  ): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work.then(() => true),
        new Promise<false>((r) => {
          timer = setTimeout(() => r(false), milliseconds);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  try {
    for await (
      const framed of lines(
        input,
        MAX_BODY_BYTES_DEFAULT,
        readController.signal,
      )
    ) {
      if (failure !== undefined) throw failure;
      if ("oversize" in framed) {
        await emit([
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: MCP_PARSE_ERROR,
              message:
                `line exceeds the ${MAX_BODY_BYTES_DEFAULT}-byte cap — refused without buffering the remainder`,
            },
          }),
        ]);
        continue;
      }
      const line = framed.line;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        raw = null;
      }
      const msg = raw && typeof raw === "object" && !Array.isArray(raw)
        ? raw as Record<string, unknown>
        : undefined;
      // Cancellation belongs to this host's pipe, never a process-wide ID registry or caller payload flag.
      // Invalid/unknown/completed notifications are fire-and-forget; initialize is not client-cancellable.
      if (
        msg?.jsonrpc === "2.0" && msg.method === "notifications/cancelled" &&
        !Object.hasOwn(msg, "id")
      ) {
        const params = msg.params && typeof msg.params === "object" &&
            !Array.isArray(msg.params)
          ? msg.params as Record<string, unknown>
          : undefined;
        const id = params?.requestId;
        if (
          typeof id === "string" ||
          (typeof id === "number" && Number.isFinite(id))
        ) {
          const request = active.get(id);
          if (request && request.method !== "initialize") {
            request.cancelled = true;
            request.controller.abort(
              new DOMException("MCP request cancelled", "AbortError"),
            );
          }
        }
        continue;
      }
      if (isJsonRpcResponse(raw)) continue; // a peer response has no response of its own
      const requestId = msg && Object.hasOwn(msg, "id") && isJsonRpcId(msg.id)
        ? msg.id
        : null;
      const request = msg?.jsonrpc === "2.0" &&
        typeof msg.method === "string" && Object.hasOwn(msg, "id") &&
        isJsonRpcId(msg.id);
      if (request && active.has(requestId)) {
        await emit([
          JSON.stringify({
            jsonrpc: "2.0",
            id: requestId,
            error: {
              code: MCP_INVALID_REQUEST,
              message: "duplicate in-flight request id",
            },
          }),
        ]);
        continue;
      }
      // Keep consuming control messages when the work window is full. Refusal itself stays bounded by
      // stdout backpressure rather than growing an unbounded queue of request bodies or promises.
      if (pending.size >= 64) {
        if (!isNotificationEnvelope(line)) {
          await emit([
            JSON.stringify({
              jsonrpc: "2.0",
              id: requestId,
              error: {
                code: -32603,
                message: "stdio request window is full; retry after one second",
                data: { status: 503, retryAfter: 1 },
              },
            }),
          ]);
        }
        continue;
      }
      const index = ordinal++;
      const controller = new AbortController();
      const entry = {
        controller,
        cancelled: false,
        method: typeof msg?.method === "string" ? msg.method : "",
      };
      if (request) active.set(requestId, entry);
      controllers.add(controller);
      const dispatch = async () => {
        if (entry.method !== "initialize") await initialization;
        if (controller.signal.aborted) return;
        const output: string[] = [];
        try {
          const res = await app.fetch(
            new Request("http://mcp.stdio.local/mcp", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                ...(token ? { authorization: `Bearer ${token}` } : {}),
                ...(sessionId ? { "mcp-session-id": sessionId } : {}),
              },
              body: line,
              signal: controller.signal,
            }),
          );
          if (controller.signal.aborted) {
            await res.body?.cancel();
            return;
          }
          const handed = res.headers.get("mcp-session-id");
          const previous = sessionId;
          const adopt = handed !== null && index >= adopted;
          if (adopt) {
            sessionId = handed;
            adopted = index;
          }
          // Concurrent requests may echo the same old stamp. A replacement stamp announces one move,
          // rather than one notification per outstanding request; late older replies cannot rewind it.
          if (
            res.headers.get("mcp-list-changed") === "true" &&
            (handed === null || (adopt && handed !== previous))
          ) {
            output.push(
              JSON.stringify({
                jsonrpc: "2.0",
                method: "notifications/tools/list_changed",
              }),
            );
          }
          if (res.status === 202 || isNotificationEnvelope(line)) {
            await res.body?.cancel();
          } else {output.push(
              claimListChanged(
                asJsonRpc(await res.text(), res.status, line),
                line,
              ),
            );}
        } catch {
          if (!controller.signal.aborted && !isNotificationEnvelope(line)) {
            output.push(JSON.stringify(mcpTransportUnavailable(requestId)));
          }
        }
        await emit(
          output,
          () =>
            !outputStopped && !entry.cancelled && !controller.signal.aborted,
        );
      };
      const task = dispatch().finally(() => {
        controllers.delete(controller);
        if (request && active.get(requestId) === entry) {
          active.delete(requestId);
        }
      }).catch((e: unknown) => {
        failure ??= e;
        stop();
      });
      pending.add(task);
      void task.then(() => {
        pending.delete(task);
      });
      if (
        request && entry.method === "initialize" && initialization === undefined
      ) initialization = task;
    }
    // EOF is transport shutdown. Let ordinary buffered requests finish, then bound cleanup even when a
    // custom fetch/handler ignores AbortSignal. Suppressed late replies cannot reopen the closed pipe.
    const drained = Promise.all([...pending]);
    if (!await within(drained, 5000)) {
      stop();
      await within(drained, 1000);
    }
    if (failure !== undefined) throw failure;
  } finally {
    stop();
  }
}

function isNotificationEnvelope(line: string): boolean {
  try {
    const message: unknown = JSON.parse(line);
    return message !== null && typeof message === "object" &&
      !Array.isArray(message) && "jsonrpc" in message &&
      message.jsonrpc === "2.0" && "method" in message &&
      typeof message.method === "string" && !Object.hasOwn(message, "id");
  } catch {
    return false;
  }
}

/**
 * stdio ADVERTISES `tools.listChanged`, because stdio is what DELIVERS it.
 *
 * The served `/mcp` handler answers `listChanged: false` and is right to: it is request-response, it holds
 * no per-session channel, and a capability claimed with no delivery path leaves a host waiting for a
 * refresh that never arrives. That is a fact about THAT door, not about this one — stdout is a real
 * server→client channel and the loop above writes `notifications/tools/list_changed` onto it. The signal
 * covers the visible tool and resource catalogs; hosts should refresh each catalog they use.
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
