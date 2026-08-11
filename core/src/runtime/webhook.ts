// `defineWebhook` — the outbound webhook sink (05-runtime.md §externalization): hardened HTTP delivery of a
// module's emitted topic, riding the same outbox substrate as every consumer (retry → `_outbox_dead` →
// `hazelnut redrive`). SSRF floor: https-only (`allowInsecureHttp` opts out), DNS pre-flight blocks
// private/loopback/link-local/ULA/metadata ranges (`allowPrivateNetwork` opts in), `redirect: "error"` — a
// post-preflight DNS re-bind is not prevented (no IP-pinned fetch in Deno). HMAC:
// `X-Hazelnut-Signature: t=<unix>, v1=<hex hmac-sha256(secret, t + "." + body)>`; no `secret` is a boot
// refuse, `sign: false` opts out. Delivery: POST JSON `{ id, topic, payload }`; non-2xx throws for retry/DLQ.
import type { OnlyKnownKeys } from "../core/config.ts";
import type { AnySubscriber } from "./events.ts";
import type { DeliveredMsg } from "./outbox.ts";
import { safeFetch } from "./safe-fetch.ts";

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

// ── delivery ───────────────────────────────────────────────────────────────────────────────────────
export interface WebhookDeps {
  readonly fetchFn?: typeof fetch;
  readonly resolve?: (host: string, kind: "A" | "AAAA") => Promise<string[]>;
  readonly now?: () => number;
}

/** One delivery attempt. Non-2xx (and every floor refusal) throws — the relay's retry/DLQ semantics are
 *  the recovery story, exactly as for any subscriber. */
export async function deliverWebhook(
  decl: WebhookDecl,
  msg: DeliveredMsg,
  deps: WebhookDeps = {},
): Promise<void> {
  const body = JSON.stringify({
    id: msg.id,
    topic: msg.topic,
    payload: msg.payload,
  });
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...decl.headers,
  };
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
  const res = await safeFetch(decl.url, { method: "POST", headers, body }, {
    allowInsecureHttp: decl.allowInsecureHttp,
    allowPrivateNetwork: decl.allowPrivateNetwork,
    resolve: deps.resolve,
    fetchFn: deps.fetchFn,
    door: "webhook", // this door names itself; a bare `safeFetch` refusal must not blame a webhook
  });
  await res.body?.cancel(); // the receiver's body is not consumed — ack is the status alone
  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      `webhook '${decl.name}' → ${decl.url} answered ${res.status} (non-2xx is a failed delivery; the relay retries → DLQ)`,
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
    handler: (msg: DeliveredMsg) => deliverWebhook(decl, msg, deps),
  } as unknown as AnySubscriber;
}
