import { z } from "zod";
import { opIsCollection, type WireReadVerb } from "../core/app-refs.ts";
import type { App, ResourceModel } from "../core/app.ts";
import { servedColumnsOf } from "../features/redact.ts";
import { CRUD_VERB_SET as CRUD_VERBS } from "../authz/auth.ts";
import { ERR_KINDS, type ErrKind, httpStatus } from "../core/pipeline.ts";
import type { OpDef } from "../core/pipeline.ts";
import { routeBase } from "./serve-helpers.ts";
import { httpVisibleViews, viewHttpPath } from "../features/view.ts";

// the five CRUD verbs the declarative routes own; every OTHER `http` key names a custom operation
// (`m.operations`) mounted as `POST /<r>s/{id}/<op>` (serve.ts) — imported from auth.ts (the one source).

// The shared error-envelope component (03-api-shape.md §HTTP contract): every err.kind→HTTP response
// on a custom-op path references this schema, matching what the runtime serializes on a Result err.
const ERROR_ENVELOPE_REF = { $ref: "#/components/schemas/Error" } as const;
function errorEnvelopeSchema(): Record<string, unknown> {
  return {
    type: "object",
    required: ["error"],
    properties: {
      error: {
        type: "object",
        required: ["kind", "message"],
        properties: {
          kind: { type: "string", enum: [...ERR_KINDS] }, // the closed err.kind union — the SAME source the routes map through
          message: { type: "string" },
        },
      },
    },
  };
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

// The offset-pagination query parameters (03-api-shape.md §pagination) the `list` route honors —
// documented so a generated client knows the paging knobs exist (keyset `after` is HTTP-absent by design).
const PAGINATION_PARAMS = [
  {
    name: "limit",
    in: "query",
    required: false,
    schema: { type: "integer", minimum: 0 },
    description: "max rows to return (offset pagination)",
  },
  {
    name: "offset",
    in: "query",
    required: false,
    schema: { type: "integer", minimum: 0 },
    description: "rows to skip before the page",
  },
] as const;

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
  const schemas: Record<string, unknown> = { Error: errorEnvelopeSchema() }; // the shared error-envelope component every error response references
  const idParam = {
    name: "id",
    in: "path",
    required: true,
    schema: { type: "string" },
  };
  const errJson = {
    content: { "application/json": { schema: ERROR_ENVELOPE_REF } },
  }; // the body a CRUD error route serializes

  for (const m of app.model) {
    schemas[m.name] = z.toJSONSchema(m.schema); // the WRITE contract — a create/update body, never a read
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
      schemas[name] = wireReadSchema(m, cols);
      return { $ref: `#/components/schemas/${name}` };
    };
    const listRef = listCols ? readRef("list", listCols) : null;
    const findRef = findCols ? readRef("find", findCols) : null;
    const base = routeBase(m);
    const one = `${base}/{id}`;
    paths[base] ??= {};
    paths[one] ??= {};

    if (m.http["list"]) {
      // the offset-pagination knobs are documented query parameters — the SAME `?limit=&offset=` serve.ts parses.
      paths[base]["get"] = {
        summary: `List ${m.name}`,
        parameters: [...PAGINATION_PARAMS],
        responses: {
          "200": {
            description: `a list of ${m.name}`,
            content: {
              "application/json": {
                schema: { type: "array", items: listRef },
              },
            },
          },
        },
      };
      // QUERY /<plural> (RFC 10008; OpenAPI 3.2 adds the native `query` operation). The rich-read sibling of GET:
      // filter + full-text `search` (searchable resources only) ride a JSON requestBody (no URL-length limit).
      const queryProps: Record<string, unknown> = {
        filter: {
          type: "object",
          additionalProperties: true,
          description:
            "column→scalar equality filter (the GET ?where shorthand)",
        },
        ...(m.searchable.length > 0
          ? {
            search: {
              type: "string",
              description: "full-text query over the searchable columns",
            },
          }
          : {}),
        limit: { type: "integer", minimum: 0 },
        offset: { type: "integer", minimum: 0 },
      };
      paths[base]["query"] = {
        summary: `Query/search ${m.name}`,
        requestBody: {
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
            description: `a list of ${m.name}`,
            content: {
              "application/json": {
                schema: { type: "array", items: listRef },
              },
            },
          },
          "400": { description: "validation error", ...errJson },
        },
      };
    }
    if (m.http["create"]) {
      // 409 = a unique-constraint clash (serve.ts maps `isUniqueViolation` → 409); both error bodies carry the envelope.
      paths[base]["post"] = {
        summary: `Create ${m.name}`,
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref } },
        },
        responses: {
          "201": { description: "created" },
          "400": { description: "validation error", ...errJson },
          "409": { description: "conflict (unique clash)", ...errJson },
        },
      };
    }
    if (m.http["find"]) {
      paths[one]["get"] = {
        summary: `Get a ${m.name}`,
        parameters: [idParam],
        responses: {
          "200": {
            description: m.name,
            content: { "application/json": { schema: findRef } },
          },
          "404": { description: "not found", ...errJson },
        },
      };
    }
    if (m.http["update"]) {
      // 400 validation · 404 missing/out-of-scope · 409 stale (version CAS) OR a unique clash — every error body is the envelope.
      paths[one]["patch"] = {
        summary: `Update a ${m.name}`,
        parameters: [idParam],
        requestBody: {
          content: {
            "application/json": {
              schema: { allOf: [ref], required: [] },
            },
          },
        },
        responses: {
          "200": { description: "updated" },
          "400": { description: "validation error", ...errJson },
          "404": { description: "not found", ...errJson },
          "409": { description: "stale or conflict", ...errJson },
        },
      };
    }
    if (m.http["delete"]) {
      paths[one]["delete"] = {
        summary: `Delete a ${m.name}`,
        parameters: [idParam],
        responses: {
          "204": { description: "deleted" },
          "404": { description: "not found", ...errJson },
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
      // from the mounted one on the implicit form (03-api-shape.md §3; boot pins the two signals agree).
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
          required: true,
          content: {
            "application/json": { schema: z.toJSONSchema(decl.input) },
          },
        },
        responses: {
          "200": { description: `${opName} result` },
          ...opErrorResponses(),
        },
      };
    }
  }
  for (const v of httpVisibleViews(app.views ?? [])) {
    const vp = viewHttpPath(v);
    paths[vp] = {
      get: {
        operationId: `view_${v.name}`,
        parameters: v.input
          ? [{
            name: "input",
            in: "query",
            required: false,
            schema: { type: "string" },
            description: "JSON filter for a run-form view",
          }]
          : [],
        responses: {
          "200": { description: `view ${v.name}` },
          "403": { description: "forbidden", ...errJson },
          "400": { description: "validation", ...errJson },
        },
      },
    };
  }
  for (const p of Object.keys(paths)) {
    if (Object.keys(paths[p]!).length === 0) delete paths[p]; // drop unused path keys
  }

  return { openapi: "3.2.0", info, paths, components: { schemas } };
}
