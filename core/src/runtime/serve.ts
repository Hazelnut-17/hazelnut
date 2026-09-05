import { type RouterFactory, setRouterFactory } from "../core/router-port.ts";
import {
  MCP_INVALID_PARAMS,
  MCP_INVALID_REQUEST,
  MCP_METHOD_NOT_FOUND,
  MCP_PARSE_ERROR,
} from "../mcp/mcp-wire.ts";
import { collectModelGuardViolations } from "../core/model-guards.ts";
import { registerResourceRoutes } from "./serve-routes.ts";
import { cancelTask, pollTask } from "./tasks.ts";
import { registerResourceOps } from "./serve-routes-ops.ts";
import { registerViewRoutes } from "./serve-routes-views.ts";
import {
  type Actor,
  ANON,
  can,
  isAnonymous,
  resolveActor,
} from "../authz/auth.ts";
import { assembleProvenance, getLogSink } from "../core/ctx.ts";
import type { Db, Transactor } from "../data/db.ts";
import { pgErrorMap, uniqueClauseMap } from "../data/pg-error-map.ts";
import type { ReadCtx } from "../data/repo.ts";
import {
  OUTAGE_FALLBACK_WINDOW_MS,
  outageFallbackAllow,
  type OutageFallbackEntry,
  rateLimitHeaders,
  type RateLimitVerdict,
  throttleHeaders,
  throttleNextAction,
  throttleProvenanceAttrs,
  toThrottleSignal,
} from "../features/throttle.ts";
import { projectMcpInstructions } from "../mcp/mcp-instructions.ts";
import {
  callMcpTool,
  capabilityFilter,
  isSemanticsUri,
  readResource,
  readSemanticsResource,
  resourceReadRpcError,
  resourceTemplates,
  toolCallError,
  toolCallOk,
  toolSurfaceStamp,
  visibleToolNames,
} from "../mcp/mcp.ts";
import {
  isRuntimeUri,
  readRuntimeResource,
  runtimeResourceEntries,
} from "../mcp/mcp-runtime.ts";
import {
  hasPromptsCapability,
  mcpPromptDefs,
  renderPromptMessages,
} from "../mcp/prompt.ts";
import { FRAMEWORK_VERSION } from "../core/version.ts";
import { resolvePin } from "./version-runtime.ts";
import { deriveOpenApi } from "./openapi.ts";
import { relayLiveness } from "./outbox-relay.ts";
import {
  type AuthVars,
  errorBody,
  type HonoCtx,
  MAX_BODY_BYTES_DEFAULT,
  type ServeConfig,
} from "./serve-helpers.ts";
import { Hono } from "hono";
// hono's body-limit middleware lives on a subpath export, resolved via the "hono/" import-map entry;
// a remote-pin consumer carries the same two entries in its scaffolded deno.json.
import { bodyLimit } from "hono/body-limit";
import { exceedsJsonDepth, MAX_JSON_DEPTH } from "./serve-json.ts";

// roster/engine extracted into cohesive submodules, re-exported so importers stay stable.
export * from "./serve-helpers.ts";

// ── JSON-RPC 2.0 (the MCP transport, 12-mcp §7) ──────────────────────────────────────────────────
/** The MCP protocol revision this server implements — the single place it is stated (12-mcp.md
 *  §protocol-version). */
export const MCP_PROTOCOL_VERSION = "2024-11-05";

// ── the PostgreSQL version floor ─────────────────────────────────────────────────────────────────
// Pins PostgreSQL 16+ (docs/guide/rundown.md §stack); enforced at `/ready` with the coarse `pg-version` slug —
// a readiness verdict, so a mis-provisioned instance is kept out of the LB rather than crash-looped.
const MIN_PG_VERSION_NUM = 160000;
async function pgVersionSupported(db: Db): Promise<boolean> {
  const { rows } = await db.query<{ v: number }>(
    `SELECT current_setting('server_version_num')::int AS v`,
  );
  return (rows[0]?.v ?? 0) >= MIN_PG_VERSION_NUM;
}

/** The `params` slice the MCP methods read (name/arguments for tools & prompts, uri for resources). */
type McpParams = {
  readonly name?: string;
  readonly arguments?: Record<string, unknown>;
  readonly uri?: string;
};
/** A dispatch outcome BEFORE the JSON-RPC envelope: a success `result`, or a protocol `error` (code+message).
 *  The `/mcp` boundary wraps exactly one of these with `{jsonrpc:"2.0", id}` — the id-echo lives at the seam. */
type McpOutcome = { readonly result: unknown } | {
  readonly error: { readonly code: number; readonly message: string };
};

/**
 * Builds the composed HTTP/MCP router from a fully-assembled `ServeConfig` — the lower-level servable path.
 * `createApp` is the guided high-level entry: it defaults the `kms`/`rateLimitStore` floors, builds
 * `resolveCtx`, and runs the servable-boot guards before composing through this factory. `createRouter` is
 * the raw assembly beneath that — the caller assembles the whole `ServeConfig` and owns `resolveCtx` —
 * but it refuses the same model-guard ids as served `createApp`. A missing `kms`/`storage` is a boot
 * refusal, not a first-request surprise. Use `createApp` for the guided path; reach for `createRouter`
 * only when hand-wiring a Hono host that still accepts the same fail-closed model.
 */
export function createRouter(cfg: ServeConfig): Hono {
  // Transactor boot guard (mirrors relay-atomicity's loud refusal, relay.ts): a served/MCP write route
  // wraps handler + audit + outbox in one tx, so `cfg.db` must be a `Transactor`. Refuse at boot when the
  // app exposes any mutating surface and the db can't transact — a deploy-time fault, not a first-request
  // surprise. A read-only app is exempt (nothing opens a tx).
  const hasWriteSurface = cfg.app.model.some((m) =>
    ["create", "update", "delete"].some((v) => m.http[v] !== undefined) ||
    Object.keys(m.operations).some((op) =>
      (m.http[op] !== undefined || m.mcp?.[op] !== undefined) &&
      (m.operations[op] as { tx?: string }).tx !== "read"
    ) ||
    ["create", "update", "delete"].some((v) => m.mcp?.[v] !== undefined)
  );
  if (
    hasWriteSurface &&
    typeof (cfg.db as Partial<Transactor>).transaction !== "function"
  ) {
    throw new Error(
      "serve: cfg.db is not a Transactor but the app exposes write route(s) — a served write wraps handler + audit + outbox in one tx and cannot run non-atomically. Pass a Transactor db (postgresDb(sql) / pgliteDb(pg)), or expose no mutating routes. (Boot refusal mirrors relay-atomicity.)",
    );
  }
  // the raw `createRouter` path used to skip createApp's boot refusal. The model-derived fail-closed
  // guards are attestable here without resolveCtx (`scope/resolver-required` stays createApp-only), so
  // createRouter refuses on the same ids, iterating the same `collectModelGuardViolations` set. Cannot
  // false-fire on the createApp path: those seams are already wired there.
  const modelGuards = collectModelGuardViolations(cfg.app.model, {
    hasKms: cfg.kms !== undefined,
    hasStorage: cfg.storage !== undefined,
    hasEmbed: cfg.embed !== undefined,
    rowPolicyOf: (m) => m.rowPolicy,
  }, cfg.app.views ?? []);
  if (modelGuards.length > 0) {
    throw new Error(modelGuards.map((g) => g.refuse).join("\n\n"));
  }
  const router = new Hono<{ Variables: AuthVars }>();
  // ── per-request wire correlation ────────────────────────────────────────────────────
  // first middleware: mint one id per request, echo it on every response (`Hazelnut-Trace-Id`), and stash
  // it so `ctxOf` threads it into the §6 ProvenanceRecord's `traceId`, and onError can return it as `id`.
  router.use("*", async (c, next) => {
    const traceId = crypto.randomUUID();
    c.set("hazelTraceId", traceId);
    c.header("Hazelnut-Trace-Id", traceId);
    await next();
  });
  // ── top-level error boundary (pairs with the wire redaction) ────────────────────────────────────
  // an uncaught route-layer throw would otherwise fall through to Hono's default 500 with the raw error
  // text (a PG string / stack) on the wire. Instead: the full error goes to the server log (keyed by the
  // trace id), the wire gets the generic `{error:"internal", id}` body, and `id` joins the log line.
  router.onError((err, c) => {
    const id = c.get("hazelTraceId") ?? crypto.randomUUID();
    console.error(`[hazelnut] uncaught route error [trace ${id}]:`, err);
    return c.json({ ...errorBody("internal", "unhandled"), id }, 500);
  });
  // pgErrorMap wiring (05-runtime.md §6): the model-derived constraint→declaration inverse map, built once
  // at router assembly. A unique-violation 409 enriches its body with the attributed clause via
  // `conflictBody`; the attribution is redaction-safe by construction (declaration names only, never a row
  // value), so no PII egresses on the enriched path.
  const clauseMap = uniqueClauseMap(cfg.app.model.map((m) => ({
    name: m.name,
    unique: m.unique,
    scopedSingleton: Boolean(m.features.singleton) && Boolean(m.features.scope),
    pgSchema: m.pgSchema,
  })));
  // the enriched conflict body: the envelope stays the shared object form; the attribution is additive
  // the attributed `message` (+ `clause` iff the model owns the violated constraint). One helper, used at both the
  // create and update unique-violation catches, so the two sites never drift.
  const conflictBody = (e: unknown): Record<string, unknown> => {
    const a = pgErrorMap(e, clauseMap);
    return a.clause
      ? { ...errorBody("conflict", a.message), clause: a.clause }
      : { ...errorBody("conflict", a.message) };
  };
  // liveness probe — the public-shallow half of the build-id secure split. Registered before the authn +
  // throttle middleware so a probe is neither rate-limited nor mass-downgraded by an IdP blip, and shallow
  // (no DB call) so it cannot be DoS-amplified. Exposes nothing — the gated `/version` half is not public.
  router.get("/health", (c) => c.json({ status: "ok" }));
  // readiness probe — the deep sibling (05-runtime.md §5.1): liveness says the process is up, readiness
  // says it can do work. Checks the DB answers `SELECT 1`, and when the app carries async consumers
  // (`app.relay`) a dead drain loop / over-budget backlog fails readiness too. The wire body is coarse
  // reason slugs only, never a driver error or SQL string (same no-internal-leak posture as the 500 boundary).
  // memoize the PG-version-floor verdict — a server version is a deploy-time constant, so probe once.
  let pgVersionOk: boolean | null = null;
  router.get("/ready", async (c) => {
    const reasons: string[] = [];
    try {
      // first probe: the version read IS the connectivity check (one round-trip). After that the
      // version is a deploy-time constant, so later probes are `SELECT 1` only.
      if (pgVersionOk === null) pgVersionOk = await pgVersionSupported(cfg.db);
      else await cfg.db.query(`SELECT 1`);
      if (!pgVersionOk) reasons.push("pg-version");
    } catch {
      reasons.push("db-unreachable");
    }
    if (reasons.length === 0 && cfg.app.relay) {
      const live = await relayLiveness(
        cfg.db,
        cfg.relayState?.lastDrainAt ?? null,
      );
      if (!live.ready) reasons.push(`relay-${live.health}`);
    }
    return reasons.length === 0
      ? c.json({ status: "ready" })
      : c.json({ status: "unready", reasons }, 503);
  });
  // ── request-body byte cap (the HTTP hardening floor) ──────────────────────────────────────────
  // Every JSON-parsing route buffers the body before Zod sees it, so an uncapped body is a memory-DoS the
  // count-based throttle cannot bound. Default-on with an explicit `false` opt-out; over-cap is a
  // transport-level 413 short-circuit, infra never an err.kind. Registered after the probes (exempt, like
  // their throttle exemption) and before every body-bearing route.
  const maxBody = cfg.http?.maxBodyBytes ?? MAX_BODY_BYTES_DEFAULT;
  if (maxBody !== false) {
    router.use(
      "*",
      bodyLimit({
        maxSize: maxBody,
        onError: (c) => c.json(errorBody("payload_too_large"), 413),
      }),
    );
  }
  // ── the opt-in wall-clock request timeout ─────────────────────────────────────────────────────
  // If `http.requestTimeoutMs` is set, a request that overruns it gets a transport-level 504, so a
  // signal-ignoring hung handler stops holding the socket. It never aborts the DB (statement_timeout is
  // the SQL bound; aborting the pooled connection would poison it). Opt-in because racing-and-abandoning a
  // write decouples the 504 from the actual commit — the window the op idempotency key remedies.
  const requestTimeoutMs = cfg.http?.requestTimeoutMs;
  if (requestTimeoutMs && requestTimeoutMs > 0) {
    router.use("*", async (c, next) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, requestTimeoutMs);
      });
      // a pre-timeout rejection propagates (onError maps it to the redacted 500); a post-timeout rejection
      // is abandoned, swallowed, so it never surfaces as an unhandled rejection.
      const work = next().catch((e) => {
        if (!timedOut) throw e;
      });
      try {
        await Promise.race([work, deadline]);
        if (timedOut) return c.json(errorBody("timeout"), 504);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    });
  }
  // unknown-pin rejection + date-range resolution (multi-version.md §3/§resolution): a `Hazelnut-Version`
  // that neither matches a declared pin nor date-resolves (newest declared date-pin at-or-before it) is a
  // loud `validation`/400, never a silent fallthrough to `current` (14-trust-gradient.md forbids the silent
  // downgrade) — a non-date unknown pin and a date BEFORE the oldest declared pin both refuse. A resolved
  // (non-exact) pin is echoed on `Hazelnut-Version-Resolved` so the mapping is never silent. A pin that
  // versions some resource but not the one addressed still passes (§7 direct-projection).
  const declaredVersions = cfg.app.versions ?? [];
  if (declaredVersions.length > 0) {
    router.use("*", async (c, next) => {
      const pin = c.req.raw.headers.get("hazelnut-version");
      if (pin) {
        const resolved = resolvePin(declaredVersions, pin);
        if (resolved === null) {
          return c.json(
            errorBody(
              "validation",
              `unknown \`hazelnut-version\` pin '${pin}' — declared: ${
                declaredVersions.join(", ")
              }`,
            ),
            400,
          );
        }
        if (resolved !== pin) c.header("Hazelnut-Version-Resolved", resolved);
      }
      await next();
    });
  }
  // deprecation / sunset notice (multi-version.md §9): a response served under a deprecated/sunset version
  // adds the RFC 9745 `Deprecation` + RFC 8594 `Sunset` headers. Keyed on the pin; the earliest declared
  // date across the pin's versions wins.
  const pinNotice = new Map<string, { deprecated?: string; sunset?: string }>();
  for (const v of cfg.app.versions ?? []) {
    if (!v.deprecated && !v.sunset) continue;
    const cur = pinNotice.get(v.version) ?? {};
    pinNotice.set(v.version, {
      deprecated: v.deprecated ?? cur.deprecated,
      sunset: v.sunset ?? cur.sunset,
    });
  }
  if (pinNotice.size > 0) {
    router.use("*", async (c, next) => {
      await next();
      const meta = pinNotice.get(
        resolvePin(
          cfg.app.versions ?? [],
          c.req.raw.headers.get("hazelnut-version"),
        ) ?? "",
      );
      if (!meta) return;
      if (meta.deprecated) {
        c.res.headers.set(
          "Deprecation",
          `@${Math.floor(new Date(meta.deprecated).getTime() / 1000)}`,
        );
      }
      if (meta.sunset) {
        c.res.headers.set("Sunset", new Date(meta.sunset).toUTCString());
      }
    });
  }
  // authn (13-authz §authz-seam): the first step. Resolver chain → first non-null wins → ctx.actor;
  // all-null → ANON. Fail-closed (§5): a thrown resolver aborts 503, never falling through to the next
  // resolver or to anonymous. Runs before throttle so the budget keys on the real resolved actor.
  // validate-first flip (05-runtime.md §op-pipeline authn ordering): a route declared `authnFirst:false`
  // runs its strict input parse before the resolver chain — global middleware skips resolution for those
  // patterns and the handler resolves lazily (`lateCtxOf`) after its 400-able parse.
  const deferredAuthn: Array<{ readonly method: string; readonly re: RegExp }> =
    [];
  const isAuthnDeferred = (method: string, path: string): boolean =>
    deferredAuthn.some((d) => d.method === method && d.re.test(path));
  if (cfg.auth) {
    const auth = cfg.auth;
    router.use("*", async (c, next) => {
      if (isAuthnDeferred(c.req.method, new URL(c.req.raw.url).pathname)) { // windows-portability:allow-http (HTTP request URL, not an fs path)
        await next(); // the flipped route's handler resolves after its parse (lateCtxOf) — fail-fast on a malformed body
        return;
      }
      let actor: Actor;
      try {
        actor = await resolveActor(auth, c.req.raw);
      } catch {
        return c.json(errorBody("auth_unavailable"), 503); // fail-closed: a thrown resolver is never anonymous
      }
      c.set("hazelActor", actor);
      await next();
    });
  }
  // Work cancellation: a dedicated controller forwarded from `request.signal` ONLY while the handler
  // runs. Deno's legacy `request.signal` also aborts on a successful response — leaving that signal on
  // ctx would cancel post-commit work. The listener is removed in `finally` so a success-abort is ignored.
  router.use("*", async (c, next) => {
    const work = new AbortController();
    const deadlineMs = cfg.http?.requestTimeoutMs;
    const timer = deadlineMs && deadlineMs > 0
      ? setTimeout(() => work.abort(), deadlineMs)
      : undefined;
    const reqSig = c.req.raw.signal;
    const onAbort = () => work.abort();
    if (reqSig.aborted) work.abort();
    else reqSig.addEventListener("abort", onAbort, { once: true });
    c.set("hazelWorkSignal", work.signal);
    try {
      await next();
    } finally {
      reqSig.removeEventListener("abort", onAbort);
      if (timer !== undefined) clearTimeout(timer);
    }
  });
  // the request ctx: scope (and a fallback actor) from `resolveCtx`; when `auth` is configured the
  // seam-resolved actor wins and is fed back into `resolveCtx` so scope may derive from it.
  const ctxOf = (
    c: HonoCtx,
  ): ReadCtx & { readonly version?: string; readonly traceId?: string } => {
    let resolved: ReadCtx;
    if (!cfg.auth) {
      resolved = cfg.resolveCtx(c.req.raw);
    } else {
      const actor = c.get("hazelActor") ?? ANON; // middleware always sets it under cfg.auth; ANON is a defensive floor
      resolved = { ...cfg.resolveCtx(c.req.raw, actor), actor };
    }
    // stamp the resolved API-version pin onto the request ctx (multi-version.md §3) so version-aware logic
    // reads `ctx.version` — date-range-resolved, so `ctx.version` is always a DECLARED pin. Absent when the
    // request carries no `Hazelnut-Version` header (⇒ `current`).
    const pin = resolvePin(
      cfg.app.versions ?? [],
      c.req.raw.headers.get("hazelnut-version"),
    );
    // thread the per-request wire correlation id so every §6 mint on this request records the same id
    // the client got back.
    const tid = c.get("hazelTraceId");
    // the DOOR stamp (`_audit.origin`): this builder serves the HTTP routes; mcpDispatch re-stamps "mcp".
    resolved = { ...resolved, origin: "http" };
    // the per-request cancellation signal: the work controller (client-disconnect while the handler
    // runs, plus the optional `http.requestTimeoutMs` deadline). The write-tx cancels its mid-flight
    // DB statement out-of-band on abort via `pg_cancel_backend` (non-poisoning).
    const signal = c.get("hazelWorkSignal");
    return {
      ...resolved,
      ...(pin ? { version: pin } : {}),
      ...(tid ? { traceId: tid } : {}),
      ...(signal ? { signal } : {}),
    };
  };
  // per-actor throttle (13-authz §rate-limit): an early step after authn, keyed on the resolved actor.
  // Over-limit is a 429 short-circuit (transport, never an err.kind); the RateLimit-* quartet rides every
  // response; the MCP channel additionally carries the throttle as a next-action.
  if (cfg.rateLimitStore) {
    const store = cfg.rateLimitStore;
    // a small per-actor in-memory fixed-window fallback budget, consulted only when the shared store
    // throws. Per-instance (no shared store during the outage), so across N instances an attacker gets up
    // to N× this budget — it must stay small. Agents always get the budget; humans follow
    // `cfg.rateLimitOutage` (default "budget"). Never a hard 500, never fail-open for agents.
    const fallback = new Map<string, OutageFallbackEntry>();
    router.use("*", async (c, next) => {
      const reqCtx = ctxOf(c);
      const actor = reqCtx.actor ?? ANON;
      // anon sub-keying: an anonymous caller shares one bucket by default (un-spoofable global DoS floor).
      // A deployment that can name a trusted client IP wires `cfg.clientIp` so each anon IP gets its own
      // bucket; the framework never reads a header itself — the trust is the deployment's own assertion.
      let throttleActor = actor;
      if (isAnonymous(actor) && cfg.clientIp) {
        const ip = cfg.clientIp(c.req.raw);
        if (ip) throttleActor = { ...ANON, id: `anon:${ip}` };
      }
      let verdict: RateLimitVerdict;
      try {
        verdict = await store.checkAndIncrement(throttleActor, 1); // atomic check+increment (only consumes a token if allowed)
      } catch {
        // store outage — degrade gracefully, never a hard 500. Agents always get the local budget; humans the knob.
        const policy = throttleActor.type === "agent"
          ? "budget"
          : (cfg.rateLimitOutage ?? "budget");
        if (
          policy === "open" ||
          (policy === "budget" &&
            outageFallbackAllow(fallback, throttleActor.id))
        ) {
          await next();
          return;
        }
        // "closed", or the local fallback budget is exhausted → degrade to 429 (not a 500), with a Retry-After.
        return c.json(errorBody("rate_limited"), 429, {
          "Retry-After": String(Math.ceil(OUTAGE_FALLBACK_WINDOW_MS / 1000)),
        });
      }
      const signal = toThrottleSignal(verdict);
      if (!verdict.allowed) {
        // observability (05-runtime.md §6): the throttle short-circuit happens before the op-pipeline runs,
        // so the pipeline's own drain can never see it — assemble + drain one infra ProvenanceRecord here.
        // The err.kind union stays closed (throttle rides kind:"forbidden", marked by attrs.throttled).
        // Fire-and-forget: a throwing sink can never change the 429 the caller already gets.
        try {
          getLogSink().drain(assembleProvenance({
            actor: reqCtx.actor,
            scope: reqCtx.scope,
            attrs: throttleProvenanceAttrs(signal),
            op: { op: "throttle", resource: c.req.path },
            origin: c.req.path === "/mcp" ? "mcp" : "http",
            outcome: "err",
            kind: "forbidden", // closest closed-union kind; attrs.throttled is the infra marker (no 9th kind)
            durationMs: 0,
            txOutcome: "none",
            traceId: reqCtx.traceId ?? crypto.randomUUID(), // the client-held Hazelnut-Trace-Id joins the throttle record
            spanId: crypto.randomUUID(),
          }));
        } catch { /* fire-and-forget: observability never changes the 429 */ }
        // MCP gets the throttle as an error-as-next-action in the body; both surfaces get 429 + the RateLimit-*/Retry-After headers
        // the MCP channel is an error-as-next-action (steer convention, 12-mcp §8), NOT the Error
        // envelope — `error` carries the throttle quartet itself; the HTTP faces carry the envelope
        const body = c.req.path === "/mcp"
          ? { error: throttleNextAction(signal) }
          : errorBody("rate_limited");
        return c.json(body, 429, throttleHeaders(signal));
      }
      await next();
      for (const [k, v] of Object.entries(rateLimitHeaders(signal))) {
        c.header(k, v); // echoed on every response — the pre-emptive lever
      }
    });
  }
  // gated /version — the secure split's non-public half. Mounted only when opted in, registered after
  // authn + throttle so the resolved actor gates it and repeated probes consume the throttle budget.
  // Deny-by-default: an actor lacking the named perm, including ANON, gets 403, never the build identity.
  if (cfg.version) {
    const v = cfg.version;
    router.get("/version", (c) => {
      if (!can(ctxOf(c).actor, v.gate)) {
        return c.json(errorBody("forbidden"), 403);
      }
      return c.json({
        frameworkVersion: FRAMEWORK_VERSION,
        ...(v.appVersion !== undefined ? { appVersion: v.appVersion } : {}),
      });
    });
  }
  // GET /tasks/:id — poll an async task (05-runtime.md §task). Registered after authn + throttle so the
  // resolved scope guards it (a task in another scope is 404, no existence leak) and a poll burns budget.
  if ((cfg.app.tasks?.length ?? 0) > 0) {
    router.get("/tasks/:id", async (c) => {
      const status = await pollTask(
        cfg.db,
        c.req.param("id"),
        ctxOf(c).scope,
        cfg.storage,
      ); // storage → an offloaded result answers a presigned resultUrl
      return status ? c.json(status) : c.json(errorBody("notFound"), 404);
    });
    // DELETE /tasks/:id — request cooperative cancellation. Scope-guarded like the poll; sets the
    // out-of-band cancel flag the run polls via `ctx.cancelled` (can't force-kill a running worker).
    router.delete("/tasks/:id", async (c) => {
      const r = await cancelTask(cfg.db, c.req.param("id"), ctxOf(c).scope);
      return r.ok ? c.json(r.value) : c.json(errorBody("notFound"), 404);
    });
  }
  // `/openapi.json` — the API doc, derived from the same declarations. Opt-in to expose: absent ⇒ not
  // mounted. `{ public: true }` ⇒ ungated; `{ gate }` ⇒ deny-by-default. Memoized lazily at first hit — the
  // model is boot-frozen so the derivation is a constant.
  let openApiDoc: ReturnType<typeof deriveOpenApi> | null = null;
  const openApiOf = () => (openApiDoc ??= deriveOpenApi(cfg.app));
  if (cfg.openapi?.public) {
    router.get("/openapi.json", (c) => c.json(openApiOf()));
  } else if (cfg.openapi?.gate) {
    const g = cfg.openapi.gate;
    router.get(
      "/openapi.json",
      (c) =>
        can(ctxOf(c).actor, g)
          ? c.json(openApiOf())
          : c.json(errorBody("forbidden"), 403),
    );
  }
  // ── the MCP server — Streamable HTTP, JSON-RPC 2.0 (12-mcp §7) ────────────────────────────────────────
  // A response echoes `id` and carries either `result` (success) or `error:{code,message}` (a protocol
  // fault). A tool execution failure is not a protocol fault: it rides inside `result` as a manufactured
  // `isError:true` tool-result (§error-channel) so a host cannot swallow it. A message with no `id` is a
  // notification, acknowledged 202, no body.
  // the per-caller surface stamp (12-mcp §surface-evolution) — `capabilityFilter` is actor-keyed, so this
  // is computed per request rather than once per build. That is the cost of the header meaning anything.
  const stampFor = (hc: HonoCtx): string =>
    toolSurfaceStamp(cfg.app, ctxOf(hc).actor);
  const mcpDispatch = async (
    method: string,
    params: McpParams,
    c: HonoCtx,
  ): Promise<McpOutcome> => {
    // the MCP door re-stamp: same resolved identity/scope, agent door — `_audit.origin` tells them apart.
    const mcpCtxOf = (hc: HonoCtx) => ({ ...ctxOf(hc), origin: "mcp" });
    if (method === "initialize") {
      // the connect-time handshake (12-mcp §138): server identity + capabilities + projected instructions
      // scoped to match this caller's tools/list exactly.
      const actor = ctxOf(c).actor;
      const prompts = cfg.prompts ?? [];
      // advertise `resources` only when this identity sees at least one `as:"resource"` template (§5
      // identity-scoping); `resources.subscribe` stays a ceiling (per-session state), not claimed.
      const hasResources = resourceTemplates(cfg.app, actor).length > 0 ||
        runtimeResourceEntries(cfg.mcpRuntime, actor).length > 0;
      return {
        result: {
          // The ONE version this server speaks. Answering it to a client that asked for a newer one is
          // what the spec requires ("otherwise, respond with another protocol version it supports") —
          // not a pin left behind. Nothing here branches on version, and rejecting JSON-RPC batches is
          // consistent with this one: batching arrived in 2025-03-26. Claiming a version means
          // implementing its semantics, so this constant moves only when they are.
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            // FALSE on THIS door, and that is a fact about the door rather than the framework: the
            // capability promises a pushed `notifications/tools/list_changed`, and request-response holds
            // no per-session channel to push on. The stamp + `Mcp-List-Changed` header are the in-band
            // best-effort here (12-mcp §surface-evolution).
            //
            // The stdio transport DOES push — stdout is a real server→client channel — so `runMcpStdio`
            // rewrites this to `true` on its own responses. The claim is made by the component that keeps
            // it, which is also why it cannot be forged: a header this handler trusted would let any HTTP
            // caller talk itself into a promise this door cannot honour.
            tools: { listChanged: false },
            ...(hasResources ? { resources: {} } : {}),
            ...(hasPromptsCapability(prompts) ? { prompts: {} } : {}),
          }, // advertise prompts/resources only if any declared
          serverInfo: {
            name: cfg.mcpServerInfo?.name ?? "hazelnut-app",
            version: cfg.mcpServerInfo?.version ?? "0.0.0",
          },
          instructions: projectMcpInstructions(cfg.app, {
            instructions: cfg.mcpInstructions,
            visibleTools: visibleToolNames(cfg.app, actor),
          }),
        },
      };
    }
    if (method === "tools/list") {
      return { result: { tools: capabilityFilter(cfg.app, ctxOf(c).actor) } }; // §5: identity-scoped surface
    }
    if (method === "tools/call") {
      if (!params.name) {
        return {
          error: {
            code: MCP_INVALID_PARAMS,
            message: "tools/call requires params.name",
          },
        };
      }
      const r = await callMcpTool(
        cfg.app,
        cfg.db as ServeConfig["db"] & Transactor,
        mcpCtxOf(c),
        params.name,
        params.arguments ?? {},
        undefined,
        cfg.kms,
        cfg.storage ?? null,
        cfg.datasources,
      );
      // 12-mcp §error-channel: a tool failure is a manufactured `isError:true` tool-result carried inside
      // `result`, not a JSON-RPC `error` a host may swallow — the agent reads the failure off the tool-result.
      // Success is the same channel: MCP `content` plus today's payload keys (PATCH — hosts that read
      // `content` see the value; JSON-RPC clients that read `id` / `items` still do).
      return { result: r.ok ? toolCallOk(r.value) : toolCallError(r.error) };
    }
    // ── the MCP §6 resource surface over the wire (12-mcp §6) ────────────────────────────────────────────
    // `resources/templates/list` advertises `<module>/<resource>/{id}` templates, capability-filtered like
    // `tools/list` (§5 — the omission, not a 403, defeats id-enumeration). Every URI is id-addressable, so
    // there are no enumerable concrete URIs: the template list IS the surface a host fills in.
    if (method === "resources/templates/list") {
      return {
        result: {
          resourceTemplates: resourceTemplates(cfg.app, ctxOf(c).actor),
        },
      };
    }
    // App resources are id-templated (the templates above carry that surface); the only concrete resources are
    // the runtime projection's two fixed URIs (12-mcp §runtime-projection) — identity-scoped like tools/list
    // (omission for a caller failing the gate, never a 403 oracle).
    if (method === "resources/list") {
      return {
        result: {
          resources: runtimeResourceEntries(cfg.mcpRuntime, ctxOf(c).actor),
        },
      };
    }
    if (method === "resources/read") {
      if (!params.uri) {
        return {
          error: {
            code: MCP_INVALID_PARAMS,
            message: "resources/read requires params.uri",
          },
        };
      }
      const uri = params.uri;
      // route by scheme — the two read paths are structurally separate: `hazelnut-semantics://` is the
      // ungated, row-free explain payload; any other URI is the gated app-resource read that mirrors the
      // `find` tool, so a host surfacing a resource inherits server-side enforcement with zero new auth.
      const r = isSemanticsUri(uri)
        ? await readSemanticsResource(uri)
        // gate-fail and unknown-URI both collapse to the same notFound → shared -32002 below, never a
        // which-part-exists oracle.
        : isRuntimeUri(uri)
        ? await readRuntimeResource(
          cfg.db,
          cfg.relayState,
          ctxOf(c).actor,
          cfg.mcpRuntime,
          uri,
        )
        : await readResource(
          cfg.app,
          cfg.db as ServeConfig["db"] & Transactor,
          mcpCtxOf(c),
          uri,
          cfg.kms,
          cfg.datasources,
        );
      // 12-mcp §129: a resources/read failure rides the JSON-RPC error channel (resources have no
      // tool-result channel). notFound-masking holds by construction: an absent and a forbidden row both
      // surface the same `-32002`, so the error is never a confirm-exists oracle. An internal throw
      // is `-32603` with a redacted message — schema text must not ride the not-found code.
      return r.ok
        ? { result: { contents: [r.value] } }
        : { error: resourceReadRpcError(r.error) };
    }
    // prompts — authored (definePrompt), not capability-filtered (render is provably row-free / app-data-free)
    if (method === "prompts/list") {
      return { result: { prompts: mcpPromptDefs(cfg.prompts ?? []) } };
    }
    if (method === "prompts/get") {
      if (!params.name) {
        return {
          error: {
            code: MCP_INVALID_PARAMS,
            message: "prompts/get requires params.name",
          },
        };
      }
      const prompt = (cfg.prompts ?? []).find((p) => p.name === params.name);
      if (!prompt) {
        return {
          error: {
            code: MCP_INVALID_PARAMS,
            message: `no prompt '${params.name}'`,
          },
        };
      }
      try {
        // render → the canon message array (a bare-string render normalizes to one `user` message); each
        // becomes an MCP `{role, content:{type:"text",text}}` entry, so a multi-turn prompt survives.
        const messages = renderPromptMessages(prompt, params.arguments ?? {})
          .map((m) => ({
            role: m.role,
            content: { type: "text", text: m.content },
          }));
        return { result: { messages } };
      } catch { // strict-input: a bad/unknown argument is a loud invalid-params error
        return {
          error: {
            code: MCP_INVALID_PARAMS,
            message: "prompt arguments failed validation",
          },
        };
      }
    }
    return {
      error: {
        code: MCP_METHOD_NOT_FOUND,
        message: `method not found: ${method}`,
      },
    };
  };
  router.post("/mcp", async (c) => {
    // origin validation (DNS-rebinding defense): when the app names an allowlist, a request carrying a
    // cross-origin `Origin` is refused; a headless agent sends no `Origin` and is never affected. THIS
    // layer's default is open — with no `mcpAllowedOrigins`, `Origin: https://evil.example` is answered
    // 200. Absence refuses one layer up, at `hazelnut launch` (`cli/permissions.ts`), so the open shape
    // reaches `createApp` and `deno task dev` only.
    const origin = c.req.header("origin");
    if (
      cfg.mcpAllowedOrigins && origin !== undefined &&
      !cfg.mcpAllowedOrigins.includes(origin)
    ) {
      return c.json({
        jsonrpc: "2.0",
        id: null,
        error: { code: MCP_INVALID_REQUEST, message: "origin not allowed" },
      }, 403);
    }
    // the CATALOGUE gate. `tools/list` names every curated tool, its description and its whole input
    // schema — the same shape `/openapi.json` refuses to serve ungated, for the same stated reason. The
    // Origin allowlist above answers a DIFFERENT question: it stops a browser page, and every MCP caller
    // is a client. `undefined` here is the app having declared `gate: null` — open on purpose; the check
    // that a decision was MADE is `mcp/gate-declared`, at the structural rung and at `launch`.
    // This gate is read BEFORE the JSON-RPC body, so it answers for the whole door, `initialize` included.
    if (cfg.mcpGate !== undefined && !can(ctxOf(c).actor, cfg.mcpGate)) {
      return c.json({
        jsonrpc: "2.0",
        id: null,
        error: { code: MCP_INVALID_REQUEST, message: "forbidden" },
      }, 403);
    }
    const raw = await c.req.json().catch(() => undefined) as unknown;
    if (raw === null || typeof raw !== "object") {
      return c.json({
        jsonrpc: "2.0",
        id: null,
        error: { code: MCP_PARSE_ERROR, message: "parse error" },
      }, 400);
    }
    if (Array.isArray(raw)) {
      return c.json({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: MCP_INVALID_REQUEST,
          message: "JSON-RPC batch is not supported",
        },
      }, 400);
    }
    const rpc = raw as { jsonrpc?: unknown };
    if (rpc.jsonrpc !== "2.0") {
      return c.json({
        jsonrpc: "2.0",
        id: (raw as { id?: unknown }).id ?? null,
        error: {
          code: MCP_INVALID_REQUEST,
          message: 'jsonrpc must be "2.0"',
        },
      }, 400);
    }
    if (exceedsJsonDepth(raw, MAX_JSON_DEPTH)) { // a depth wall over the byte cap (deep-nest → 400, not slow processing)
      return c.json({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: MCP_INVALID_REQUEST,
          message: "request nested too deeply",
        },
      }, 400);
    }
    const msg = raw as {
      jsonrpc?: unknown;
      id?: string | number | null;
      method?: unknown;
      params?: McpParams;
    };
    // a notification carries no `id` (JSON-RPC 2.0 §4.1) — the client expects no response. Ack 202 with
    // an empty body and run nothing further.
    const isNotification = !("id" in msg) || msg.id === undefined;
    if (isNotification) return c.body(null, 202);
    if (typeof msg.method !== "string") {
      return c.json({
        jsonrpc: "2.0",
        id: msg.id ?? null,
        error: {
          code: MCP_INVALID_REQUEST,
          message: "invalid request: `method` must be a string",
        },
      });
    }
    const outcome = await mcpDispatch(msg.method, msg.params ?? {}, c);
    // the tool-surface session stamp (12-mcp §surface-evolution): `initialize` hands out the boot-time
    // whole-surface stamp as the session id; the client echoes it on every later request (Streamable HTTP).
    if (msg.method === "initialize") {
      c.header("Mcp-Session-Id", `hz.${stampFor(c)}`);
    }
    const envelope = { jsonrpc: "2.0", id: msg.id ?? null, ...outcome };
    // a stale echoed stamp = this session initialized before a boot changed the tool surface — set
    // `Mcp-List-Changed: true` on the single envelope (stateless: no session store; a JSON-RPC
    // array is refused; the client clears the staleness by re-initializing after re-reading tools/list).
    const echoed = c.req.header("mcp-session-id");
    if (
      msg.method !== "initialize" && echoed !== undefined &&
      echoed.startsWith("hz.") && echoed !== `hz.${stampFor(c)}`
    ) {
      c.header("Mcp-List-Changed", "true");
      return c.json(envelope);
    }
    return c.json(envelope); // envelope: id-echo + result|error (12-mcp §7)
  });
  // the flipped-route seam threaded to the mount passes: `deferAuthn` registers a (method, pattern) the
  // global middleware skips; `lateCtxOf` is the handler-side resolver with the same fail-closed semantics.
  const deferAuthn = (method: string, pattern: string): void => {
    const placeholder = pattern.replace(/:[^/]+/g, "\0P\0");
    const escaped = placeholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replaceAll("\0P\0", "[^/]+");
    deferredAuthn.push({
      method,
      re: new RegExp(`^${escaped}$`),
    });
  };
  const lateCtxOf = async (raw: HonoCtx): Promise<ReadCtx | Response> => {
    // the live Hono context carries set/json beyond the narrow HonoCtx face — recover them structurally
    const c = raw as HonoCtx & {
      set(k: "hazelActor", v: Actor): void;
      json(b: unknown, s: number): Response;
    };
    if (cfg.auth) {
      try {
        c.set("hazelActor", await resolveActor(cfg.auth, c.req.raw));
      } catch {
        return c.json(errorBody("auth_unavailable"), 503);
      }
    }
    return ctxOf(c);
  };
  const rctx = { cfg, ctxOf, conflictBody, deferAuthn, lateCtxOf };
  for (const m of cfg.app.model) {
    registerResourceRoutes(router, m, rctx);
    registerResourceOps(router, m, rctx);
  }
  registerViewRoutes(router, rctx);
  return router as unknown as Hono; // the internal `Variables` (the stashed actor) is an implementation detail
}

// installs `createRouter` into the core router-factory port (avoids a value cycle with core/app,
// router-port.ts). Checked adapter: a signature drift fails `deno check` here.
const installedFactory: RouterFactory = (cfg) => {
  const router = createRouter(cfg);
  return { fetch: (req: Request) => router.fetch(req) };
};
setRouterFactory(installedFactory);
