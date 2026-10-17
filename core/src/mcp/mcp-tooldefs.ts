import { mcpGrantedFileFields } from "../features/file-grant.ts";
import { isBuiltinDataDoor } from "../core/resource-doors.ts";
import { restoreOptionsInput } from "../data/restore-input.ts";
// Barrel re-exports keep import sites stable.
import {
  type Actor,
  crudWriteDenied,
  staticPolicyAllows,
} from "../authz/auth.ts";
import {
  effectiveOpPolicy,
  httpPolicyMode,
  wireColumnsOf,
  type WireReadVerb,
  withheldFromOpsOf,
} from "../core/app-refs.ts";
import type { App, HttpRoute, ResourceModel } from "../core/app.ts";
import {
  mcpVisibleViews,
  resourceToolName,
  runFormActorDenied,
  VIEW_OP_SEGMENT,
  type ViewDecl,
  viewToolName,
} from "../features/view.ts";
import type { Violation } from "../core/structural-violation.ts";
import {
  assertFiniteEgress,
  mcpOpEgressSchema,
  servedColumnsOf,
} from "../features/redact.ts";
import {
  countInputSchema,
  isValidCursor,
  LIST_LIMIT_MAX,
  listInputSchema,
  type McpToolDef,
  refuseOffsetWithAfter,
  SEP,
} from "./mcp-wire.ts";
import { z } from "zod";
import { jsonSchemaInput } from "../data/schema.ts";
import {
  stableJsonSchemaEncoding,
  wireJsonSchema,
} from "../data/schema-types.ts";
import { resourceInputSchema } from "../data/resource-input.ts";
import { emptyPatchWouldWrite } from "../data/repo-audit.ts";
import { markSequencePartitionReadOnly } from "../features/sequence-write.ts";
import { markUpdateReadOnly, markWriteOnly } from "../features/write-only.ts";

/** The reserved MCP argument carrying an idempotent op's replay key — the agent-channel twin of the HTTP
 *  `Idempotency-Key` header (03-api-shape.md §HTTP contract). Only an op that declares `idempotent: true`
 *  has this transport slot; other ops may use the same spelling as ordinary input. */
export const IDEMPOTENCY_KEY_ARG = "_idempotencyKey";

/** A successful parse of these output nodes cannot be undefined. Opaque/default/catch decoders retain
 * optional result presence; deciding more would execute application code merely to build a catalogue. */
function definedOutput(schema: z.ZodType): boolean {
  const def = schema.def as {
    type: string;
    innerType?: z.ZodType;
    options?: z.ZodType[];
  };
  if (def.type === "nonoptional") return true;
  if (def.type === "nullable" || def.type === "readonly") {
    return !!def.innerType && definedOutput(def.innerType);
  }
  if (def.type === "union") {
    return !!def.options?.length && def.options.every(definedOutput);
  }
  return [
    "object",
    "array",
    "string",
    "number",
    "bigint",
    "date",
    "boolean",
    "null",
    "enum",
    "record",
    "tuple",
  ].includes(def.type);
}

/** A declared custom output describes the actual structured object, after the MCP value projection. */
export function customOutputSchema(
  app: App,
  model: ResourceModel,
  op: string,
): Record<string, unknown> | undefined {
  if (isBuiltinDataDoor(model, op)) return undefined;
  const output = (model.operations[op] as { output?: z.ZodType } | undefined)
    ?.output;
  if (!output) return undefined;
  const projected = mcpOpEgressSchema(
    app.model,
    stableJsonSchemaEncoding(
      wireJsonSchema(output, "output", { opaqueOutput: true }),
    ) as Record<string, unknown>,
    model.mcp[op]?.shape,
  );
  const { $schema: _dialect, $defs, definitions, ...result } = projected;
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: { result },
    ...(definedOutput(output) ? { required: ["result"] } : {}),
    additionalProperties: false,
    ...($defs === undefined ? {} : { $defs }),
    ...(definitions === undefined ? {} : { definitions }),
  };
}

/** The auto-CRUD verbs — they write through the repo, not `dispatchOp`, so no op-level `idempotent` flag
 *  (and no idempotency claim) applies to them. */
const CRUD_OPS: ReadonlySet<string> = new Set([
  "list",
  "find",
  "create",
  "update",
  "delete",
]);

/** Does this tool dispatch a custom op with optional keyed replay? Keyless retries remain distinct. */
export function opIsIdempotent(
  op: string,
  ops: Readonly<Record<string, unknown>>,
): boolean {
  if (CRUD_OPS.has(op)) return false;
  return Boolean((ops[op] as { idempotent?: boolean } | undefined)?.idempotent);
}

/** Derive the protocol's standard hints; optional replay keys do not make keyless writes idempotent. */
function annotationsFor(
  op: string,
  model: ResourceModel,
): NonNullable<McpToolDef["annotations"]> {
  const builtin = isBuiltinDataDoor(model, op);
  const read = op === "list" || op === "find" || (op === "count" && builtin) ||
    (!builtin &&
      (model.operations[op] as { tx?: string } | undefined)?.tx === "read");
  return {
    readOnlyHint: read,
    destructiveHint: !read && op !== "create" &&
      !(op === "delete" && model.features.softDelete) &&
      !(op === "restore" && builtin),
    idempotentHint: read || op === "delete" || (builtin && op === "restore"),
    openWorldHint: !builtin,
  };
}

/** The view read-tool's `inputSchema` — offset-first pagination only (12-mcp §6); a view's own `where` is
 *  the narrowing, so the agent supplies just page controls, capped at the same finite `limit` as `list`. */
function viewInputSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1, maximum: LIST_LIMIT_MAX },
      offset: { type: "integer", minimum: 0 },
      after: {
        type: "string",
        description:
          "opaque keyset cursor from a prior page's `nextCursor` — stable pagination (no dup/skip under concurrent writes); supersedes `offset`",
      },
    },
    additionalProperties: false,
  };
}

/** The strict Zod parser mirroring `viewInputSchema` — an unknown query key or an out-of-range limit/offset
 *  is a LOUD `validation` error (`mcp/strict-input`), never a silent drop. One source with the JSON-Schema. */
export function viewQueryParser(): z.ZodType {
  return z.object({
    limit: z.number().int().min(1).max(LIST_LIMIT_MAX).optional(),
    offset: z.number().int().min(0).optional(),
    after: z.string().refine(
      isValidCursor,
      "malformed cursor — re-read the view to get a fresh `nextCursor`",
    ).optional(),
  }).strict().superRefine(refuseOffsetWithAfter);
}

/** Projects `defineView` declarations that opt into `mcp` to read-tools (12-mcp §6). Always read-only, always
 *  a tool (no addressable id); `shape` is the view's `columns`, omitted when a fn-escape shape is present
 *  (the source columns would mislead about the actual return keys). No `mcp` ⇒ invisible (the safe default). */
export function viewToolDefs(
  app: App,
  views: readonly ViewDecl[],
): McpToolDef[] {
  const tools: McpToolDef[] = [];
  // mcpVisibleViews = mcp-opted ∧ non-binary (a binary() view is a BLOB — never a tool, 12-mcp §6; its `mcp:`
  // is caught as a loud advisory by checkBinaryViewNotMcp). The SAME filter the collision scan rides.
  for (const view of mcpVisibleViews(views)) {
    if (typeof view.run === "function" || view.query) {
      // a run-form view dispatches (mcp-call.ts run-form branch) — advertise its REAL typed input schema
      // (`view.input`), not the pagination schema (input-shaped, not offset-paginated). No input ⇒ a CLOSED
      // empty object: a caller must not smuggle arbitrary args into a run body that declared none.
      tools.push({
        name: viewToolName(app, view),
        description: view.mcp.describe,
        inputSchema: (view.query?.input ?? view.input)
          ? jsonSchemaInput((view.query?.input ?? view.input)!)
          : jsonSchemaInput(z.object({})),
        annotations: { readOnlyHint: true }, // a view is read-only by construction (12-mcp §6); writes in run are lint-forbidden
      });
      continue;
    }
    const def: McpToolDef = {
      name: viewToolName(app, view),
      description: view.mcp.describe,
      inputSchema: viewInputSchema(),
      annotations: { readOnlyHint: true }, // a view is read-only by construction (12-mcp §6 — readOnlyHint)
    };
    // the view's projected columns ARE its output shape (the narrowed read surface); absent (or a fn-escape
    // that renames/computes, so the source columns would mislead) ⇒ no static column-list advertised.
    tools.push(
      !view.shape && view.columns && view.columns.length > 0
        ? { ...def, _meta: { "hazelnut/shape": view.columns } }
        : def,
    );
  }
  return tools;
}

/** The MCP tool catalog (`tools/list`) — curated, not co-projected: only ops a resource lists in its
 *  `mcp` field become tools (12-mcp §5/§13 — naive co-projection from `http` explodes the surface).
 *  `views` defaults to `app.views` so every caller (capabilityFilter, surface-lock, instructions) sees
 *  view tools through this one function; an explicit arg overrides for a standalone caller. */
export function mcpToolDefs(
  app: App,
  views: readonly ViewDecl[] = app.views ?? [],
): McpToolDef[] {
  const tools: McpToolDef[] = [];
  // Custom-op `shape` ads must match egressOp: withhold framework-minted names no read projects
  // (OPENAPI-OP-REDACT's MCP twin). Read tools already go through `readToolShape`.
  const withheld = withheldFromOpsOf(app.model);
  const idInput = {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  };
  const empty = { type: "object", properties: {} };
  for (const m of app.model) {
    const schema = (patch = false) => {
      const shape = markWriteOnly(
        m,
        jsonSchemaInput(resourceInputSchema(m, patch, true)),
      );
      return patch
        ? markUpdateReadOnly(m, markSequencePartitionReadOnly(m, shape))
        : shape;
    };
    const opInput = (name: string): Record<string, unknown> => {
      const decl = m.operations[name] as { input?: z.ZodType } | undefined;
      return decl?.input ? jsonSchemaInput(decl.input) : empty;
    };
    // an `idempotent` op advertises the reserved key argument alongside its own input: the agent mints one
    // value and RESENDS it on a retry, so the retry replays the first result instead of applying twice.
    // Optional by design — a new REQUIRED param is a non-additive surface change (12-mcp §surface-lock).
    const inputFor = (op: string): Record<string, unknown> => {
      const base = baseInputFor(op);
      return opIsIdempotent(op, m.operations) ? withIdempotencyKey(base) : base;
    };
    const baseInputFor = (op: string): Record<string, unknown> => {
      if (
        (op === "count" || op === "restore") && Object.hasOwn(m.operations, op)
      ) return opInput(op);
      switch (op) {
        case "count":
          return countInputSchema(m);
        case "restore":
          return jsonSchemaInput(
            z.object({
              id: z.string(),
              options: restoreOptionsInput(m).optional(),
            }).strict(),
          );
        case "list":
          return listInputSchema(m, m.mcp.list?.shape); // filter/sort names stay inside the delivered list projection
        case "find":
          return m.features.temporal
            ? {
              ...idInput,
              properties: {
                ...idInput.properties,
                asOf: { type: "string", format: "date-time" },
              },
              additionalProperties: false,
            }
            : idInput;
        case "delete":
          // a versioning resource ADVERTISES + REQUIRES the expected `version` on delete too: the CAS
          // precondition so an agent re-reads then resends, never a stale blind delete.
          return m.features.versioning
            ? {
              type: "object",
              properties: {
                id: { type: "string" },
                version: {
                  type: "integer",
                  description:
                    "the expected row version (optimistic-lock precondition; re-read to get it)",
                },
              },
              required: ["id", "version"],
            }
            : idInput;
        case "create":
          return schema();
        case "update":
          // a versioning resource REQUIRES the expected `version` (no `If-Match` header on this channel),
          // so an agent re-reads then resends with the version.
          return m.features.versioning
            ? {
              type: "object",
              properties: {
                id: { type: "string" },
                version: {
                  type: "integer",
                  minimum: 0,
                  description:
                    "the expected row version (optimistic-lock precondition; re-read the row to get it)",
                },
                patch: {
                  ...schema(true),
                  required: [],
                  ...(!emptyPatchWouldWrite(m) ? { minProperties: 1 } : {}),
                },
              },
              required: [
                "id",
                "version",
                ...(!emptyPatchWouldWrite(m) ? ["patch"] : []),
              ],
            }
            : {
              type: "object",
              properties: {
                id: { type: "string" },
                patch: {
                  ...schema(true),
                  required: [],
                  ...(!emptyPatchWouldWrite(m) ? { minProperties: 1 } : {}),
                },
              },
              required: ["id", ...(!emptyPatchWouldWrite(m) ? ["patch"] : [])],
            };
        default:
          return opInput(op); // a custom op → its declared input contract
      }
    };
    for (const [op, entry] of Object.entries(m.mcp)) {
      // the declared per-tool version (12-mcp §tool-versioning): the description carries the version tag so
      // a bump is visible in tools/list; an echo:"required" tool additionally REQUIRES `_toolVersion` — the
      // call-time proof of which surface the call was generated against.
      const versioned = entry.version === undefined
        ? { description: entry.describe, inputSchema: inputFor(op) }
        : {
          description: `${entry.describe} [tool v${entry.version.v}]`,
          inputSchema: entry.version.echo === "required"
            ? withVersionEcho(inputFor(op), entry.version.v)
            : inputFor(op),
        };
      const outputSchema = customOutputSchema(app, m, op);
      let def: McpToolDef = {
        name: resourceToolName(m.module, m.name, op),
        ...versioned,
        ...(outputSchema === undefined ? {} : { outputSchema }),
      };
      // a read tool DELIVERS the route's wire projection narrowed by any pick, so it advertises exactly
      // that — an agent reading `tools/list` learns the return columns, and never one the call omits.
      const readVerb = readVerbOf(op);
      if (readVerb) {
        def = {
          ...def,
          _meta: { "hazelnut/shape": readToolShape(m, readVerb, entry.shape) },
        };
      } else if (entry.shape && !(op === "count" && isBuiltinDataDoor(m, op))) {
        def = {
          ...def,
          _meta: {
            "hazelnut/shape": entry.shape.filter((c) => !withheld.has(c)),
          },
        };
      }
      const annotations = annotationsFor(op, m);
      if (entry.confirm && !annotations.readOnlyHint) {
        def = { ...def, _meta: { ...def._meta, "hazelnut/confirmHint": true } };
      }
      tools.push({ ...def, annotations });
    }
  }
  for (const task of app.tasks ?? []) {
    for (
      const [method, op] of [["poll", "task_poll"], [
        "cancel",
        "task_cancel",
      ]] as const
    ) {
      const entry = task.mcp?.[method];
      if (entry) {
        tools.push({
          name: resourceToolName(task.module ?? "app", task.name, op),
          description: entry.describe,
          inputSchema: { ...idInput, additionalProperties: false },
          annotations: method === "poll"
            ? { readOnlyHint: true }
            : { idempotentHint: true },
        });
      }
    }
  }
  for (const workflow of app.workflows ?? []) {
    for (
      const [method, op] of [["inspect", "workflow_inspect"], [
        "cancel",
        "workflow_cancel",
      ]] as const
    ) {
      const entry = workflow.mcp?.[method];
      if (entry) {
        tools.push({
          name: resourceToolName(workflow.module ?? "app", workflow.name, op),
          description: entry.describe,
          inputSchema: { ...idInput, additionalProperties: false },
          annotations: method === "inspect"
            ? { readOnlyHint: true }
            : { idempotentHint: true },
        });
      }
    }
  }
  for (const model of app.model) {
    const fields = mcpGrantedFileFields(model);
    if (fields.length) {
      tools.push({
        name: resourceToolName(model.module, model.name, "file_grant"),
        description:
          "Grant a temporary URL for a readable projected file field",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
            field: { type: "string", enum: [...fields] },
            ttl: { type: "number" },
          },
          required: ["id", "field"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
      });
    }
    if (fields.length) {
      tools.push({
        name: resourceToolName(model.module, model.name, "file_upload_grant"),
        description:
          "Grant an atomic if-absent PUT for the row's current file key; requires update permission",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
            field: { type: "string", enum: [...fields] },
            ttl: { type: "number" },
          },
          required: ["id", "field"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      });
    }
  }
  // §6: a `defineView` with `mcp` joins the SAME catalog as a resource op — the widened agent surface.
  tools.push(...viewToolDefs(app, views));
  return tools.map((tool) => ({
    ...tool,
    annotations: {
      readOnlyHint: tool.annotations?.readOnlyHint ?? false,
      destructiveHint: tool.annotations?.destructiveHint ??
        !(tool.annotations?.readOnlyHint || tool.annotations?.idempotentHint),
      idempotentHint: tool.annotations?.idempotentHint ??
        Boolean(tool.annotations?.readOnlyHint),
      openWorldHint: tool.annotations?.openWorldHint ?? false,
    },
  }));
}

/** Widen an inputSchema with the REQUIRED `_toolVersion` echo param (12-mcp §tool-versioning). */
function withVersionEcho(
  schema: Record<string, unknown>,
  v: number,
): Record<string, unknown> {
  const props = (schema.properties ?? {}) as Record<string, unknown>;
  const required = (schema.required ?? []) as string[];
  return {
    ...schema,
    type: "object",
    properties: {
      ...props,
      _toolVersion: {
        type: "integer",
        description:
          `echo the live tool version (${v}) verbatim — a call generated against a different version fails loud at validate`,
      },
    },
    required: [...required, "_toolVersion"],
  };
}

/** Widen an idempotent op's inputSchema with the OPTIONAL reserved idempotency-key param — the agent
 *  channel for the key `dispatchOp` claims on (05-runtime.md §op-pipeline step 7). */
function withIdempotencyKey(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const props = (schema.properties ?? {}) as Record<string, unknown>;
  return {
    ...schema,
    type: "object",
    properties: {
      ...props,
      [IDEMPOTENCY_KEY_ARG]: {
        type: "string",
        description:
          "a unique key you mint for this call — resend the SAME value when retrying to reuse its settled execution with this door's current redaction instead of applying the operation twice",
      },
    },
  };
}

// ── Tool-explosion advisory lint (12-mcp §5) ──────────────────────────────────────────────────────────
// A reasoner degrades on a large flat tool list, so this warns (never a build error) past a configurable
// threshold, steering the author to coarser ops. Count is total over the whole app surface, not per-resource.

/** The default tool-explosion threshold — the upper edge of the canon's ~30-40 band (12-mcp §5). */
export const TOOL_EXPLOSION_THRESHOLD = 40;

/** The tool-explosion advisory (12-mcp §5) — empty within `threshold`, else one advisory `Violation`.
 *  Pure over `mcpToolDefs(app)`, the SAME catalog the host serves, so the count can never drift. */
export function toolExplosionAdvisory(
  app: App,
  threshold: number = TOOL_EXPLOSION_THRESHOLD,
): Violation[] {
  const count = mcpToolDefs(app).length;
  if (count <= threshold) return [];
  return [{
    id: "mcp/tool-explosion",
    resource: "mcp-surface",
    message:
      `the agent surface projects ${count} tools (> ${threshold}) — a reasoner degrades on a large flat tool list; ` +
      `author COARSER jobs as ops in \`logic/\` (a bundling op opt-in to \`mcp:\`) and expose fewer, agent-shaped tools (advisory, not a build error)`,
  }];
}

/** The §5 capability filter — which tools this identity may see. Framework-authored identity-only policies
 *  (`requires`, `requiresAll`, `requiresAny`) are omitted when they deny (omission, not a 403, closes the
 *  enumeration oracle). An ad-hoc/dynamic policy stays visible and its op pipeline remains the gate. */
export function capabilityFilter(app: App, actor: Actor | null): McpToolDef[] {
  return mcpToolDefs(app).filter((tool) => {
    const parsed = parseToolName(tool.name);
    if (!parsed) return false;
    // a view tool resolves to no resource model, so the resource branches below leave it visible. Hide a
    // run-form view whose rowPolicy denies the actor (returns none()); an over-form view stays visible.
    if (parsed.op === VIEW_OP_SEGMENT) {
      const view = (app.views ?? []).find((v) => v.name === parsed.resource);
      return !view || !runFormActorDenied(view, actor);
    }
    const m = mcpResourceModel(app, parsed);
    if (parsed.op === "file_upload_grant") {
      const owner = app.model.find((model) =>
        model.module === parsed.module && model.name === parsed.resource &&
        mcpGrantedFileFields(model).length > 0
      );
      if (owner) return !crudWriteDenied(actor, owner.name, "update", true);
    }
    // an auto-CRUD write verb is gated by the seeded `<r>:<verb>` perm at call time, not `op.policy`; omit
    // it from `tools/list` via the SAME gate the call path checks (`crudWriteDenied`). `external` is an
    // HTTP-only upstream-authority exemption; it does not authorize a direct MCP caller.
    if (
      m &&
      (parsed.op === "create" || parsed.op === "update" ||
        parsed.op === "delete" ||
        (parsed.op === "restore" && isBuiltinDataDoor(m, parsed.op)))
    ) {
      return !crudWriteDenied(
        actor,
        m.name,
        parsed.op === "restore" ? "update" : parsed.op,
        crudWriteGated(m, parsed.op),
      );
    }
    // A tagged built-in policy can be evaluated without running app code, so tools/list and the call gate
    // agree for one- and multi-key permission rules. Reads stay visible — rowPolicy gates rows, not existence.
    const allowed = m
      ? staticPolicyAllows(effectiveOpPolicy(m, parsed.op), actor)
      : null;
    return allowed ?? true;
  });
}

/** Resolve the unique curated declaration, not the first bare home label.
 * A hidden app-schema sibling cannot own a flat app tool, or vice versa. The
 * existing composed tool-name collision guard makes actual exposed names unique;
 * a structurally fabricated ambiguous app is refused instead of choosing one. */
export function mcpResourceModel(
  app: App,
  parsed: { module: string; resource: string; op: string },
): ResourceModel | undefined {
  const owners = app.model.filter((m) =>
    m.module === parsed.module && m.name === parsed.resource &&
    Object.hasOwn(m.mcp, parsed.op)
  );
  return owners.length === 1 ? owners[0] : undefined;
}

/** The visible tool NAMES for an actor — feeds `projectMcpInstructions({ visibleTools })` so the connect-time
 *  surface roll-up matches exactly what `tools/list` returns for the same identity. */
export function visibleToolNames(app: App, actor: Actor | null): string[] {
  return capabilityFilter(app, actor).map((t) => t.name);
}

/** Is the auto-CRUD write tool for `verb` default-deny gated on the MCP surface? `public` is an explicit
 *  cross-surface permission opt-out. `external` only means an upstream authorized the HTTP request; direct
 *  MCP does not traverse that upstream, so the route's policy posture still gates the MCP twin. Reads are
 *  never gated here. */
export function crudWriteGated(m: ResourceModel, verb: string): boolean {
  const route = m.http[verb] as HttpRoute | undefined;
  if (route === undefined) return true; // no declared exposure → deny-by-default
  return httpPolicyMode(route) === "policy";
}

/** Reverse a tool FQN to its parts. Returns null if it is not exactly three non-empty segments. */
export function parseToolName(
  name: string,
): { module: string; resource: string; op: string } | null {
  const parts = name.split(SEP);
  if (parts.length !== 3 || parts.some((p) => p === "")) return null;
  return { module: parts[0]!, resource: parts[1]!, op: parts[2]! };
}

/** The projection syntax consumed by the shared shaper. A resource `mcp.shape` is always the typed
 *  field-pick (`Pick<Row,…>`); only `defineView.shape` may use the function escape `(row) => AgentShape`
 *  for compute/rename. That escape is pure, actor-agnostic (no ctx), and runs AFTER sensitive-redaction,
 *  so a `sensitive` field cannot re-enter. */
export type ShapeSpec =
  | readonly string[]
  | ((row: Record<string, unknown>) => Record<string, unknown>);

/** Is this shape the FUNCTION escape (compute/rename) vs the typed field-pick? */
function isShapeFn(
  s: ShapeSpec,
): s is (row: Record<string, unknown>) => Record<string, unknown> {
  return typeof s === "function";
}

/** Applies a field-pick or a `defineView` compute/rename projection at the output boundary. Field-pick
 *  omits undeclared columns (a later-added field never silently over-returns); the view-only function
 *  escape runs post-redaction. Absent shape → the full (redacted) row. */
export function applyShape(
  rows: readonly Record<string, unknown>[],
  shape?: ShapeSpec,
): Record<string, unknown>[] {
  if (!shape) return rows as Record<string, unknown>[];
  if (isShapeFn(shape)) return rows.map((r) => shape(r)); // the function escape — runs post-redaction, pure
  return rows.map((r) =>
    Object.fromEntries(shape.filter((f) => f in r).map((f) => [f, r[f]]))
  );
}

/** The MCP read verbs — the two tools that return a row of the resource, so the two whose output space is
 *  the HTTP twin's wire projection. `create`/`update`/`delete` return an envelope; a custom op returns the
 *  handler's own contract. */
const MCP_READ_VERBS: ReadonlySet<string> = new Set(["list", "find"]);

/** Is this curated tool one of the row-returning reads, and which projection does it ride? */
function readVerbOf(op: string): WireReadVerb | null {
  return MCP_READ_VERBS.has(op) ? op as WireReadVerb : null;
}

/** The DELIVERED field set of a curated read tool: the verb's wire projection (03-api-shape.md
 *  §wire-projection), narrowed by a declared field-pick. A pick naming a column outside the projection
 *  resolves to nothing at call time, so the advertisement must not promise it either. */
/** MCP read columns: the HTTP wire list, plus `version` on a versioning resource so update/delete
 *  can be given the CAS precondition the tools require (HTTP carries it as ETag; MCP has no header). */
function mcpReadColumns(
  m: ResourceModel,
  verb: WireReadVerb,
): readonly string[] {
  const served = new Set(servedColumnsOf(m, verb));
  const blocked = new Set([
    ...m.passwords,
    ...(m.encryptedConfig?.equality ?? []).map((field) => `${field}_bidx`),
  ]);
  // Keep the positive projection's order. Encrypted members are fixed logical placeholders, while
  // sensitive plaintext, password storage and equality MACs never become MCP delivered columns.
  const cols = wireColumnsOf(m, verb).filter((field) =>
    !blocked.has(field) &&
    (served.has(field) || m.encrypted.includes(field))
  );
  if (m.features.versioning && !cols.includes("version")) {
    return [...cols, "version"];
  }
  return cols;
}

export function readToolShape(
  m: ResourceModel,
  verb: WireReadVerb,
  shape?: readonly string[],
): readonly string[] {
  const cols = mcpReadColumns(m, verb);
  // the declared pick keeps ITS order — that is the author's presentation intent, and `applyShape` emits the
  // delivered keys in the same order, so advertisement and delivery agree key-for-key.
  return shape ? shape.filter((c) => cols.includes(c)) : cols;
}

/** Agent reads retain fixed encrypted placeholders in their advertised shape, without fetching a
 * ciphertext that no agent may receive. A dynamic shape sees the same full masked logical projection. */
export function mcpReadSelection(
  m: ResourceModel,
  verb: WireReadVerb,
  shape?: ShapeSpec,
): readonly string[] {
  const columns = Array.isArray(shape)
    ? readToolShape(m, verb, shape)
    : mcpReadColumns(m, verb);
  return columns.filter((field) => !m.encrypted.includes(field));
}

/** A curated read tool's rows, projected then shaped (12-mcp §6 read order). The projection is the HTTP
 *  twin's column list, plus `version` on a versioning resource (MCP has no If-Match header). The `shape`
 *  runs INSIDE that set — a curated tool can only narrow the route it mirrors, never widen it. The
 *  finite-number wall is the HTTP twin's `assertFiniteEgress` — one helper, so MCP cannot teach `null` for
 *  a stored `NaN` / `Infinity` the GET list already refuses. */
export function projectRead(
  m: ResourceModel,
  verb: WireReadVerb,
  rows: readonly Record<string, unknown>[],
  shape?: ShapeSpec,
): Record<string, unknown>[] {
  return assertFiniteEgress(
    m,
    applyShape(
      applyShape(
        rows.map((row) => ({
          ...row,
          ...Object.fromEntries(
            m.encrypted.map((field) => [field, "[redacted]"]),
          ),
        })),
        mcpReadColumns(m, verb),
      ),
      shape,
    ),
  );
}

/** Applies a custom-op's advertised `shape` field-pick to its already-redacted return value (row, array
 *  of rows, or scalar/null unchanged). Mirrors the read tools' `applyShape`, closing the gap where a
 *  custom op advertised `shape` but its dispatch path returned the un-shaped row. */
export function shapeOpValue(value: unknown, shape?: ShapeSpec): unknown {
  if (!shape || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => shapeOpValue(item, shape));
  }
  // These serialize as scalar values on the JSON wire; a field pick must not turn them into {}.
  if (value instanceof Date || value instanceof Uint8Array) return value;
  return applyShape([value as Record<string, unknown>], shape)[0];
}
