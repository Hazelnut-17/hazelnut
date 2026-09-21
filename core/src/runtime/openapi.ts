import { z } from "zod";
import {
  httpPolicyMode,
  type HttpRoute,
  isExternalRoute,
  opIsCollection,
  type WireReadVerb,
  withheldFromOpsOf,
} from "../core/app-refs.ts";
import type { App, ResourceModel } from "../core/app.ts";
import { outputRedactSet, servedColumnsOf } from "../features/redact.ts";
import { ANON, CRUD_VERB_SET as CRUD_VERBS, userActor } from "../authz/auth.ts";
import { ERR_KINDS, type ErrKind, httpStatus } from "../core/pipeline.ts";
import type { OpDef } from "../core/pipeline.ts";
import {
  FILE_URL_TTL_DEFAULT,
  FILE_URL_TTL_MAX,
  routeBase,
} from "./serve-helpers.ts";
import { BULK_MAX } from "../data/data-verbs.ts";
import { emptyPatchWouldWrite } from "../data/repo-audit.ts";
import { PAGE_LIMIT_MAX } from "../data/repo-read.ts";
import { jsonSchemaInput, strictify } from "../data/schema.ts";
import {
  httpVisibleViews,
  runFormActorDenied,
  type ViewDecl,
  viewHttpPath,
} from "../features/view.ts";

/** A `password()` column rides `sensitive/not-in-response`: a client SENDS it and never receives it back.
 *  JSON Schema says exactly that with `writeOnly`, and without it a generated client models the field as
 *  readable and a doc renderer prints it in the response shape. `format` is the masking hint that goes
 *  with it — the same one the login face carries. */
function markWriteOnly(
  m: ResourceModel,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (m.passwords.length === 0) return schema;
  const props = schema.properties as Record<string, unknown> | undefined;
  if (!props) return schema;
  const next: Record<string, unknown> = { ...props };
  for (const pw of m.passwords) {
    const prop = next[pw];
    if (prop && typeof prop === "object") {
      next[pw] = {
        ...prop as Record<string, unknown>,
        writeOnly: true,
        format: "password",
      };
    }
  }
  return { ...schema, properties: next };
}

/**
 * Names `egressOp` subtracts from a custom-op return (sensitive ∪ encrypted ∪
 * withheld framework columns). OpenAPI's op 200 schema must document the wire
 * shape, not the declared `output` before that door — same contract as CRUD
 * reads using `servedColumnsOf`.
 */
function opDoorDropNames(models: readonly ResourceModel[]): Set<string> {
  const drop = new Set<string>();
  for (const m of models) {
    for (const f of outputRedactSet(m)) drop.add(f);
  }
  for (const f of withheldFromOpsOf(models)) drop.add(f);
  return drop;
}

/**
 * Recursively omit properties whose names the op door drops. `$ref` nodes are
 * left intact (component schemas are write contracts, not op returns).
 */
function stripOpDoorDrops(
  schema: unknown,
  drop: ReadonlySet<string>,
): unknown {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return schema;
  }
  const src = schema as Record<string, unknown>;
  if (typeof src.$ref === "string") return schema;
  const out: Record<string, unknown> = { ...src };
  if (
    out.properties && typeof out.properties === "object" &&
    !Array.isArray(out.properties)
  ) {
    const props: Record<string, unknown> = {
      ...(out.properties as Record<string, unknown>),
    };
    for (const k of Object.keys(props)) {
      if (drop.has(k)) delete props[k];
      else props[k] = stripOpDoorDrops(props[k], drop);
    }
    out.properties = props;
    if (Array.isArray(out.required)) {
      const kept = (out.required as string[]).filter((k) => !drop.has(k));
      if (kept.length > 0) out.required = kept;
      else delete out.required;
    }
  }
  if ("items" in out) out.items = stripOpDoorDrops(out.items, drop);
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    if (Array.isArray(out[key])) {
      out[key] = (out[key] as unknown[]).map((branch) =>
        stripOpDoorDrops(branch, drop)
      );
    }
  }
  return out;
}

/** Declared `output` JSON Schema after the same drops `egressOp` applies on the wire. */
function opWireOutputSchema(
  models: readonly ResourceModel[],
  output: z.ZodType,
): unknown {
  return stripOpDoorDrops(z.toJSONSchema(output), opDoorDropNames(models));
}

/** Signed-in probe for OpenAPI 403. A public run-form can admit ANON and `none()` a Bearer
 *  (`isAnonymous ? shared() : none()`) — probing only ANON under-documents that 403. */
const VIEW_SIGNED_IN_PROBE = userActor("authenticated");

/** OpenAPI `requestBody.required` tracks whether serve 400s an omitted body.
 *  `parseJsonBody` treats omit as `{}`, then Zod runs — required iff `{}` (plus any
 *  path-supplied seed) fails that parse. */
function jsonBodyRequired(schema: z.ZodType, seed: unknown = {}): boolean {
  return !strictify(schema).safeParse(seed).success;
}

/** Instance ops merge the path `:id` into an omitted body, so the seed is that merge. */
const INSTANCE_OP_OMIT_SEED = {
  id: "00000000-0000-4000-8000-000000000000",
} as const;

function viewHttpCanForbidden(
  v: ViewDecl & { http: NonNullable<ViewDecl["http"]> },
): boolean {
  if (v.http.policy === "policy") return true;
  return runFormActorDenied(v, ANON) ||
    runFormActorDenied(v, VIEW_SIGNED_IN_PROBE);
}

// the five CRUD verbs the declarative routes own; every OTHER `http` key names a custom operation
// (`m.operations`) mounted as `POST /<r>s/{id}/<op>` (serve.ts) — imported from auth.ts (the one source).

// The shared error-envelope component (03-api-shape.md §HTTP contract): every err.kind→HTTP response
// on a custom-op path references this schema, matching what the runtime serializes on a Result err.
const ERROR_ENVELOPE_REF = { $ref: "#/components/schemas/Error" } as const;
/** The Result rail has a closed eight-kind union, while auth/throttle middleware answers outside it.
 * Keep those contracts separate: reusing `Error` for a middleware body makes a real 429/503 invalid to
 * every generated client that trusts its enum. */
function errorEnvelopeSchema(
  kinds: readonly string[] = ERR_KINDS,
): Record<string, unknown> {
  return {
    type: "object",
    required: ["error"],
    properties: {
      error: {
        type: "object",
        required: ["kind", "message"],
        properties: {
          kind: { type: "string", enum: [...kinds] },
          message: { type: "string" },
        },
      },
    },
  };
}

const BULK_OUTCOME_REF = { $ref: "#/components/schemas/BulkOutcome" } as const;

/** The body `createMany` / `updateMany` serialize on HTTP 200 (`data-verbs.ts` BulkOutcome). */
function bulkOutcomeSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["succeeded", "failed"],
    properties: {
      succeeded: { type: "array", items: { type: "string" } },
      failed: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["index", "error"],
          properties: {
            index: { type: "integer" },
            error: {
              type: "object",
              required: ["kind", "message"],
              properties: {
                kind: { type: "string", enum: [...ERR_KINDS] },
                message: { type: "string" },
              },
            },
          },
        },
      },
    },
  };
}

const CREATED_ID_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: { type: "string" } },
} as const;

const UPDATED_TRUE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["updated"],
  properties: { updated: { type: "boolean", enum: [true] } },
} as const;

const FILE_GRANT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["url", "ttl"],
  properties: {
    url: { type: "string" },
    ttl: { type: "integer" },
  },
} as const;

function jsonContent(schema: unknown): {
  readonly content: {
    readonly "application/json": { readonly schema: unknown };
  };
} {
  return { content: { "application/json": { schema } } };
}

/** Serve maps `RestrictedDeleteError` to 409 from two paths: an inbound
 *  `onDelete:"restrict"` sweep (soft-deleting parent) and a tree node's default
 *  `onParentDelete:"restrict"`. Versioning adds stale-CAS 409 on the same status. */
function deleteCanConflict(m: ResourceModel): boolean {
  if (m.features.versioning === true) return true;
  if (m.onDeleteSweeps.some((s) => s.onDelete === "restrict")) return true;
  const tree = m.features.tree;
  if (!tree) return false;
  const mode = typeof tree === "object"
    ? tree.onParentDelete ?? "restrict"
    : "restrict";
  return mode === "restrict";
}

/** A DELETE route always answers 204, but its lifecycle effect is declaration-dependent.  In
 * particular, describing a soft delete as an ordinary physical delete teaches a generated client
 * that the row cannot be restored, while the read stack merely hides its tombstone. */
function deleteSuccessDescription(m: ResourceModel): string {
  return m.features.softDelete
    ? "soft-deleted — tombstoned and hidden from ordinary reads"
    : "deleted";
}

/** Serve maps unique (23505), temporal exclusion (23P01), versioned stale CAS,
 * field-level immutable freeze, and a tree re-parent cycle to 409. Document 409
 * only when one of those can fire. */
function writeCanConflict(
  m: ResourceModel,
  kind: "create" | "update",
): boolean {
  if (m.unique.length > 0) return true;
  const temporal = m.features.temporal;
  if (typeof temporal === "object" && (temporal.noOverlap?.length ?? 0) > 0) {
    return true;
  }
  if (kind === "update") {
    if (m.features.versioning === true) return true;
    const imm = m.features.immutable;
    if (typeof imm === "object" && (imm.fields?.length ?? 0) > 0) return true;
    if (m.features.tree) return true; // update({ parent_id }) can be refused by tree/no-cycle
  }
  return false;
}

/** The read-response component for a projection: each declared key keeps its Zod-derived shape, `id` is a
 *  string, and a framework-minted column stays unconstrained — its type lives in the DDL, not in Zod. */
function wireReadSchema(
  m: ResourceModel,
  cols: readonly string[],
): Record<string, unknown> {
  const json = z.toJSONSchema(m.schema) as {
    properties?: Record<string, unknown>;
    required?: readonly string[];
  };
  const properties: Record<string, unknown> = {};
  for (const c of cols) {
    properties[c] = c === "id"
      ? { type: "string" }
      : json.properties?.[c] ?? {};
  }
  const req = new Set(json.required ?? []);
  return {
    type: "object",
    additionalProperties: false, // the projection is closed — a column outside it never reaches the wire
    properties,
    required: cols.filter((c) => c === "id" || req.has(c)),
  };
}

// The op's error responses, keyed by the same err.kind→status contract the route runs through
// (httpStatus, pipeline.ts step 14) — one entry per distinct status; conflict/stale share 409.
function opErrorResponses(): Record<
  string,
  {
    readonly description: string;
    readonly content: Record<string, { readonly schema: unknown }>;
  }
> {
  const byStatus: Record<
    string,
    { description: string; content: Record<string, { schema: unknown }> }
  > = {};
  for (const kind of ERR_KINDS as readonly ErrKind[]) {
    const status = String(httpStatus(kind));
    byStatus[status] ??= {
      description: kind,
      content: { "application/json": { schema: ERROR_ENVELOPE_REF } },
    };
  }
  return byStatus;
}

// The pagination query parameters (03-api-shape.md §pagination) the read routes honor — documented so a
// generated client knows the paging knobs exist. Mixing `after` with `offset` is 400 on both doors.
/** GET `?after=` / QUERY `after` share this — serve 400s the mix; MCP is the same validation. */
const AFTER_OFFSET_MUTEX = "Mixing `offset` with `after` is 400 — drop one.";
const AFTER_DESCRIPTION =
  `opaque keyset cursor from a prior page's \`Hazelnut-Next-Cursor\` response header — stable pagination (no dup/skip under concurrent writes). ${AFTER_OFFSET_MUTEX}`;
/** The conditional-read header a `versioning` resource honours, and the response it earns. Emitted ONLY for
 *  a resource that versions: on one that does not, the runtime answers no `ETag` and a documented `304` would
 *  describe a reply that cannot happen. */
const IF_NONE_MATCH_PARAM = {
  name: "If-None-Match",
  in: "header",
  required: false,
  schema: { type: "string" },
  description:
    "a prior answer's strong `ETag`. Matching, the read answers 304 with no body. Weak (`W/`) validators are ignored and the read answers in full.",
} as const;

/** The compare-and-set header a `versioning` write REQUIRES: absent is 428, stale is 409. */
const IF_MATCH_PARAM = {
  name: "If-Match",
  in: "header",
  required: true,
  schema: { type: "string" },
  description:
    "the strong `ETag` of the row you read. Absent, a weak tag (`W/…`), `*`, a list, or anything that is not a non-negative integer → 428 (no precondition parsed). Different from the stored version → 409.",
} as const;

/** What `readCacheHeaders` puts on every GET read of a rowPolicy resource (serve-helpers.ts): the answer
 *  was chosen for ONE caller, so `private, no-store` asks a shared cache to abstain and `Vary` puts the
 *  credential in the key for one that ignores it. An un-policed read carries neither and must not claim to. */
const CACHE_HEADERS = {
  "Cache-Control": {
    description:
      "`private, no-store` — the rows were chosen by this caller's row-policy, so the answer is not a shared-cache entry",
    schema: { type: "string" },
  },
  Vary: {
    description:
      "`Authorization` — the credential is part of the cache key, so two bearers cannot collide on one entry",
    schema: { type: "string" },
  },
} as const;

const ETAG_HEADER = {
  ETag: {
    description:
      "the row's current version, strong. Send it back as `If-Match` on a write, or `If-None-Match` on the next read.",
    schema: { type: "string" },
  },
} as const;

const WHERE_PARAM = {
  name: "where",
  in: "query",
  required: false,
  schema: { type: "string" },
  description:
    "JSON object of column→scalar equality — the QUERY `filter` shorthand. Invalid JSON is 400. On find it AND-composes with the path id, never retargets it.",
} as const;

/** GET query-param description and QUERY body property share this — serve clamps both via `httpListPage`. */
const LIMIT_CLAMP_DESCRIPTION =
  `max rows to return (capped at ${PAGE_LIMIT_MAX}; a larger value is the same as ${PAGE_LIMIT_MAX})`;

const PAGINATION_PARAMS = [
  {
    name: "after",
    in: "query",
    required: false,
    schema: { type: "string" },
    description: AFTER_DESCRIPTION,
  },
  {
    name: "limit",
    in: "query",
    required: false,
    schema: { type: "integer", minimum: 0 },
    description: LIMIT_CLAMP_DESCRIPTION,
  },
  {
    name: "offset",
    in: "query",
    required: false,
    schema: { type: "integer", minimum: 0 },
    description: "rows to skip before the page",
  },
  WHERE_PARAM,
] as const;

const NEXT_CURSOR_HEADERS = {
  "Hazelnut-Next-Cursor": {
    description:
      "present when a FULL page of a caller-asked `limit` was returned: pass it back as `?after=` (GET) or `{ after }` (QUERY) to continue. Absent when the page ends the read, or when `limit` was omitted (unbounded).",
    schema: { type: "string" },
  },
} as const;

// The recognized Idempotency-Key request header (03-api-shape.md §HTTP contract), documented only
// on an op route whose op declares `idempotent:true`, mirroring serve.ts's `useIdem` gate.
const IDEMPOTENCY_HEADER = {
  name: "Idempotency-Key",
  in: "header",
  required: false,
  schema: { type: "string" },
  description:
    "dedup key — a resend with the same key replays the first result",
} as const;

/** `?mode=` on bulk HTTP (`serve-routes.ts`): `continue` isolates per-row failures into `failed[]`. */
const BULK_MODE_PARAM = {
  name: "mode",
  in: "query",
  required: false,
  schema: { enum: ["atomic", "continue"] },
  description:
    "`continue` isolates per-row failures into `failed[]`; absent ⇒ atomic",
} as const;

const HAZELNUT_VERSION_HEADER = {
  name: "Hazelnut-Version",
  in: "header",
  required: false,
  schema: { type: "string" },
  description:
    "API version pin. Unknown pins are validation/400. A date that maps to a different declared pin is echoed on `Hazelnut-Version-Resolved`; an exact pin is not.",
} as const;

/** `?ttl=` on the file grant (`fileUrlTtl`): serve clamps; never 400 for range. */
const FILE_TTL_PARAM = {
  name: "ttl",
  in: "query",
  required: false,
  schema: {
    type: "integer",
  },
  description:
    `seconds the minted URL lasts. Absent, unparseable, or ≤0 ⇒ ${FILE_URL_TTL_DEFAULT}. Values above ${FILE_URL_TTL_MAX} clamp to ${FILE_URL_TTL_MAX}.`,
} as const;

/** Derives an OpenAPI 3.2 document from the composed app — the same declarations that drive the
 *  HTTP routes (serve.ts), so the doc cannot drift. 3.2 (over 3.1) carries the native `query`
 *  operation for `QUERY /<plural>` (RFC 10008). */
export function deriveOpenApi(
  app: App,
  info: { readonly title: string; readonly version: string } = {
    title: "Hazelnut API",
    version: "0.0.0",
  },
): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  const schemas: Record<string, unknown> = {
    Error: errorEnvelopeSchema(),
    RateLimitedError: errorEnvelopeSchema(["rate_limited"]),
    AuthUnavailableError: errorEnvelopeSchema(["auth_unavailable"]),
    BulkOutcome: bulkOutcomeSchema(),
  }; // Error is the Result rail; middleware has its own exact error kinds.
  const idParam = {
    name: "id",
    in: "path",
    required: true,
    schema: { type: "string" },
  };
  const errJson = {
    content: { "application/json": { schema: ERROR_ENVELOPE_REF } },
  }; // the body a Result error route serializes
  const rateLimitedJson = {
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/RateLimitedError" },
      },
    },
  };
  const authUnavailableJson = {
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/AuthUnavailableError" },
      },
    },
  };
  // Middleware can 429 / 503 on any CRUD path (rate floor + auth resolver throw) —
  // same kinds SSE already documents (OPENAPI-CRUD-TRANSPORT-429-503).
  const transportRes = {
    "429": {
      description:
        "Rate limited — body.error.kind is rate_limited (transport middleware)",
      ...rateLimitedJson,
    },
    "503": {
      description:
        "Auth unavailable — body.error.kind is auth_unavailable (thrown resolver; never anonymous)",
      ...authUnavailableJson,
    },
  };
  const forbiddenRes = {
    "403": { description: "forbidden", ...errJson },
  };
  const writeForbidden = (route: HttpRoute | undefined) => {
    if (route === undefined) return {};
    if (httpPolicyMode(route) !== "policy" || isExternalRoute(route)) {
      return {};
    }
    return forbiddenRes;
  };
  const writeConflictRes = (
    m: ResourceModel,
    kind: "create" | "update",
  ): Record<string, unknown> =>
    writeCanConflict(m, kind)
      ? {
        "409": {
          description: kind === "create"
            ? "conflict (unique clash or overlapping validity window)"
            : "`body.error.kind` is `stale` when the `If-Match` version lost to a concurrent write — re-read the row and retry — or `conflict` for a unique clash, a frozen `immutable` field, or a tree cycle, which no retry can clear",
          ...errJson,
        },
      }
      : {};

  for (const topic of Object.keys(app.push?.topics ?? {}).sort()) {
    paths[`/events/${topic}`] = {
      get: {
        operationId: `invalidate_${topic}`,
        summary: "Observe authorized topic changes in the current scope",
        description: app.push?.topics[topic]?.rows
          ? `SSE event: rows carries the current '${
            app.push.topics[topic]!.rows!.resource
          }' list projection — bare GET (no ?where= / page): same rowPolicy, columns and redaction. Reconnect sends current rows; no event replay. Observation is rechecked during the stream; each rows frame re-reads the list projection.`
          : "SSE invalidate events contain only {}. Refetch through the read API. Reconnect invalidates current state; no event replay. Authorization is rechecked during the stream.",
        responses: {
          "200": {
            description: app.push?.topics[topic]?.rows
              ? "SSE row stream"
              : "SSE invalidation stream",
            content: { "text/event-stream": { schema: { type: "string" } } },
          },
          "204": {
            description:
              "Client abandoned before admission — empty body (observe already ran; no SSE slot taken)",
          },
          "403": { description: "Observation denied", ...errJson },
          "429": {
            description:
              "Connection limit — body.error.kind is rate_limited (transport, not the CRUD Error envelope)",
            ...rateLimitedJson,
          },
          "503": {
            description:
              "Observation unavailable — body.error.kind is auth_unavailable (transport, not the CRUD Error envelope)",
            ...authUnavailableJson,
          },
        },
      },
    };
  }

  for (const m of app.model) {
    schemas[m.name] = {
      description:
        `the WRITE body for ${m.name} — what a create or patch sends. It is not the read shape: the framework mints \`id\` and the lifecycle columns, and a redacted field never comes back.`,
      ...markWriteOnly(m, jsonSchemaInput(m.schema)),
    };
    const ref = { $ref: `#/components/schemas/${m.name}` };
    // the READ contract is the wire projection, which differs from the write body (it carries `id`, it may
    // carry a named framework column, and it never carries a redacted one). One component when both read
    // verbs project the same set, two when they diverge.
    const listCols = m.http["list"] ? servedColumnsOf(m, "list") : null;
    const findCols = m.http["find"] ? servedColumnsOf(m, "find") : null;
    const sameCols = listCols !== null && findCols !== null &&
      listCols.length === findCols.length &&
      listCols.every((c, i) => c === findCols[i]);
    const readRef = (verb: WireReadVerb, cols: readonly string[]) => {
      const name = sameCols
        ? `${m.name}_read`
        : `${m.name}_read_${verb}` as const;
      schemas[name] = {
        description:
          `the READ projection for ${m.name} — exactly the columns this door serves. It carries \`id\` and any named framework column, and omits every \`sensitive\`/\`encrypted\` one, so it differs from the write body by design.`,
        ...wireReadSchema(m, cols),
      };
      return { $ref: `#/components/schemas/${name}` };
    };
    const listRef = listCols ? readRef("list", listCols) : null;
    const findRef = findCols ? readRef("find", findCols) : null;
    const base = routeBase(m);
    const one = `${base}/{id}`;
    paths[base] ??= {};
    paths[one] ??= {};

    if (m.http["list"]) {
      // GET query knobs are the SAME `?where=&limit=&offset=&after=` serve.ts parses. A generated
      // client that never saw `where` could not filter; a 400 on bad JSON that the doc omitted
      // looked like an undocumented status.
      paths[base]["get"] = {
        summary: `List ${m.name}`,
        parameters: [...PAGINATION_PARAMS],
        responses: {
          "200": {
            headers: {
              ...NEXT_CURSOR_HEADERS,
              ...(m.rowPolicy !== null ? CACHE_HEADERS : {}),
            },
            description: `a list of ${m.name}`,
            content: {
              "application/json": {
                schema: { type: "array", items: listRef },
              },
            },
          },
          "400": { description: "validation error", ...errJson },
          ...transportRes,
        },
      };
      // QUERY /<plural> (RFC 10008; OpenAPI 3.2 adds the native `query` operation). The rich-read sibling of GET:
      // filter + full-text `search` (searchable resources only) ride a JSON requestBody (no URL-length limit).
      const queryProps: Record<string, unknown> = {
        filter: {
          type: "object",
          additionalProperties: true,
          description:
            "column→scalar equality filter (the GET ?where shorthand). Unknown columns and nested values are 400.",
        },
        ...(m.searchable.length > 0
          ? {
            search: {
              type: "string",
              description:
                "full-text query over the searchable columns (HTTP QUERY only; MCP list rejects `search`)",
            },
          }
          : {}),
        after: {
          type: "string",
          description: AFTER_DESCRIPTION,
        },
        limit: {
          type: "integer",
          minimum: 0,
          description: LIMIT_CLAMP_DESCRIPTION,
        },
        offset: {
          type: "integer",
          minimum: 0,
          description: "rows to skip before the page",
        },
      };
      paths[base]["query"] = {
        summary: m.searchable.length > 0
          ? `Query/search ${m.name}`
          : `Query ${m.name}`,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: queryProps,
                additionalProperties: false,
              },
            },
          },
        },
        responses: {
          "200": {
            headers: {
              ...NEXT_CURSOR_HEADERS,
            },
            description: `a list of ${m.name}`,
            content: {
              "application/json": {
                schema: { type: "array", items: listRef },
              },
            },
          },
          "400": { description: "validation error", ...errJson },
          ...transportRes,
        },
      };
    }
    const versioned = m.features.versioning === true;
    if (m.http["create"]) {
      // 409 = a unique-constraint clash (serve.ts maps `isUniqueViolation` → 409); both error bodies carry the envelope.
      // An array body is bulk create (`createMany`) — 200 BulkOutcome, same `?mode=` as collection PATCH.
      paths[base]["post"] = {
        summary: `Create ${m.name}`,
        parameters: [BULK_MODE_PARAM],
        requestBody: {
          required: jsonBodyRequired(m.schema),
          content: {
            "application/json": {
              schema: {
                oneOf: [
                  ref,
                  {
                    type: "array",
                    items: ref,
                    maxItems: BULK_MAX,
                    description:
                      `at most ${BULK_MAX} rows; a larger body is 400`,
                  },
                ],
              },
            },
          },
        },
        responses: {
          "201": {
            description: "created",
            // the write answers the version it wrote, so the next `If-Match` needs no read
            ...(versioned ? { headers: { ...ETAG_HEADER } } : {}),
            ...jsonContent(CREATED_ID_SCHEMA),
          },
          "200": {
            description: "bulk create",
            ...jsonContent(BULK_OUTCOME_REF),
          },
          "400": { description: "validation error", ...errJson },
          ...transportRes,
          ...writeForbidden(m.http["create"]),
          ...writeConflictRes(m, "create"),
        },
      };
    }
    if (m.http["find"]) {
      paths[one]["get"] = {
        summary: `Get a ${m.name}`,
        parameters: versioned
          ? [idParam, WHERE_PARAM, IF_NONE_MATCH_PARAM]
          : [idParam, WHERE_PARAM],
        responses: {
          "200": {
            description: m.name,
            headers: {
              ...(versioned ? ETAG_HEADER : {}),
              ...(m.rowPolicy !== null ? CACHE_HEADERS : {}),
            },
            content: { "application/json": { schema: findRef } },
          },
          "400": { description: "validation error", ...errJson },
          ...transportRes,
          ...(versioned
            ? {
              "304": {
                description:
                  "not modified — your copy is current. Answered only AFTER the row survived the read gate, so a 304 never reveals a row you may not see.",
                headers: { ...ETAG_HEADER },
              },
            }
            : {}),
          "404": { description: "not found", ...errJson },
        },
      };
    }
    if (m.http["update"]) {
      // 400 validation · 404 missing/out-of-scope · 409 stale (version CAS) OR a unique clash — every error body is the envelope.
      // The PATCH body is DERIVED from the same Zod source the runtime validates against —
      // `parsePatch` is `schema.partial()` — and emitted as its own component. The previous
      // `{ allOf: [createRef], required: [] }` did not describe that: JSON Schema does not clear the
      // $ref target's `required`, so a generated client kept demanding every create-required field on
      // PATCH while the runtime accepted a single key.
      const patchName = `${m.name}Patch`;
      const patchSchema = markWriteOnly(
        m,
        jsonSchemaInput(
          m.schema instanceof z.ZodObject ? m.schema.partial() : m.schema,
        ),
      );
      // NO_WRITE empty patch is 400 (`emptyPatchWouldWrite` false). Stamp/bump `{}` is a
      // real write — minProperties:1 there would document 400 while serve 200s.
      schemas[patchName] = emptyPatchWouldWrite(m)
        ? patchSchema
        : { ...patchSchema, minProperties: 1 };
      // The SAME `update` declaration mounts a bulk door at the collection (serve-routes.ts): one body,
      // many rows, `?mode=continue` isolating per-row failures. Undocumented, it was a route a generated
      // client could not call and a reader could not see. A versioning resource requires per-item
      // `expectedVersion` (428 when absent) — the single PATCH's If-Match sibling, not optional.
      const casWrite = m.features.versioning === true;
      const itemRequired = [
        "id",
        ...(casWrite ? ["expectedVersion"] as const : []),
        ...(!emptyPatchWouldWrite(m) ? ["patch"] as const : []),
      ];
      paths[base]["patch"] = {
        summary: `Update many ${m.name}s`,
        parameters: [BULK_MODE_PARAM],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "array",
                maxItems: BULK_MAX,
                description: `at most ${BULK_MAX} rows; a larger body is 400`,
                items: {
                  type: "object",
                  required: itemRequired,
                  properties: {
                    id: { type: "string" },
                    patch: { $ref: `#/components/schemas/${m.name}Patch` },
                    expectedVersion: {
                      oneOf: [
                        { type: "integer", minimum: 0 },
                        { type: "string" },
                      ],
                      description:
                        "the row's current version — the same token an ETag / If-Match carries (integer or digit string)",
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "bulk update",
            ...jsonContent(BULK_OUTCOME_REF),
          },
          "400": { description: "validation error", ...errJson },
          ...transportRes,
          ...writeForbidden(m.http["update"]),
          ...writeConflictRes(m, "update"),
          ...(casWrite
            ? {
              "428": {
                description:
                  "precondition required — a versioned bulk item without `expectedVersion` is refused",
                ...errJson,
              },
            }
            : {}),
          "404": {
            description:
              "not found — atomic mode, a listed id is missing or out of scope. `?mode=continue` still returns 200 with that id in failed[]",
            ...errJson,
          },
        },
      };
      paths[one]["patch"] = {
        summary: `Update a ${m.name}`,
        parameters: casWrite ? [idParam, IF_MATCH_PARAM] : [idParam],
        requestBody: {
          // omit ≡ `{}` (`parseJsonBody`). Stamp/bump 200s that; NO_WRITE 400s it.
          required: !emptyPatchWouldWrite(m),
          content: {
            "application/json": {
              schema: { $ref: `#/components/schemas/${patchName}` },
            },
          },
        },
        responses: {
          "200": {
            description: "updated",
            ...(versioned ? { headers: { ...ETAG_HEADER } } : {}),
            ...jsonContent(UPDATED_TRUE_SCHEMA),
          },
          "400": { description: "validation error", ...errJson },
          ...transportRes,
          ...writeForbidden(m.http["update"]),
          "404": { description: "not found", ...errJson },
          ...writeConflictRes(m, "update"),
          ...(casWrite
            ? {
              "428": {
                description:
                  "precondition required — this resource versions, so a write without `If-Match` is refused rather than allowed to overwrite a row it never read",
                ...errJson,
              },
            }
            : {}),
        },
      };
    }
    if (m.http["delete"]) {
      const casDelete = m.features.versioning === true;
      const conflict409 = deleteCanConflict(m);
      paths[one]["delete"] = {
        summary: `Delete a ${m.name}`,
        parameters: casDelete ? [idParam, IF_MATCH_PARAM] : [idParam],
        responses: {
          "204": { description: deleteSuccessDescription(m) },
          ...transportRes,
          ...writeForbidden(m.http["delete"]),
          "404": { description: "not found", ...errJson },
          ...(conflict409
            ? {
              "409": {
                description: casDelete
                  ? "`body.error.kind` is `stale` when the `If-Match` version lost to a concurrent write — re-read and retry — or `conflict` when a child still references this row under `onDelete:'restrict'`, which no retry can clear"
                  : "`body.error.kind` is `conflict` — a child still references this row under `onDelete:'restrict'`; remove or re-point it first. A retry cannot clear it",
                ...errJson,
              },
            }
            : {}),
          ...(casDelete
            ? {
              "428": {
                description:
                  "precondition required — a versioned delete without `If-Match` is refused",
                ...errJson,
              },
            }
            : {}),
        },
      };
    }
    // Custom operations (03-api-shape §custom-op-binding): every http key that is not a CRUD verb
    // and names a declared op mounts as POST /<r>s/{id}/<op> — the same path serve.ts mounts.
    for (const opName of Object.keys(m.http)) {
      if (CRUD_VERBS.has(opName) || !(opName in m.operations)) continue; // skip CRUD verbs and any non-op `http` key
      const decl = m.operations[opName] as OpDef<unknown>;
      // a collection op mints the resource → `POST /<plural>/<op>` with NO `:id`; an instance op is
      // `POST /<plural>/{id}/<op>`. Read the SAME combined signal serve.ts mounts on (explicit
      // `at:"collection"` OR the structural no-`id`-input fallback), so the documented path can never diverge
      // from the mounted one on the implicit form (03-api-shape.md §http-routes; boot pins the two signals agree).
      const collection = opIsCollection(m, opName);
      const opPath = collection ? `${base}/${opName}` : `${one}/${opName}`;
      // An idempotent op recognizes the Idempotency-Key header, documented only when idempotent:true;
      // an instance op also carries the {id} path param — the two compose into one parameters array.
      const params = [
        ...(collection ? [] : [idParam]),
        ...(decl.idempotent ? [IDEMPOTENCY_HEADER] : []),
      ];
      paths[opPath] ??= {};
      paths[opPath]["post"] = {
        summary: `${opName} on ${collection ? m.name : `a ${m.name}`}`,
        ...(params.length > 0 ? { parameters: params } : {}),
        requestBody: {
          required: jsonBodyRequired(
            decl.input,
            collection ? {} : INSTANCE_OP_OMIT_SEED,
          ),
          content: {
            "application/json": { schema: jsonSchemaInput(decl.input) },
          },
        },
        responses: {
          "200": decl.output
            ? {
              description:
                `${opName} result — documented shape matches the wire (sensitive, encrypted, and withheld names omitted)`,
              ...jsonContent({
                type: "object",
                required: ["result"],
                properties: {
                  result: opWireOutputSchema(app.model, decl.output),
                },
              }),
            }
            : { description: `${opName} result` },
          ...opErrorResponses(),
          ...transportRes,
        },
      };
    }
    // The presigned file grant (serve-routes.ts): mounted on the same pair — a `file()` field plus a
    // `find` door, because minting the URL runs `find`'s read gate. It was mounted and undocumented.
    if (m.files.length > 0 && m.http["find"]) {
      paths[`${base}/{id}/{field}/url`] = {
        get: {
          summary: `Mint a time-limited URL for one ${m.name} file field`,
          parameters: [
            idParam,
            {
              name: "field",
              in: "path",
              required: true,
              schema: { enum: [...m.files] },
              description: "a `file()` field of this resource",
            },
            FILE_TTL_PARAM,
          ],
          responses: {
            "200": {
              description:
                "a TTL-bounded URL and its expiry (`exp=` on a localDriver path; store TTL off-box). Follow the minted URL — this document does not list the bytes GET path (`serveBase` is the driver's)",
              ...jsonContent(FILE_GRANT_SCHEMA),
            },
            "404": {
              description: "no such row, field, or not readable",
              ...errJson,
            },
            ...transportRes,
          },
        },
      };
    }
  }
  // Task poll / cancel (05-runtime.md §task) — app-level, mounted iff the app declares a task.
  if ((app.tasks?.length ?? 0) > 0) {
    paths["/tasks/{id}"] = {
      get: {
        summary: "Poll an async task",
        parameters: [idParam],
        responses: {
          "200": {
            description:
              "task status; a succeeded poll answers `result` (inline) or `resultUrl` (offloaded), never both. A non-terminal poll may include `cancelRequested: true` when cooperative cancel was requested",
          },
          "404": { description: "no such task in this scope", ...errJson },
          "500": {
            description:
              "offloaded result and no storage configured — body.error.kind is storageUnconfigured (not the CRUD Error envelope)",
          },
          ...transportRes,
        },
      },
      delete: {
        summary: "Request cooperative cancellation of an async task",
        parameters: [idParam],
        responses: {
          "200": {
            description:
              "`{ cancelling: true }` when the cooperative flag was set; `{ cancelling: false }` when the task is already terminal (`succeeded`, `cancelled`, or `failed` including a DLQ corpse)",
          },
          "404": { description: "no such task in this scope", ...errJson },
          ...transportRes,
        },
      },
    };
  }
  const versioned = (app.versions?.length ?? 0) > 0;
  for (const v of httpVisibleViews(app.views ?? [])) {
    const vp = viewHttpPath(v);
    const runInput = typeof v.run === "function" && v.input;
    paths[vp] = {
      get: {
        operationId: `view_${v.name}`,
        parameters: runInput
          ? [{
            name: "input",
            in: "query",
            required: true,
            schema: { type: "string" },
            description:
              "JSON object for the view's `input` schema. Omitting it is 400 (`undefined` is not `{}`).",
          }]
          : [],
        responses: {
          "200": { description: `view ${v.name}` },
          // `"policy"` refuses anonymous before dispatch. `"public"` over-form never 403s (empty
          // rows). A public run-form throws ViewForbiddenError for whoever rowPolicy none()s —
          // ANON or a signed-in caller. Same door serve-routes-views.ts maps to 403.
          ...(viewHttpCanForbidden(v) ? forbiddenRes : {}),
          // Over-form omit is 200. Document 400 only when serve actually returns it: run-form
          // `?input=` validation, or an unknown `Hazelnut-Version` when versions are declared.
          ...(runInput || versioned
            ? { "400": { description: "validation", ...errJson } }
            : {}),
          ...transportRes,
        },
      },
    };
  }
  for (const p of Object.keys(paths)) {
    if (Object.keys(paths[p]!).length === 0) delete paths[p]; // drop unused path keys
  }
  if ((app.versions?.length ?? 0) > 0) {
    const methods = [
      "get",
      "put",
      "post",
      "delete",
      "options",
      "head",
      "patch",
      "trace",
      "query",
    ] as const;
    for (const p of Object.keys(paths)) {
      const item = paths[p]!;
      const existing = item.parameters;
      item.parameters = Array.isArray(existing)
        ? [...existing, HAZELNUT_VERSION_HEADER]
        : [HAZELNUT_VERSION_HEADER];
      for (const method of methods) {
        const op = item[method];
        if (op === undefined || typeof op !== "object" || op === null) continue;
        const rec = op as { responses?: Record<string, unknown> };
        rec.responses ??= {};
        if (rec.responses["400"] === undefined) {
          rec.responses["400"] = {
            description: "validation error",
            ...errJson,
          };
        }
      }
    }
  }

  return { openapi: "3.2.0", info, paths, components: { schemas } };
}
