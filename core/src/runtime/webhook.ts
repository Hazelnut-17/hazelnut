// `defineWebhook` — the outbound webhook sink (05-runtime.md §externalization): hardened HTTP delivery of a
// module's emitted topic, riding the same outbox substrate as every consumer (retry → `_outbox_dead` →
// `hazelnut redrive`). SSRF floor: https-only (`allowInsecureHttp` opts out), DNS pre-flight blocks
// private/loopback/link-local/ULA/metadata ranges (`allowPrivateNetwork` opts in), `redirect: "error"` — a
// post-preflight DNS re-bind is not prevented (no IP-pinned fetch in Deno). HMAC:
// `X-Hazelnut-Signature: t=<unix>, v1=<hex hmac-sha256(secret, t + "." + body)>`; no `secret` is a boot
// refuse, `sign: false` opts out. Delivery: POST JSON `{ id, topic, payload }`; classified failures drive retry/DLQ.
import type { OnlyKnownKeys } from "../core/config.ts";
import type { AnySubscriber } from "./events.ts";
import type { DeliveredMsg } from "./outbox.ts";
import { safeFetch } from "./safe-fetch.ts";
import { displayUrl } from "../core/loggable-error.ts";

export interface WebhookDecl {
  readonly name: string; // the consumer identity (`webhook:<name>` — the DLQ/fence key)
  readonly topic: string; // the declared module emit this webhook externalizes (typo = boot refuse)
  readonly url: string; // https receiver endpoint
  readonly secret?: string; // HMAC key (config-sourced, e.g. Deno.env — the encryptionKey precedent)
  readonly sign?: false; // explicit unsigned opt-out (visible in the decl/diff)
  readonly headers?: Readonly<Record<string, string>>; // extra static headers (auth tokens etc.)
  readonly allowInsecureHttp?: true; // dev-only loud opt-out of the https floor
  readonly allowPrivateNetwork?: true; // explicit opt-in: receiver on a private/internal range
  readonly maxAttempts?: number; // per-consumer retry budget override (05-runtime.md §relay-mode)
}

export function defineWebhook<D = unknown>(
  decl: WebhookDecl & OnlyKnownKeys<D, WebhookDecl>,
): WebhookDecl {
  return decl; // pure data; createApp validates + derives the subscriber
}

// ── signing ────────────────────────────────────────────────────────────────────────────────────────
const enc = new TextEncoder();
export async function signWebhook(
  secret: string,
  timestampSec: number,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [
      "sign",
    ],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      enc.encode(`${timestampSec}.${body}`),
    ),
  );
  const hex = [...mac].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `t=${timestampSec}, v1=${hex}`;
}

/** Verify the original request text before parsing it. A fresh signature does not deduplicate an event. */
export async function verifyWebhook(
  secret: string,
  signature: string,
  rawBody: string,
  opts: { readonly maxSkewSec?: number; readonly now?: () => number } = {},
): Promise<boolean> {
  const maxSkewSec = opts.maxSkewSec ?? 300;
  if (!Number.isFinite(maxSkewSec) || maxSkewSec < 0) {
    throw Object.assign(
      new Error(
        "webhook/skew-invalid: maxSkewSec must be finite and non-negative",
      ),
      { kind: "validation" },
    );
  }
  if (secret.length === 0) {
    throw Object.assign(
      new Error(
        "webhook/secret-required: signature verification needs a nonempty shared secret",
      ),
      { kind: "validation" },
    );
  }
  const match = /^t=(0|[1-9][0-9]{0,15}),\s*v1=([0-9a-fA-F]{64})$/.exec(
    signature,
  );
  if (!match) return false;
  const timestamp = Number(match[1]);
  const now = (opts.now ?? Date.now)();
  if (
    !Number.isSafeInteger(timestamp) || !Number.isFinite(now) ||
    Math.abs(now / 1000 - timestamp) > maxSkewSec
  ) return false;
  const mac = Uint8Array.from(
    match[2]!.match(/../g)!,
    (hex) => Number.parseInt(hex, 16),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return await crypto.subtle.verify(
    "HMAC",
    key,
    mac,
    enc.encode(`${timestamp}.${rawBody}`),
  );
}

// ── delivery ───────────────────────────────────────────────────────────────────────────────────────
export interface WebhookDeps {
  readonly fetchFn?: typeof fetch;
  readonly resolve?: (host: string, kind: "A" | "AAAA") => Promise<string[]>;
  readonly now?: () => number;
  readonly timeoutMs?: number; // override DELIVERY_TIMEOUT_MS (tests only)
}

// The relay's own `handlerTimeoutMs` (default 10 min, 05-runtime.md §relay) bounds the WHOLE consumer
// invocation, not one HTTP call — too long to be the only deadline a single delivery attempt gets. This
// mirrors the framework's own OP_DEADLINE_DEFAULT_MS convention (core/pipeline-run.ts) for "a reasonable
// network operation", scoped here to one webhook POST.
const DELIVERY_TIMEOUT_MS = 30_000;

/** One delivery attempt. Floor refusals and deterministic 4xx are permanent; 408/429, network failures,
 *  deadlines and remote 5xx are retryable under the relay's budget. `signal` is the drain's deadline (05-runtime.md
 *  §async-core `ctx.signal`) — threaded into the actual `fetch`, not just honored by the relay's own
 *  `await` race, so a hung receiver's TCP connection is genuinely aborted at `handlerTimeoutMs` instead of
 *  running on as an orphaned socket past the point the relay already gave up on it. `safeFetch`'s own
 *  `timeoutMs` combines with that signal to also bound a receiver that never sends a response at all.
 *  `safeFetch` also offers `maxResponseBytes` as a reusable floor primitive, but it is deliberately NOT
 *  wired here: it errors a stream only once something reads it, and this function's `res.body?.cancel()`
 *  never reads a single byte — cancelling an UNREAD stream already bounds the exposure to nothing, so the
 *  cap would be inert decoration for this one caller (verified directly, not assumed). */
export async function deliverWebhook(
  decl: WebhookDecl,
  msg: DeliveredMsg,
  deps: WebhookDeps = {},
  signal?: AbortSignal,
): Promise<void> {
  const body = JSON.stringify({
    id: msg.id,
    topic: msg.topic,
    payload: msg.payload,
  });
  const headers: Record<string, string> = Object.fromEntries(
    Object.entries(decl.headers ?? {}).filter(([name]) =>
      name.toLowerCase() !== "content-type" &&
      (decl.sign === false || name.toLowerCase() !== "x-hazelnut-signature")
    ),
  );
  headers["content-type"] = "application/json";
  if (decl.sign !== false) {
    // the secret's presence is a boot guard (`webhook/secret-required`); belt-and-braces here for the raw path
    if (!decl.secret) {
      throw new Error(
        `webhook/secret-required: webhook '${decl.name}' has no secret and sign !== false`,
      );
    }
    const t = Math.floor((deps.now ?? Date.now)() / 1000);
    headers["x-hazelnut-signature"] = await signWebhook(decl.secret, t, body);
  }
  // one floor, two doors: delivery rides the same safeFetch primitive consumers get (https + DNS
  // pre-flight + redirect:"error"), so the webhook path can never drift from the published floor.
  let res: Response;
  try {
    res = await safeFetch(decl.url, {
      method: "POST",
      headers,
      body,
      signal,
    }, {
      allowInsecureHttp: decl.allowInsecureHttp,
      allowPrivateNetwork: decl.allowPrivateNetwork,
      resolve: deps.resolve,
      fetchFn: deps.fetchFn,
      door: "webhook", // this door names itself; a bare `safeFetch` refusal must not blame a webhook
      timeoutMs: deps.timeoutMs ?? DELIVERY_TIMEOUT_MS,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error as Error & { kind?: string }).kind === "forbidden"
    ) throw error;
    const timeout = error instanceof DOMException &&
        ["AbortError", "TimeoutError"].includes(error.name) ||
      signal?.aborted ||
      (error as { category?: unknown } | null)?.category === "timeout";
    throw Object.assign(
      new Error(
        timeout
          ? "webhook delivery timed out or was cancelled"
          : "webhook transport or DNS validation failed",
      ),
      {
        kind: timeout ? "timeout" as const : "internal" as const,
        code: timeout ? "webhook/deadline" : "webhook/transport",
      },
    );
  }
  await res.body?.cancel(); // the receiver's body is not consumed — ack is the status alone
  if (res.status < 200 || res.status >= 300) {
    const transient = res.status === 408 || res.status === 429;
    throw Object.assign(
      new Error(
        `webhook '${decl.name}' → ${
          displayUrl(decl.url, { origin: true })
        } answered ${res.status} (non-2xx is a failed delivery)`,
      ),
      {
        kind: transient
          ? "timeout" as const
          : res.status >= 400 && res.status < 500
          ? "business" as const
          : "internal" as const,
        code: transient
          ? "webhook/remote-retry"
          : res.status >= 400 && res.status < 500
          ? "webhook/remote-rejected"
          : "webhook/remote-unavailable",
      },
    );
  }
}

/** Derive the named subscriber a declared webhook rides the relay as. */
export function webhookSubscriber(
  decl: WebhookDecl,
  deps: WebhookDeps = {},
): AnySubscriber {
  return {
    topic: decl.topic,
    name: `webhook:${decl.name}`,
    ...(decl.maxAttempts !== undefined
      ? { maxAttempts: decl.maxAttempts }
      : {}),
    // the relay calls every handler as (event, ctx) — this one-arg form silently dropped ctx.signal, the
    // ONLY thread from the drain's deadline into the actual network call. Threading it here mirrors what a
    // typed defineSubscriber handler is expected to do with it.
    handler: (msg: DeliveredMsg, ctx?: { readonly signal?: AbortSignal }) =>
      deliverWebhook(decl, msg, deps, ctx?.signal),
  } as unknown as AnySubscriber;
}
