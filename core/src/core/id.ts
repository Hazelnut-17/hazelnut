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

/** The id-stream state one `seedIds` displaced. Frames are compared by IDENTITY, so no token is needed. */
interface SeedFrame {
  readonly before: {
    stream: typeof stream;
    lastMs: number;
    counter: number;
  };
}

/** The live seed stack, outermost first. The process stream belongs to whichever frame is on top. */
const seedStack: SeedFrame[] = [];
/** What the process had before ANY seeding — captured when the stack goes empty→non-empty, and the only
 *  correct target when it returns to empty. The innermost frame's own `before` is NOT that state: under an
 *  out-of-order unwind it is the stream of an outer seed that has already finished. */
let seedBase: SeedFrame["before"] | undefined;

/**
 * Install a reproducible id stream: the same seed mints the same ids in the same order, so an op that
 * creates a row can be asserted by equality instead of by shape. They are still real UUIDv7s — only the ms
 * prefix and the entropy are made deterministic, and the prefix still advances so ids stay strictly ordered.
 * Returns the restore that puts the previous stream back; nest with try/finally.
 *
 * The stream is PROCESS-WIDE, so two overlapping harnesses share it, and a snapshot-and-assign restore was
 * wrong in BOTH unwind orders: restoring the outer one first re-installed a stream the inner was still
 * drawing from, and restoring the inner first put the outer's stream back but left it installed after the
 * outer finished. A stack answers both — a restore only reassigns when its frame is the TOP (the one that
 * actually owns the stream), and the stream returns to what it was before any seeding once the stack
 * empties. Restoring twice is a no-op rather than a second, wrong assignment.
 */
export function seedIds(seed: number): () => void {
  const frame: SeedFrame = { before: { stream, lastMs, counter } };
  if (seedStack.length === 0) seedBase = frame.before;
  seedStack.push(frame);
  stream = { rng: mulberry32(seed | 0), draws: 0 };
  lastMs = 0;
  counter = 0;
  return () => {
    const at = seedStack.indexOf(frame);
    if (at === -1) return; // already restored — idempotent, never a second assignment
    const wasTop = at === seedStack.length - 1;
    seedStack.splice(at, 1);
    if (seedStack.length === 0) {
      // every seed is unwound: the process returns to what it had before ANY of them, whatever order the
      // restores ran in. Using this frame's own `before` here lands on an outer seed's stream instead.
      const base = seedBase ?? frame.before;
      seedBase = undefined;
      stream = base.stream;
      lastMs = base.lastMs;
      counter = base.counter;
      return;
    }
    // an inner frame is still live and owns the stream — only the top's restore may reassign
    if (!wasTop) return;
    stream = frame.before.stream;
    lastMs = frame.before.lastMs;
    counter = frame.before.counter;
  };
}

/** Reused across calls: neither buffer ESCAPES — both are consumed into the hex string before this
 *  function returns, and it is not re-entrant (the seeded rng is pure arithmetic, `getRandomValues` is
 *  synchronous). Two fresh 16- and 8-byte arrays per id is churn on the hottest allocation path the
 *  framework has: every row mints one. */
const SCRATCH_ID = new Uint8Array(16);
const SCRATCH_RAND = new Uint8Array(8);

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
  const b = SCRATCH_ID;
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
  const rand = SCRATCH_RAND;
  if (stream === undefined) crypto.getRandomValues(rand);
  else for (let i = 0; i < 8; i++) rand[i] = (stream.rng() * 256) & 0xff;
  b[8] = 0x80 | (rand[0]! & 0x3f);
  b.set(rand.subarray(1), 9);

  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)
  }-${hex.slice(20)}`;
}
