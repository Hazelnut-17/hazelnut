import type { KdfReply, KdfRequest } from "./kdf-worker.ts";
import "./kdf-worker.ts"; // the closure edge — the worker script rides the release artifact
import { DerivationGate } from "./kdf-gate.ts";
import {
  codeAlphabet,
  CodeConfigError,
  codeGlyphCount,
} from "./code-alphabet.ts";

/**
 * `unguessableCode()` and `slugify()` are pure helpers the AI calls in `logic/` (02-dsl.md §unguessable
 * codes / §unique ≠ generate) — the `randomCode`→`unguessableCode()`, `slug`→`slugify()` routing demotions.
 * `ctx.ts` exposes them as `ctx.code.generate` / `ctx.code.hash`; `unique` is enforced underneath, not here.
 */

/**
 * `unguessableCode()` config (02-dsl.md §unguessable codes) — every field optional; the bare call mints a
 * 10-char no-confusables upper code. `pattern` is the positional alternative (`X` = random glyph, else
 * literal) and overrides `length` when present.
 */
export interface CodeConfig {
  readonly length?: number; // random characters → keyspace (default 10)
  readonly alphabet?:
    | "alphanumeric"
    | "numeric"
    | "alpha"
    | "crockford32"
    | "no-confusables"
    | string; // exact, case-sensitive preset name; every other string is a custom alphabet literal
  readonly prefix?: string; // fixed prefix (e.g. "M-")
  readonly suffix?: string; // fixed suffix
  readonly case?: "upper" | "lower" | "mixed"; // case normalization (default "upper")
  readonly groups?: { readonly size: number; readonly sep: string }; // → M-X7K9-P2QR (readable grouping)
  readonly excludeVowels?: boolean; // drop vowels from the alphabet (avoid accidental profanity)
  readonly pattern?: string; // positional form: "M-XXXX-XXXX" (X = random); overrides length when set
}

/** Draws `n` uniform glyphs from `alphabet` via CSPRNG rejection sampling, so keyspace is exactly
 *  `[...alphabet].length ** n` — `hygiene/code-entropy` reads that number. */
function drawGlyphs(alphabet: string, n: number): string[] {
  const choices = [...alphabet];
  const len = choices.length;
  const max = Math.floor(2 ** 32 / len) * len;
  const out: string[] = [];
  // A bounded buffer also respects WebCrypto's 65536-byte quota for long codes.
  const buf = new Uint32Array(Math.min(4096, Math.max(16, n * 2)));
  while (out.length < n) {
    crypto.getRandomValues(buf);
    for (const value of buf) {
      if (value < max) out.push(choices[value % len]!);
      if (out.length === n) break;
    }
  }
  return out;
}

/**
 * Mints one unguessable code (02-dsl.md §unguessable codes) — pure of the DB, it draws from a CSPRNG with
 * the requested formatting but does not enforce `unique` (checked on insert/`maxRetries`). Default: a
 * 10-char no-confusables upper code; `pattern` (`X` = random glyph) overrides `length` when set.
 */
export function unguessableCode(config: CodeConfig = {}): string {
  const caseMode = config.case ?? "upper";
  const alphabet = codeAlphabet(config);
  let body: string;
  if (config.pattern !== undefined) {
    // positional form: each `X` consumes one fresh random glyph; the literals take the case mode too.
    const count = codeGlyphCount(config);
    if (count < 1) {
      throw new CodeConfigError(
        "unguessableCode: pattern must contain at least one random X",
      );
    }
    const glyphs = drawGlyphs(alphabet, count);
    let gi = 0;
    body = [...config.pattern].map((c) =>
      c === "X"
        ? glyphs[gi++]!
        : caseMode === "upper"
        ? c.toUpperCase()
        : caseMode === "lower"
        ? c.toLowerCase()
        : c
    ).join("");
  } else {
    const length = config.length ?? 10;
    if (!Number.isSafeInteger(length) || length < 1) {
      throw new CodeConfigError(
        `unguessableCode: length must be ≥ 1 (got ${length})`,
      );
    }
    const drawn = drawGlyphs(alphabet, length);
    if (config.groups !== undefined) {
      if (!Number.isSafeInteger(config.groups.size) || config.groups.size < 1) {
        throw new CodeConfigError(
          "unguessableCode: group size must be a positive integer",
        );
      }
      const parts: string[] = [];
      for (let i = 0; i < drawn.length; i += config.groups.size) {
        parts.push(drawn.slice(i, i + config.groups.size).join(""));
      }
      body = parts.join(config.groups.sep);
    } else body = drawn.join("");
  }
  return `${config.prefix ?? ""}${body}${config.suffix ?? ""}`;
}

// ── slugify (02-dsl.md §unique ≠ generate — `slug`→`slugify()` demotion) ────────────────────────────────

/**
 * Derives a url-safe slug from a title (02-dsl.md: `slug`→`slugify()`) — lowercases, strips diacritics,
 * collapses non-`[a-z0-9]` runs to one hyphen, trims edges. A collision suffix (`-2`) is the caller's job;
 * `unique`/`url-safe` are framework invariants underneath, not this helper.
 */
export function slugify(
  text: string,
  opts: { readonly maxLength?: number; readonly suffix?: string | number } = {},
): string {
  const base = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritical marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // any non-url-safe run → one hyphen
    .replace(/^-+|-+$/g, ""); // trim edge hyphens
  if (!base) {
    throw Object.assign(
      new Error(
        "slugify: title has no usable ASCII slug; supply an explicit nonempty fallback",
      ),
      { kind: "validation" as const, code: "code/slug-empty" },
    );
  }
  let slug = opts.maxLength !== undefined
    ? base.slice(0, opts.maxLength).replace(/-+$/g, "")
    : base;
  if (opts.suffix !== undefined && `${opts.suffix}`.length > 0) {
    slug = slug.length > 0 ? `${slug}-${opts.suffix}` : `${opts.suffix}`;
  }
  return slug;
}

// ── ctx.code.hash — the password / confirm-token hash (02-dsl.md §unguessable codes) ────────────────────
// Argon2id (the PHC winner, OWASP's first choice) at OWASP's recommended profile, written as a
// self-describing `argon2id$m=..,t=..,p=..$<saltB64>$<hashB64>` string; `verifyCodeHash` re-derives it.

// Memory-hardness is the point — a GPU/ASIC attacker cannot trade memory for parallelism — and the profile
// is chosen so the defensive cost stays bounded: 19 MiB per derivation, not scrypt's ~134 MiB at its own
// OWASP floor. The login endpoint is UNAUTHENTICATED, so the amplification that buys is gated below.
const ARGON2_M_KIB = 19_456; // 19 MiB — OWASP's first recommended Argon2id profile
const ARGON2_T = 2; // iterations
const ARGON2_P = 1; // lanes
const HASH_BYTES = 32; // 256-bit derived key
const SALT_BYTES = 16;
const MAX_STORED_SALT_BYTES = 64;
const LEGACY_PBKDF2_MAX_ITERATIONS = 600_000; // the highest count any earlier build wrote

/** The parameters the CURRENT `hashCode` writes — the yardstick `needsRehash` compares a stored hash to. */
const CURRENT_PARAMS = `argon2id$m=${ARGON2_M_KIB},t=${ARGON2_T},p=${ARGON2_P}`;

// The derivation gate — the bound that a per-identifier login throttle cannot provide. 4 slots × 19 MiB
// caps the KDF's resident cost at ~76 MiB however many unauthenticated attempts arrive at once; over
// capacity WAITS (a queue is the honest answer to a slow resource) and a wait past the deadline surfaces
// `timeout`, which is retryable — never `forbidden`, which would read as a wrong password. `kdf-gate.ts`.
const KDF_MAX_INFLIGHT = 4;
const KDF_MAX_WAIT_MS = 2_000;
const GATE = new DerivationGate(KDF_MAX_INFLIGHT, KDF_MAX_WAIT_MS);

function toB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function fromB64(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null; // malformed / padded-wrong — maps to false, never a throw
  }
}

/** One CPU lane for each admitted Argon2 derivation. The gate bounds resident memory and the pool makes
 * those slots real parallel work rather than a queue behind one synchronous worker. Workers are lazy. */
interface KdfLane {
  worker: Worker | null;
  pending?: {
    id: number;
    resolve: (hash: string) => void;
    reject: (error: Error) => void;
  };
}
const kdfLanes: KdfLane[] = Array.from(
  { length: KDF_MAX_INFLIGHT },
  () => ({ worker: null }),
);
let kdfReqId = 1;

function kdfWorkerLane(lane: KdfLane): Worker {
  if (lane.worker) return lane.worker;
  const worker = new Worker(new URL("./kdf-worker.ts", import.meta.url), {
    type: "module",
  });
  lane.worker = worker;
  worker.onmessage = (e: MessageEvent<KdfReply>) => {
    const p = lane.pending?.id === e.data.id ? lane.pending : undefined;
    if (!p) return;
    delete lane.pending;
    if (e.data.error != null) p.reject(new Error(e.data.error));
    else p.resolve(e.data.hash!);
  };
  worker.onerror = (e) => {
    const err = new Error(`kdf worker failed: ${e.message ?? "unknown"}`);
    lane.pending?.reject(err);
    delete lane.pending;
    worker.terminate();
    lane.worker = null;
  };
  return worker;
}

/** Derive with an explicit profile — the same entry the write and the verify both take, so a stored hash is
 *  always re-derived with the parameters BAKED INTO IT rather than with today's. The derivation runs in
 *  the worker lane: argon2id is synchronous, so on the main thread one login freezes the whole loop. */
function argon2(
  plaintext: string,
  salt: Uint8Array,
  p: { m: number; t: number; p: number },
): Promise<Uint8Array> {
  return GATE.run(
    () =>
      new Promise<Uint8Array>((resolve, reject) => {
        const lane = kdfLanes.find((candidate) =>
          candidate.pending === undefined
        );
        if (!lane) {
          reject(
            new Error(
              "kdf worker pool: an admitted derivation has no free lane",
            ),
          );
          return;
        }
        const id = kdfReqId++;
        lane.pending = {
          id,
          resolve: (h) => {
            const bytes = fromB64(h);
            if (bytes == null) {
              reject(new Error("kdf worker returned a malformed hash"));
            } else resolve(bytes);
          },
          reject,
        };
        const q: KdfRequest = {
          id,
          plaintext,
          salt: toB64(salt),
          m: p.m,
          t: p.t,
          p: p.p,
          dkLen: HASH_BYTES,
        };
        try {
          kdfWorkerLane(lane).postMessage(q);
        } catch (error) {
          delete lane.pending;
          reject(error);
        }
      }),
  );
}

/** The legacy PBKDF2 profile. It exists for ONE reason: `verifyCodeHash` must still open a hash written by
 *  an older build so `needsRehash` can upgrade it on the next successful login. Nothing writes this form. */
function pbkdf2(
  plaintext: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  return GATE.run(async () => {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(plaintext) as BufferSource,
      { name: "PBKDF2" },
      false,
      ["deriveBits"],
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: salt as BufferSource,
        iterations,
        hash: "SHA-256",
      },
      key,
      HASH_BYTES * 8,
    );
    return new Uint8Array(bits);
  });
}

/**
 * Hashes a plaintext secret (Argon2id) with a fresh random salt, returning the self-describing
 * `argon2id$m=..,t=..,p=..$<saltB64>$<hashB64>` string. A fresh salt per call means the same plaintext
 * hashes to different strings (no-rainbow-table); `verifyCodeHash` re-derives to compare in constant time.
 */
export async function hashCode(plaintext: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await argon2(plaintext, salt, {
    m: ARGON2_M_KIB,
    t: ARGON2_T,
    p: ARGON2_P,
  });
  return `${CURRENT_PARAMS}$${toB64(salt)}$${toB64(hash)}`;
}

/** Constant-time compare a plaintext against a `hashCode` string. Re-derives with the STORED parameters —
 *  today's Argon2id profile, or a retired one a previous build wrote — and compares the derived bytes with
 *  no early exit. A malformed/unknown record, or one costlier than any profile this framework wrote, is
 *  `false` without deriving, never a throw. */
export async function verifyCodeHash(
  plaintext: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4) return false;
  const salt = fromB64(parts[2]!);
  const expected = fromB64(parts[3]!);
  if (salt == null || salt.length > MAX_STORED_SALT_BYTES) return false;
  if (expected == null || expected.length !== HASH_BYTES) return false;
  // The KDF lane is process-wide: one stored record allowed to cost more than today's `hashCode` would
  // pin every login, signup and refresh behind it until restart.
  let got: Uint8Array;
  if (parts[0] === "argon2id") {
    const p = Object.fromEntries(
      parts[1]!.split(",").map((kv) => kv.split("=")),
    ) as Record<string, string>;
    const [m, t, lanes] = [Number(p.m), Number(p.t), Number(p.p)];
    if (![m, t, lanes].every((n) => Number.isInteger(n) && n > 0)) return false;
    if (m > ARGON2_M_KIB || t > ARGON2_T || lanes > ARGON2_P) return false;
    if (m < 8 * lanes) return false; // below Argon2's own floor: the worker would throw instead of answering
    got = await argon2(plaintext, salt, { m, t, p: lanes });
  } else if (parts[0] === "pbkdf2") {
    const iterations = Number(parts[1]);
    if (!Number.isInteger(iterations) || iterations < 1) return false;
    if (iterations > LEGACY_PBKDF2_MAX_ITERATIONS) return false;
    got = await pbkdf2(plaintext, salt, iterations);
  } else return false;
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i]! ^ expected[i]!;
  return diff === 0;
}

/**
 * Was `stored` written with parameters this build no longer uses? A hash is verified with the parameters
 * BAKED INTO IT, so raising the cost (or moving off the algorithm, as this build did) leaves every existing
 * row at its old strength — silently, and forever, because nothing ever rewrites it. This is the door that
 * makes the KDF a decision this project can revisit rather than one it made once: a caller that holds the
 * plaintext at verify time (`passwordLogin`) rehashes on the spot.
 *
 * Answered from the stored prefix alone — no derivation, so calling it costs nothing on the hot path.
 */
export function needsRehash(stored: string): boolean {
  return !stored.startsWith(`${CURRENT_PARAMS}$`);
}

/**
 * Hashes each present `password()` field's plaintext in-place via `hashCode` before the repo write — the
 * `password/strong-hash` guarantee (a stored password is NEVER plaintext or a fast hash). Mirrors
 * `encryptValues`: only fields present in `values` transform, so a partial update skips an omitted password.
 */
export async function hashPasswordValues(
  fields: readonly string[],
  values: Record<string, unknown>,
): Promise<void> {
  for (const f of fields) {
    const v = values[f];
    if (typeof v === "string") values[f] = await hashCode(v);
  }
}

/**
 * `ctx.code` (02-dsl.md §unguessable codes) — the helper surface a handler reaches in `logic/`. `generate`
 * mints an unguessable code (async, to match `await ctx.code.generate(...)` and leave room for a future
 * retry loop); `hash` hashes a confirm-token; `slugify` derives a url-safe slug. Pure of the DB.
 */
export interface CodeSurface {
  generate(config?: CodeConfig): Promise<string>;
  hash(plaintext: string): Promise<string>;
  verifyHash(plaintext: string, stored: string): Promise<boolean>;
  slugify(
    text: string,
    opts?: { readonly maxLength?: number; readonly suffix?: string | number },
  ): string;
}

/** The single `ctx.code` surface — pure helpers, no per-request state, so one frozen instance is shared. */
export const codeSurface: CodeSurface = Object.freeze(
  {
    generate: async (config?: CodeConfig) => unguessableCode(config),
    hash: hashCode,
    verifyHash: verifyCodeHash,
    slugify,
  } satisfies CodeSurface,
);
