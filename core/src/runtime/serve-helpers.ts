// Barrel re-exports keep import sites stable.
import type { Actor, AuthConfig, PermKey } from "../authz/auth.ts";
import type { App, ResourceModel } from "../core/app.ts";
import { all, type Where } from "../core/where.ts";
import type { Datasources } from "../data/datasources.ts";
import type { Db } from "../data/db.ts";
import type { Page, ReadCtx } from "../data/repo.ts";
import type { StorageDriver } from "../data/storage.ts";
import type { EmbeddingProvider } from "../features/embed.ts";
import type { Kms } from "../features/encrypt.ts";
import type { RateLimitStore } from "../features/throttle.ts";
import type { PromptDef } from "../mcp/prompt.ts";
import {
  ERR_KINDS,
  httpStatus,
  isTimeoutError,
  redactWireError,
} from "../core/pipeline.ts";
import type { ErrKind, HttpStatus } from "../core/pipeline.ts";
import { exceedsJsonDepth, MAX_JSON_DEPTH } from "./serve-json.ts";
import { resolvedRouteBase } from "../core/resource-registered.ts";

/**
 * The HTTP projection — Hono routes derived from each resource's `http` config:
 *   list GET /<plural>   find GET /<plural>/:id   create POST /<plural>
 *   update PATCH /<plural>/:id   delete DELETE /<plural>/:id
 * where `<plural>` is `path` when set, else mechanical `name+"s"`. Reads run the 6-conjunct WHERE-stack;
 * writes run the scope-stamping repo. Row-level write authz rides custom ops through the op-pipeline —
 * these declarative routes are scope-isolated only.
 */
/** The one route-base rule — `path` when set, else mechanical `/${name}s`. Single-sourced so the served
 *  routes, OpenAPI, and the typed client (`runtime/client.ts`) can never drift on a second copy. */
export const routeBase = resolvedRouteBase;

export interface ServeConfig {
  readonly app: App;
  readonly db: Db;
  // Produces the request's base ctx (scope + fallback actor). When `auth` is supplied, its resolved actor
  // OVERRIDES `ctx.actor` — the second arg lets a scope resolver read it (e.g. `from: "actor.tenantId"`).
  readonly resolveCtx: (req: Request, actor?: Actor) => ReadCtx;
  // The auth seam (13-authz §authz-seam): first non-null resolver wins → `ctx.actor`; all-null → ANON. A
  // thrown resolver FAILS CLOSED (13-authz §5) — 503, never falling through. Absent → the bare resolveCtx actor.
  readonly auth?: AuthConfig<Request>;
  // The in-process relay's liveness handle, mutated after each drain; `/ready` reads `lastDrainAt`. Absent
  // (standalone router / external relay) → readiness falls back to the queue's own relay-lag signal.
  readonly relayState?: { lastDrainAt: number | null };
  readonly kms?: Kms;
  // The embedding provider seam (04-features.md §vector) a vector resource's async re-embed job drains
  // through. Absent ⇒ re-embed stays inert — `runReEmbedJob(null)` throws rather than storing a garbage vector.
  readonly embed?: EmbeddingProvider;
  // The off-box file-bytes seam. A `file()` field keeps only the opaque key in its column; this seam mints
  // the presigned URL and GCs bytes on hard-delete. The boot guard already refuses a driverless file() app.
  readonly storage?: StorageDriver;
  // The live external-datasource registry (05-runtime.md §datasources), threaded to ctx so `ctx.datasource(name)`
  // reaches an external DB. Absent ⇒ `ctx.datasource` throws loud if a handler calls it.
  readonly datasources?: Datasources;
  readonly mcpServerInfo?: {
    readonly name?: string;
    readonly version?: string;
  }; // the MCP `initialize` server identity
  readonly mcpInstructions?: string; // the one authored "what is this business" sentence (projected into instructions)
  readonly mcpRuntime?: { readonly gate: string }; // the runtime-projection opt-in (12-mcp.md §runtime-projection): relay/dlq read floor for gate-holders
  // MCP Origin allowlist (DNS-rebinding defense; 12-mcp §7). Opt-in — a headless agent sends no `Origin`
  // (unchecked). Set ⇒ a `/mcp` request with an Origin not listed is refused (JSON-RPC -32600, HTTP 403).
  readonly mcpAllowedOrigins?: readonly string[];
  readonly prompts?: ReadonlyArray<PromptDef>; // authored MCP prompts (`definePrompt`) — served via prompts/list + prompts/get
  readonly rateLimitStore?: RateLimitStore; // opt-in per-actor throttle (13-authz §rate-limit); absent → no throttling
  // Store-outage policy for the human path (13-authz §218): "budget" (default, graceful degrade), "closed"
  // (429), or "open" (fail-open). The agent path always gets the small budget regardless — this knob is humans-only.
  readonly rateLimitOutage?: "budget" | "closed" | "open";
  // Opt-in trusted-client-IP resolver for anon rate-limit sub-keying (`anon:<ip>`). The deployment asserts
  // trustworthiness — read a proxy-set/stripped header, never a raw client header (reopens spoofing).
  readonly clientIp?: (req: Request) => string | null | undefined;
  // HTTP hardening floor: every JSON-parsing route sits behind this body-byte cap. Floor, not opt-in — absent
  // → 1 MiB default; `false` → explicit uncapped opt-out (without it a large body is a memory-DoS on the parse).
  readonly http?: {
    readonly maxBodyBytes?: number | false;
    /** Opt-in wall-clock request deadline (ms). Set ⇒ merges into `ctx.signal` (a signal-aware handler
     *  aborts its I/O) and an outer middleware 504s an overrun request. Opt-in because racing-and-abandoning
     *  a write decouples the 504 from the actual commit — the remedy is the op idempotency key. */
    readonly requestTimeoutMs?: number;
  };
 // Gated build-identity endpoint. Opt-in: set ⇒ `GET /version` requires `can(actor, gate)`.
  // Absent ⇒ not mounted (deny-by-default, a probe gets plain 404, no existence signal).
  readonly version?: { readonly gate: PermKey; readonly appVersion?: string };
  // `/openapi.json` exposure, opt-in like an `http` route. Absent ⇒ not mounted (404, no contract).
  // `{ public: true }` ⇒ mounted ungated; `{ gate: PermKey }` ⇒ mounted deny-by-default (ANON → 403).
  readonly openapi?: { readonly public?: boolean; readonly gate?: PermKey };
}

export type HttpRow = Record<string, unknown>;

/** Default per-request body byte cap (`ServeConfig.http.maxBodyBytes` overrides; `false` uncaps). 1 MiB
 *  fits every declarative write (file bytes ride `StorageDriver`, never JSON) while bounding the buffering parse. */
export const MAX_BODY_BYTES_DEFAULT = 1_048_576;

/** The ONE error-envelope serializer every route family shares (03-api-shape.md §HTTP contract): the
 *  wire form is `{ error: { kind, message } }`, the shape the OpenAPI document records. Extra context
 *  fields (a required perm, a conflict clause) ride BESIDE `error`, never inside it. */
export function errorBody(
  kind: string,
  message = "",
): { readonly error: { readonly kind: string; readonly message: string } } {
  return { error: { kind, message } };
}

/**
 * Classify a throw from a CRUD write to its wire `(status, body)`. A PG statement_timeout (57014) → 504; a
 * kinded throw (the err.kind union) → its `httpStatus` + `redactWireError`. `internal`/unknown → `null`, so
 * the caller re-throws to `router.onError` (keeps the correlation-id + generic redacted body).
 */
export function crudErrorResponse(
  e: unknown,
): { body: Record<string, unknown>; status: HttpStatus } | null {
  if (isTimeoutError(e)) {
    return { body: { ...errorBody("timeout") }, status: 504 };
  }
  const k = (e as { kind?: unknown } | null)?.kind;
  if (
    typeof k === "string" && (ERR_KINDS as readonly string[]).includes(k) &&
    k !== "internal"
  ) {
    const safe = redactWireError({
      kind: k as ErrKind,
      message: String((e as { message?: unknown }).message ?? ""),
    });
    return {
      body: { ...errorBody(safe.kind, safe.message) },
      status: httpStatus(safe.kind),
    };
  }
  return null;
}

/** Map a CRUD Result error (bulk create/update return a `Result`, not a throw) to its wire `(status, body)`
 *  through the same authority the op-pipeline uses — `httpStatus` + `redactWireError`. */
export function crudResultError(
  error: { readonly kind: ErrKind; readonly message: string },
): { body: Record<string, unknown>; status: HttpStatus } {
  const safe = redactWireError(error);
  return {
    body: { ...errorBody(safe.kind, safe.message) },
    status: httpStatus(safe.kind),
  };
}

/** Parse `?limit=&offset=` into the repo's `Page` (03-api-shape.md §pagination). A missing param
 *  is `undefined`; junk becomes NaN and `clampCount` refuses it as `read/limit-valid`. */
export function pageOf(c: { req: { raw: Request } }): Page {
  const u = new URL(c.req.raw.url);
  const num = (k: string): number | undefined => {
    const raw = u.searchParams.get(k);
    if (raw === null || raw.trim() === "") return undefined;
    return Number(raw);
  };
  return { limit: num("limit"), offset: num("offset") };
}

/** A malformed `?where=` filter (bad JSON, non-flat shape, disallowed column) — a distinct sentinel so the
 *  route's `catch` maps it to `validation`/400, never a silent ignore or a smuggled column. */
export class CallerWhereError extends Error {}

/** Columns an HTTP caller may filter on (03-api-shape.md §75): declared schema columns plus `id`, minus
 *  `encrypted` ∪ `sensitive`. A column outside this set is REJECTED, not dropped — load-bearing because
 *  `lowerInto` interpolates the column name as a bare identifier, so only a schema-derived name reaches SQL. */
function filterableCols(m: ResourceModel): ReadonlySet<string> {
  const excluded = new Set<string>([...m.encrypted, ...m.sensitive]);
  const cols = new Set<string>(["id"]);
  for (const k of Object.keys(m.schema.shape)) {
    if (!excluded.has(k)) cols.add(k);
  }
  for (const e of excluded) cols.delete(e); // id can't be encrypted/sensitive, but keep the rule total
  return cols;
}

/** The `?where=`/QUERY-body wire filter rides the SAME 6-conjunct WHERE-stack as scope/rowPolicy
 *  (03-api-shape.md §75) — a flat `{col:value}` shorthand lowered to `eq`/`isNull` only, never a bypass. */
/** Validate a filter object (flat column→scalar) into the caller `Where` — shared by `callerWhereOf` (GET)
 *  and `queryBodyOf` (QUERY body), so the two transports can never disagree on what a filter means. */
export function whereFromFilterObject(
  parsed: unknown,
  m: ResourceModel,
): Where<HttpRow> {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CallerWhereError("filter must be a flat object of column→value");
  }
  const allowed = filterableCols(m);
  const out: Record<string, unknown> = {};
  for (
    const [col, value] of Object.entries(parsed as Record<string, unknown>)
  ) {
    if (!allowed.has(col)) {
      throw new CallerWhereError(
        `column '${col}' is not filterable`,
      );
    }
    // a scalar (or null) maps to the shorthand's `eq`/`isNull`; a nested object/array would have no shorthand
    // lowering and could only smuggle structure, so it is rejected — the wire filter is equality-only.
    if (
      value !== null && (typeof value === "object")
    ) throw new CallerWhereError(`column '${col}' value must be a scalar`);
    out[col] = value;
  }
  return out as Where<HttpRow>;
}

export function callerWhereOf(
  c: { req: { raw: Request } },
  m: ResourceModel,
): Where<HttpRow> {
  const raw = new URL(c.req.raw.url).searchParams.get("where");
  if (raw === null || raw.trim() === "") return all<HttpRow>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CallerWhereError("where filter is not valid JSON");
  }
  // The same depth wall the other three JSON doors run (write body, QUERY body, view `?input=`). A nested
  // value was already refused downstream as a non-scalar filter, so this changes no verdict — it makes the
  // REASON the true one, and stops this door being the family's one exception.
  if (exceedsJsonDepth(parsed, MAX_JSON_DEPTH)) {
    throw new CallerWhereError("where filter nested too deeply");
  }
  return whereFromFilterObject(parsed, m);
}

/** The parsed `QUERY /<plural>` body (RFC 10008; 03-api-shape.md §read-contract): `filter` (same shorthand
 *  as `GET ?where`), `search` (searchable resources only), and offset pagination — rides JSON, not a bounded URL. */
export interface QuerySpec {
  readonly caller: Where<HttpRow>;
  readonly search?: string;
  readonly page: Page;
}

/** Parse + validate the `QUERY` body into a `QuerySpec`. Strict-input: any unknown key, non-scalar filter
 *  value, or non-string `search` is a loud `CallerWhereError` (400), never a silent drop. */
/**
 * DELIBERATELY not `parseJsonBody`: QUERY is a READ, so the write path's `application/json` wall does not
 * apply to it. That wall is the CSRF floor — it exists to stop a form POST from mutating state, and a read
 * has no state to protect. The consequence, said out loud because it surprises: `QUERY /cards` with
 * `Content-Type: text/plain` and a JSON body is a 200, while the same header on a write is a 400.
 * What this door DOES share with the write path is the JSON depth wall below — the resource-exhaustion
 * guard is about the payload, not the verb, and it applies to both.
 */
export async function queryBodyOf(
  c: { req: { raw: Request } },
  m: ResourceModel,
): Promise<QuerySpec> {
  let body: unknown;
  try {
    body = await c.req.raw.json();
  } catch {
    throw new CallerWhereError("QUERY body is not valid JSON");
  }
  if (exceedsJsonDepth(body, MAX_JSON_DEPTH)) {
    throw new CallerWhereError("QUERY body nested too deeply");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new CallerWhereError("QUERY body must be a JSON object");
  }
  const b = body as Record<string, unknown>;
  const KNOWN = new Set(["filter", "search", "limit", "offset"]);
  for (const k of Object.keys(b)) {
    if (!KNOWN.has(k)) {
      throw new CallerWhereError(
        `unknown QUERY key '${k}' (allowed: filter, search, limit, offset)`,
      );
    }
  }
  const caller = b.filter === undefined
    ? all<HttpRow>()
    : whereFromFilterObject(b.filter, m);
  if (b.search !== undefined && typeof b.search !== "string") {
    throw new CallerWhereError("'search' must be a string");
  }
  const num = (k: "limit" | "offset"): number | undefined => {
    if (b[k] === undefined) return undefined;
    if (typeof b[k] !== "number" || !Number.isFinite(b[k])) {
      throw new CallerWhereError(`'${k}' must be a finite number`);
    }
    return b[k] as number;
  };
  return {
    caller,
    search: b.search as string | undefined,
    page: { limit: num("limit"), offset: num("offset") },
  };
}

/** Compose the authoritative `:id` path filter with the caller's `?where` narrowing into one read predicate.
 *  Two invariants hold together: `:id` is ALWAYS applied (a naive spread over `all()` would drop it, since
 *  `all()`'s enumerable `node` key makes `toNode` ignore a merged `id`), and the path `:id` OVERRIDES any
 *  caller `?where={"id": other}` — the path is the authoritative address, `?where` narrows other columns only. */
export function byIdWithin<HttpRow>(
  callerWhere: Where<HttpRow>,
  id: string,
): Where<HttpRow> {
  const base = "node" in callerWhere ? {} : callerWhere; // all() carries no column keys — drop it so it cannot shadow `id`
  return { ...(base as object), id } as unknown as Where<HttpRow>;
}

// The presigned file URL is short-lived by construction: the grant route clamps `?ttl=` to [1, MAX] seconds
// (default 5 min) — a leaked URL self-expires, never an effectively-permanent link past the policy gate.
const FILE_URL_TTL_MAX = 3600; // 1h ceiling
const FILE_URL_TTL_DEFAULT = 300; // 5 min default when `?ttl=` is absent/unparseable

/** Parse + clamp the presigned-URL TTL from `?ttl=` (seconds). Absent/unparseable/non-positive → default;
 *  any asked value floors to an integer and caps at the ceiling — the bound can't be widened from the wire. */
export function fileUrlTtl(c: { req: { raw: Request } }): number {
  const raw = new URL(c.req.raw.url).searchParams.get("ttl");
  const n = raw === null ? FILE_URL_TTL_DEFAULT : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return FILE_URL_TTL_DEFAULT;
  return Math.min(Math.floor(n), FILE_URL_TTL_MAX);
}

/** Read the `Idempotency-Key` request header (03-api-shape.md §HTTP contract). Blank/whitespace → absent
 *  (`undefined`), never arming the idempotency gate on an empty header; a present value is trimmed once. */
export function idempotencyKeyOf(
  c: { req: { raw: Request } },
): string | undefined {
  const raw = c.req.raw.headers.get("idempotency-key");
  if (raw === null) return undefined;
  const key = raw.trim();
  return key === "" ? undefined : key;
}

/** Parse the optimistic-lock expected version from `If-Match` — the ETag IS the row's `version`. An
 *  absent/`*`/unparseable header returns undefined, so a versioned update with no concrete precondition is
 *  rejected. A WEAK validator (`W/"1"`) is unparseable here: `If-Match` takes strong comparison only
 *  (RFC 9110 §13.1.1) and the framework emits no weak tag, so honouring one widens the door for nothing. */
export function ifMatchVersionOf(
  c: { req: { raw: Request } },
): number | undefined {
  const raw = c.req.raw.headers.get("if-match");
  if (raw === null) return undefined;
  const tag = raw.trim().replace(/^"|"$/g, "");
  if (tag === "" || tag === "*") return undefined;
  const n = Number(tag);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

// the seam-resolved actor, stashed once per request by the authn middleware so the throttle step and every
// handler read it (and re-derive scope from it) without re-running the chain.
export type AuthVars = {
  hazelActor: Actor;
  hazelTraceId: string;
  hazelWorkSignal: AbortSignal;
};
export type HonoCtx = {
  req: { raw: Request };
  get: {
    (k: "hazelActor"): Actor | undefined;
    (k: "hazelTraceId"): string | undefined;
    (k: "hazelWorkSignal"): AbortSignal | undefined;
  };
};
