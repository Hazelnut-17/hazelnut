import type { Db, Transactor } from "../data/db.ts";
import type { App } from "../core/app.ts";
import type { Kms } from "../features/encrypt.ts";
import type { StorageDriver } from "../data/storage.ts";
import {
  type ConsumePlan,
  DEFAULT_HANDLER_TIMEOUT_MS,
  DEFAULT_STALL_BUDGET,
  type DeliveredMsg,
  type DrainResult,
  type DrainTuning,
  runRelay,
} from "./outbox.ts";
import {
  type AnySubscriber,
  type AnyWorker,
  type ConsumerCtxFactory,
  relayPlan,
} from "./events.ts";
import { makeCtx } from "../data/data.ts";
import type { Datasources } from "../data/datasources.ts";
import { systemActor } from "../authz/auth.ts";
import {
  buildUpcasterChain,
  type Upcaster,
  type UpcasterChain,
} from "../features/versioning.ts";

/**
 * The live relay supervisor (05-runtime.md §5) — the entrypoint a `hazelnut relay` process (or a
 * `Deno.cron` tick) calls. Builds the app's subscribers/workers + per-topic upcasters into a `ConsumePlan`
 * and drains the outbox with it: upcast → parse-at-consume → handler, with ordering/fence/DLQ intact.
 */

/** The composed async surface the live relay consumes: `subscribers` react to EVENT messages, `workers` to
 *  QUEUE messages, both by topic. `upcasters` maps each topic to its `defineUpcaster` links plus
 *  `currentVersion`; a topic absent from `upcasters` passes through untouched (v1-only). */
export interface RelayRegistry {
  readonly subscribers?: readonly AnySubscriber[];
  readonly workers?: readonly AnyWorker[];
  readonly upcasters?: Readonly<
    Record<
      string,
      { readonly links: readonly Upcaster[]; readonly currentVersion?: number }
    >
  >;
}

/** Build the per-topic `UpcasterChain` map the live relay threads into the consume plan (each message runs
 *  `upcastDelivered` against it). A non-contiguous chain (a missing vN→vN+1 link) throws at boot, not at
 *  consume — drop the chains and a stored vN payload reaches the vCurrent consumer un-upgraded and DLQs. */
export function buildChains(
  upcasters: Readonly<
    Record<
      string,
      { readonly links: readonly Upcaster[]; readonly currentVersion?: number }
    >
  > = {},
): Record<string, UpcasterChain> {
  const chains: Record<string, UpcasterChain> = {};
  for (const [topic, spec] of Object.entries(upcasters)) {
    chains[topic] = buildUpcasterChain(spec.links, spec.currentVersion);
  }
  return chains;
}

/** Build the per-consumer ctx factory (05-runtime.md §4/§5) from the composed `App`. The relay drain calls
 *  this with the per-consumer tx db, so a consumer's `ctx.data`/`ctx.transition`/`ctx.emit` join the SAME tx
 *  as the `_processed` claim (effectively-once). Runs as a least-privilege `system` actor, scope recovered
 *  from the message's emit-time `scope` stamp (absent/NULL = crossScope). Absent `App` → the read-only floor ctx. */
export function consumerCtxFactory(
  app: App,
  kms?: Kms,
  datasources?: Datasources,
  baseDb?: Db,
  storage?: StorageDriver,
): ConsumerCtxFactory {
  return (
    msg: DeliveredMsg,
    txDb: Db,
    signal?: AbortSignal,
    selfModule = "app",
  ) => {
    // system-ctx: no HTTP caller. Scope is the emit-time ctx.scope stamped onto the `_outbox` row;
    // omitted/NULL = crossScope ("").
    const base = {
      actor: systemActor(`relay:${msg.topic}`),
      scope: msg.scope ?? "",
    };
    // binds the ctx to the per-consumer tx db so a handler write commits with the claim. `selfModule` is
    // the owning module's face (`ctx.data` is that module only; cross-module is `ctx.modules`) — relayPlan
    // stamps it from the consumer's `module` slot, defaulting to the flat `"app"` module.
    // `ctx.signal` is the drain's deadline signal (aborted at `handlerTimeoutMs`) — a handler passes it to its
    // external I/O (`fetch(url, { signal })`) so the deadline cancels the work, not just the wait.
    // `ctx.baseDb` (05-runtime.md §task) is the relay's base db, not the per-consumer tx — a handler can
    // write a row visible before commit (task progress) or surviving rollback. Absent without a base db.
    // `ctx.storage` (05-runtime.md §task) is the off-box bytes seam, threaded like baseDb: present iff the
    // drive site bound a StorageDriver.
    return {
      ...makeCtx(app, txDb, base, kms, selfModule, datasources),
      signal,
      baseDb,
      storage,
    };
  };
}

/** Compose the live `ConsumePlan` from a registry: subscribers + workers fanned by topic, with per-topic
 *  upcaster chains threaded in (upcast runs before parse-at-consume) and, given `app`, a tx-bound consumer
 *  ctx so handlers are called `(event|payload, ctx)`. */
export function liveRelayPlan(
  registry: RelayRegistry,
  app?: App,
  kms?: Kms,
  datasources?: Datasources,
  baseDb?: Db,
  storage?: StorageDriver,
): ConsumePlan {
  const chains = buildChains(registry.upcasters);
  const ctxFactory = app
    ? consumerCtxFactory(app, kms, datasources, baseDb, storage)
    : undefined;
  return relayPlan(
    registry.subscribers ?? [],
    registry.workers ?? [],
    chains,
    ctxFactory,
  );
}

/**
 * Run the live relay over the app's composed async surface (05-runtime.md §5) — drains the outbox via the
 * ctx-aware per-consumer plan until empty (or `maxCycles`). Rejects (`err.kind:"internal"`) when DB-writing
 * consumers are registered but neither `db` nor `opts.transactor` is a `Transactor` — the claim+handler
 * would run non-atomically, duplicating writes on crash/retry. Defaults `stallBudget`/`handlerTimeoutMs`
 * (05-runtime.md §relay) when the caller omits them; `{ stallBudget: {} }` opts out of the breaker.
 */
// async so the boot-guard refusal surfaces as a REJECTED promise (the `Promise<DrainResult>` contract),
// reaching a caller's `await`/`.catch` uniformly rather than as a bare synchronous throw.
export function runLiveRelay(
  db: Db,
  registry: RelayRegistry,
  opts: DrainTuning = {},
  app?: App,
  kms?: Kms,
  datasources?: Datasources,
  storage?: StorageDriver,
): Promise<DrainResult> {
  // ctx.baseDb threads only when the db can query concurrently with an open tx (a real pool); a
  // single-connection db (PGlite) would deadlock on an out-of-band write during the worker tx, so it stays undefined.
  const plan = liveRelayPlan(
    registry,
    app,
    kms,
    datasources,
    db.concurrent ? db : undefined,
    storage,
  );
  const transactor = opts.transactor ??
    ((db as Partial<Transactor>).transaction !== undefined
      ? (db as Db & Transactor)
      : undefined);
  // DB-writing iff a write-capable consumer ctx is built (an `app` is threaded) AND a consumer is declared.
  const hasConsumers =
    (registry.subscribers?.length ?? 0) + (registry.workers?.length ?? 0) > 0;
  const canWriteDb = app !== undefined && hasConsumers;
  if (canWriteDb && transactor === undefined) {
    return Promise.reject(Object.assign(
      new Error(
        "relay: refusing to run DB-writing consumers without a Transactor db — the per-consumer claim+handler " +
          "would run non-atomically (at-least-once → duplicate writes on crash/retry). Construct the relay db via " +
          "postgresDb(sql) (db.ts) so `.transaction` runs the claim+handler in one Postgres tx (effectively-once).",
      ),
      { kind: "internal" as const },
    ));
  }
  // default the stall budget ON — the live relay must bound head-of-line freeze — unless the caller set one.
  const stallBudget = opts.stallBudget ?? DEFAULT_STALL_BUDGET;
  // default the handler deadline ON too — arms `ctx.signal` for every live consumer and bounds a hung handler
  // (fail → backoff → DLQ) instead of letting it hold its partition until the stall breaker fires.
  const handlerTimeoutMs = opts.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
  return runRelay(db, {
    ...opts,
    plan,
    transactor,
    stallBudget,
    handlerTimeoutMs,
  });
}
