// AWS KMS `Kms` adapter (04-features.md §encrypted "Key lifecycle") — the shipped external-custody Port:
// `wrapKey`/`unwrapKey` ride KMS Encrypt/Decrypt (never sees value plaintext); a cross-key mixup hard-fails
// at AWS. `keyId` in the envelope is the response KeyId (full CMK ARN), so rotation = pointing at a new key.
// Dependency-free (no `@aws-sdk/client-kms`). Design:

/** Static credentials, app-sourced (env → config, the encryptionKey precedent). `sessionToken` for STS. */
export interface AwsKmsConfig {
  readonly region: string;
  readonly keyId: string; // the CMK to wrap under — ARN or alias/… form
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

export interface AwsKmsDeps {
  readonly fetchFn?: typeof fetch;
  readonly now?: () => Date;
}

const enc = new TextEncoder();

async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as BufferSource),
  );
  return [...digest].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function hmac(
  key: Uint8Array,
  data: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const k = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

/** AWS Signature V4 over one HTTP request (the generic core, exported so the official AWS test vector can
 *  pin it). Returns the `Authorization` header value. Headers MUST include `host` and `x-amz-date`. */
export async function sigV4(req: {
  readonly method: string;
  readonly path: string;
  readonly query: string; // canonical (already sorted/encoded) or ""
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly service: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}): Promise<string> {
  const names = Object.keys(req.headers).map((h) => h.toLowerCase()).sort();
  const canonicalHeaders = names.map((n) => {
    const v = Object.entries(req.headers).find(([k]) =>
      k.toLowerCase() === n
    )![1];
    return `${n}:${v.trim().replace(/\s+/g, " ")}\n`;
  }).join("");
  const signedHeaders = names.join(";");
  const canonical = [
    req.method,
    req.path,
    req.query,
    canonicalHeaders,
    signedHeaders,
    await sha256Hex(req.body),
  ]
    .join("\n");
  const amzDate = req.headers["x-amz-date"] ?? req.headers["X-Amz-Date"]!;
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${req.region}/${req.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonical),
  ].join("\n");
  let key: Uint8Array = enc.encode(`AWS4${req.secretAccessKey}`);
  for (const part of [date, req.region, req.service, "aws4_request"]) {
    key = await hmac(key, part);
  }
  const signature = [...await hmac(key, stringToSign)].map((x) =>
    x.toString(16).padStart(2, "0")
  ).join("");
  return `AWS4-HMAC-SHA256 Credential=${req.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

const b64 = {
  encode: (b: Uint8Array): string => btoa(String.fromCharCode(...b)),
  decode: (s: string): Uint8Array =>
    Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
};

async function kmsCall(
  cfg: AwsKmsConfig,
  deps: AwsKmsDeps,
  target: "TrentService.Encrypt" | "TrentService.Decrypt",
  payload: Record<string, string>,
): Promise<Record<string, string>> {
  const host = `kms.${cfg.region}.amazonaws.com`;
  const body = JSON.stringify(payload);
  const amzDate = (deps.now?.() ?? new Date()).toISOString().replace(
    /[-:]/g,
    "",
  ).replace(/\.\d{3}/, "");
  const headers: Record<string, string> = {
    "content-type": "application/x-amz-json-1.1",
    host,
    "x-amz-date": amzDate,
    "x-amz-target": target,
    ...(cfg.sessionToken ? { "x-amz-security-token": cfg.sessionToken } : {}),
  };
  headers["authorization"] = await sigV4({
    method: "POST",
    path: "/",
    query: "",
    headers,
    body,
    service: "kms",
    region: cfg.region,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
  });
  const res = await (deps.fetchFn ?? fetch)(`https://${host}/`, {
    method: "POST",
    headers,
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    // KMS errors carry `__type` (e.g. AccessDeniedException) — surface it verbatim, never a silent retry
    // (the caller's op/worker context owns retry semantics).
    throw new Error(
      `kms-aws: ${target} failed ${res.status} — ${text || "(empty body)"}`,
    );
  }
  try {
    return JSON.parse(text) as Record<string, string>;
  } catch {
    throw new Error(
      `kms-aws: ${target} ${host} returned ${res.status} but the body is not JSON`,
    );
  }
}

import type { Kms } from "./encrypt.ts";

/** Construct the AWS-KMS-backed `Kms` Port. Inject via `createApp(config, { kms: awsKms({...}) })`.
 *  Does not implement `equalityMacs` — `equality` fields need an adapter with that capability. */
export function awsKms(cfg: AwsKmsConfig, deps: AwsKmsDeps = {}): Kms {
  return {
    async wrapKey(
      dek: Uint8Array,
    ): Promise<{ wrapped: Uint8Array; keyId: string }> {
      const out = await kmsCall(cfg, deps, "TrentService.Encrypt", {
        KeyId: cfg.keyId,
        Plaintext: b64.encode(dek),
      });
      if (!out.CiphertextBlob || !out.KeyId) {
        throw new Error(
          "kms-aws: Encrypt answered without CiphertextBlob/KeyId",
        );
      }
      return { wrapped: b64.decode(out.CiphertextBlob), keyId: out.KeyId };
    },
    async unwrapKey(wrapped: Uint8Array, keyId: string): Promise<Uint8Array> {
      const out = await kmsCall(cfg, deps, "TrentService.Decrypt", {
        CiphertextBlob: b64.encode(wrapped),
        // passing the stored keyId makes a cross-key mixup an AWS-side hard failure, not a silent wrong-key try
        KeyId: keyId,
      });
      if (!out.Plaintext) {
        throw new Error("kms-aws: Decrypt answered without Plaintext");
      }
      return b64.decode(out.Plaintext);
    },
  };
}
