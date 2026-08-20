/**
 * `hazelnut/test` — the app-facing test harness (05-runtime.md §testCtx). `testCtx(...)` picks a mode by
 * options shape: **in-memory-real** (`{ app, … }`) runs real repo methods/feature hooks over an in-memory
 * PGlite store — business-faithful, not DB-semantics-faithful (that fidelity is `deno task test:pg`);
 * `ctx.query` loud-fails by design. **shallow** (`{ data, modules, … }`, no `app`) is a pure ctx face over
 * author-provided stubs. Exposes `t.arb.<r>(opts?)`/`t.build.<r>(overrides?, o?)` fixture derivers per
 * resource, plus the unbound `arb(model)`/`build(model, …)`.
 */
import type { Actor } from "./authz/auth.ts";
import type { App } from "./core/app.ts";
import type { Clock } from "./core/ctx-provenance.ts";
import type { DataOf, FixturesOf } from "./core/faces-ctx.ts";
import { arb, type ArbOptions, build } from "./core/fixtures.ts";
import type { InsertableFixture } from "./core/faces.ts";
import { type Db, pgliteDb, type Transactor } from "./data/db.ts";
import type { Datasources } from "./data/datasources.ts";
import { type FullCtx, makeCtx, opSurfaceFactory } from "./data/data-ctx.ts";
import { applySchema } from "./data/migrate.ts";
import {
  composeOpHandler,
  dispatchOp,
  type OpDecl,
  type Result,
  runOp as runOpPipeline,
} from "./core/pipeline.ts";
import type { Kms } from "./features/encrypt.ts";
import { seedIds } from "./core/id.ts";

export { arb, type ArbOptions, build };

/** Run `fn` under a seeded id stream, restoring the previous one whether it settles, rejects, or throws
 *  before it ever returns a promise. An unrestored seed would replay into every later id in the process. */
function withIdSeed<T>(
  seed: number | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (seed === undefined) return fn();
  const restore = seedIds(seed);
  try {
    return fn().finally(restore);
  } catch (e) {
    restore();
    throw e;
  }
}

// The deterministic in-memory Port doubles. They live HERE, not on the production barrel: an app wiring a
// real deployment reaches for `localDriver`/`openaiEmbed` (still exported from `hazelnut`), and shipping
// test doubles on the production facade advertises them as deployment options. Their only consumers are
// tests — including the reference app's, which previously had to deep-import past the barrel to get one.
export { stubStorage } from "./data/storage.ts";
export { stubEmbed } from "./features/embed.ts";

/** The canon loud-fail (05-runtime.md §testCtx) — pinned verbatim; a silent no-op `[]` is a vacuous pass. */
const IN_MEMORY_QUERY_REFUSAL =
  "testCtx[in-memory-real]: ctx.query (raw SQL) is not runnable in memory — use a shallow mock or deno task test:pg.";

/** One fixture-deriver face per declared resource, bound over the composed model. */
export type FixtureFaces = {
  readonly arb: Readonly<
    Record<
      string,
      (opts?: ArbOptions) => InsertableFixture<Record<string, unknown>>
    >
  >;
  readonly build: Readonly<
    Record<
      string,
      (
        overrides?: Partial<InsertableFixture<Record<string, unknown>>>,
        opts?: ArbOptions,
      ) => InsertableFixture<Record<string, unknown>>
    >
  >;
};

export interface RealTestCtxOptions {
  /** The composed app (`createApp(...)`) — its model boots into a fresh in-memory PGlite store. */
  readonly app: App;
  /** The module whose ctx face to build (`ctx.modules` = its declared deps). Omit for a flat app. */
  readonly module?: string;
  readonly actor?: Actor | null;
  readonly scope?: string;
  /** Freeze (or drive) time: the clock `ctx.now()` reads on BOTH doors this harness opens — `t.ctx` and the
   *  op-pipeline `t.runOp` builds. `now: () => new Date("2026-01-01T00:00:00Z")` makes every `ctx.now()`-derived
   *  value reproducible, so a time assertion is an equality instead of a tolerance. Absent ⇒ the wall clock.
   *  It moves NEITHER of the other two non-reproducible things: `created_at`/`updated_at` are stamped by the
   *  DATABASE (`DEFAULT now()`), and the row `id` is minted per row — `idSeed` is the door for that one. */
  readonly now?: Clock;
  /** Freeze the id stream: every id the framework MINTS (rows, audit, outbox, workflow, schedule) replays
   *  from this seed, so two runs of one op agree on the ids too. Trace/span ids are not row ids and stay
   *  random. Held for this harness's LIFETIME and restored by `t.dispose()`; the stream is process-wide, so
   *  one seeded harness at a time. Absent ⇒ real ids. */
  readonly idSeed?: number;
  /** The KMS for `encrypted` resources (the framework threads kms explicitly — pass your test KMS here). */
  readonly kms?: Kms;
  /** An open real-Postgres connection wrapped as `Db & Transactor` — the db-semantics path (isolation/MVCC,
   *  `unique` rejection, gap-free numbering, 3-valued NULL/index) that `t.runOp` cannot see over the default
   *  in-memory PGlite. When provided, `ctx.query` stays the live raw-SQL door; when absent, a fresh in-memory
   *  PGlite. The caller owns the connection: drop stale-shape tables before calling `testCtx`, and close it
   *  yourself — `t.dispose()` never closes an injected connection. */
  readonly db?: Db & Transactor;
  /** Named external datasources (`ctx.datasource(name)` — 05-runtime.md §datasources) — the same live registry
   *  serve/mcp thread onto the op surface, so a datasource-backed op is driven through the paved seam
   *  faithfully. Absent ⇒ `ctx.datasource` throws loud, exactly as production. */
  readonly datasources?: Datasources;
}

export interface RealTestCtx extends FixtureFaces {
  /** The full real ctx face (data/config/i18n/transition/emit/queue/schedule/modules) over the in-memory store. */
  readonly ctx: FullCtx;
  /** The backing store, for direct seeding / asserting around the repo surface. */
  readonly db: Db & Transactor;
  /** Run one op through the full op-pipeline (validate → policy → tx → handler → collect → Result) over the
   *  in-memory store, with this module's op-surface composed for you. `opts.actor`/`opts.scope` override this
   *  harness's base; `idempotencyKey` exercises the dedup path. `opts.subject` is the op's ambient instance
   *  subject `{ resource, id }` — absent means no subject (the collection-op posture). `opts.now` overrides the
   *  harness clock for this call, so one test can advance time between two otherwise identical runs, and
   *  `opts.idSeed` does the same for the id stream (restored when the call settles). */
  runOp<I, O>(
    op: OpDecl<I, O>,
    input: I,
    opts?: {
      actor?: Actor | null;
      scope?: string;
      idempotencyKey?: string;
      subject?: { resource: string; id: string };
      now?: Clock;
      idSeed?: number;
    },
  ): Promise<Result<O>>;
  /** Close the in-memory store (idempotent). */
  dispose(): Promise<void>;
}

export interface ShallowTestCtxOptions {
  readonly actor?: Actor | null;
  readonly scope?: string;
  /** Your `ctx.data` stub — the shallow mode wires NOTHING for you. */
  readonly data?: unknown;
  /** Your `ctx.modules` stub. */
  readonly modules?: unknown;
  /** Your `ctx.query` stub; omitted → a loud throw (never a silent `[]`). */
  readonly query?: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: unknown[] }>;
  /** Extra ctx members to spread onto the face (emit/queue/transition/log stubs as your test needs). */
  readonly members?: Readonly<Record<string, unknown>>;
}

export interface ShallowTestCtx {
  /** The assembled shallow ctx face — cast it to your op's `Ctx<M>` at the test edge (you own the stubs). */
  readonly ctx: Record<string, unknown>;
}

function fixtureFaces(app: App): FixtureFaces {
  return {
    arb: Object.fromEntries(
      app.model.map((m) => [m.name, (opts?: ArbOptions) => arb(m, opts)]),
    ),
    build: Object.fromEntries(
      app.model.map((
        m,
      ) => [
        m.name,
        (
          overrides?: Partial<InsertableFixture<Record<string, unknown>>>,
          opts?: ArbOptions,
        ) => build(m, overrides, opts),
      ]),
    ),
  };
}

/** The typed real-mode harness face: supply the decls (`testCtx<[typeof doc, typeof ticket]>({ app })`, or
 *  `typeof myModule`) and `t.ctx.data.<r>` gains the same derived faces the op path's `Ctx<M>` has, while
 *  `t.arb.<r>`/`t.build.<r>` key on the declared resource names — a typo is a compile error, not a runtime
 *  crash. `createApp` erases decls, so the type param must be supplied explicitly; the no-type-param call
 *  keeps today's untyped faces unchanged. */
export interface TypedRealTestCtx<T>
  extends Omit<RealTestCtx, "ctx" | "arb" | "build"> {
  readonly ctx: Omit<FullCtx, "data"> & { readonly data: DataOf<T> };
  // The fixture faces derive per-resource, not just per-KEY: `t.build.<r>(...)` returns that resource's own
  // insertable, so it is assignable to `t.ctx.data.<r>.create` without a cast. Keying alone would type the
  // name and leave the value a loose Record — the two halves of one harness disagreeing about one resource.
  readonly arb: Readonly<
    { [K in keyof FixturesOf<T>]: (opts?: ArbOptions) => FixturesOf<T>[K] }
  >;
  readonly build: Readonly<
    {
      [K in keyof FixturesOf<T>]: (
        overrides?: Partial<FixturesOf<T>[K]>,
        opts?: ArbOptions,
      ) => FixturesOf<T>[K];
    }
  >;
}

export async function testCtx<T = undefined>(
  opts: RealTestCtxOptions,
): Promise<[T] extends [undefined] ? RealTestCtx : TypedRealTestCtx<T>>;
export async function testCtx(
  opts?: ShallowTestCtxOptions,
): Promise<ShallowTestCtx>;
export async function testCtx(
  opts: RealTestCtxOptions | ShallowTestCtxOptions = {},
): Promise<RealTestCtx | ShallowTestCtx> {
  if ("app" in opts && opts.app !== undefined) {
    const {
      app,
      module,
      actor = null,
      scope = "",
      now,
      idSeed,
      kms,
      db: injected,
      datasources,
    } = opts;
    // Seed BEFORE applySchema: a resource whose DDL mints a row (a global singleton) draws from this stream
    // too, so installing it later would leave part of the harness's own state un-replayable.
    const unseed = idSeed === undefined ? undefined : seedIds(idSeed);
    // a fresh PGlite per harness (test isolation is the point). When the caller injects a live Postgres
    // connection, the harness runs the same applySchema + ctx + op-pipeline over it instead. The dynamic
    // PGlite import stays unloaded on the injected path.
    let pg: { close(): Promise<void> } | undefined;
    let db: Db & Transactor;
    if (injected !== undefined) {
      db = injected;
    } else {
      const { PGlite } = await import("@electric-sql/pglite");
      // loaded so a `temporal:{noOverlap}` app's `CREATE EXTENSION btree_gist` resolves on the harness
      // store too — a consumer testing the overlap refuse must not need real PG.
      const { btree_gist } = await import(
        "@electric-sql/pglite/contrib/btree_gist"
      );
      const fresh = new PGlite({ extensions: { btree_gist } });
      pg = fresh;
      db = pgliteDb(fresh);
    }
    await applySchema(db, app);
    // `now` rides on the BASE ctx, the one slot both compositions read (`makeCtx` here, `buildOpCtx` under
    // `runOp`) — a clock passed to only one of them is a harness whose two doors disagree about the time.
    const base = { actor, scope, now };
    // thread `datasources` so `t.ctx.datasource(name)` reaches the same live registry serve/mcp wire.
    const real = makeCtx(app, db, base, kms, module, datasources);
    // in-memory-real refuses raw ctx.query: a silent `[]` would be the most toxic false-green — the store
    // runs real repo methods, but the `queries/` seam is real-PG territory. An injected real connection can
    // run raw SQL, so its ctx.query stays the live makeCtx door.
    const ctx: FullCtx = injected !== undefined ? real : {
      ...real,
      query: () => Promise.reject(new Error(IN_MEMORY_QUERY_REFUSAL)),
    };
    let closed = false;
    return {
      ctx,
      db,
      runOp: <I, O>(
        op: OpDecl<I, O>,
        input: I,
        o: {
          actor?: Actor | null;
          scope?: string;
          idempotencyKey?: string;
          subject?: { resource: string; id: string };
          now?: Clock;
          idSeed?: number;
        } = {},
      ) => {
        const runBase = {
          actor: o.actor ?? actor,
          scope: o.scope ?? scope,
          now: o.now ?? now,
        };
        // A per-call seed lasts exactly the call, and is restored on rejection too — one throwing op must
        // not leave every later id in the process replaying this call's stream.
        return withIdSeed(o.idSeed, () => {
          // compose the op-surface for this harness's module. Thread the per-call `subject` and the harness
          // `datasources` so `ctx.transition(to)`/`ctx.datasource(name)` drive through the same surface
          // serve/mcp compose — without them a subject- or datasource-backed op would false-green here.
          const surface = opSurfaceFactory(
            app,
            runBase,
            module ?? "app",
            kms,
            o.subject,
            datasources,
          )(db);
          // delegate to `dispatchOp` — the one dispatch chokepoint serve.ts/mcp.ts/cross-module all funnel
          // through, so every production dispatch step (gate, provenance, handler composition, withSpan) runs
          // from the same source. Find the op's owning resource by reference identity (an OpDecl carries no
          // name); `origin:"cross-module"` is the honest in-process origin for a bare runOp.
          for (const m of app.model) {
            for (const [opName, decl] of Object.entries(m.operations)) {
              if (decl === op) {
                return dispatchOp<O>(
                  m,
                  opName,
                  db,
                  runBase,
                  input,
                  o.idempotencyKey,
                  surface,
                  {
                    module: m.module,
                    resource: m.name,
                    origin: "cross-module",
                  },
                );
              }
            }
          }
          // a standalone `defineOp` has no carrier to dispatch through — run the pipeline directly with
          // no gate. Provenance still has to be resource-qualified when an idempotency key is present
          // (L-3): empty `opName` is `err(internal)`, so the harness module names the claim namespace.
          return runOpPipeline(
            op,
            composeOpHandler(op),
            db,
            runBase,
            input,
            o.idempotencyKey,
            surface,
            o.idempotencyKey !== undefined
              ? {
                op: "write",
                module: module ?? "app",
                resource: module ?? "app",
                origin: "cross-module",
              }
              : undefined,
            undefined,
          );
        });
      },
      ...fixtureFaces(app),
      // dispose owns ONLY a PGlite this harness minted; an injected connection is the caller's to open, clean,
      // and close (t.dispose never closes it).
      dispose: async () => {
        if (!closed) {
          closed = true;
          unseed?.(); // the harness seed is process-wide; leaving it installed would leak into the next test
          if (pg) await pg.close();
        }
      },
    };
  }
  const { actor = null, scope = "", data, modules, query, members } =
    opts as ShallowTestCtxOptions;
  return {
    ctx: {
      actor,
      scope,
      data,
      modules,
      query: query ??
        (() =>
          Promise.reject(
            new Error(
              "testCtx[shallow]: no ctx.query stub was provided — pass `query` (or use the in-memory-real mode / deno task test:pg)",
            ),
          )),
      ...(members ?? {}),
    },
  };
}

// ── module-isolation slice ────────────────────────────────────────────────────────────────────────
/**
 * `moduleSlice(config, name)` — narrow an app config to one module plus its declared transitive `deps`,
 * so a test boots exactly the module under test. Carries along the target module and every module
 * reachable through `deps` (a dangling dep name is a loud throw), plus the subscribers/workers whose
 * `topic` is emitted by an included module. Top-level `resources` (the flat, module-less lane) are
 * excluded — a slice is a module boundary test.
 */
export function moduleSlice<
  C extends {
    readonly modules?: ReadonlyArray<
      {
        readonly name: string;
        readonly deps?: readonly string[];
        readonly emits?: readonly string[] | Readonly<Record<string, unknown>>;
      }
    >;
    readonly subscribers?: ReadonlyArray<{ readonly topic: string }>;
    readonly workers?: ReadonlyArray<{ readonly topic: string }>;
  },
>(config: C, name: string): C {
  const byName = new Map((config.modules ?? []).map((m) => [m.name, m]));
  const keep = new Set<string>();
  const walk = (n: string): void => {
    if (keep.has(n)) return;
    const mod = byName.get(n);
    if (!mod) {
      throw new Error(
        `moduleSlice: module '${n}' is not declared${
          keep.size ? ` (reached via deps)` : ""
        } — known: ${[...byName.keys()].join(", ") || "(none)"}`,
      );
    }
    keep.add(n);
    for (const d of mod.deps ?? []) walk(d);
  };
  walk(name);
  const emitted = new Set<string>();
  for (const m of config.modules ?? []) {
    if (!keep.has(m.name)) continue;
    const e = m.emits;
    if (Array.isArray(e)) { for (const t of e) emitted.add(t as string); }
    else if (e && typeof e === "object") {
      for (const t of Object.keys(e)) emitted.add(t);
    }
  }
  return {
    ...config,
    resources: [], // the flat lane is out of a module slice by definition
    modules: (config.modules ?? []).filter((m) => keep.has(m.name)),
    subscribers: (config.subscribers ?? []).filter((s) => emitted.has(s.topic)),
    workers: (config.workers ?? []).filter((w) => emitted.has(w.topic)),
    // a webhook sink externalizes an emitted topic — same filter as subscribers (05-runtime.md §externalization)
    ...("webhooks" in config
      ? {
        webhooks: ((config as { webhooks?: ReadonlyArray<{ topic: string }> })
          .webhooks ?? []).filter((w) => emitted.has(w.topic)),
      }
      : {}),
  } as C;
}
