// The KDF worker lane. argon2id (@noble/hashes) is synchronous JS: on the main thread the full
// memory-hard pass freezes the event loop — every request, timer, and health check stalls behind one
// unauthenticated login. This module is BOTH the worker script and a value-import of code-helpers.ts
// (so the release closure carries it); its top level only installs the message handler, so importing
// it on the main thread is inert.
import { argon2id } from "@noble/hashes/argon2.js";

export interface KdfRequest {
  readonly id: number;
  readonly plaintext: string;
  readonly salt: string; // b64
  readonly m: number;
  readonly t: number;
  readonly p: number;
  readonly dkLen: number;
}
export interface KdfReply {
  readonly id: number;
  readonly hash?: string; // b64
  readonly error?: string;
}

const fromB64 = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const toB64 = (bytes: Uint8Array): string => {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

// the worker global — Deno's default lib types `self` as Window, which carries neither member
declare const self: {
  onmessage: ((e: MessageEvent<KdfRequest>) => void) | null;
  postMessage(msg: KdfReply): void;
};

self.onmessage = (e: MessageEvent<KdfRequest>) => {
  const q = e.data;
  try {
    const hash = argon2id(
      new TextEncoder().encode(q.plaintext),
      fromB64(q.salt),
      { m: q.m, t: q.t, p: q.p, dkLen: q.dkLen },
    );
    self.postMessage({ id: q.id, hash: toB64(hash) } satisfies KdfReply);
  } catch (err) {
    self.postMessage(
      {
        id: q.id,
        error: err instanceof Error ? err.message : String(err),
      } satisfies KdfReply,
    );
  }
};
