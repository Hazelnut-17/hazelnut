import type { Actor } from "../authz/auth.ts";
import type { Db, Transactor } from "../data/db.ts";
import { rateLimitOverride } from "../runtime/outbox-relay.ts";

/**
 * The throttle affordance (13-authz.md §rate-limit, 12-mcp.md §throttle). A per-actor rate-limit
 * short-circuits with a `429` carried as a `ThrottleSignal` — a runtime-only type, not a 9th `err.kind`
 * (rate-limiting is infra, never domain). `remaining` is echoed on every response as a pre-emptive lever.
 * Two stores ship: the in-memory dev/single-instance default, and `pgRateLimitStore` for multi-instance.
 */
export interface ThrottleSignal {
  readonly retryAfter: number; // delta-seconds (RFC 9110), never an epoch; clamped to a ≥1s floor
  readonly limit: number; // window budget
  readonly remaining: number; // tokens left now — echoed on every response (the pre-emptive lever)
  readonly reset: number; // delta-seconds until refill
  readonly scope: "actor"; // budget key class — per-credential
}

/** The store's atomic return (`checkAndIncrement`). `retryAfter`/`scope` are *derived* into the signal,
 *  so the store only computes the four observable quantities inside its one atomic unit. */
export interface RateLimitVerdict {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly reset: number; // delta-seconds until the window refills
  readonly limit: number;
}

/**
 * The rate-limit store seam — `checkAndIncrement` must be one atomic unit (no TOCTOU between the read
 * and the increment), which is why it is a store method, not check-then-write in the pipeline.
 */
export interface RateLimitStore {
  checkAndIncrement(actor: Actor, cost: number): Promise<RateLimitVerdict>;
}

/** Derive the caller-facing signal from a store verdict. `retryAfter` clamps to a ≥1s floor (a 0 would
 *  invite an instant-retry hot loop); `reset` rounds up to whole delta-seconds. */
export function toThrottleSignal(v: RateLimitVerdict): ThrottleSignal {
  const reset = Math.max(0, Math.ceil(v.reset));
  return {
    retryAfter: Math.max(1, reset),
    limit: v.limit,
    remaining: Math.max(0, v.remaining),
    reset,
    scope: "actor",
  };
}

/** The always-on `RateLimit-*` quartet (draft RFC) — emitted on every response so a client can steer
 *  before it trips, not only after a 429. No `Retry-After` here (that is the 429-only signal). */
export function rateLimitHeaders(s: ThrottleSignal): Record<string, string> {
  return {
    "RateLimit-Limit": String(s.limit),
    "RateLimit-Remaining": String(s.remaining),
    "RateLimit-Reset": String(s.reset),
  };
}

/** The 429 short-circuit headers — the always-on quartet plus `Retry-After` (RFC 9110 delta-seconds). */
export function throttleHeaders(s: ThrottleSignal): Record<string, string> {
  return { ...rateLimitHeaders(s), "Retry-After": String(s.retryAfter) };
}

/** The MCP/agent channel encoding — an error-as-next-action (the steer convention, `12-mcp.md §8`), not
 *  an err.kind. The agent reads a precise backoff from the quartet; `steer` is the human-of-the-loop line. */
export function throttleNextAction(s: ThrottleSignal): {
  readonly throttled: true;
  readonly retryAfter: number;
  readonly remaining: number;
  readonly reset: number;
  readonly limit: number;
  readonly steer: string;
} {
  return {
    throttled: true,
    retryAfter: s.retryAfter,
    remaining: s.remaining,
    reset: s.reset,
    limit: s.limit,
    steer:
      `rate limit reached — wait ${s.retryAfter}s and retry (${s.remaining}/${s.limit} remaining)`,
  };
}

/**
 * Derive the throttle provenance attrs from the signal, so the 429 short-circuit's record carries a
 * derived `attrs` bag rather than one hand-built at the serve call site. `throttled:true` marks a
 * rate-limit infra event distinct from a domain err (the err.kind union stays closed).
 */
export function throttleProvenanceAttrs(s: ThrottleSignal): {
  readonly throttled: true;
  readonly retryAfter: number;
  readonly remaining: number;
  readonly limit: number;
  readonly reset: number;
} {
  return {
    throttled: true,
    retryAfter: s.retryAfter,
    remaining: s.remaining,
    limit: s.limit,
    reset: s.reset,
  };
}

/**
 * A deterministic in-memory fixed-window store — the zero-infra dev/single-instance default and test
 * reference. Exact for a single instance; the multi-instance shared store is `pgRateLimitStore` below.
 * `now` is injectable so the window edge is testable without wall-clock flake. Keyed on `actor.id`.
 */
export function memoryRateLimitStore(
  opts: {
    limit: number | ((a: Actor) => number);
    windowSec: number | ((a: Actor) => number);
    now?: () => number;
  },
): RateLimitStore {
  const clock = opts.now ?? (() => Date.now() / 1000);
  const buckets = new Map<string, { count: number; windowStart: number }>();
  return {
    checkAndIncrement: (actor, cost) => {
      const t = clock();
      const key = actor.id;
      const limit = typeof opts.limit === "function"
        ? opts.limit(actor)
        : opts.limit;
      const windowSec = typeof opts.windowSec === "function"
        ? opts.windowSec(actor)
        : opts.windowSec;
      let b = buckets.get(key);
      if (!b || t - b.windowStart >= windowSec) {
        b = { count: 0, windowStart: t }; // a fresh window (first hit, or the prior window elapsed)
        buckets.set(key, b);
      }
      const reset = windowSec - (t - b.windowStart);
      if (b.count + cost > limit) {
        return Promise.resolve({
          allowed: false,
          remaining: Math.max(0, limit - b.count),
          reset,
          limit,
        });
      }
      b.count += cost; // the increment is part of the same synchronous unit as the check — no TOCTOU
      return Promise.resolve({
        allowed: true,
        remaining: limit - b.count,
        reset,
        limit,
      });
    },
  };
}

/** The DDL for the shared counter table `pgRateLimitStore` reads/writes — one row per budget key, `key` PK
 *  so the atomic upsert's row lock serializes every instance against the same row. */
export const RATE_LIMIT_DDL =
  // `window_sec` records this row's own window width, so a TTL sweep only deletes past that row's own
  // close — never a fixed horizon, which would live-sweep a >24h (weekly/monthly) quota.
  `CREATE TABLE IF NOT EXISTS "_rate_limit" (key text PRIMARY KEY, count int NOT NULL, window_start double precision NOT NULL, window_sec double precision NOT NULL DEFAULT 0)`;

/**
 * The shared multi-instance store (canon `real-pg` adapter, 13-authz.md §rate-limit): one Postgres row per
 * budget key, check+increment as one atomic unit under `FOR UPDATE` so the verdict reads the lock-current
 * count, never a pre-lock MVCC snapshot that would let two concurrent callers both see "under limit".
 * The only store an operator can cap without a deploy — it reads `_ops_control` in the same transaction.
 */
export function pgRateLimitStore(
  // `limit`/`windowSec` may be per-actor functions, so one store applies a type-aware floor (agent-strict /
  // human-lax) keyed on the resolved actor.
  opts: {
    db: Db & Transactor;
    limit: number | ((a: Actor) => number);
    windowSec: number | ((a: Actor) => number);
    now?: () => number;
    // Let an operator cap RAISE the declared budget. Off by default: an `_ops_control` cap can only TIGHTEN,
    // so an operator (or anyone who reaches that table) can never hand out more traffic than the app declared.
    allowWiden?: boolean;
  },
): RateLimitStore {
  const clock = opts.now ?? (() => Date.now() / 1000);
  return {
    checkAndIncrement: (actor, cost) =>
      opts.db.transaction(async (tx) => {
        const t = clock();
        const key = actor.id;
        const declared = typeof opts.limit === "function"
          ? opts.limit(actor)
          : opts.limit;
        const windowSec = typeof opts.windowSec === "function"
          ? opts.windowSec(actor)
          : opts.windowSec;
        // seed idempotently so the row is real before it's locked (a phantom row can't be `FOR UPDATE`-locked).
        await tx.query(
          `INSERT INTO "_rate_limit" (key, count, window_start) VALUES ($1, 0, $2) ON CONFLICT (key) DO NOTHING`,
          [key, t],
        );
        // lock-current read — a peer blocks here and re-reads our committed count when it proceeds.
        const cur = (await tx.query<{ count: number; window_start: number }>(
          `SELECT count, window_start FROM "_rate_limit" WHERE key = $1 FOR UPDATE`,
          [key],
        )).rows[0]!;
        // The operator cap (05-runtime.md §ops-levers), read AFTER the lock rather than before it: under READ
        // COMMITTED a request that queued on the lock re-reads here on a fresh snapshot, so a cap that landed
        // while it waited binds THAT request. Read before the lock it would have queued on a stale answer.
        // A malformed/absent row yields null → the declared budget stands, so a cap that fails to parse loses
        // its power rather than removing the limit.
        const override = await rateLimitOverride(tx, key);
        const limit = override === null
          ? declared
          : opts.allowWiden
          ? override
          : Math.min(declared, override);
        const elapsed = t - Number(cur.window_start) >= windowSec;
        const oldCount = elapsed ? 0 : Number(cur.count);
        const windowStart = elapsed ? t : Number(cur.window_start);
        const allowed = oldCount + cost <= limit;
        const count = allowed ? oldCount + cost : oldCount;
        await tx.query(
          `UPDATE "_rate_limit" SET count = $2, window_start = $3, window_sec = $4 WHERE key = $1`,
          [key, count, windowStart, windowSec],
        );
        const reset = windowSec - (t - windowStart);
        return { allowed, remaining: Math.max(0, limit - count), reset, limit };
      }),
  };
}

/** The recommended rate-limit floor (13-authz §9), per minute: `agent` gets a strict cap (machine-speed
 *  threat actor); human/session gets a lax cap; anon shares the human ceiling on one bucket by default,
 *  with the opt-in `clientIp` serve seam sub-keying it per trusted IP. A safety floor, not policy — an app
 *  overrides via `credential.rateLimit` / its own store. */
export const RATE_LIMIT_FLOOR = {
  agentPerMin: 120,
  humanPerMin: 600,
  windowSec: 60,
} as const;

/** The born-on PG rate-limit floor: `createApp` defaults `rateLimitStore` to this when a Transactor db is
 *  wired, so an app is throttled out of the box, multi-instance-correct by construction. */
export function defaultRateLimitStore(
  db: Db & Transactor,
  now?: () => number,
): RateLimitStore {
  return pgRateLimitStore({
    db,
    limit: (a) =>
      a.type === "agent"
        ? RATE_LIMIT_FLOOR.agentPerMin
        : RATE_LIMIT_FLOOR.humanPerMin,
    windowSec: RATE_LIMIT_FLOOR.windowSec,
    now,
  });
}

/** The in-memory sibling of `defaultRateLimitStore`, for a served app whose db is not a Transactor. Same
 *  type-aware floor, enforced per-instance — N replicas admit up to N× the budget, a documented tradeoff
 *  against no throttle at all. It reads no shared row, so an operator cap cannot reach it: capping a key on
 *  this store needs a deploy. That is the same opt-down the N×-budget line already buys. */
export function defaultMemoryRateLimitStore(
  now?: () => number,
): RateLimitStore {
  return memoryRateLimitStore({
    limit: (a) =>
      a.type === "agent"
        ? RATE_LIMIT_FLOOR.agentPerMin
        : RATE_LIMIT_FLOOR.humanPerMin,
    windowSec: RATE_LIMIT_FLOOR.windowSec,
    now,
  });
}
