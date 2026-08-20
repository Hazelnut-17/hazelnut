import type { Db } from "../data/db.ts";
import { tableOf } from "../core/app-define.ts";
import type { ResourceModel } from "../core/app.ts";
import { tamperEvidentOn } from "../data/schema.ts";
import type { Violation } from "../core/structural-violation.ts"; // type-only — no runtime cycle (verify.ts pulls no tamper runtime)

/**
 * Cryptographic tamper-evidence — the hash-chain floor (opt-in `immutable:{ tamperEvident:true }`). Each
 * appended row carries `row_hash = H(canonical_row_bytes || prev_hash)`; a raw-SQL rewrite behind the repo's
 * immutability policy breaks the link and `verifyHashChain` pinpoints it. Standalone (on-demand/CI), never
 * a registered static invariant.
 */

const te = new TextEncoder();

function timingSafeEqual(a: string, b: string): boolean {
  const ea = te.encode(a);
  const eb = te.encode(b);
  const n = Math.max(ea.length, eb.length);
  let d = ea.length ^ eb.length;
  for (let i = 0; i < n; i++) d |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return d === 0;
}

/** SHA-256 hex of a byte buffer — the chain's hash primitive (mirrors embed.ts `sourceHash`'s SHA-256 hex). */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The two chain columns, excluded from the canonical row serialization (the hash must not hash itself);
 * `prev_hash` is concatenated separately as the chain link, never folded into the canonical bytes.
 */
const CHAIN_COLS: ReadonlySet<string> = new Set([
  "prev_hash",
  "row_hash",
  "chain_seq",
]);

/**
 * Canonicalize one stored column value to a stable byte-string fragment. Hashing the read-back row (both at
 * write and verify time) avoids JS-value/DB-value coercion drift. NULL is a reserved sentinel distinct from
 * the string "null".
 */
function canonField(value: unknown): string {
  if (value === null || value === undefined) return "\x00NULL\x00";
  if (value instanceof Uint8Array) {
    return "b:" +
      [...value].map((x) => x.toString(16).padStart(2, "0")).join("");
  }
  if (value instanceof Date) return "d:" + value.toISOString();
  return "j:" + JSON.stringify(value);
}

/**
 * The canonical row bytes — the row's data columns (excluding the two chain columns) sorted by name, each
 * rendered `name=canonField(value)`, joined by a NUL separator so column order and field boundaries can't
 * collide.
 */
function canonicalRowBytes(
  row: Record<string, unknown>,
  volatile: ReadonlySet<string>,
): Uint8Array {
  // also exclude framework-maintained columns rewritten without re-stamping (rollup, encrypted envelope,
 // embedding cols) — false-flag risk otherwise. Cost: an encrypted cell sits outside the chain (deferred, ).
  const cols = Object.keys(row).filter((c) =>
    !CHAIN_COLS.has(c) && !volatile.has(c)
  ).sort();
  const s = cols.map((c) => `${c}=${canonField(row[c])}`).join("\x00");
  return te.encode(s);
}

/**
 * Compute a row's `row_hash` = H(canonical_row_bytes || prev_hash). `prev_hash` is the genesis-or-prior link
 * (empty string on the genesis row). The `|| prev_hash` term is load-bearing: without it a mid-chain rewrite
 * is invisible; with it, rewriting row N changes the hash row N+1 depended on, so the break propagates.
 */
export async function computeRowHash(
  row: Record<string, unknown>,
  prevHash: string | null,
  volatile: ReadonlySet<string> = new Set(),
): Promise<string> {
  const bytes = canonicalRowBytes(row, volatile);
  const link = te.encode(prevHash ?? "");
  const combined = new Uint8Array(bytes.length + link.length);
  combined.set(bytes, 0);
  combined.set(link, bytes.length);
  return await sha256Hex(combined);
}

/**
 * Stamp the hash-chain link on a freshly-appended row — the repo `create` append hook. Runs after the insert
 * and inside the write tx, so the link commits/rolls back with the append. No-op unless the resource opted
 * into `tamperEvident`.
 */
export async function stampTamperRow(
  db: Db,
  model: ResourceModel,
  id: string,
): Promise<void> {
  if (!tamperEvidentOn(model.features)) return;
  const t = tableOf(model);
  // the per-table append serialization is `create()`'s pg_advisory_xact_lock, so chain_seq order == commit
  // order. Order by chain_seq, not id — a uuidv7 id is commit-ordered only within one process, so a cross-
  // process id-keyed predecessor could false-flag an honest row.
  const prevRes = await db.query<{ row_hash: string | null }>(
    `SELECT row_hash FROM ${t} WHERE chain_seq < (SELECT chain_seq FROM ${t} WHERE id = $1) ORDER BY chain_seq DESC LIMIT 1`,
    [id],
  );
  const prevHash = prevRes.rows[0]?.row_hash ?? null;
  const rowRes = await db.query<Record<string, unknown>>(
    `SELECT * FROM ${t} WHERE id = $1`,
    [id],
  );
  const row = rowRes.rows[0];
  if (!row) {
    throw new Error(
      `stampTamperRow: appended row '${id}' not found in '${model.name}'`,
    );
  }
  const rowHash = await computeRowHash(
    row,
    prevHash,
    new Set(model.tamperVolatileCols),
  ); // hash authored data only
  await db.query(
    `UPDATE ${t} SET prev_hash = $1, row_hash = $2 WHERE id = $3`,
    [prevHash, rowHash, id],
  );
}

/**
 * `verifyHashChain` — the on-demand / CI tamper detector. Walks the resource's rows in commit order,
 * recomputes each expected `row_hash`, and returns a `Violation` for the first row whose stored hash
 * mismatches (a `business` integrity fault, `clause` carries the offending row id). `[]` for an intact
 * chain or a non-tamper-evident resource.
 */
export async function verifyHashChain(
  db: Db,
  model: ResourceModel,
): Promise<Violation[]> {
  if (!tamperEvidentOn(model.features)) return [];
  const t = tableOf(model);
  const res = await db.query<Record<string, unknown>>(
    `SELECT * FROM ${t} ORDER BY chain_seq ASC`,
  ); // commit order, not uuidv7 id order (cross-process safe)
  const volatile = new Set(model.tamperVolatileCols); // same framework-maintained exclusion the stamp used
  let prevHash: string | null = null;
  for (const row of res.rows) {
    const expected = await computeRowHash(row, prevHash, volatile);
    const stored = (row.row_hash ?? null) as string | null;
    if (!timingSafeEqual(stored ?? "", expected)) {
      return [{
        id: "tamper/hash-chain",
        resource: model.name,
        clause: String(row.id),
        message:
          `row '${
            String(row.id)
          }' of '${model.name}' fails the hash-chain: stored row_hash does not match the ` +
          `recomputed H(canonical_row_bytes || prev_hash) — the row was rewritten behind the append-only ledger ` +
          `(business-integrity violation)`,
      }];
    }
    prevHash = stored; // advance by the row's own stored hash (matched above)
  }
  return [];
}

// ── AnchorSink Port (the external-witness seam) ──────────────────────────────────────────────────
// The chain catches a single-row rewrite; anchoring a periodic root hash to an external witness (BYO Port,
// mirrors setTracer's noop default) also catches a full-chain rewrite by a DBA who recomputes it downstream.

/** An anchoring receipt — opaque proof the root hash was witnessed. */
export interface AnchorReceipt {
  readonly sink: string; // which sink produced it ("local-file" / "noop")
  readonly rootHash: string;
  readonly at: string; // ISO instant the anchor was recorded
  readonly ref?: string; // sink-specific locator, opaque to the framework
}

/** The external-witness Port: anchor a chain root hash to an append-only witness, returning a receipt. A real
 *  adapter writes to a transparency log / chain; the floor sinks below are the zero-cost in-process defaults. */
export interface AnchorSink {
  anchor(rootHash: string): Promise<AnchorReceipt>;
}

/**
 * The zero-cost default sink (mirrors setTracer's noop): records nothing external, just stamps a receipt.
 * An app that wires no AnchorSink still gets single-rewrite detection from the chain alone.
 */
export const noopAnchorSink: AnchorSink = {
  anchor(rootHash: string): Promise<AnchorReceipt> {
    return Promise.resolve({
      sink: "noop",
      rootHash,
      at: new Date().toISOString(),
    });
  },
};

/**
 * A local-file floor sink — appends each `{rootHash, at}` to a newline-delimited file. Still inside the trust
 * domain (a DBA with disk access can rewrite it), so it is a floor, not the real external witness.
 */
export function fileAnchorSink(path: string): AnchorSink {
  return {
    async anchor(rootHash: string): Promise<AnchorReceipt> {
      const at = new Date().toISOString();
      await Deno.writeTextFile(path, JSON.stringify({ rootHash, at }) + "\n", {
        append: true,
      });
      return { sink: "local-file", rootHash, at, ref: path };
    },
  };
}

/**
 * The chain root = the head row's `row_hash` (by `chain_seq` commit order, not uuidv7 id order). Anchoring
 * this one value witnesses the whole chain transitively. `null` for an empty ledger.
 */
export async function chainRoot(
  db: Db,
  model: ResourceModel,
): Promise<string | null> {
  if (!tamperEvidentOn(model.features)) return null;
  const res = await db.query<{ row_hash: string | null }>(
    `SELECT row_hash FROM ${tableOf(model)} ORDER BY chain_seq DESC LIMIT 1`,
  );
  return res.rows[0]?.row_hash ?? null;
}
