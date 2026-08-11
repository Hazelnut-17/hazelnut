// Barrel re-exports keep import sites stable.
import {
  type Actor,
  can,
  crudWriteDenied,
  requiredPerm,
} from "../authz/auth.ts";
import {
  effectiveOpPolicy,
  httpPolicyMode,
  isExternalRoute,
  wireColumnsOf,
  type WireReadVerb,
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
  isValidCursor,
  LIST_LIMIT_MAX,
  listInputSchema,
  type McpToolDef,
  SEP,
} from "./mcp-wire.ts";
import { z } from "zod";
import { stableStringify } from "../core/version.ts";

/** The reserved MCP argument carrying the op's idempotency key — the agent-channel twin of the HTTP
 *  `Idempotency-Key` header (03-api-shape.md §HTTP contract). Peeled before input validation (mcp-call.ts),
 *  so an op input may not declare a field of this name. */
export const IDEMPOTENCY_KEY_ARG = "_idempotencyKey";

/** The auto-CRUD verbs — they write through the repo, not `dispatchOp`, so no op-level `idempotent` flag
 *  (and no idempotency claim) applies to them. */
const CRUD_OPS: ReadonlySet<string> = new Set([
  "list",
  "find",
  "create",
  "update",
  "delete",
]);

/** Does this tool dispatch a custom op declared `idempotent: true`? — the single predicate the
 *  `idempotentHint` annotation and the reserved key argument share, so advertising and mechanism agree. */
export function opIsIdempotent(
  op: string,
  ops: Readonly<Record<string, unknown>>,
): boolean {
  if (CRUD_OPS.has(op)) return false;
  return Boolean((ops[op] as { idempotent?: boolean } | undefined)?.idempotent);
}

/** Derives tool annotations (12-mcp §31) from CRUD verb / custom-op `tx`/`idempotent`, never authored.
 *  An authored `confirm:true` (§5) suppresses `idempotentHint` — confirm and idempotent are opposite intents. */
function annotationsFor(
  op: string,
  ops: Readonly<Record<string, unknown>>,
  confirm: boolean,
): McpToolDef["annotations"] | undefined {
  const a: {
    readOnlyHint?: true;
    destructiveHint?: true;
    idempotentHint?: true;
    confirmHint?: true;
  } = {};
  if (op === "list" || op === "find") a.readOnlyHint = true;
  else if (op === "delete") a.destructiveHint = true;
  else if (!["create", "update"].includes(op)) {
    const decl = ops[op] as { tx?: string; idempotent?: boolean } | undefined;
    if (decl?.tx === "read") a.readOnlyHint = true;
    if (opIsIdempotent(op, ops)) a.idempotentHint = true;
  }
  if (confirm) {
    a.confirmHint = true; // the host must elicit human approval — a destructive op needing confirmation
    a.destructiveHint = true;
    delete a.idempotentHint; // never advertise auto-retry for an op the host must confirm
  }
  return Object.keys(a).length > 0 ? a : undefined;
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
  }).strict();
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
    if (typeof view.run === "function") {
      // a run-form view dispatches (mcp-call.ts run-form branch) — advertise its REAL typed input schema
      // (`view.input`), not the pagination schema (input-shaped, not offset-paginated). No input ⇒ empty-object.
      tools.push({
        name: viewToolName(app, view),
        description: view.mcp.describe,
        inputSchema: view.input
          ? z.toJSONSchema(view.input) as Record<string, unknown>
          : { type: "object", properties: {} },
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
        ? { ...def, shape: view.columns }
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
  const idInput = {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  };
  const empty = { type: "object", properties: {} };
  for (const m of app.model) {
    const schema = () => z.toJSONSchema(m.schema) as Record<string, unknown>;
    const opInput = (name: string): Record<string, unknown> => {
      const decl = m.operations[name] as { input?: z.ZodType } | undefined;
      return decl?.input
        ? z.toJSONSchema(decl.input) as Record<string, unknown>
        : empty;
    };
    // an `idempotent` op advertises the reserved key argument alongside its own input: the agent mints one
    // value and RESENDS it on a retry, so the retry replays the first result instead of applying twice.
    // Optional by design — a new REQUIRED param is a non-additive surface change (12-mcp §surface-lock).
    const inputFor = (op: string): Record<string, unknown> => {
      const base = baseInputFor(op);
      return opIsIdempotent(op, m.operations) ? withIdempotencyKey(base) : base;
    };
    const baseInputFor = (op: string): Record<string, unknown> => {
      switch (op) {
        case "list":
          return listInputSchema(m); // the rich-query contract: filter/sort/limit/offset (12-mcp §6)
        case "find":
          return idInput;
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
                  description:
                    "the expected row version (optimistic-lock precondition; re-read the row to get it)",
                },
                patch: schema(),
              },
              required: ["id", "version"],
            }
            : {
              type: "object",
              properties: { id: { type: "string" }, patch: schema() },
              required: ["id"],
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
      let def: McpToolDef = {
        name: resourceToolName(m.module, m.name, op),
        ...versioned,
      };
      // a read tool DELIVERS the route's wire projection narrowed by any pick, so it advertises exactly
      // that — an agent reading `tools/list` learns the return columns, and never one the call omits.
      const readVerb = readVerbOf(op);
      if (readVerb) {
        def = { ...def, shape: readToolShape(m, readVerb, entry.shape) };
      } else if (entry.shape) def = { ...def, shape: entry.shape };
      const ann = annotationsFor(op, m.operations, entry.confirm ?? false);
      tools.push(ann ? { ...def, annotations: ann } : def);
    }
  }
  // §6: a `defineView` with `mcp` joins the SAME catalog as a resource op — the widened agent surface.
  tools.push(...viewToolDefs(app, views));
  return tools;
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
          "a unique key you mint for this call — resend the SAME value when retrying, and the retry replays the first result instead of applying the operation twice",
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

/** The §5 capability filter — which tools this identity may see. A custom op gated by `requires(key)` is
 *  omitted unless `can(actor, key)` (omission, not a 403, closes the enumeration oracle). A tool with no
 *  statically-readable perm stays visible — the op-pipeline still gates the actual call. */
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
    const m = app.model.find((x) =>
      x.module === parsed.module && x.name === parsed.resource
    );
    // an auto-CRUD write verb is gated by the seeded `<r>:<verb>` perm at call time, not `op.policy`; omit
    // it from `tools/list` via the SAME gate the call path checks (`crudWriteDenied`). Public/external stays visible.
    if (
      m &&
      (parsed.op === "create" || parsed.op === "update" ||
        parsed.op === "delete")
    ) {
      return !crudWriteDenied(
        actor,
        m.name,
        parsed.op,
        crudWriteGated(m, parsed.op),
      );
    }
    // the effective policy (explicit `op.policy` or the injected deny-by-default) hides a gated tool for
    // an actor lacking the perm (§5). Reads stay visible — the rowPolicy gates rows, not tool existence.
    const perm = m ? requiredPerm(effectiveOpPolicy(m, parsed.op)) : null;
    return perm === null || can(actor, perm);
  });
}

/** The visible tool NAMES for an actor — feeds `projectMcpInstructions({ visibleTools })` so the connect-time
 *  surface roll-up matches exactly what `tools/list` returns for the same identity. */
export function visibleToolNames(app: App, actor: Actor | null): string[] {
  return capabilityFilter(app, actor).map((t) => t.name);
}

/** Is the auto-CRUD write tool for `verb` default-deny gated on the MCP surface? Mirrors the HTTP route's
 *  exposure mode off the same `defineResource` declaration, so no surface can be looser than the other:
 *  `"policy"`/no route ⇒ gated; `"public"`/`external` ⇒ ungated. Reads are never gated here. */
export function crudWriteGated(m: ResourceModel, verb: string): boolean {
  const route = m.http[verb] as HttpRoute | undefined;
  if (route === undefined) return true; // no declared exposure → deny-by-default
  return httpPolicyMode(route) === "policy" && !isExternalRoute(route);
}

/** Reverse a tool FQN to its parts. Returns null if it is not exactly three non-empty segments. */
export function parseToolName(
  name: string,
): { module: string; resource: string; op: string } | null {
  const parts = name.split(SEP);
  if (parts.length !== 3 || parts.some((p) => p === "")) return null;
  return { module: parts[0]!, resource: parts[1]!, op: parts[2]! };
}

/** The curated output read-view (`mcp` `shape` / `defineView` shape, 12-mcp §5). Two forms: a typed
 *  field-pick (`Pick<Row,…>`), or a function escape `(row) => AgentShape` for compute/rename — pure,
 *  actor-agnostic (no ctx), and runs AFTER sensitive-redaction, so a `sensitive` field can't re-enter. */
export type ShapeSpec =
  | readonly string[]
  | ((row: Record<string, unknown>) => Record<string, unknown>);

/** Is this shape the FUNCTION escape (compute/rename) vs the typed field-pick? */
function isShapeFn(
  s: ShapeSpec,
): s is (row: Record<string, unknown>) => Record<string, unknown> {
  return typeof s === "function";
}

/** Applies the curated output read-view (`mcp` `shape`, 12-mcp §5) — output minimization at the call
 *  boundary. Field-pick omits undeclared columns (a later-added field never silently over-returns);
 *  function-escape runs post-redaction. Absent shape → the full (redacted) row. */
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
export function readToolShape(
  m: ResourceModel,
  verb: WireReadVerb,
  shape?: readonly string[],
): readonly string[] {
  const cols = wireColumnsOf(m, verb);
  // the declared pick keeps ITS order — that is the author's presentation intent, and `applyShape` emits the
  // delivered keys in the same order, so advertisement and delivery agree key-for-key.
  return shape ? shape.filter((c) => cols.includes(c)) : cols;
}

/** A curated read tool's rows, projected then shaped (12-mcp §6 read order). The projection is the SAME
 *  column list the HTTP twin of this verb serves, and the `shape` runs INSIDE it — so a curated tool, and
 *  the fn-escape that renames within one, can only narrow the route it mirrors, never widen it. */
export function projectRead(
  m: ResourceModel,
  verb: WireReadVerb,
  rows: readonly Record<string, unknown>[],
  shape?: ShapeSpec,
): Record<string, unknown>[] {
  return applyShape(applyShape(rows, wireColumnsOf(m, verb)), shape);
}

/** Applies a custom-op's advertised `shape` field-pick to its already-redacted return value (row, array
 *  of rows, or scalar/null unchanged). Mirrors the read tools' `applyShape`, closing the gap where a
 *  custom op advertised `shape` but its dispatch path returned the un-shaped row. */
export function shapeOpValue(value: unknown, shape?: ShapeSpec): unknown {
  if (!shape || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return applyShape(value as Record<string, unknown>[], shape);
  }
  return applyShape([value as Record<string, unknown>], shape)[0];
}

// ── the boot-time tool-surface stamp (12-mcp.md §surface-evolution `tools/list_changed`) ─────────────────

/** FNV-1a 64-bit over a string — tiny, dependency-free; stable across runs for a stable input. */
function fnv1a64(s: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

/** The boot-time stamp of the WHOLE (identity-blind) tool surface. `initialize` hands it out as the
 *  `Mcp-Session-Id`; a later request echoing a DIFFERENT stamp is a session that connected before a boot
 *  changed the surface — the serve layer batches a `notifications/tools/list_changed` onto that response
 *  so the long-lived agent re-reads `tools/list` (and re-initializes for a fresh stamp). */
export function toolSurfaceStamp(app: App): string {
  return fnv1a64(stableStringify({ tools: mcpToolDefs(app) }));
}
