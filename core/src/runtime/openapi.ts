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
import {
  grantedFileFields,
  outputRedactSet,
  servedColumnsOf,
} from "../features/redact.ts";
import { ANON, CRUD_VERB_SET as CRUD_VERBS, userActor } from "../authz/auth.ts";
import { ERR_KINDS, type ErrKind, httpStatus } from "../core/pipeline.ts";
import type { OpDef } from "../core/pipeline.ts";
import {
  FILE_URL_TTL_DEFAULT,
  FILE_URL_TTL_MAX,
  routeBase,
} from "./serve-helpers.ts";
import { BULK_MAX } from "../data/data-verbs.ts";
import { isBuiltinDataDoor } from "../core/resource-doors.ts";
import { restoreOptionsInput } from "../data/restore-input.ts";
import { schemaForWireMetadata } from "../data/schema-wire-projection.ts";
import { resourceInputSchema } from "../data/resource-input.ts";
import { markSequencePartitionReadOnly } from "../features/sequence-write.ts";
import { markUpdateReadOnly, markWriteOnly } from "../features/write-only.ts";
import {
  emptyPatchWouldWrite,
  onRowGate,
  timestampsGate,
} from "../data/repo-audit.ts";
import { PAGE_LIMIT_MAX } from "../data/repo-read.ts";
import { sortableKeyFields } from "../data/read-page.ts";
import { jsonSchemaInput, strictify } from "../data/schema.ts";
import {
  stableJsonSchemaEncoding,
  wireJsonSchema,
} from "../data/schema-types.ts";
import {
  httpVisibleViews,
  runFormActorDenied,
  type ViewDecl,
  viewHttpPath,
} from "../features/view.ts";

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
  return stripOpDoorDrops(
    stableJsonSchemaEncoding(wireJsonSchema(output)),
    opDoorDropNames(models),
  );
}

/** Signed-in probe for OpenAPI 403. A public run-form can admit ANON and `none()` a Bearer
 *  (`isAnonymous ? shared() : none()`) — probing only ANON under-documents that 403. */
const VIEW_SIGNED_IN_PROBE = userActor("authenticated");

/** Body-only validation: parseJsonBody treats omission as {}. Instance HTTP projection is handled below. */
function jsonBodyRequired(schema: z.ZodType): boolean {
  return !strictify(schemaForWireMetadata(schema)).safeParse({}).success;
}

/** HTTP alone supplies the authoritative instance id. Never validate a made-up id to decide body presence. */
function httpOpInput(input: z.ZodType, collection: boolean) {
  const schema = jsonSchemaInput(input);
  if (collection) {
    return {
      schema,
      required: jsonBodyRequired(input),
      idSchema: { type: "string" },
    };
  }
  const properties = {
    ...(schema.properties as Record<string, unknown> | undefined),
  };
  const idSchema = properties.id ?? { type: "string" };
  delete properties.id;
  const requiredKeys = ((schema.required as string[] | undefined) ?? []).filter(
    (key) => key !== "id",
  );
  // Object-level refinements are not representable JSON Schema; field defaults/refinements remain live here.
  const bodyRequired = input instanceof z.ZodObject
    ? jsonBodyRequired(
      z.object(Object.fromEntries(
        Object.entries(input.shape).filter(([key]) => key !== "id"),
      )),
    )
    : requiredKeys.length > 0;
  return {
    schema: { ...schema, properties, required: requiredKeys },
    required: bodyRequired,
    idSchema,
  };
}

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
      required: {
        type: "string",
        description:
          "HTTP CRUD development diagnostic only when HAZELNUT_DEV=1; absent from MCP and typed Result values",
      },
      error: {
        type: "object",
        required: ["kind", "message"],
        properties: {
          kind: { type: "string", enum: [...kinds] },
          message: { type: "string" },
          code: {
            type: "string",
            description: "optional stable framework refusal or retry code",
          },
          clause: {
            type: "string",
            description:
              "optional declared unique clause of the addressed resource; never a raw database constraint or conflicting value",
          },
          retryAfter: {
            type: "integer",
            minimum: 1,
            description: "retry delay in seconds, also sent as Retry-After",
          },
          throttle: {
            type: "object",
            required: ["limit", "remaining", "reset", "scope"],
            properties: {
              limit: { type: "integer", minimum: 0 },
              remaining: { type: "integer", minimum: 0 },
              reset: { type: "number" },
              scope: { type: "string", enum: ["credential"] },
            },
          },
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
                clause: {
                  type: "string",
                  description:
                    "optional declared unique clause of this resource",
                },
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

function updatedAckSchema(model: ResourceModel): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    ...UPDATED_TRUE_SCHEMA.properties,
  };
  if (model.features.versioning) {
    properties.version = { type: "integer", minimum: 1 };
  }
  if (timestampsGate(model)?.updated) {
    properties.updated_at = { type: "string", format: "date-time" };
  }
  if (onRowGate(model)?.updated) {
    properties.updated_by_type = { type: ["string", "null"] };
    properties.updated_by_id = { type: ["string", "null"] };
  }
  return {
    ...UPDATED_TRUE_SCHEMA,
    properties,
    required: Object.keys(properties),
  };
}

const FILE_GRANT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["url", "ttl"],
  properties: {
    url: { type: "string" },
    ttl: { type: "integer", minimum: 1 },
    exists: {
      type: "boolean",
      description: "present only when the storage driver implements head",
    },
    metadata: {
      type: "object",
      required: ["size"],
      properties: {
        size: { type: "integer", minimum: 0 },
        contentType: { type: "string" },
      },
    },
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

function schemaAllowsNull(schema: unknown): boolean {
  if (schema === true) return true;
  if (schema === false || schema === null || typeof schema !== "object") {
    return false;
  }
  const node = schema as Record<string, unknown>;
  if (
    node.type === "null" ||
    (Array.isArray(node.type) && node.type.includes("null"))
  ) return true;
  if (
    node.const === null ||
    (Array.isArray(node.enum) && node.enum.includes(null))
  ) return true;
  if (Array.isArray(node.anyOf)) return node.anyOf.some(schemaAllowsNull);
  if (Array.isArray(node.oneOf)) return node.oneOf.some(schemaAllowsNull);
  return Object.keys(node).length === 0;
}

/** The read-response component for a projection: each declared key keeps its Zod-derived shape, `id` is a
 *  string, and a framework-minted column stays unconstrained — its type lives in the DDL, not in Zod. */
function wireReadSchema(
  m: ResourceModel,
  cols: readonly string[],
): Record<string, unknown> {
  const json = stableJsonSchemaEncoding(wireJsonSchema(m.schema)) as {
    properties?: Record<string, unknown>;
    required?: readonly string[];
  };
  const properties: Record<string, unknown> = {};
  for (const c of cols) {
    const shape = c === "id" ? { type: "string" } : json.properties?.[c] ?? {};
    // Storage nullability survives an outer .default(), even when Zod's output is required.
    properties[c] = m.columns[c]?.nullable === true && !schemaAllowsNull(shape)
      ? { anyOf: [shape, { type: "null" }] }
      : shape;
  }
  return {
    type: "object",
    additionalProperties: false, // the projection is closed — a column outside it never reaches the wire
    properties,
    required: [...cols],
  };
}

type ResourceSchemaRole =
  | "write"
  | "patch"
  | "read"
  | "read_list"
  | "read_find";

function readProjection(m: ResourceModel) {
  const listCols = m.http.list ? servedColumnsOf(m, "list") : null;
  const findCols = m.http.find ? servedColumnsOf(m, "find") : null;
  const sameCols = listCols !== null && findCols !== null &&
    listCols.length === findCols.length &&
    listCols.every((c, i) => c === findCols[i]);
  return { listCols, findCols, sameCols };
}

/** Allocate the WHOLE component-owner set before writing any schema. Collisions qualify every owner, independent of order. */
function resourceSchemaKeys(
  models: readonly ResourceModel[],
  reserved: readonly string[],
) {
  const requests: {
    model: ResourceModel;
    role: ResourceSchemaRole;
    preferred: string;
  }[] = [];
  for (const m of models) {
    requests.push({ model: m, role: "write", preferred: m.name });
    if (m.http.update) {
      requests.push({ model: m, role: "patch", preferred: `${m.name}Patch` });
    }
    const { listCols, findCols, sameCols } = readProjection(m);
    if (sameCols) {
      requests.push({ model: m, role: "read", preferred: `${m.name}_read` });
    } else {
      if (listCols) {
        requests.push({
          model: m,
          role: "read_list",
          preferred: `${m.name}_read_list`,
        });
      }
      if (findCols) {
        requests.push({
          model: m,
          role: "read_find",
          preferred: `${m.name}_read_find`,
        });
      }
    }
  }
  const counts = new Map(reserved.map((key) => [key, 1]));
  for (const { preferred } of requests) {
    counts.set(preferred, (counts.get(preferred) ?? 0) + 1);
  }
  const keys = new Map<
    ResourceModel,
    Partial<Record<ResourceSchemaRole, string>>
  >();
  for (const { model, role, preferred } of requests) {
    const names = keys.get(model) ?? {};
    // Declaration schema/resource segments cannot contain dots; role is a closed vocabulary.
    names[role] = counts.get(preferred) === 1
      ? preferred
      : `${model.pgSchema}.${model.name}.${role}`;
    keys.set(model, names);
  }
  return (m: ResourceModel, role: ResourceSchemaRole) => keys.get(m)![role]!;
}

// The op's error responses, keyed by the same err.kind→status contract the route runs through
// (httpStatus, pipeline.ts step 14) — one entry per distinct status; conflict/stale share 409.
// Handler/admit/before code can return any kind, including forbidden on a public/external route.
// These are potential Result responses, not a promise that an automatic policy gate runs.
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
      description:
        `${kind} — possible handler/Result refusal; automatic permission admission depends on the route and authored policy`,
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
    "the strong `ETag` of the row you read. Absent, a weak tag (`W/…`), `*`, a list, or anything that is not a non-negative integer → 428 with error.kind=validation (version/precondition-required). A different version on a still-visible row → 409 stale; a missing, hidden or expired target → 404 notFound.",
} as const;

/** What `readCacheHeaders` puts on every GET read of a rowPolicy resource (serve-helpers.ts): the answer
 *  was chosen for ONE caller, so `private, no-store` asks a shared cache to abstain and `Vary` puts the
 *  credential in the key for one that ignores it. An un-policed read carries neither and must not claim to. */
const CACHE_HEADERS = {
  "Cache-Control": {
    description:
      "`private, no-store` — conservative for every declared rowPolicy (including shared()) and every view; no shared-cache entry is promised",
    schema: { type: "string" },
  },
  Vary: {
    description:
      "`Authorization` — emitted conservatively with declared rowPolicy and view reads, even when a particular policy returns shared()",
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
  `max rows to return (defaults to ${PAGE_LIMIT_MAX}; capped at ${PAGE_LIMIT_MAX}; a larger value is the same as ${PAGE_LIMIT_MAX})`;

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
    schema: { type: "integer", minimum: 1, default: PAGE_LIMIT_MAX },
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

const AS_OF_PARAM = {
  name: "asOf",
  in: "query",
  required: false,
  schema: { type: "string", format: "date-time" },
  description:
    "Temporal and expiry visibility at this ISO instant; soft-deletion and authorization remain current.",
} as const;
const NEXT_CURSOR_HEADERS = {
  "Hazelnut-Has-More": {
    description:
      "Whether a lookahead row proved another page exists, even when its cursor key is withheld.",
    schema: { type: "boolean" },
  },
  "Hazelnut-Next-Offset": {
    description:
      "Safe continuation offset when hasMore is true and the request used offset pagination; absent for keyset requests.",
    schema: { type: "integer", minimum: 0 },
  },
  "Hazelnut-Next-Cursor": {
    description:
      "Present only without an explicit offset, when lookahead proves another page exists, the encoded tuple fits 8192 characters, and the final projection safely carries the cursor key: pass it back as `?after=` (GET) or `{ after }` (QUERY). A full final page has no next cursor.",
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
    "dedup key — a resend reuses the settled execution, then applies this door's current redaction to its stored masked result",
} as const;

/** HTTP continue commits surviving rows independently; ctx continue keeps savepoints in its caller tx. */
const BULK_MODE_PARAM = {
  name: "mode",
  in: "query",
  required: false,
  schema: { enum: ["atomic", "continue"] },
  description:
    "`continue` commits each surviving row in its own HTTP transaction and reports per-row failures in failed[]; inspect failed even on 200, including all-failed batches. Earlier commits survive later failures. Absent ⇒ one atomic batch. Inside ctx.data, continue uses savepoints in the caller's transaction instead; MCP has no automatic bulk tools.",
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
    `seconds the minted URL lasts, floored to whole seconds and kept within 1–${FILE_URL_TTL_MAX}. Absent, unparseable, or ≤0 ⇒ ${FILE_URL_TTL_DEFAULT}.`,
} as const;

/** Derives structural OpenAPI 3.2 from the HTTP declarations. Executable Zod refinements remain runtime
 *  checks, not a complete JSON Schema promise. 3.2 carries native `query` for `QUERY /<plural>` (RFC 10008). */
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
  const schemaKey = resourceSchemaKeys(app.model, Object.keys(schemas));
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
        operationId: `${
          app.push?.topics[topic]?.rows ? "rows" : "invalidate"
        }_${topic}`,
        summary: "Observe authorized topic changes in the current scope",
        description: app.push?.topics[topic]?.rows
          ? `SSE event: rows carries the current '${
            app.push.topics[topic]!.rows!.resource
          }' full, unpaged live snapshot: same rowPolicy and redaction as GET list, using the list projection even when GET find projects different columns. HTTP defaults to a 100-row page; SSE does not apply that limit or promise the same row order. Reconnect sends current rows; no event replay. Observation is rechecked during the stream; each rows frame re-reads the list projection.`
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
          "400": {
            description: "Unknown query key or invalid version pin",
            ...errJson,
          },
          "404": { description: "Unknown topic", ...errJson },
          "405": {
            description: "Only GET is supported; HEAD returns an empty body",
            headers: { Allow: { schema: { const: "GET" } } },
          },
          "504": {
            description: "Request deadline elapsed before stream admission",
            ...errJson,
          },
          "403": { description: "Observation denied", ...errJson },
          "429": {
            description:
              "Connection limit — preflight before auth/observe and checked again before admission; body.error.kind is rate_limited",
            headers: {
              "Retry-After": { schema: { type: "integer", const: 1 } },
            },
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
    const writeName = schemaKey(m, "write");
    schemas[writeName] = {
      description:
        `the WRITE body for ${m.name} — what a create sends. The framework mints \`id\` and lifecycle stamps; temporal window fields may be supplied. A redacted field never comes back.`,
      ...markWriteOnly(m, jsonSchemaInput(resourceInputSchema(m, false, true))),
    };
    const ref = { $ref: `#/components/schemas/${writeName}` };
    // the READ contract is the wire projection, which differs from the write body (it carries `id`, it may
    // carry a named framework column, and it never carries a redacted one). One component when both read
    // verbs project the same set, two when they diverge.
    const { listCols, findCols, sameCols } = readProjection(m);
    const readRef = (verb: WireReadVerb, cols: readonly string[]) => {
      const name = schemaKey(m, sameCols ? "read" : `read_${verb}`);
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
        parameters: [
          ...PAGINATION_PARAMS,
          ...(m.features.temporal ? [AS_OF_PARAM] : []),
          {
            name: "sort",
            in: "query",
            required: false,
            schema: { type: "string" },
            description:
              "JSON {field,direction?:asc|desc}; field must be a non-null delivered sortable column; keep the same sort with after",
          },
        ],
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
        ...(m.features.temporal ? { asOf: AS_OF_PARAM.schema } : {}),
        sort: {
          type: "object",
          properties: {
            field: {
              type: "string",
              enum: servedColumnsOf(m, "list").filter((field) =>
                sortableKeyFields(m).includes(field)
              ),
            },
            direction: { type: "string", enum: ["asc", "desc"] },
          },
          required: ["field"],
          additionalProperties: false,
        },
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
              description: "full-text query over the searchable columns",
            },
          }
          : {}),
        after: {
          type: "string",
          description: AFTER_DESCRIPTION,
        },
        limit: {
          type: "integer",
          minimum: 1,
          default: PAGE_LIMIT_MAX,
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
          description:
            "JSON object bytes are required; Content-Type is not enforced for this safe read method",
          content: Object.fromEntries(
            ["application/json", "*/*"].map((media) => [media, {
              schema: {
                type: "object",
                properties: queryProps,
                additionalProperties: false,
              },
            }]),
          ),
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
          "400": {
            description:
              "validation error, including a refused Idempotency-Key header: CRUD create never deduplicates",
            ...errJson,
          },
          ...transportRes,
          ...writeForbidden(m.http["create"]),
          ...writeConflictRes(m, "create"),
        },
      };
    }
    if (m.http["find"]) {
      paths[one]["get"] = {
        summary: `Get a ${m.name}`,
        parameters: [
          idParam,
          WHERE_PARAM,
          ...(versioned ? [IF_NONE_MATCH_PARAM] : []),
          ...(m.features.temporal ? [AS_OF_PARAM] : []),
        ],
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
      const patchName = schemaKey(m, "patch");
      const patchSchema = markUpdateReadOnly(
        m,
        markSequencePartitionReadOnly(
          m,
          markWriteOnly(
            m,
            jsonSchemaInput(
              resourceInputSchema(m, true, true).partial(),
            ),
          ),
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
                    patch: { $ref: `#/components/schemas/${patchName}` },
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
            ...jsonContent(updatedAckSchema(m)),
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
          "204": {
            description: deleteSuccessDescription(m),
            ...(casDelete && m.features.softDelete
              ? { headers: ETAG_HEADER }
              : {}),
          },
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
    if (m.http.count && isBuiltinDataDoor(m, "count")) {
      paths[`${base}/count`] = {
        get: {
          summary: `Count visible ${m.name} rows`,
          parameters: [
            WHERE_PARAM,
            ...(m.features.temporal ? [AS_OF_PARAM] : []),
            ...(m.searchable.length
              ? [{
                name: "search",
                in: "query",
                required: false,
                schema: { type: "string" },
              }]
              : []),
          ],
          responses: {
            "200": {
              description:
                "Exact stack-visible count; no pagination is applied",
              ...(m.rowPolicy !== null ? { headers: CACHE_HEADERS } : {}),
              ...jsonContent({
                type: "object",
                required: ["count"],
                properties: { count: { type: "integer", minimum: 0 } },
                additionalProperties: false,
              }),
            },
            "400": { description: "validation error", ...errJson },
            ...transportRes,
          },
        },
      };
    }
    if (m.http.restore && isBuiltinDataDoor(m, "restore")) {
      paths[`${one}/restore`] = {
        post: {
          summary: `Restore a soft-deleted ${m.name}`,
          description:
            "Uses the update permission, current scope and row policy. Superseded heads, expired tombstones without permitted renewal, and hidden rows stay unavailable. A unique-key reuse can conflict; restore does not accept a caller CAS token.",
          parameters: [idParam],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: jsonSchemaInput(restoreOptionsInput(m)),
              },
            },
          },
          responses: {
            "200": {
              description: "restored",
              ...(versioned ? { headers: ETAG_HEADER } : {}),
              ...jsonContent({
                type: "object",
                required: ["restored", ...(versioned ? ["version"] : [])],
                properties: {
                  restored: { const: true },
                  ...(versioned ? { version: { type: "integer" } } : {}),
                },
                additionalProperties: false,
              }),
            },
            "400": { description: "validation error", ...errJson },
            "404": { description: "not found or not restorable", ...errJson },
            "409": {
              description:
                "a live row already uses a unique key or temporal window",
              ...errJson,
            },
            ...transportRes,
            ...writeForbidden(m.http.restore),
          },
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
      const body = httpOpInput(decl.input, collection);
      const opPath = collection ? `${base}/${opName}` : `${one}/${opName}`;
      // An idempotent op recognizes the Idempotency-Key header, documented only when idempotent:true;
      // an instance op also carries the {id} path param — the two compose into one parameters array.
      const params = [
        ...(collection ? [] : [{ ...idParam, schema: body.idSchema }]),
        ...(decl.idempotent ? [IDEMPOTENCY_HEADER] : []),
      ];
      paths[opPath] ??= {};
      paths[opPath]["post"] = {
        summary: `${opName} on ${collection ? m.name : `a ${m.name}`}`,
        ...(decl.deprecated ? { deprecated: true } : {}),
        description: isExternalRoute(m.http[opName]!)
          ? "External route skips automatic op-policy admission; handler Result errors remain possible."
          : httpPolicyMode(m.http[opName]!) === "public"
          ? "Public route skips injected default permission admission; authored policy and handler Result errors remain possible."
          : "Policy route applies declared or convention-seeded permission admission; handler Result errors remain possible.",
        ...(params.length > 0 ? { parameters: params } : {}),
        requestBody: {
          required: body.required,
          content: {
            "application/json": { schema: body.schema },
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
            : {
              description:
                `${opName} result — undeclared shape; undefined is omitted from JSON`,
              ...jsonContent({ type: "object", properties: { result: {} } }),
            },
          ...opErrorResponses(),
          ...transportRes,
        },
      };
      const evolutionHeaders = {
        ...(decl.deprecated
          ? {
            Deprecation: {
              description:
                "When this route reaches operation dispatch; pre-dispatch middleware and body refusals may omit it",
              schema: {
                type: "string",
                const: `@${
                  Math.floor(new Date(decl.deprecated).getTime() / 1000)
                }`,
              },
            },
          }
          : {}),
        ...(decl.sunset
          ? {
            Sunset: {
              description: "When this route reaches operation dispatch",
              schema: {
                type: "string",
                const: new Date(decl.sunset).toUTCString(),
              },
            },
          }
          : {}),
        ...(decl.replacedBy
          ? {
            Link: {
              description: "When this route reaches operation dispatch",
              schema: {
                type: "string",
                const: `<${base}/${decl.replacedBy}>; rel="successor-version"`,
              },
            },
          }
          : {}),
      };
      const responses = paths[opPath]["post"] as {
        responses: Record<string, { headers?: Record<string, unknown> }>;
      };
      for (const response of Object.values(responses.responses)) {
        response.headers = {
          ...(response.headers ?? {}),
          "Cache-Control": { schema: { const: "no-store" } },
          ...evolutionHeaders,
        };
      }
    }
    // The presigned file grant (serve-routes.ts): mounted on the same pair — a `file()` field plus a
    // `find` door, because minting the URL runs `find`'s read gate. It was mounted and undocumented.
    const granted = grantedFileFields(m);
    if (granted.length > 0) {
      paths[`${base}/{id}/{field}/url`] = {
        get: {
          summary: `Mint a time-limited URL for one ${m.name} file field`,
          parameters: [
            idParam,
            {
              name: "field",
              in: "path",
              required: true,
              schema: { enum: [...granted] },
              description: "a `file()` field the `find` route serializes",
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
            "500": {
              description: "storage is unconfigured or failed",
              ...errJson,
            },
            ...transportRes,
          },
        },
      };
      paths[`${base}/{id}/{field}/upload-url`] = {
        post: {
          summary: `Mint an if-absent upload URL for one ${m.name} file field`,
          description:
            "Requires the resource update permission and full row visibility. Uses the currently stored key; replace the field to mint a new key before replacing bytes. The storage driver must advertise atomic conditionalPut support.",
          parameters: [idParam, {
            name: "field",
            in: "path",
            required: true,
            schema: { enum: [...granted] },
          }, FILE_TTL_PARAM],
          responses: {
            "200": {
              description:
                "PUT URL for a fresh object key; upload is a separate request",
              ...jsonContent({
                type: "object",
                required: ["url", "ttl", "method"],
                properties: {
                  url: { type: "string" },
                  ttl: { type: "integer", minimum: 1 },
                  method: { const: "PUT" },
                },
              }),
            },
            "403": { description: "update permission denied", ...errJson },
            "404": {
              description: "row or projected file field not readable",
              ...errJson,
            },
            "409": { description: "object bytes already exist", ...errJson },
            "422": {
              description: "storage lacks atomic if-absent upload support",
              ...errJson,
            },
            "500": { description: "storage operation failed", ...errJson },
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
        parameters: [idParam, {
          name: "name",
          in: "query",
          required: false,
          schema: { type: "string", enum: app.tasks!.map((task) => task.name) },
          description: "optional declared task name; narrows the owning task",
        }],
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
        parameters: [idParam, {
          name: "name",
          in: "query",
          required: false,
          schema: { type: "string", enum: app.tasks!.map((task) => task.name) },
          description: "optional declared task name; narrows the owning task",
        }],
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
  if ((app.workflows?.length ?? 0) > 0) {
    paths["/workflows/{name}/{id}"] = {
      get: {
        summary: "Inspect an owned workflow",
        parameters: [{
          name: "name",
          in: "path",
          required: true,
          schema: {
            type: "string",
            enum: app.workflows!.map((workflow) => workflow.name),
          },
        }, idParam],
        responses: {
          "200": {
            description:
              "Scoped owner workflow metadata; no results or raw errors",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: [
                    "workflowId",
                    "completed",
                    "cancelRequested",
                    "steps",
                  ],
                  properties: {
                    workflowId: { type: "string" },
                    completed: { type: "boolean" },
                    cancelRequested: { type: "boolean" },
                    steps: {
                      type: "array",
                      items: {
                        type: "object",
                        required: ["stepId", "status", "attempts", "errorKind"],
                        properties: {
                          stepId: { type: "string" },
                          status: { type: "string" },
                          attempts: { type: "integer" },
                          errorKind: { type: ["string", "null"] },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          "404": { description: "unknown or unowned workflow", ...errJson },
          ...transportRes,
        },
      },
      delete: {
        summary: "Request cooperative cancellation of an owned workflow",
        parameters: [{
          name: "name",
          in: "path",
          required: true,
          schema: {
            type: "string",
            enum: app.workflows!.map((workflow) => workflow.name),
          },
        }, idParam],
        responses: {
          "200": {
            description: "Cooperative request; completed runs return false",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["cancelling"],
                  properties: { cancelling: { type: "boolean" } },
                },
              },
            },
          },
          "404": { description: "unknown or unowned workflow", ...errJson },
          ...transportRes,
        },
      },
    };
  }
  for (const v of httpVisibleViews(app.views ?? [])) {
    const vp = viewHttpPath(v);
    const runInput = v.query?.input ?? (typeof v.run === "function" && v.input);
    const queryOmissionAccepted = v.query && runInput
      ? runInput.safeParse({}).success
      : false;
    paths[vp] = {
      get: {
        operationId: `view_${v.name}`,
        parameters: runInput
          ? [{
            name: "input",
            in: "query",
            required: !queryOmissionAccepted,
            schema: { type: "string" },
            description: v.query
              ? "JSON object for the query's input schema. Omission validates {} (including declared defaults)."
              : "JSON object for the view's `input` schema. Omitting it is 400 (`undefined` is not `{}`).",
          }]
          : [],
        responses: {
          "200": { description: `view ${v.name}`, headers: CACHE_HEADERS },
          // `"policy"` refuses anonymous before dispatch. `"public"` over-form never 403s (empty
          // rows). A public run-form throws ViewForbiddenError for whoever rowPolicy none()s —
          // ANON or a signed-in caller. Same door serve-routes-views.ts maps to 403.
          ...(viewHttpCanForbidden(v) ? forbiddenRes : {}),
          "400": {
            description:
              "validation, including unknown query keys on every view form",
            ...errJson,
          },
          "404": { description: "not found", ...errJson },
          "500": { description: "internal view failure", ...errJson },
          "504": { description: "view or request deadline", ...errJson },
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

  return {
    openapi: "3.2.0",
    info,
    paths,
    components: { schemas: reachableSchemas(paths, schemas) },
  };
}

/** The component schemas a published path reaches, directly or through another component. A resource
 *  that mounts no HTTP route (a module-internal one) publishes no write or read contract here. */
function reachableSchemas(
  roots: unknown,
  schemas: Record<string, unknown>,
): Record<string, unknown> {
  const prefix = "#/components/schemas/";
  const keep = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (v === null || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      if (k === "$ref" && typeof x === "string" && x.startsWith(prefix)) {
        const name = x.slice(prefix.length);
        if (!keep.has(name) && name in schemas) {
          keep.add(name);
          walk(schemas[name]);
        }
      } else walk(x);
    }
  };
  walk(roots);
  return Object.fromEntries(
    Object.entries(schemas).filter(([name]) => keep.has(name)),
  );
}
