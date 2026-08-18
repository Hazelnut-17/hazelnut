// serve.ts CRUD route registration — one resource's REST surface, extracted from createRouter's per-model loop.
import type { ResourceModel } from "../core/app.ts";
import { type Actor, crudWriteDenied } from "../authz/auth.ts";
import {
  httpPolicyMode,
  isExternalRoute,
  routeAuthnDeferred,
} from "../core/app-refs.ts";
import type { HttpRoute } from "../core/app.ts";
import {
  crudWriteTx,
  isExclusionViolation,
  isUniqueViolation,
} from "../core/pipeline.ts";
import { all, type Where } from "../core/where.ts";
import {
  type Db,
  isTransactor,
  type Transactor,
  withDeadlockRetry,
} from "../data/db.ts";
import type { Result } from "../core/result.ts";
import {
  create,
  drainFileGc,
  drainReEmbed,
  list,
  type ReadCtx,
  remove,
  RestrictedDeleteError,
  type RowPolicy,
  search,
  update,
} from "../data/repo.ts";
import { BULK_MAX, dataOf } from "../data/data.ts";
import { parsePatch, strictify } from "../data/schema.ts";
import { egress, servedColumnsOf } from "../features/redact.ts";
import { createStatusGuardViolation } from "../features/transition.ts";
import { crudProvenance } from "../mcp/mcp.ts";
import {
  type AuthVars,
  byIdWithin,
  CallerWhereError,
  callerWhereOf,
  crudErrorResponse,
  crudResultError,
  fileUrlTtl,
  type HonoCtx,
  type HttpRow,
  idempotencyKeyOf,
  ifMatchVersionOf,
  pageOf,
  queryBodyOf,
  routeBase,
  type ServeConfig,
} from "./serve-helpers.ts";
import { jsonBodyErrorMessage, parseJsonBody } from "./serve-json.ts";
import {
  applyVersion,
  upcastBody,
  versionInputInvalid,
} from "./version-runtime.ts";
import { validationDetail, validationIssues } from "../core/validation.ts";
import type { Hono } from "hono";
export interface RouteCtx {
  readonly cfg: ServeConfig;
  readonly ctxOf: (c: HonoCtx) => ReadCtx;
  readonly conflictBody: (e: unknown) => Record<string, string>;
  /** Register a (method, path-pattern) whose authn the global middleware DEFERS (`authnFirst:false`). */
  readonly deferAuthn: (method: string, pattern: string) => void;
  /** The handler-side lazy resolver for a deferred route — a thrown resolver yields the 503 Response. */
  readonly lateCtxOf: (c: HonoCtx) => Promise<ReadCtx | Response>;
}

/** A bulk write's `err` Result, carried out through `crudProvenance` as a throw so the §6 record reads
 *  `err`/`rolled-back` — the batch tx did roll back, and a returned `err` would have recorded a false ok. */
class BulkAbort<T> extends Error {
  constructor(readonly result: Result<T>) {
    super("bulk write failed");
  }
}

/** The bulk door's tx opener, retried on a transient deadlock/serialization abort. `withDeadlockRetry` only
 *  ever sees a THROW, and a bulk verb returns its abort as an `err` Result — so the retry binds to
 *  `db.transaction` itself, which covers `atomic`'s one batch tx and `continue`'s per-row txs alike. */
export function retryingTx(db: Db): Db {
  if (!isTransactor(db)) return db;
  const transaction = <T>(fn: (tx: Db) => Promise<T>) =>
    withDeadlockRetry(() => db.transaction(fn));
  // A Proxy that keeps the ORIGINAL as receiver, never `Object.create(db)`: prototype delegation runs every
  // delegated member with `this` = the derived object, so a BYO handle holding its pool in a `#private`
  // field throws a brand-check TypeError. A getter needs `Reflect.get`'s receiver, a method needs `bind`.
  return new Proxy(db, {
    get: (t, p) => {
      if (p === "transaction") return transaction;
      const v = Reflect.get(t, p, t);
      return typeof v === "function" ? v.bind(t) : v;
    },
  }) as Db & Transactor;
}

/** The array branch of a CRUD write door, through the SAME cross-cutting wrappers the single-row branch
 *  applies: the §6 ProvenanceRecord and the deadlock retry (`retryingTx` on the db it is handed). Both
 *  branches call this or `crudProvenance(… withDeadlockRetry …)`, so neither can carry a wrapper the other lacks. */
async function crudBulk<T>(
  m: ResourceModel,
  verb: "create" | "update",
  ctx: ReadCtx,
  db: Db,
  run: (db: Db) => Promise<Result<T>>,
): Promise<Result<T>> {
  try {
    return await crudProvenance(m, verb, ctx, "http", async () => {
      const r = await run(retryingTx(db));
      if (!r.ok) throw new BulkAbort(r);
      return r;
    });
  } catch (e) {
    if (e instanceof BulkAbort) return e.result as Result<T>;
    throw e;
  }
}

export function registerResourceRoutes(
  router: Hono<{ Variables: AuthVars }>,
  m: ResourceModel,
  rctx: RouteCtx,
): void {
  const { cfg, ctxOf, conflictBody } = rctx; // deferAuthn/lateCtxOf ride rctx for the flipped routes
  const base = routeBase(m);
  // `public` lifts the PERM gate only — the model's rowPolicy still applies (declared or boot-injected,
  // composed into the model at createApp), the same resolution the MCP twin uses. An owned() policy on a
  // public read therefore shows an anonymous caller nothing, not the whole table.
  const rpOf = (_read: string): RowPolicy<HttpRow> =>
    (m.rowPolicy as RowPolicy<HttpRow> | null) ?? (() => all<HttpRow>());

  // op-level default-deny for an auto-CRUD write route: a create/update/delete route exposed at
  // `http:"policy"` is gated by the convention-seeded `<r>:<verb>` perm, same deny-by-default the
  // custom-op boundary injects; `"public"`/external routes are the explicit opt-out.
  const writeDenied = (verb: string, actor: Actor | null): boolean => {
    const route = m.http[verb] as HttpRoute;
    const gated = httpPolicyMode(route) === "policy" && !isExternalRoute(route);
    return crudWriteDenied(actor, m.name, verb, gated);
  };
  // The wire projection (03-api-shape.md §wire-projection), resolved once per resource: the declared
  // `columns` or `id` + the schema keys, minus the redaction set the output chokepoint drops — a projected
  // key is therefore a key every response carries. Reads only: a write returns an id/updated envelope.
  const listCols = m.http["list"] ? servedColumnsOf(m, "list") : null;
  const findCols = m.http["find"] ? servedColumnsOf(m, "find") : null;
  // The response row is MINTED from the projection, so a column the DDL grew cannot reach the wire at all.
  // Top-level only: a jsonb column's own keys are the app's value, never the column space.
  const projectWire = (
    cols: readonly string[],
    row: Record<string, unknown>,
  ): Record<string, unknown> =>
    Object.fromEntries(cols.map((k) => [k, row[k]]));
  // wire/response-shape: the projection promises these keys, so a STORED row missing one is DB drift — a
  // loud 500, never a response silently short a promised field. Reads the pre-projection row: the minted
  // one carries every key by construction, so checking it would be vacuous.
  const wireMissing = (
    cols: readonly string[],
    rows: readonly unknown[],
  ): string | null => {
    for (const row of rows) {
      if (row === null || typeof row !== "object") continue;
      for (const k of cols) {
        if (!(k in (row as Record<string, unknown>))) return k;
      }
    }
    return null;
  };
  const wireError = (
    c: { json: (body: unknown, status: 500) => Response },
    k: string,
  ) =>
    c.json({
      error: "internal",
      message:
        `wire/response-shape: '${k}' is projected by ${m.name} but absent from the row — the physical table no longer carries it (DB drift); fix the drift, never ship a response missing a promised field`,
    }, 500);
  // Dev-shape 403 hint — gated on a POSITIVE `HAZELNUT_DEV=1`, never on an absent DATABASE_URL: name the
  // convention perm the gate wanted so the fix is one read. Every other shape stays opaque — the perm
  // vocabulary is surface information a prober must not enumerate.
  const forbidden = (
    c: { json: (body: unknown, status: 403) => Response },
    verb: string,
  ) =>
    c.json(
      // An absence is what a Dockerfile copied from the dev one arrives carrying, and an app whose pool
      // comes from any other variable never sets DATABASE_URL at all. Development proves itself.
      Deno.env.get("HAZELNUT_DEV") === "1"
        ? { error: "forbidden", required: `${m.name}:${verb}` }
        : { error: "forbidden" },
      403,
    );

  if (m.http["list"]) {
    router.get(base, async (c) => {
      const ctx = ctxOf(c);
      // the caller-`where` (03-api-shape.md §75) parsed from `?where=` is and-composed through the same
      // WHERE-stack site as scope/rowPolicy, so it can only narrow, never widen past them.
      let caller: Where<HttpRow>;
      try {
        caller = callerWhereOf(c, m);
      } catch (e) {
        if (e instanceof CallerWhereError) {
          return c.json({ error: "validation" }, 400);
        }
        throw e;
      }
      // offset pagination (03-api-shape.md §pagination): `?limit=&offset=` parse to the `Page` the repo
      // appends after the WHERE-stack; the keyset `after` cursor is repo-only, HTTP deliberately omits it.
      const rows = await list<HttpRow>(
        cfg.db,
        m,
        ctx,
        rpOf("list"),
        caller,
        cfg.kms,
        pageOf(c),
      );
      // project to the wire columns, then redact, then down-project to the pinned API version's shape
      // (multi-version.md §4) — a version sits above the read stack, so it can un-project nothing and
      // un-redact nothing. The shape check runs beneath it, on what the projection promised.
      const versions = cfg.app.versions ?? [];
      const badList = wireMissing(listCols!, rows);
      if (badList !== null) return wireError(c, badList);
      const outList = egress(m, rows.map((r) => projectWire(listCols!, r)));
      return c.json(outList.map((r) => applyVersion(versions, m, c, r)));
    });
    // QUERY /<plural> (RFC 10008; 03-api-shape.md §read-contract): the rich-read projection of the same `list`
    // exposure — filter and full-text search ride a JSON body instead of `?where`, through the same WHERE-stack
    // + `rpOf("list")` as GET, so QUERY can never read past what GET's policy allows.
    router.on("QUERY", base, async (c) => {
      const ctx = ctxOf(c);
      let spec;
      try {
        spec = await queryBodyOf(c, m);
      } catch (e) {
        if (e instanceof CallerWhereError) {
          return c.json({ error: "validation", message: e.message }, 400);
        }
        throw e;
      }
      // a full-text `search` on a non-`searchable` resource has no tsvector to match — loud 400, never a
      // silent ignore-the-search-and-return-everything.
      if (spec.search !== undefined && m.searchable.length === 0) {
        return c.json({
          error: "validation",
          message: `resource '${m.name}' is not searchable — omit 'search'`,
        }, 400);
      }
      const rows = spec.search !== undefined
        ? await search<HttpRow>(
          cfg.db,
          m,
          ctx,
          spec.search,
          rpOf("list"),
          spec.caller,
          cfg.kms,
          spec.page,
        )
        : await list<HttpRow>(
          cfg.db,
          m,
          ctx,
          rpOf("list"),
          spec.caller,
          cfg.kms,
          spec.page,
        );
      // QUERY rides the `list` exposure, so it rides `list`'s projection — a rich read must never be a
      // wider hole around the narrow one.
      const versions = cfg.app.versions ?? [];
      const badQuery = wireMissing(listCols!, rows);
      if (badQuery !== null) return wireError(c, badQuery);
      const outQuery = egress(m, rows.map((r) => projectWire(listCols!, r)));
      return c.json(outQuery.map((r) => applyVersion(versions, m, c, r)));
    });
  }
  if (m.http["find"]) {
    router.get(`${base}/:id`, async (c) => {
      const ctx = ctxOf(c);
      // `find` is the `:id` lookup and the asked filter — `:id` merges over the caller-`where` so it is
      // authoritative; a `?where={"id":...}` can never re-target away from the path.
      let caller: Where<HttpRow>;
      try {
        caller = byIdWithin(callerWhereOf(c, m), c.req.param("id")); // the id conjunct is never dropped
      } catch (e) {
        if (e instanceof CallerWhereError) {
          return c.json({ error: "validation" }, 400);
        }
        throw e;
      }
      const rows = await list<HttpRow>(
        cfg.db,
        m,
        ctx,
        rpOf("find"),
        caller,
        cfg.kms,
      );
      // project, redact, then down-project to the pinned version's shape (multi-version.md §4) — the version
      // reshapes the already-projected, already-redacted row, so it can widen neither.
      if (!rows[0]) return c.json({ error: "notFound" }, 404);
      // the row `version` IS the ETag the CAS `If-Match` expects (05-runtime.md §versioning): read off the
      // pre-projection row, so a client can precondition an update without `version` on the wire.
      if (m.features.versioning) {
        c.header("ETag", `"${String(rows[0]["version"])}"`);
      }
      const badFind = wireMissing(findCols!, [rows[0]]);
      if (badFind !== null) return wireError(c, badFind);
      const outFind = egress(m, projectWire(findCols!, rows[0]));
      return c.json(applyVersion(cfg.app.versions ?? [], m, c, outFind));
    });
  }
  // file grant (file/grant-policy-gated + file/signed-url-ttl): `GET /<plural>/:id/:field/url` runs the same
  // read WHERE-stack as `find`, so a caller mints a URL for a row's file ONLY if they can read that row — an
  // unreadable/absent row is the same 404 (no existence leak). TTL is clamped so a leaked URL self-expires.
  if (m.files.length > 0 && m.http["find"]) {
    const fileSet = new Set(m.files);
    router.get(`${base}/:id/:field/url`, async (c) => {
      const field = c.req.param("field");
      if (!fileSet.has(field)) return c.json({ error: "notFound" }, 404); // not a file() field of this resource
      if (!cfg.storage) return c.json({ error: "storageUnconfigured" }, 500); // unreachable on the served path (boot guard), defensive floor
      const ctx = ctxOf(c);
      const caller = byIdWithin(all<HttpRow>(), c.req.param("id")); // by-id only; the policy gate is rpOf("find")
      const rows = await list<HttpRow>(
        cfg.db,
        m,
        ctx,
        rpOf("find"),
        caller,
        cfg.kms,
      ); // the read-gate IS the policy gate
      const row = rows[0];
      if (!row) return c.json({ error: "notFound" }, 404); // not readable (policy/scope) OR absent — same 404, no existence leak
      const key = row[field];
      if (typeof key !== "string" || key.length === 0) {
        return c.json({ error: "notFound" }, 404); // no file set on this row
      }
      const ttl = fileUrlTtl(c);
      const url = await cfg.storage.presignedGet(key, ttl);
      return c.json({ url, ttl });
    });
  }
  if (m.http["create"]) {
    // validate-first flip (05-runtime.md §op-pipeline authn ordering; `authnFirst:false`): the body parse
    // runs before the resolver chain, so a malformed body 400s with zero authn round-trips; writeDenied is
    // still enforced on the late actor. Default = authn-first, unchanged.
    const createDeferred = routeAuthnDeferred(m.http["create"]);
    if (createDeferred) rctx.deferAuthn("POST", base);
    router.post(base, async (c) => {
      // CRUD create does not ride the op-pipeline's idempotency machinery — a client believing a resend is
      // deduped but isn't would double-create, so reject `Idempotency-Key` loudly rather than ignore it.
      // For deduplicated creation, declare a custom op with `idempotent:true` (05-runtime.md §idempotency).
      if (idempotencyKeyOf(c) !== undefined) {
        return c.json({
          error: "validation",
          message:
            "Idempotency-Key is not honored on CRUD create — declare a custom op with idempotent:true for deduplicated creation",
        }, 400);
      }
      const parsedCreate = await parseJsonBody(c);
      if (!parsedCreate.ok) {
        return c.json({
          error: "validation",
          message: jsonBodyErrorMessage(parsedCreate.reason),
        }, 400); // malformed + over-deep both loud-400
      }
      const rawCreate = parsedCreate.value;
      // bulk create (03-api-shape.md §bulk): an array body → `createMany`, authn-first only, additive to
      // single-object create. Rides `crudBulk` for the wrappers the single path applies; the version
      // up-cast and the inline vector re-embed stay single-row (the re-embed job is durable either way).
      if (Array.isArray(rawCreate)) {
        const bctx = ctxOf(c);
        if (writeDenied("create", bctx.actor)) {
          return forbidden(c, "create");
        }
        if (rawCreate.length > BULK_MAX) {
          return c.json({
            error: "validation",
            message:
              `bulk exceeds the ${BULK_MAX}-row limit — chunk the request`,
          }, 400);
        }
        const rows: HttpRow[] = [];
        for (let i = 0; i < rawCreate.length; i++) {
          const parsed = strictify(m.schema).safeParse(rawCreate[i]);
          if (!parsed.success) {
            return c.json({
              error: "validation",
              message: `row ${i}: ${
                validationDetail("failed validation", parsed.error)
              }`,
              issues: validationIssues(parsed.error),
            }, 400);
          }
          const fsmErrRow = createStatusGuardViolation(
            m,
            parsed.data as HttpRow,
          );
          if (fsmErrRow) {
            return c.json({
              error: "validation",
              message: `row ${i}: ${fsmErrRow}`,
            }, 400);
          }
          rows.push(parsed.data as HttpRow);
        }
        const mode =
          new URL(c.req.raw.url).searchParams.get("mode") === "continue"
            ? "continue"
            : "atomic";
        const r = await crudBulk(
          m,
          "create",
          bctx,
          cfg.db,
          (db) =>
            dataOf(cfg.app, db, bctx, cfg.kms)[m.name]!.createMany(rows, {
              mode,
            }),
        );
        if (r.ok) return c.json(r.value);
        const be = crudResultError(r.error); // total httpStatus map + redact, not a hand-map
        return c.json(be.body, be.status);
      }
      let ctx: ReadCtx | undefined = createDeferred ? undefined : ctxOf(c);
      if (ctx && writeDenied("create", ctx.actor)) {
        return forbidden(c, "create");
      }
      // version write up-cast (multi-version.md §5): validate against the pinned version's own input schema
      // first, reshape into `current`'s input, then re-validate against `current`'s schema — the two-step, so
      // a shape `current` rejects is a loud 400, never a smuggled write.
      const vErrC = versionInputInvalid(
        cfg.app.versions ?? [],
        m,
        c,
        rawCreate,
        "create",
      );
      if (vErrC) return c.json({ error: "validation", message: vErrC }, 400);
      const body = upcastBody(
        cfg.app.versions ?? [],
        m,
        c,
        rawCreate,
        "create",
      );
      const parsed = strictify(m.schema).safeParse(body);
      // the reject names each offending path + issue code (redaction-safe — never the received value):
      // `message` is the human line, `issues` the machine list.
      if (!parsed.success) {
        return c.json({
          error: "validation",
          message: validationDetail("body failed validation", parsed.error),
          issues: validationIssues(parsed.error),
        }, 400);
      }
      // FSM create guard — the shared rule (`createStatusGuardViolation`), one home for both projections.
      // Reads `parsed.data` (the up-cast output) so a version `up` cannot smuggle a non-initial status.
      const fsmErr = createStatusGuardViolation(m, parsed.data as HttpRow);
      if (fsmErr) return c.json({ error: "validation", message: fsmErr }, 400);
      if (ctx === undefined) {
        const late = await rctx.lateCtxOf(c);
        if (late instanceof Response) return late;
        ctx = late;
        if (writeDenied("create", ctx.actor)) {
          return forbidden(c, "create"); // deferred route's op gate — post-parse, never skipped
        }
      }
      try {
        // one tx wraps the INSERT + rollup UPDATE + tree-closure + `_audit` INSERT (05-runtime.md
        // §op-pipeline) — a failure after the main write rolls the business row back too, never a committed
        // row with no audit row. `crudProvenance` emits the §6 ProvenanceRecord CRUD would otherwise lack.
        const id = await crudProvenance(
          m,
          "create",
          ctx,
          "http",
          () =>
            withDeadlockRetry(() =>
              crudWriteTx(
                cfg.db,
                (tx) => create(tx, m, ctx, parsed.data as HttpRow, cfg.kms),
                ctx.signal,
              )
            ),
        );
        // vector re-embed (04-features.md §vector): the embed is an external model call, so it cannot ride
        // the write tx — it drains after commit through the bound `embed` seam, re-reading the source text
        // and writing the vector back so the served POST yields an embedded row.
        if (m.vector && cfg.embed) {
          // topic-scoped: `drainReEmbed` SELECTs only `_vector_reembed`, never another topic's message.
          // The job is durable already; this drain is a latency optimization whose failure must not 5xx
          // the committed create (a retry would duplicate the row) — swallow + log, the relay owns it.
          try {
            await drainReEmbed(cfg.db, cfg.app.model, cfg.embed);
          } catch (e) {
            console.error(
              "[hazelnut] inline re-embed drain after a committed create failed (durable job persists; the standing relay will drain it):",
              e,
            );
          }
        }
        return c.json({ id }, 201);
      } catch (e) {
        if (isUniqueViolation(e)) return c.json(conflictBody(e), 409); // attributed, not an unhandled 500
        if (isExclusionViolation(e)) return c.json(conflictBody(e), 409); // overlapping validity window
        const resp = crudErrorResponse(e); // a kinded throw → its real status + redact, not an opaque 500
        if (resp) return c.json(resp.body, resp.status);
        throw e;
      }
    });
  }
  if (m.http["update"]) {
    const updateDeferred = routeAuthnDeferred(m.http["update"]);
    if (updateDeferred) rctx.deferAuthn("PATCH", `${base}/:id`);
    // bulk update by-ids (03-api-shape.md §bulk): PATCH /<plural> (collection, no :id) with a JSON array of
    // { id, patch, expectedVersion? } → updateMany, additive to single PATCH /<plural>/:id. `?mode=continue`
    // isolates per-row failures into `failed[]`. `expectedVersion` is required per item on a versioning resource.
    router.patch(base, async (c) => {
      const ctx = ctxOf(c);
      if (writeDenied("update", ctx.actor)) {
        return forbidden(c, "update");
      }
      const parsedBulk = await parseJsonBody(c);
      if (!parsedBulk.ok) {
        return c.json({
          error: "validation",
          message: jsonBodyErrorMessage(parsedBulk.reason),
        }, 400);
      }
      const raw = parsedBulk.value;
      if (!Array.isArray(raw)) {
        return c.json({
          error: "validation",
          message:
            "bulk update expects a JSON array of { id, patch, expectedVersion? }",
        }, 400);
      }
      if (raw.length > BULK_MAX) {
        return c.json({
          error: "validation",
          message: `bulk exceeds the ${BULK_MAX}-row limit — chunk the request`,
        }, 400);
      }
      const items: { id: string; patch: HttpRow; expectedVersion?: number }[] =
        [];
      for (let i = 0; i < raw.length; i++) {
        const it = raw[i] as {
          id?: unknown;
          patch?: unknown;
          expectedVersion?: unknown;
        };
        if (typeof it?.id !== "string") {
          return c.json({
            error: "validation",
            message: `item ${i}: missing string 'id'`,
          }, 400);
        }
        // the collection door carries the same optimistic-lock precondition as the single PATCH: one
        // `If-Match` cannot address N rows, so each item states its own expected version or the batch is refused.
        if (m.features.versioning && typeof it.expectedVersion !== "number") {
          return c.json({
            error: "validation",
            message:
              `item ${i}: 'expectedVersion' is required to update a versioned resource`,
          }, 428);
        }
        // parsePatch (schema.ts): strict `.partial()` validation, then only caller-sent keys survive — an
        // absent field's default must not re-stamp the column (nor trip the FSM `status` guard below).
        const parsed = parsePatch(m.schema, it.patch ?? {});
        if (!parsed.success) {
          return c.json({
            error: "validation",
            message: `item ${i}: ${
              validationDetail("patch failed validation", parsed.error)
            }`,
            issues: validationIssues(parsed.error),
          }, 400);
        }
        if (
          Object.keys(m.transitions).length > 0 &&
          "status" in (parsed.data as HttpRow)
        ) {
          return c.json({
            error: "validation",
            message:
              `item ${i}: status changes go through the transition path, not update`,
          }, 400);
        }
        items.push({
          id: it.id,
          patch: parsed.data as HttpRow,
          ...(typeof it.expectedVersion === "number"
            ? { expectedVersion: it.expectedVersion }
            : {}),
        });
      }
      const mode =
        new URL(c.req.raw.url).searchParams.get("mode") === "continue"
          ? "continue"
          : "atomic";
      const r = await crudBulk(
        m,
        "update",
        ctx,
        cfg.db,
        (db) =>
          dataOf(cfg.app, db, ctx, cfg.kms)[m.name]!.updateMany(items, {
            mode,
          }),
      );
      if (r.ok) return c.json(r.value);
      const be = crudResultError(r.error); // total httpStatus map + redact, not a hand-map
      return c.json(be.body, be.status);
    });
    router.patch(`${base}/:id`, async (c) => {
      let ctx: ReadCtx | undefined = updateDeferred ? undefined : ctxOf(c);
      if (ctx && writeDenied("update", ctx.actor)) {
        return forbidden(c, "update");
      }
      // version write up-cast on PATCH (multi-version.md §5): validate the partial body against the
      // version's own partial schema first, then map only touched `current` fields (no defaults — a
      // partial update must not fill untouched siblings) and re-validate against the partial schema.
      const parsedPatch = await parseJsonBody(c);
      if (!parsedPatch.ok) {
        return c.json({
          error: "validation",
          message: jsonBodyErrorMessage(parsedPatch.reason),
        }, 400);
      }
      const rawPatch = parsedPatch.value;
      const vErrU = versionInputInvalid(
        cfg.app.versions ?? [],
        m,
        c,
        rawPatch,
        "update",
      );
      if (vErrU) return c.json({ error: "validation", message: vErrU }, 400);
      const body = upcastBody(cfg.app.versions ?? [], m, c, rawPatch, "update");
      // parsePatch (schema.ts): strict `.partial()` validation, then only caller-sent keys survive — an
      // absent field's `.default(...)` must not re-stamp the column (nor trip the FSM `status` guard below).
      const parsed = parsePatch(m.schema, body);
      if (!parsed.success) {
        return c.json({
          error: "validation",
          message: validationDetail("body failed validation", parsed.error),
          issues: validationIssues(parsed.error),
        }, 400);
      }
      // `status` on a `transitions` resource is FSM-controlled — it moves only through the transition
      // path, never a raw CRUD update. Loud-reject a status-carrying patch rather than silently drop it.
      if (
        Object.keys(m.transitions).length > 0 &&
        "status" in (parsed.data as HttpRow)
      ) {
        return c.json({
          error: "validation",
          message: "status changes go through the transition path, not update",
        }, 400);
      }
      if (ctx === undefined) {
        const late = await rctx.lateCtxOf(c);
        if (late instanceof Response) return late;
        ctx = late;
        if (writeDenied("update", ctx.actor)) {
          return forbidden(c, "update"); // deferred: the op gate runs post-parse, never skipped
        }
      }
      // optimistic-lock (04-features.md §versioning): a versioning resource's update is a compare-and-swap
      // on `version` and requires `If-Match` — without it the request is refused (428), so a client can
      // never blind-write past a concurrent change.
      let expectedVersion: number | undefined;
      if (m.features.versioning) {
        expectedVersion = ifMatchVersionOf(c);
        if (expectedVersion === undefined) {
          return c.json({
            error: "validation",
            message:
              "If-Match: <version> is required to update a versioned resource",
          }, 428);
        }
      }
      let r: { updated: boolean; stale: boolean; frozen?: boolean };
      try {
        // one tx wraps the UPDATE + its `_audit` INSERT (commit-or-rollback together, as above).
        r = await crudProvenance(
          m,
          "update",
          ctx,
          "http",
          () =>
            withDeadlockRetry(() =>
              crudWriteTx(cfg.db, (tx) =>
                update(
                  tx,
                  m,
                  ctx,
                  c.req.param("id"),
                  parsed.data as HttpRow,
                  expectedVersion,
                  cfg.kms,
                ), ctx.signal)
            ),
        );
      } catch (e) {
        if (isUniqueViolation(e)) return c.json(conflictBody(e), 409); // moving a field to a taken value
        if (isExclusionViolation(e)) return c.json(conflictBody(e), 409); // re-windowing into an overlap
        const resp = crudErrorResponse(e); // a kinded throw → its real status + redact
        if (resp) return c.json(resp.body, resp.status);
        throw e;
      }
      // a patch touching a field-level `immutable` frozen field is a conflict (set-once) — 409, ahead of the
      // stale/notFound checks so it never falls through to a misleading 404 (04-features.md §immutable).
      if (r.frozen) return c.json({ error: "conflict" }, 409);
      if (r.stale) return c.json({ error: "stale" }, 409);
      return r.updated
        ? c.json({ updated: true })
        : c.json({ error: "notFound" }, 404);
    });
  }
  if (m.http["delete"]) {
    router.delete(`${base}/:id`, async (c) => {
      const ctx = ctxOf(c);
      if (writeDenied("delete", ctx.actor)) {
        return forbidden(c, "delete");
      }
      // version-CAS on delete: like update, a versioning resource requires `If-Match` so a stale delete
      // is refused (428 absent, 409 stale on mismatch) rather than silently succeeding.
      let expectedVersion: number | undefined;
      if (m.features.versioning) {
        expectedVersion = ifMatchVersionOf(c);
        if (expectedVersion === undefined) {
          return c.json({
            error: "validation",
            message:
              "If-Match: <version> is required to delete a versioned resource",
          }, 428);
        }
      }
      let deleted: boolean, stale: boolean;
      try {
        // one tx wraps the (soft) delete + the rollup decrement + the `_audit` INSERT (commit-or-rollback).
        ({ deleted, stale } = await crudProvenance(
          m,
          "delete",
          ctx,
          "http",
          () =>
            withDeadlockRetry(() =>
              crudWriteTx(cfg.db, (tx) =>
                remove(
                  tx,
                  m,
                  ctx,
                  c.req.param("id"),
                  undefined,
                  expectedVersion,
                ), ctx.signal)
            ),
        ));
      } catch (e) {
        // an onDelete:'restrict' refusal (a surviving restrict-child still references the parent) maps to
        // 409, same as the unique/stale/frozen 409s, never a raw 500. The op tx already rolled back.
        if (e instanceof RestrictedDeleteError) {
          return c.json({ error: "conflict" }, 409);
        }
        const resp = crudErrorResponse(e); // a kinded throw → its real status + redact
        if (resp) return c.json(resp.body, resp.status);
        throw e;
      }
      if (stale) return c.json({ error: "stale" }, 409); // a versioned delete whose If-Match version is stale
      // file no-orphan GC: a hard-delete enqueued a `_file_gc` job in the committed delete tx — drain it
      // here (post-commit) so the off-box bytes go promptly. Topic-scoped (`drainFileGc` SELECTs only
      // `_file_gc`); the job is durable, so its failure must not 5xx the committed delete — swallow + log,
      // the standing relay owns the byte reclaim.
      if (deleted && m.files.length > 0) {
        try {
          await drainFileGc(cfg.db, cfg.storage ?? null);
        } catch (e) {
          console.error(
            "[hazelnut] inline file-gc drain after a committed delete failed (durable job persists; the standing relay will drain it):",
            e,
          );
        }
      }
      return deleted ? c.body(null, 204) : c.json({ error: "notFound" }, 404); // missing/out-of-scope is 404
    });
  }
  // custom operations (03-api-shape §custom-op-binding · 05-runtime §op-pipeline route convention): every
  // `http` key that is not a CRUD verb names a declared op. Instance ops act on an existing row via
  // `POST /<r>s/:id/<op>`; collection ops mint via `POST /<r>s/<op>`, no `:id`. Both dispatch through the
  // same `dispatchOp` pipeline a custom op runs through MCP, so REST and MCP never diverge.
  // the dispatch operations map (app.ts §dispatchOperations): the author's op decls with the deny-by-default
  // `requires("<r>:<op>")` injected for every policy-exposed op that omits its own (13-authz.md §authz-seam).
  // Both the HTTP route here and MCP's `callMcpTool` consume this ONE composition, so policy-omit is safe
  // by construction on both surfaces; `m.operations` itself stays untouched for the verifier.
}
