// Barrel re-exports keep import sites stable.
import { DEK_BYTES, type Kms, unpackEnvelope } from "./encrypt-envelope.ts";

const APP_KEY_ID = "app"; // the master-key version every envelope carries — the rotation discriminator

/** Import a 32-byte master key as a non-extractable AES-KW key for local DEK wrap/unwrap — distinct from
 *  the AES-GCM the value itself rides. */
async function importMasterKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== DEK_BYTES) {
    throw new Error(
      `encrypt: the app master key must be ${DEK_BYTES} bytes (got ${raw.length}) — a 32-byte AES-256 key`,
    );
  }
  return await crypto.subtle.importKey(
    "raw",
    raw as BufferSource,
    { name: "AES-KW" },
    false,
    ["wrapKey", "unwrapKey"],
  );
}

/** The floor `Kms` adapter: wraps/unwraps the per-row DEK locally (AES-KW) under one app master key,
 *  no network — the default when no external `kms` seam is injected. Key length is validated at
 *  construction, a loud throw at boot rather than a deferred surprise on first encrypt. */
export class AppKeyKms implements Kms {
  readonly #raw: Uint8Array;
  #master: Promise<CryptoKey> | null = null;
  constructor(masterKey: Uint8Array) {
    if (masterKey.length !== DEK_BYTES) {
      throw new Error(
        `encrypt: the app master key must be ${DEK_BYTES} bytes (got ${masterKey.length}) — a 32-byte AES-256 key`,
      );
    }
    // defensive copy — the caller's buffer stays theirs; this copy is zeroed once the CryptoKey import
    // lands, narrowing the window the raw key bytes are readable in a heap dump.
    this.#raw = masterKey.slice();
  }
  #hkdf: Promise<CryptoKey> | null = null;
  #masterKey(): Promise<CryptoKey> {
    return (this.#master ??= (async () => {
      // import both purposes off the raw bytes, then zero: AES-KW for wrap/unwrap + the HKDF base the
      // blind-index derivation reads (04-features.md §encrypted equality) — the wipe stays a single point.
      const kw = importMasterKey(this.#raw);
      this.#hkdf = crypto.subtle.importKey(
        "raw",
        this.#raw as BufferSource,
        "HKDF",
        false,
        ["deriveKey"],
      );
      const k = await kw;
      await this.#hkdf;
      this.#raw.fill(0);
      return k;
    })());
  }
  /** Blind-index MACs (04-features.md §encrypted equality) — single-version adapter: exactly one MAC, the
   *  HMAC-SHA-256 of `data` under the per-purpose key HKDF-derived from the app master. */
  async equalityMacs(purpose: string, data: Uint8Array): Promise<Uint8Array[]> {
    await this.#masterKey(); // settles #hkdf + the wipe ordering
    const mac = await hmacUnderHkdf(await this.#hkdf!, purpose, data);
    return [mac];
  }
  /** Wrap a per-row DEK under the app master key — local AES-KW, no network. The DEK is imported as a raw
   *  AES key purely so `wrapKey` accepts it; the returned `wrapped` blob is the AES-KW ciphertext of the DEK. */
  async wrapKey(
    dek: Uint8Array,
  ): Promise<{ wrapped: Uint8Array; keyId: string }> {
    const dekKey = await crypto.subtle.importKey(
      "raw",
      dek as BufferSource,
      { name: "AES-GCM" },
      true,
      ["encrypt"],
    );
    const wrapped = await crypto.subtle.wrapKey(
      "raw",
      dekKey,
      await this.#masterKey(),
      { name: "AES-KW" },
    );
    return { wrapped: new Uint8Array(wrapped), keyId: APP_KEY_ID };
  }
  /** Unwrap a DEK previously wrapped under this master key — local AES-KW, no network. A tampered/foreign
   *  wrapped blob fails the AES-KW integrity check and throws (never a silent wrong DEK). */
  async unwrapKey(wrapped: Uint8Array, _keyId: string): Promise<Uint8Array> {
    const dekKey = await crypto.subtle.unwrapKey(
      "raw",
      wrapped as BufferSource,
      await this.#masterKey(),
      { name: "AES-KW" },
      { name: "AES-GCM" },
      true,
      ["decrypt"],
    );
    return new Uint8Array(await crypto.subtle.exportKey("raw", dekKey));
  }
}

/** Build the default app-key adapter from a 32-byte raw master key. Synchronous (the Web Crypto import is
 *  memoized on first use), so the boot composition can default `kms` to it without an async createApp. */
export function appKeyKms(masterKey: Uint8Array): AppKeyKms {
  return new AppKeyKms(masterKey);
}

/** The floor `Kms` adapter holding more than one app master-key version, so a local key rotation
 *  completes with no external infra. `wrapKey` wraps under `current`; `unwrapKey` routes by the
 *  envelope's `keyId` (an old-version row still unwraps) — an unknown `keyId` is a loud throw. */
export class RotatingAppKeyKms implements Kms {
  readonly #raw: ReadonlyMap<string, Uint8Array>;
  readonly #current: string;
  readonly #imported = new Map<string, Promise<CryptoKey>>();
  constructor(
    versions: Record<string, Uint8Array> | ReadonlyMap<string, Uint8Array>,
    current: string,
  ) {
    const entries = versions instanceof Map
      ? [...versions]
      : Object.entries(versions as Record<string, Uint8Array>);
    if (entries.length === 0) {
      throw new Error(
        "encrypt: RotatingAppKeyKms needs at least one master-key version",
      );
    }
    const map = new Map<string, Uint8Array>();
    for (const [id, raw] of entries) {
      if (raw.length !== DEK_BYTES) {
        throw new Error(
          `encrypt: master key '${id}' must be ${DEK_BYTES} bytes (got ${raw.length}) — a 32-byte AES-256 key`,
        );
      }
      map.set(id, raw.slice()); // defensive copy — ours to zero once this version's CryptoKey import lands
    }
    if (!map.has(current)) {
      throw new Error(
        `encrypt: the current master-key version '${current}' is not among the supplied versions`,
      );
    }
    this.#raw = map;
    this.#current = current;
  }
  /** The version `wrapKey` seals new/re-wrapped DEKs under — the discriminator written into the envelope. */
  get currentVersion(): string {
    return this.#current;
  }
  readonly #hkdf = new Map<string, Promise<CryptoKey>>();
  #masterKey(keyId: string): Promise<CryptoKey> {
    let p = this.#imported.get(keyId);
    if (p === undefined) {
      const raw = this.#raw.get(keyId);
      if (raw === undefined) {
        throw new Error(
          `encrypt: no app master key for version '${keyId}' — the envelope was sealed under an unknown/evicted key version`,
        );
      }
      // import both purposes off this version's raw bytes, then zero (per version): AES-KW for wrap/unwrap
      // + the HKDF base the blind-index derivation reads (04-features.md §encrypted equality).
      const hkdf = crypto.subtle.importKey(
        "raw",
        raw as BufferSource,
        "HKDF",
        false,
        ["deriveKey"],
      );
      this.#hkdf.set(keyId, hkdf);
      p = (async () => {
        const k = await importMasterKey(raw);
        await hkdf;
        raw.fill(0);
        return k;
      })();
      this.#imported.set(keyId, p);
    }
    return p;
  }
  /** Blind-index MACs across every held master-key version — current first (the write-side stamp), older
   *  after (the read side `IN`-matches rows sealed under any version, so rotation needs no bidx backfill). */
  async equalityMacs(purpose: string, data: Uint8Array): Promise<Uint8Array[]> {
    const versions = [
      this.#current,
      ...[...this.#raw.keys()].filter((v) => v !== this.#current),
    ];
    const out: Uint8Array[] = [];
    for (const v of versions) {
      await this.#masterKey(v); // settles this version's #hkdf + wipe ordering
      out.push(await hmacUnderHkdf(await this.#hkdf.get(v)!, purpose, data));
    }
    return out;
  }
  /** Wrap a per-row DEK under the current master-key version — local AES-KW, no network. The returned `keyId`
   *  is that version, so the envelope records which version sealed it (rotation discriminator). */
  async wrapKey(
    dek: Uint8Array,
  ): Promise<{ wrapped: Uint8Array; keyId: string }> {
    const dekKey = await crypto.subtle.importKey(
      "raw",
      dek as BufferSource,
      { name: "AES-GCM" },
      true,
      ["encrypt"],
    );
    const wrapped = await crypto.subtle.wrapKey(
      "raw",
      dekKey,
      await this.#masterKey(this.#current),
      { name: "AES-KW" },
    );
    return { wrapped: new Uint8Array(wrapped), keyId: this.#current };
  }
  /** Unwrap a DEK under the master-key version in the envelope's `keyId` — local AES-KW, no network. `keyId`
   *  routes to the right master key (old rows still unwrap); a tampered/foreign blob fails the integrity check. */
  async unwrapKey(wrapped: Uint8Array, keyId: string): Promise<Uint8Array> {
    const dekKey = await crypto.subtle.unwrapKey(
      "raw",
      wrapped as BufferSource,
      await this.#masterKey(keyId),
      { name: "AES-KW" },
      { name: "AES-GCM" },
      true,
      ["decrypt"],
    );
    return new Uint8Array(await crypto.subtle.exportKey("raw", dekKey));
  }
}

/** Where the app master key was sourced: `"config"` = via `defineConfig({ encryptionKey })`
 *  (05-runtime.md §config-sourcing — the only path); `"none"` = no key configured. */
export type KeySource = "config" | "none";

/** The floor on distinct byte values. 32 bytes from a CSPRNG average ~31 distinct and MEASURED a minimum of
 *  24 over 20 000 draws, so 20 rejects a degenerate key (all-zero, one repeated value) with a margin no real
 *  key reaches. A property, never a list of known placeholders — a list only refuses the last one seen. */
const MIN_DISTINCT_BYTES = 20;

/** Whether these bytes are a TYPED PASSPHRASE rather than generated key material.
 *
 * Every byte printable ASCII is the tell: a CSPRNG produces that with probability (95/256)^32 ≈ 10⁻¹⁴, while
 * every placeholder a human writes — `changeme…`, a project name, a row of one letter — is nothing else.
 * The second clause catches the degenerate keys that are NOT text, `new Uint8Array(32)` first among them.
 */
function looksTyped(raw: Uint8Array): boolean {
  return raw.every((c) => c >= 0x20 && c <= 0x7e) ||
    new Set(raw).size < MIN_DISTINCT_BYTES;
}

/**
 * Decode a base64 master key into its raw 32 bytes, refusing anything that is not generated key material.
 *
 * Length alone is not the guard this once claimed to be: `changemechangemechangemechangeme` is exactly 32
 * bytes, and an app booted on it encrypted every `encrypted:` column under a key an attacker guesses first.
 * The refusal is fail-closed and lives HERE because this is the one seam where a string becomes a key —
 * `doctor` and boot both reach it, so neither needs its own copy of the rule.
 */
export function decodeMasterKey(b64: string): Uint8Array {
  let raw: Uint8Array;
  try {
    raw = Uint8Array.from(atob(b64.trim()), (c) => c.charCodeAt(0));
  } catch {
    throw new Error(
      `encrypt: the app master key (defineConfig({ encryptionKey })) is not valid base64 — supply a base64-encoded 32-byte key`,
    );
  }
  if (raw.length !== DEK_BYTES) {
    throw new Error(
      `encrypt: the app master key must decode to ${DEK_BYTES} bytes (got ${raw.length}) — generate one with \`openssl rand -base64 32\``,
    );
  }
  if (looksTyped(raw)) {
    throw new Error(
      `encrypt: the app master key decodes to ${DEK_BYTES} bytes but is not generated key material — it is ` +
        `printable text or has too few distinct bytes, which every placeholder ("changeme…", a project name, ` +
        `a repeated character) is and a random key never is. Generate one with \`openssl rand -base64 32\`. ` +
        `This is refused rather than warned: the columns it would seal are unrecoverable once written.`,
    );
  }
  return raw;
}

/** Resolve the app master key + provenance from `defineConfig({ encryptionKey })` (05-runtime.md
 *  §config-sourcing). Absent ⇒ `{ key: null, source: "none" }` (the boot guard refuses when a resource
 *  declares `encrypted`). NEVER auto-generates a key — a regenerated key orphans DEKs sealed under the old one. */
export function resolveMasterKey(
  configKey: string | undefined,
): { key: Uint8Array | null; source: KeySource } {
  if (configKey != null && configKey.trim() !== "") {
    return { key: decodeMasterKey(configKey), source: "config" };
  }
  return { key: null, source: "none" };
}

// ── Rotation accounting (04-features.md §encrypted "Key lifecycle") ──────────────────────────
// The framework owns the envelope + `key_id` + rotation accounting; the re-wrap worker and KMS custody are
// external substrate. These helpers read the retirement predicate — an old master-key version is removable
// once `count(key_id = old) = 0` — off stored envelopes, pure, no KMS.

/** The master-key version recorded in a stored `bytea` envelope (arrives as a Uint8Array or driver array-like;
 *  null/absent ⇒ `null`). Read without decrypting — the discriminator rotation keys on. */
export function envelopeKeyId(
  blob: Uint8Array | ArrayLike<number> | null | undefined,
): string | null {
  if (blob == null) return null;
  const bytes = blob instanceof Uint8Array ? blob : Uint8Array.from(blob);
  return unpackEnvelope(bytes).keyId;
}

/** Tally live key_id versions across a column of stored envelopes — the `count(key_id = …)` a re-wrap job
 *  needs. Null/absent cells are skipped (an unset column is not pinned to any key version). */
export function keyIdCounts(
  blobs: ReadonlyArray<Uint8Array | ArrayLike<number> | null | undefined>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const b of blobs) {
    const kid = envelopeKeyId(b);
    if (kid === null) continue;
    counts.set(kid, (counts.get(kid) ?? 0) + 1);
  }
  return counts;
}

/** The rotation-retirement predicate (04-features.md §encrypted): an old master-key version is removable
 *  once `count(key_id = old) = 0`. Pure over the tally, so a re-wrap job can gate on it without re-scanning. */
export function isKeyRemovable(
  counts: ReadonlyMap<string, number>,
  keyId: string,
): boolean {
  return (counts.get(keyId) ?? 0) === 0;
}

/** Derive the per-purpose HMAC-SHA-256 key from an HKDF base and MAC `data` under it — the blind-index
 *  primitive (04-features.md §encrypted equality); purpose-bound `info` keeps every field's index key distinct. */
async function hmacUnderHkdf(
  hkdfBase: CryptoKey,
  purpose: string,
  data: Uint8Array,
): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32),
      info: enc.encode(purpose),
    },
    hkdfBase,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, data as BufferSource),
  );
}
