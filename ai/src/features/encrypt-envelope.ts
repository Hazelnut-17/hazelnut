/** The `kms` seam (05-runtime.md §seams) — encrypted-at-rest: `encrypted` fields become a `bytea`
 *  envelope `[key_id | iv | wrapped_dek | ciphertext]` (04-features.md §encrypted; 03-api-shape.md §4),
 *  never an `"enc:"` string. The framework owns DEK/IV/AES-256-GCM; the KMS only wraps the DEK. */
export interface Kms {
  /** Wrap a per-row DEK under the current master key — the adapter sees only the DEK, never plaintext.
   *  Returns the wrapped blob + the master-key version (`keyId`), written into the envelope for rotation. */
  wrapKey(dek: Uint8Array): Promise<{ wrapped: Uint8Array; keyId: string }>;
  /** Unwrap a DEK previously wrapped under master-key version `keyId` (read off the stored envelope). */
  unwrapKey(wrapped: Uint8Array, keyId: string): Promise<Uint8Array>;
  /** Optional blind-index capability (04-features.md §encrypted equality): keyed MACs of `data` under every
   *  held master-key version, current first — lets rotation match old rows via `IN` with no bidx backfill. */
  equalityMacs?(purpose: string, data: Uint8Array): Promise<Uint8Array[]>;
}

/** The encrypted feature config, normalized from either declaration form (04-features.md §encrypted):
 *  the 90% list `encrypted: ["ssn"]`, or the object `{ fields, table?, key? }`. */
export interface EncryptedConfig {
  readonly fields: readonly string[]; // the column list stored as the bytea envelope
  readonly table: boolean; // true = whole-row at-rest (option); default column-level (false)
  readonly key: string | null; // logical KMS key-id / data-key namespace (seam-resolved); null = app default key
  /** The equality-searchable subset (04-features.md §encrypted equality): each field mints a `<f>_bidx`
   *  blind-index column; declaring a field here accepts that the bidx column leaks equality/frequency. */
  readonly equality: readonly string[];
}

/** Normalize the two declared forms of `encrypted` (04-features.md §encrypted). A bare string[] is the
 *  column-level 90% form (no whole-row, app default key); the object form parses `table`/`key`. */
export function normalizeEncrypted(
  raw: readonly string[] | {
    readonly fields: readonly string[];
    readonly table?: boolean;
    readonly key?: string;
    readonly equality?: readonly string[];
  } | undefined,
): EncryptedConfig {
  if (raw === undefined) {
    return { fields: [], table: false, key: null, equality: [] };
  }
  if (Array.isArray(raw)) {
    return { fields: raw, table: false, key: null, equality: [] };
  }
  const o = raw as {
    readonly fields: readonly string[];
    readonly table?: boolean;
    readonly key?: string;
    readonly equality?: readonly string[];
  };
  return {
    fields: o.fields ?? [],
    table: o.table ?? false,
    key: o.key ?? null,
    equality: o.equality ?? [],
  };
}

// ── Per-row crypto primitives (framework-owned; AES-256-GCM over Web Crypto) ─────
export const DEK_BYTES = 32; // AES-256 key
const IV_BYTES = 12; // GCM nonce — the standard 96-bit IV

const te = new TextEncoder();
const td = new TextDecoder();

/** The position a ciphertext is sealed to — `<pgSchema>.<table>` plus the row id, fed to AES-GCM as
 *  `additionalData`. A valid envelope moved to a different row/field fails the GCM tag check on decrypt. */
export interface EnvelopeSite {
  readonly schema: string; // the owning table's pg schema
  readonly table: string; // the resource table name
  readonly rowId: string; // app-minted before encrypt on create (encrypted requires an app-minted id strategy)
}

/** The canonical AAD bytes for one sealed cell: `<schema>.<table>.<field>.<rowId>`. */
function siteAad(site: EnvelopeSite, field: string): Uint8Array {
  return te.encode(`${site.schema}.${site.table}.${field}.${site.rowId}`);
}

/** Mint a fresh per-row DEK (32 random bytes). One key per value: re-encrypting the same plaintext draws
 *  a different DEK + IV, so the ciphertext differs every time (IND-CPA). */
function freshDek(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(DEK_BYTES));
}

/** Mint a fresh random IV (12 bytes / 96 bits — the GCM-recommended nonce length). */
function freshIv(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(IV_BYTES));
}

/** AES-256-GCM encrypt `plaintext` under a raw DEK + IV, with the cell's position bytes as
 *  `additionalData`. Returns the GCM ciphertext (which embeds the authentication tag) as raw bytes. */
async function aesEncrypt(
  dek: Uint8Array,
  iv: Uint8Array,
  plaintext: string,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    dek as BufferSource,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const ct = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv as BufferSource,
      additionalData: aad as BufferSource,
    },
    key,
    te.encode(plaintext) as BufferSource,
  );
  return new Uint8Array(ct);
}

/** AES-256-GCM decrypt a GCM ciphertext under a raw DEK + IV back to the plaintext string. A tampered
 *  ciphertext, wrong DEK, or relocated envelope fails the GCM tag check and throws — never a silent wrong-plaintext. */
async function aesDecrypt(
  dek: Uint8Array,
  iv: Uint8Array,
  cipher: Uint8Array,
  aad: Uint8Array,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    dek as BufferSource,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const pt = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: iv as BufferSource,
      additionalData: aad as BufferSource,
    },
    key,
    cipher as BufferSource,
  );
  return td.decode(pt);
}

// ── Envelope format ──────────────────────────────────────────────────────────────────
// `[ keyIdLen:1 | keyId:keyIdLen | ivLen:1 | iv:ivLen | dekLen:2(BE) | wrapped_dek:dekLen | ciphertext:* ]`
// (04-features.md §encrypted); wrapped_dek gets 2 bytes since it can exceed 255. No position is stored —
// that rides GCM additionalData, so the bytes decrypt only in place.

/** Pack the envelope `[key_id | iv | wrapped_dek | ciphertext]` into a single `bytea` blob — `keyId` is
 *  the master-key version discriminator for rotation. */
export function packEnvelope(
  keyId: string,
  iv: Uint8Array,
  wrappedDek: Uint8Array,
  cipher: Uint8Array,
): Uint8Array {
  const kid = te.encode(keyId);
  if (kid.length > 255 || iv.length > 255) {
    throw new Error("encrypt: key_id / iv exceed the 1-byte length prefix");
  }
  if (wrappedDek.length > 0xffff) {
    throw new Error("encrypt: wrapped_dek exceeds the 2-byte length prefix");
  }
  const out = new Uint8Array(
    1 + kid.length + 1 + iv.length + 2 + wrappedDek.length + cipher.length,
  );
  let o = 0;
  out[o++] = kid.length;
  out.set(kid, o);
  o += kid.length;
  out[o++] = iv.length;
  out.set(iv, o);
  o += iv.length;
  out[o++] = (wrappedDek.length >> 8) & 0xff;
  out[o++] = wrappedDek.length & 0xff;
  out.set(wrappedDek, o);
  o += wrappedDek.length;
  out.set(cipher, o);
  return out;
}

/** Unpack a `bytea` envelope back to its parts. Throws on a malformed blob (a short/garbled column is a
 *  loud failure, never a silent plaintext leak). */
export function unpackEnvelope(
  blob: Uint8Array,
): {
  keyId: string;
  iv: Uint8Array;
  wrappedDek: Uint8Array;
  cipher: Uint8Array;
} {
  if (blob.length < 2) throw new Error("decrypt: envelope too short");
  let o = 0;
  const kidLen = blob[o++]!;
  if (o + kidLen + 1 > blob.length) {
    throw new Error("decrypt: malformed envelope (key_id length)");
  }
  const keyId = td.decode(blob.subarray(o, o + kidLen));
  o += kidLen;
  const ivLen = blob[o++]!;
  if (o + ivLen + 2 > blob.length) {
    throw new Error("decrypt: malformed envelope (iv length)");
  }
  const iv = blob.subarray(o, o + ivLen);
  o += ivLen;
  const dekLen = (blob[o++]! << 8) | blob[o++]!;
  if (o + dekLen > blob.length) {
    throw new Error("decrypt: malformed envelope (wrapped_dek length)");
  }
  const wrappedDek = blob.subarray(o, o + dekLen);
  o += dekLen;
  const cipher = blob.subarray(o);
  return { keyId, iv, wrappedDek, cipher };
}

/** Encrypt the declared fields in-place (only present, non-null values): fresh per-row DEK + IV, AES-256-GCM
 *  under the cell's position as `additionalData`, DEK wrapped by the KMS — packed into the `bytea` envelope. */
export async function encryptValues(
  kms: Kms,
  fields: readonly string[],
  values: Record<string, unknown>,
  site: EnvelopeSite,
): Promise<void> {
  for (const f of fields) {
    const v = values[f];
    if (v != null) {
      const dek = freshDek();
      const iv = freshIv();
      const cipher = await aesEncrypt(dek, iv, String(v), siteAad(site, f));
      const { wrapped, keyId } = await kms.wrapKey(dek);
      values[f] = packEnvelope(keyId, iv, wrapped, cipher); // a Uint8Array → the pg driver binds it to the bytea column
    }
  }
}

/** Decrypt the declared fields in-place on a fetched row (only present, non-null values): unpack the
 *  envelope, unwrap the DEK via the KMS (routed by `key_id`), decrypt under the cell's position —
 *  a relocated envelope fails the tag check loudly. */
export async function decryptRow(
  kms: Kms,
  fields: readonly string[],
  row: Record<string, unknown>,
  at: { readonly schema: string; readonly table: string },
): Promise<void> {
  const rowId = row["id"];
  for (const f of fields) {
    const v = row[f];
    if (v == null) continue;
    if (rowId == null) {
      throw new Error(
        `decrypt: row of '${at.schema}.${at.table}' carries encrypted field '${f}' but no id — cannot rebind the position AAD`,
      );
    }
    const blob = v instanceof Uint8Array
      ? v
      : Uint8Array.from(v as ArrayLike<number>); // pg `bytea` → Uint8Array
    const { keyId, iv, wrappedDek, cipher } = unpackEnvelope(blob);
    const dek = await kms.unwrapKey(wrappedDek, keyId);
    row[f] = await aesDecrypt(
      dek,
      iv,
      cipher,
      siteAad({ ...at, rowId: String(rowId) }, f),
    );
  }
}

// ── The app-key floor adapter (04-features.md §encrypted) ────────────────────────
// `Kms` is a key-custody seam (framework owns DEK + AES-256-GCM value crypto). The floor adapter wraps
// the DEK locally under one app master key, zero infra; an external KMS is a swap-in Port.

// Guarantee level: the app key defends at-rest theft (master key lives in the env/secret store, not the
// data store) but not a compromised running process (RCE reading memory + env also reaches the key).

// ── Blind index (04-features.md §encrypted equality) ─────────────────────────────
// Equality search rides a separate `<f>_bidx` column (keyed MAC per field), leaving the envelope random-IV
// IND-CPA. SIV-style deterministic ciphertext was rejected: the per-row-DEK envelope makes cross-row
// equality impossible without restructuring onto per-field keys.

/** The minted blind-index column for an equality field. */
export function blindIndexCol(field: string): string {
  return `${field}_bidx`;
}

/** The per-field MAC purpose — schema+table+field bound, NEVER the row id (the index must match across rows). */
export function bidxPurpose(
  schema: string,
  table: string,
  field: string,
): string {
  return `bidx:${schema}.${table}.${field}`;
}

/** Canonical plaintext bytes for the MAC — JSON encoding (stable for the string/number/boolean values
 *  equality fields carry; declaring an object-valued field equality-searchable is legal but discouraged). */
function bidxBytes(value: unknown): Uint8Array {
  return te.encode(JSON.stringify(value));
}

const b64 = (u: Uint8Array): string => btoa(String.fromCharCode(...u));

/** Stamp the `<f>_bidx` values for the changed equality fields — MUST run before `encryptValues` (it reads
 *  the plaintext the seal consumes). A null/absent value stamps/leaves null (isNull rides the bidx column
 *  1:1). Uses the current master version's MAC (index zero of `equalityMacs`). */
export async function stampBlindIndexes(
  kms: Kms,
  equality: readonly string[],
  values: Record<string, unknown>,
  at: { readonly schema: string; readonly table: string },
): Promise<void> {
  for (const f of equality) {
    if (!(f in values)) continue; // untouched on this write — the column keeps its stored value
    const v = values[f];
    if (v === undefined || v === null) {
      values[blindIndexCol(f)] = null;
      continue;
    }
    if (!kms.equalityMacs) {
      throw new Error(
        `resource '${at.table}' declares equality-searchable encrypted field '${f}' but the bound KMS adapter has no equalityMacs capability — use the app-key KMS floor or extend the adapter`,
      );
    }
    const macs = await kms.equalityMacs(
      bidxPurpose(at.schema, at.table, f),
      bidxBytes(v),
    );
    values[blindIndexCol(f)] = b64(macs[0]!); // current version — the write-side stamp
  }
}

/** Rewrite caller WHERE conjuncts over equality fields onto their bidx columns: `eq(f,v)` → `bidx IN
 *  (macs-of-v under every master version)` (no backfill needed on rotation); `inArray` → flattened MAC set;
 *  `isNull` → `isNull(bidx)`. Any other operator is untouched — the `encrypted/no-where` lint refuses those
 *  (ranges/likes are structurally impossible on a MAC). */
export async function rewriteEqualityNode(
  kms: Kms,
  equality: readonly string[],
  at: { readonly schema: string; readonly table: string },
  node: import("../core/where.ts").Node,
): Promise<import("../core/where.ts").Node> {
  type N = import("../core/where.ts").Node;
  const eqSet = new Set(equality);
  const macsFor = async (f: string, v: unknown): Promise<string[]> => {
    if (!kms.equalityMacs) {
      throw new Error(
        `equality-searchable field '${f}' needs a KMS adapter with equalityMacs — the bound adapter has none`,
      );
    }
    return (await kms.equalityMacs(
      bidxPurpose(at.schema, at.table, f),
      bidxBytes(v),
    )).map(b64);
  };
  const walk = async (n: N): Promise<N> => {
    switch (n.kind) {
      case "cmp":
        if (n.op === "eq" && eqSet.has(n.col)) {
          return {
            kind: "inArray",
            col: blindIndexCol(n.col),
            values: await macsFor(n.col, n.value),
          };
        }
        return n;
      case "inArray": {
        if (!eqSet.has(n.col)) return n;
        const all: string[] = [];
        for (const v of n.values) all.push(...await macsFor(n.col, v));
        return { kind: "inArray", col: blindIndexCol(n.col), values: all };
      }
      case "isNull":
        return eqSet.has(n.col)
          ? { kind: "isNull", col: blindIndexCol(n.col) }
          : n;
      case "and":
        return { kind: "and", parts: await Promise.all(n.parts.map(walk)) };
      case "or":
        return { kind: "or", parts: await Promise.all(n.parts.map(walk)) };
      case "not":
        return { kind: "not", part: await walk(n.part) };
      default:
        return n;
    }
  };
  return walk(node);
}

// roster/engine extracted into cohesive submodules, re-exported so importers stay stable.
