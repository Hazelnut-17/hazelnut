/**
 * Every framework-minted id is a UUIDv7 (RFC 9562): the 48-bit unix-ms prefix keeps ids time-ordered
 * (index locality, natural outbox/audit order) — a v4 would scatter inserts. Same-ms ids stay strictly
 * ordered via a 12-bit `rand_a` counter; wrap (>4096/ms) is fine — `_outbox`'s bigserial is the strict order.
 * `seedIds` is the test seam: it makes the stream reproducible without making it anything but a UUIDv7.
 */
let lastMs = 0;
let counter = 0;

/** The fixed ms prefix a seeded stream starts from — any constant works, this one just has to not move. */
const SEED_EPOCH_MS = Date.UTC(2020, 0, 1);

/** The deterministic stream a test installed, if any. Process-global BY NECESSITY: `uuidv7` is called from
 *  sites that thread no ctx, so exactly one seeded harness may be live at a time. */
let stream: { rng: () => number; draws: number } | undefined;

/** A 32-bit seeded PRNG — the entropy source a seeded stream draws its 62 random bits from. */
function mulberry32(a: number): () => number {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Install a reproducible id stream: the same seed mints the same ids in the same order, so an op that
 * creates a row can be asserted by equality instead of by shape. They are still real UUIDv7s — only the ms
 * prefix and the entropy are made deterministic, and the prefix still advances so ids stay strictly ordered.
 * Returns the restore that puts the previous stream back, exactly where it was; nest with try/finally.
 */
export function seedIds(seed: number): () => void {
  const prev = { stream, lastMs, counter };
  stream = { rng: mulberry32(seed | 0), draws: 0 };
  lastMs = 0;
  counter = 0;
  return () => {
    stream = prev.stream;
    lastMs = prev.lastMs;
    counter = prev.counter;
  };
}

export function uuidv7(): string {
  // A seeded stream advances its prefix once per 4096 draws — exactly when `counter` would wrap, so a long
  // seeded run stays collision-free and ordered rather than repeating its first id.
  const ts = stream === undefined
    ? Date.now()
    : SEED_EPOCH_MS + (stream.draws++ >> 12);
  if (ts === lastMs) {
    counter = (counter + 1) & 0xfff; // 12-bit rand_a counter
  } else {
    lastMs = ts;
    counter = 0;
  }
  const b = new Uint8Array(16);
  // bytes 0..5 — 48-bit big-endian unix-ms timestamp
  b[0] = Math.floor(ts / 2 ** 40) & 0xff;
  b[1] = Math.floor(ts / 2 ** 32) & 0xff;
  b[2] = Math.floor(ts / 2 ** 24) & 0xff;
  b[3] = Math.floor(ts / 2 ** 16) & 0xff;
  b[4] = Math.floor(ts / 2 ** 8) & 0xff;
  b[5] = ts & 0xff;
  // bytes 6..7 — version (0b0111) in the high nibble + the 12-bit monotonic counter
  b[6] = 0x70 | ((counter >> 8) & 0x0f);
  b[7] = counter & 0xff;
  // bytes 8..15 — variant (0b10) + 62 bits of randomness
  const rand = new Uint8Array(8);
  if (stream === undefined) crypto.getRandomValues(rand);
  else for (let i = 0; i < 8; i++) rand[i] = (stream.rng() * 256) & 0xff;
  b[8] = 0x80 | (rand[0]! & 0x3f);
  b.set(rand.subarray(1), 9);

  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)
  }-${hex.slice(20)}`;
}
