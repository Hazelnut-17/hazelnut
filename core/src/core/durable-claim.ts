import type { Db } from "../data/db.ts";

/**
 * The shared durable-claim primitive (lease + heartbeat + catch-release): claim a unit of work, run it
 * at most once, and distinguish a crashed prior runner from one still alive but slow. `_idempotency`
 * and `workflow` both compose this; never hand-roll a separate fence.
 */
export interface DurableClaimSpec {
  /** the claim table, e.g. `_idempotency` / `_workflow_journal`. */
  readonly table: string;
  /** the PK columns, e.g. `["key"]` / `["workflow_id", "step_id"]`. Values are bound $1..$n in order. */
  readonly keyCols: readonly string[];
  /** the in-flight predicate — a row still claimable/releasable (not yet finalized): `result IS NULL` /
   *  `status <> 'done'`. Used in the reclaim where clause, the heartbeat guard, and the catch-release guard. */
  readonly inflight: string;
  /** the done predicate — a finalized row whose stored `result` may be replayed: `result IS NOT NULL` /
   *  `status = 'done'`. */
  readonly done: string;
}

/** A claim attempt's verdict: `own` (run + finalize), `replay` (a finalized row exists — return its
 *  stored value, never re-run), or `conflict` (a live peer holds a fresh-lease claim — back off). */
/** The GENERATION of a claim — the `created_at` the acquire that won it stamped, rendered as text.
 *
 *  Rendered, not bound as a timestamptz: postgres.js re-serializes a bound timestamptz through a JS Date and
 *  truncates microseconds, so the predicate would silently never match and every release would no-op.
 *
 *  `created_at`, not `locked_at`: the heartbeat's write set is `locked_at` alone, so a beat — or stopping
 *  one — can never move the value the release identifies itself by. Fencing on `locked_at` is what made an
 *  earlier attempt wedge the workflow resume path permanently. */
export type ClaimFence = string;

export type ClaimVerdict<T> =
  | { readonly kind: "own"; readonly fence: ClaimFence }
  | { readonly kind: "replay"; readonly value: T | null }
  | { readonly kind: "conflict" };

const q = (table: string, col: string) => `"${table}".${col}`;
const eqKeys = (spec: DurableClaimSpec) =>
  spec.keyCols.map((c, i) => `${c} = $${i + 1}`).join(" AND ");

/** The generation fence expression — see `ClaimFence`. TZ-independent so a server on any timezone renders
 *  the same text for the same instant. */
const FENCE_EXPR =
  `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')`;

/** Atomically claim or crash-reclaim the row (the `_idempotency` pre-claim shape): a row back means we
 *  own it (fresh insert or a stale, lease-expired takeover); no row means the existing row is done
 *  (replay) or a live in-flight claim (conflict). Staleness is tested against the server clock `now()`.
 *
 *  A takeover re-stamps `created_at`, minting a NEW generation, and the winner's generation comes back on the
 *  verdict. Threading that value to the heartbeat and the release is what stops a holder whose lease already
 *  lapsed from deleting the claim a peer has since taken — after which a third runner double-runs the work. */
export async function acquireClaim<T>(
  db: Db,
  spec: DurableClaimSpec,
  keyVals: readonly (string | number)[],
  leaseMs: number,
  readStored: (result: unknown) => T | null = (r) => (r ?? null) as T | null,
): Promise<ClaimVerdict<T>> {
  const cols = spec.keyCols.join(", ");
  const placeholders = spec.keyCols.map((_, i) => `$${i + 1}`).join(", ");
  const leaseParam = `$${spec.keyCols.length + 1}`;
  const claim = await db.query<{ inserted: boolean; fence: ClaimFence }>(
    `INSERT INTO "${spec.table}" (${cols}, locked_at) VALUES (${placeholders}, now())
       ON CONFLICT (${cols}) DO UPDATE SET locked_at = now(), created_at = clock_timestamp()
       WHERE ${q(spec.table, spec.inflight)} AND ${
      q(spec.table, "locked_at")
    } < now() - (${leaseParam} || ' milliseconds')::interval
     RETURNING (xmax = 0) AS inserted, ${FENCE_EXPR} AS fence`,
    [...keyVals, leaseMs],
  );
  if (claim.rows.length > 0) {
    return { kind: "own", fence: claim.rows[0]!.fence };
  }
  // not ours — branch on the done predicate at the SQL level so a stored JSON-null result (an op that
  // returned null/undefined) is not mistaken for the in-flight sentinel.
  const prior = await db.query<{ result: unknown; done: boolean }>(
    `SELECT result, (${spec.done}) AS done FROM "${spec.table}" WHERE ${
      eqKeys(spec)
    }`,
    [...keyVals],
  );
  const row = prior.rows[0];
  if (row?.done) return { kind: "replay", value: readStored(row.result) };
  return { kind: "conflict" };
}

/** Start the in-flight claim heartbeat: re-stamp `locked_at` every `leaseMs / 3` on the base connection
 *  so a slow-but-alive claim never goes stale-reclaimable mid-run. Guarded on the in-flight predicate AND
 *  on our own generation `fence` — once finalized, released, or taken over the beat is a no-op, so a
 *  lapsed holder cannot keep a peer's fresh claim alive. Best-effort — a missed beat degrades to the
 *  bare-lease residual, never fails the work. Caller MUST run the returned stop fn in `finally`. */
export function startClaimHeartbeat(
  db: Db,
  spec: DurableClaimSpec,
  keyVals: readonly (string | number)[],
  leaseMs: number,
  fence: ClaimFence,
): () => void {
  const fenceParam = `$${spec.keyCols.length + 1}`;
  const timer = setInterval(() => {
    db.query(
      `UPDATE "${spec.table}" SET locked_at = now() WHERE ${
        eqKeys(spec)
      } AND ${spec.inflight} AND ${FENCE_EXPR} = ${fenceParam}`,
      [...keyVals, fence],
    )
      .catch(
        () => {
          /* best-effort — a missed beat is the bare-lease residual, never a failure */
        },
      );
  }, Math.max(1, Math.floor(leaseMs / 3)));
  return () => clearInterval(timer);
}

/** Release our still-in-flight claim (the catch-release): a clean throw drops the unfinished row so an
 *  immediate retry re-owns it without waiting out the lease. Guarded on the in-flight predicate AND on our
 *  own generation `fence`, so a holder whose lease lapsed mid-work cannot delete the claim a peer has since
 *  taken over — which would leave that peer running with no row and admit a third runner. A hard crash
 *  skips this — the stale row is reclaimed by the lease instead. */
export function releaseClaim(
  db: Db,
  spec: DurableClaimSpec,
  keyVals: readonly (string | number)[],
  fence: ClaimFence,
): Promise<unknown> {
  const fenceParam = `$${spec.keyCols.length + 1}`;
  return db.query(
    `DELETE FROM "${spec.table}" WHERE ${
      eqKeys(spec)
    } AND ${spec.inflight} AND ${FENCE_EXPR} = ${fenceParam}`,
    [...keyVals, fence],
  );
}

/** The terminal-write guard — ` AND <inflight> AND <fence> = $N`: the UPDATE/DELETE that FINALIZES a
 *  claim's outcome carries the same generation guard releaseClaim/heartbeat do, so a lease-lost zombie
 *  committing late changes zero rows instead of overwriting the peer that owns the generation. Append to
 *  the key-equality WHERE; `N` is the placeholder index the caller binds the fence at. */
export function fenceGuard(
  spec: DurableClaimSpec,
  fenceParamIdx: number,
): string {
  return ` AND ${spec.inflight} AND ${FENCE_EXPR} = $${fenceParamIdx}`;
}
