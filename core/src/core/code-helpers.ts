import type { KdfReply, KdfRequest } from "./kdf-worker.ts";
import "./kdf-worker.ts"; // the closure edge — the worker script rides the release artifact
import { DerivationGate } from "./kdf-gate.ts";
/**
 * `unguessableCode()` and `slugify()` are pure helpers the AI calls in `logic/` (02-dsl.md §unguessable
 * codes / §unique ≠ generate) — the `randomCode`→`unguessableCode()`, `slug`→`slugify()` routing demotions.
 * `ctx.ts` exposes them as `ctx.code.generate` / `ctx.code.hash`; `unique` is enforced underneath, not here.
 */

// ── alphabets (02-dsl.md §unguessable codes) ──────────────────────────────────────────────────────────
// The default drops confusable glyphs 0/O/1/I/L so a spoken/typed code cannot be transposed — no-confusables
// is the default.

const ALPHANUMERIC =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const NUMERIC = "0123456789";
const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const CROCKFORD32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32 — no I/L/O/U
const NO_CONFUSABLES =
  "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"; // drops 0/O/1/I/L

const PRESETS: Record<string, string> = {
  alphanumeric: ALPHANUMERIC,
  numeric: NUMERIC,
  alpha: ALPHA,
  crockford32: CROCKFORD32,
  "no-confusables": NO_CONFUSABLES,
};

/** The vowels stripped when `excludeVowels` is set (02-dsl.md — avoids accidental profanity). Case-folded. */
const VOWELS = new Set("aeiouAEIOU");

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
    | string; // preset name or a custom alphabet literal
  readonly prefix?: string; // fixed prefix (e.g. "M-")
  readonly suffix?: string; // fixed suffix
  readonly case?: "upper" | "lower" | "mixed"; // case normalization (default "upper")
  readonly groups?: { readonly size: number; readonly sep: string }; // → M-X7K9-P2QR (readable grouping)
  readonly excludeVowels?: boolean; // drop vowels from the alphabet (avoid accidental profanity)
  readonly pattern?: string; // positional form: "M-XXXX-XXXX" (X = random); overrides length when set
}

/** Resolve the effective alphabet: a known preset name maps to its glyph set, else the value is a custom
 *  alphabet literal; `excludeVowels` filters it after resolution. */
function resolveAlphabet(
  alphabet: string | undefined,
  excludeVowels: boolean | undefined,
): string {
  const base = alphabet === undefined
    ? NO_CONFUSABLES
    : (PRESETS[alphabet] ?? alphabet);
  const filtered = excludeVowels
    ? [...base].filter((c) => !VOWELS.has(c)).join("")
    : base;
  if (filtered.length < 2) {
    // an alphabet of <2 glyphs has zero keyspace — a guaranteed-guessable code; loud-fail, never mint it.
    throw new Error(
      `unguessableCode: alphabet '${
        alphabet ?? "(default)"
      }' resolves to <2 usable glyphs — no keyspace`,
    );
  }
  return filtered;
}

/** Apply the `case` normalization to a minted body (the alphabet may be mixed-case; `case` forces it). */
function applyCase(s: string, mode: CodeConfig["case"]): string {
  if (mode === "upper") return s.toUpperCase();
  if (mode === "lower") return s.toLowerCase();
  return s; // "mixed" (or undefined-default-after-upper) — leave as drawn
}

/** Draws `n` uniform glyphs from `alphabet` via CSPRNG rejection sampling, so keyspace is exactly
 *  `alphabet.length ** n` (the randomCode/weak-entropy principle depends on this). */
function drawGlyphs(alphabet: string, n: number): string {
  const len = alphabet.length;
  const max = Math.floor(256 / len) * len; // the largest byte value that does not bias the modulo
  let out = "";
  const buf = new Uint8Array(Math.max(16, n * 2));
  while (out.length < n) {
    crypto.getRandomValues(buf);
    for (let i = 0; i < buf.length && out.length < n; i++) {
      const b = buf[i]!;
      if (b < max) out += alphabet[b % len];
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
  const alphabet = resolveAlphabet(config.alphabet, config.excludeVowels);
  let body: string;
  if (config.pattern !== undefined) {
    // positional form: every literal char passes through; each `X` consumes one fresh random glyph.
    const xCount = [...config.pattern].filter((c) => c === "X").length;
    const glyphs = drawGlyphs(alphabet, xCount);
    let gi = 0;
    body = [...config.pattern].map((c) => (c === "X" ? glyphs[gi++]! : c)).join(
      "",
    );
    body = applyCase(body, caseMode);
  } else {
    const length = config.length ?? 10;
    if (length < 1) {
      throw new Error(`unguessableCode: length must be ≥ 1 (got ${length})`);
    }
    let drawn = applyCase(drawGlyphs(alphabet, length), caseMode);
    if (config.groups !== undefined && config.groups.size > 0) {
      const parts: string[] = [];
      for (let i = 0; i < drawn.length; i += config.groups.size) {
        parts.push(drawn.slice(i, i + config.groups.size));
      }
      drawn = parts.join(config.groups.sep);
    }
    body = drawn;
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

/** The single KDF worker (bounded by construction: ONE thread, however many logings arrive). A dead
 *  worker is re-created on the next derivation; every pending caller of a crashed worker is rejected. */
let kdfWorker: Worker | null = null;
let kdfReqId = 1;
const kdfPending = new Map<
  number,
  { resolve: (h: string) => void; reject: (e: Error) => void }
>();

function kdfWorkerLane(): Worker {
  if (kdfWorker) return kdfWorker;
  kdfWorker = new Worker(new URL("./kdf-worker.ts", import.meta.url), {
    type: "module",
  });
  kdfWorker.onmessage = (e: MessageEvent<KdfReply>) => {
    const p = kdfPending.get(e.data.id);
    if (!p) return;
    kdfPending.delete(e.data.id);
    if (e.data.error != null) p.reject(new Error(e.data.error));
    else p.resolve(e.data.hash!);
  };
  kdfWorker.onerror = (e) => {
    const err = new Error(`kdf worker failed: ${e.message ?? "unknown"}`);
    for (const p of kdfPending.values()) p.reject(err);
    kdfPending.clear();
    kdfWorker?.terminate();
    kdfWorker = null;
  };
  return kdfWorker;
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
        const id = kdfReqId++;
        kdfPending.set(id, {
          resolve: (h) => {
            const bytes = fromB64(h);
            if (bytes == null) {
              reject(new Error("kdf worker returned a malformed hash"));
            } else resolve(bytes);
          },
          reject,
        });
        const q: KdfRequest = {
          id,
          plaintext,
          salt: toB64(salt),
          m: p.m,
          t: p.t,
          p: p.p,
          dkLen: HASH_BYTES,
        };
        kdfWorkerLane().postMessage(q);
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
 *  no early exit. A malformed/unknown record is `false`, never a throw. */
export async function verifyCodeHash(
  plaintext: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4) return false;
  let got: Uint8Array;
  if (parts[0] === "argon2id") {
    const p = Object.fromEntries(
      parts[1]!.split(",").map((kv) => kv.split("=")),
    ) as Record<string, string>;
    const [m, t, lanes] = [Number(p.m), Number(p.t), Number(p.p)];
    if (![m, t, lanes].every((n) => Number.isInteger(n) && n > 0)) return false;
    const salt = fromB64(parts[2]!);
    if (salt == null) return false;
    got = await argon2(plaintext, salt, { m, t, p: lanes });
  } else if (parts[0] === "pbkdf2") {
    const iterations = Number(parts[1]);
    if (!Number.isInteger(iterations) || iterations < 1) return false;
    const salt = fromB64(parts[2]!);
    if (salt == null) return false;
    got = await pbkdf2(plaintext, salt, iterations);
  } else return false;
  const expected = fromB64(parts[3]!);
  if (expected == null) return false;
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
    generate: (config?: CodeConfig) => Promise.resolve(unguessableCode(config)),
    hash: hashCode,
    verifyHash: verifyCodeHash,
    slugify,
  } satisfies CodeSurface,
);
