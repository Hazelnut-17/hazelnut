import type { z } from "zod";
import type { Db } from "../data/db.ts";
import type { StorageDriver } from "../data/storage.ts";
import type { FullCtx } from "../data/data-ctx.ts";
import type { DataOf } from "../core/faces-ctx.ts";
import type { OnlyKnownKeys } from "../core/config.ts";
import type {
  ConsumePlan,
  ConsumerInvocation,
  DeliveredMsg,
} from "./outbox.ts";
import { strictify } from "../data/schema.ts";
import { upcastDelivered, type UpcasterChain } from "../features/versioning.ts";

// Async declaration verbs over the outbox relay: defineSubscriber reacts to EVENT messages, defineWorker
// to QUEUE messages; relayPlan turns declared consumers into a ConsumePlan the relay drain fans through.

/** The op-handler FullCtx write/read/effect surface (05-runtime.md §4 / §5) plus the relay-added
 *  signal/baseDb; imported type-only so events.ts stays free of the app/repo graph at runtime. */
export type ConsumerCtx = FullCtx & {
  /** the drain's deadline AbortSignal (aborted at `handlerTimeoutMs`) — a handler threads it into external I/O. */
  readonly signal?: AbortSignal;
  /** the OUT-OF-BAND base connection for task progress / terminal-failure writes (05-runtime.md §task). */
  readonly baseDb?: Db;
  /** the off-box bytes seam (05-runtime.md §task): present when the boot bound a StorageDriver (the
   *  same driver `file()` rides); the task runner offloads over-threshold results through it. */
  readonly storage?: StorageDriver;
};

/** ConsumerCtx with typed `ctx.data` faces: pass resource decls as the `resources` value witness and
 *  every `ctx.data.<r>.*` call is checked against the derived faces; omitting resources is untyped. */
export type ConsumerCtxOf<M> = [M] extends [never]
  ? Omit<ConsumerCtx, "data"> & { readonly data: Record<never, never> }
  : [M] extends [undefined] ? ConsumerCtx
  : Omit<ConsumerCtx, "data"> & { readonly data: DataOf<M> };

/** Decl-erased consumer shapes (M = never ⇒ ctx.data is Record<never, never>) for heterogeneous
 *  registry positions; author-facing defineSubscriber/defineWorker keep their typed M default. */
export type AnySubscriber = Subscriber<never>;
export type AnyWorker = Worker<never>;

/** Builds the per-consumer ctx bound to the consumer's tx db, so a handler write joins the claim's tx;
 *  the relay provides this, absent one a consumer gets a minimal ctx. `signal` aborts at the drain deadline. */
export type ConsumerCtxFactory = (
  msg: DeliveredMsg,
  txDb: Db,
  signal?: AbortSignal,
) => ConsumerCtx;

/** A consumer's per-message scope-resolution mode (13-authz.md §7): "inherit" (default) rides the
 *  originating event's stamped scope; "cross" resolves scope→null (all scopes), the audited opt-in. */
export type ConsumerScopeMode = "inherit" | "cross";

/** Scope-mode + audited-acknowledgment as a discriminated pair: "cross" behavior requires the audited
 *  `crossScope: true` flag, making the mismatch unrepresentable at the type level. */
export type ConsumerScopeDecl =
  | { readonly scope?: "inherit"; readonly crossScope?: never }
  | { readonly scope: "cross"; readonly crossScope: true };

/** A DeliveredMsg with `payload` narrowed to the consumer's declared schema type `P`; method-param
 *  bivariance lets a typed consumer store in the erased AnySubscriber/AnyWorker collection. */
type TypedMsg<P> = Omit<DeliveredMsg, "payload"> & { readonly payload: P };

/** Declared event-topic union of one producer module decl (05-runtime.md §5.2): string members or
 *  typed-form keys; never for a decl with no emits. */
type TopicsOfOne<D> = D extends { readonly emits: infer E }
  ? E extends readonly string[] ? E[number]
  : E extends Readonly<Record<string, unknown>> ? keyof E & string
  : never
  : never;
/** Topic union a `from: [module, …]` witness admits — the same value-witness pattern as `resources`.
 *  No witness keeps today's `string`; runtime floor stays the static event/subscribe-declared check. */
type TopicsOf<Mods> = Mods extends undefined ? string
  : Mods extends readonly unknown[] ? TopicsOfOne<Mods[number]>
  : never;

interface SubscriberBase<M = undefined, P = unknown, EM = undefined> {
  /** The event topic this subscriber reacts to (05-runtime.md §async / 02-dsl.md §async) — matched
   *  against the drained message's `_outbox.topic`; a `from:` witness narrows it to the emits union. */
  readonly topic: TopicsOf<EM>;
  /** A stable unique name for the per-consumer `(consumer, msg_id)` fence (05-runtime.md §5.1). Two subscribers
   *  on one topic MUST differ here; absent, the relay hashes the handler so a redeploy does not double-deliver. */
  readonly name?: string;
  readonly schema?: z.ZodType<P>; // the declared event payload contract — `event/parse-at-consume` checks it, and types `event.payload` in the handler
  /** Per-subscriber retry budget (05-runtime.md §relay-mode). Overrides the relay's
   *  global `maxAttempts` for this subscriber's DLQ decision; absent ⇒ the global default. */
  readonly maxAttempts?: number;
  handler(event: TypedMsg<P>, ctx: ConsumerCtxOf<M>): Promise<void>;
}
/** Scope mode + audited flag ride the discriminated ConsumerScopeDecl (13-authz.md §7): absent ⇒
 *  "inherit" (safe default); "cross" (scope→null) requires the audited `crossScope: true` flag. */
export type Subscriber<M = undefined, P = unknown, EM = undefined> =
  & SubscriberBase<M, P, EM>
  & ConsumerScopeDecl;

/** `defineSubscriber({ resources: [doc], schema, handler })` infers both the typed `ctx.data` face
 *  (from `resources`) and the typed `event.payload` (from `schema`) from values, since TS cannot
 *  partially infer type args across two independent generics. Omit either for the untyped default. */
export function defineSubscriber<
  const M = undefined,
  P = unknown,
  const EM = undefined,
  D = unknown,
>(
  decl:
    & Subscriber<M, P, EM>
    & { readonly resources?: M; readonly from?: EM }
    & OnlyKnownKeys<
      D,
      Subscriber<M, P, EM> & { readonly resources?: M; readonly from?: EM }
    >,
): Subscriber<M, P, EM> {
  return decl;
}

interface WorkerBase<M = undefined, P = unknown> {
  readonly topic: string;
  readonly name?: string; // per-consumer fence key; defaults to `worker:<topic>` (a worker's topic is its name)
  readonly schema?: z.ZodType<P>; // the declared job-payload contract — checked at consume and types the handler's payload
  /** Per-worker retry budget (05-runtime.md §relay-mode); overrides the relay global `maxAttempts` for this worker. */
  readonly maxAttempts?: number;
  handler(payload: TypedMsg<P>, ctx: ConsumerCtxOf<M>): Promise<void>;
}
/** Scope mode + audited flag ride the same discriminated ConsumerScopeDecl as Subscriber. */
export type Worker<M = undefined, P = unknown> =
  & WorkerBase<M, P>
  & ConsumerScopeDecl;

/** `defineWorker({ resources: [doc], schema, handler })` — like defineSubscriber, both `M` and `P`
 *  infer from values so they compose; the witness is parameter-only so the stored Worker is unchanged. */
export function defineWorker<const M = undefined, P = unknown, D = unknown>(
  decl:
    & Worker<M, P>
    & { readonly resources?: M }
    & OnlyKnownKeys<D, Worker<M, P> & { readonly resources?: M }>,
): Worker<M, P> {
  return decl;
}

/** The stable per-consumer fence key (the `_processed.consumer` value). An unnamed consumer hashes
 *  its handler so a redeploy that inserts another unnamed subscriber does not steal the fence. */
function consumerKey(
  kind: "sub" | "worker",
  c: AnySubscriber | AnyWorker,
  _index: number,
): string {
  if (c.name) return c.name;
  const src = Function.prototype.toString.call(c.handler);
  let h = 2166136261;
  for (let i = 0; i < src.length; i++) {
    h ^= src.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${kind}:${c.topic}:${(h >>> 0).toString(16)}`;
}

/** Builds a ConsumePlan from declared consumers (05-runtime.md §5.1): each drained message runs
 *  through, per matching consumer, an ordered versioned-upcast then `event/parse-at-consume` gate
 *  before the handler — a gate failure rolls back the claim and dead-letters `(consumer, msg_id)`. */
export function relayPlan(
  subscribers: readonly AnySubscriber[],
  workers: readonly AnyWorker[] = [],
  chains: Readonly<Record<string, UpcasterChain>> = {},
  ctxFactory?: ConsumerCtxFactory,
): ConsumePlan {
  return (rawMsg) => {
    const isQueue = rawMsg.kind === "queue";
    const targets: ReadonlyArray<
      { key: string; c: AnySubscriber | AnyWorker }
    > = isQueue
      ? workers.map((c, i) => ({ key: consumerKey("worker", c, i), c }))
      : subscribers.map((c, i) => ({ key: consumerKey("sub", c, i), c }));

    const invocations: ConsumerInvocation[] = [];
    for (const { key, c } of targets) {
      if (c.topic !== rawMsg.topic) continue;
      invocations.push({
        consumer: key,
        maxAttempts: c.maxAttempts, // per-consumer retry budget (05-runtime.md §relay-mode) — overrides the relay global
        run: async (msg, txDb, signal) => {
          // gate 1 — versioned upcast (before parse); a retention-guard reject throws validation → DLQ
          const upcast = upcastDelivered(msg, chains[msg.topic]);
          // gate 2 — parse-at-consume over the upcast payload
          const event = c.schema ? parseOrThrow(c.schema, upcast) : upcast;
          // `ctx.signal`: the drain's deadline signal, aborted when `handlerTimeoutMs` elapses, so the
          // handler can stop in-flight work instead of zombie-running.
          // app-less read-only floor (no ctxFactory): a minimal `{ msg, db, signal }` cast at this single
          // framework-internal construction site; a body reaching it touches only read/signal members.
          const ctx = ctxFactory
            ? ctxFactory(event, txDb, signal)
            : ({ msg: event, db: txDb, signal } as unknown as ConsumerCtx);
          await c.handler(event, ctx);
        },
      });
    }
    return invocations;
  };
}

/** Strict-parse the (upcast) payload against the consumer's declared schema; a mismatch is a `validation`
 *  failure → the relay dead-letters it (deterministic, no retry). Returns the msg with the parsed payload. */
function parseOrThrow(schema: z.ZodType, msg: DeliveredMsg): DeliveredMsg {
  const parsed = strictify(schema).safeParse(msg.payload);
  if (!parsed.success) {
    throw Object.assign(
      new Error(`event payload failed schema for topic '${msg.topic}'`),
      { kind: "validation" },
    );
  }
  return { ...msg, payload: parsed.data };
}

/** Single-message fan handler — a `drainOutbox(db, { handler })` adapter over relayPlan giving each
 *  consumer a minimal `{ msg, db }` ctx (no tx-bound writes); write-through consumers need the
 *  per-consumer relayPlan path instead. The production drain always uses relayPlan. */
export function relayHandler(
  subscribers: readonly AnySubscriber[],
  workers: readonly AnyWorker[] = [],
  chains: Readonly<Record<string, UpcasterChain>> = {},
): (msg: DeliveredMsg, db?: Db) => Promise<void> {
  const plan = relayPlan(subscribers, workers, chains);
  return async (rawMsg, db) => {
    for (const inv of plan(rawMsg)) await inv.run(rawMsg, db as Db);
  };
}
