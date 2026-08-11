// Barrel re-exports keep import sites stable.
import { type Actor, can, requiredPerm } from "../authz/auth.ts";
import {
  dispatchOperations,
  effectiveOpPolicy,
  opIsCollection,
} from "../core/app-refs.ts";
import type { App, ResourceModel } from "../core/app.ts";
import { dispatchOp, err, ok, type Result } from "../core/pipeline.ts";
import { all } from "../core/where.ts";
import { opSurfaceFactory } from "../data/data-ctx.ts";
import type { Datasources } from "../data/datasources.ts";
import type { Db, Transactor } from "../data/db.ts";
import { list, type ReadCtx, type RowPolicy } from "../data/repo.ts";
import type { Kms } from "../features/encrypt.ts";
import { egressOp, redactAll } from "../features/redact.ts";
import type { Explanation } from "../core/verifier-contract.ts";
import { projectRead, readToolShape, shapeOpValue } from "./mcp-tooldefs.ts";

/** The declared/injected rowPolicy for a resource — the SAME resolution `callMcpTool` and serve.ts use,
 *  so the resource-template read path can never open a looser gate than the `find` tool. */
export function resolveRowPolicy(
  m: ResourceModel,
  rowPolicies?: Readonly<Record<string, RowPolicy<Record<string, unknown>>>>,
): RowPolicy<Record<string, unknown>> {
  return rowPolicies?.[m.name] ??
    (m.rowPolicy as RowPolicy<Record<string, unknown>> | null) ?? (() => all());
}

// ── §6 resource surface — the resource-template path `<module>/<resource>/{id}` ───────────────────────
// A find/get op opts in via `mcp:{find:{as:"resource"}}` (12-mcp §6). The read-dispatch MIRRORS the `find`
// tool dispatch, so a host surfacing a resource never opens a new unredacted branch. `templates/list` is
// policy-filtered like `tools/list` (§5). URI axis uses `/` (tool names use `__`, §8).

const RESOURCE_SCHEME = ""; // app-resource URIs are bare `<module>/<resource>/{id}` (no scheme); see §6.

/** One resource-template advertisement (`resources/templates/list`, 12-mcp §6); `uriTemplate` is the
 *  RFC-6570 `<module>/<resource>/{id}` form. */
export interface McpResourceTemplate {
  readonly uriTemplate: string;
  readonly name: string;
  readonly description: string;
  readonly shape?: readonly string[];
}

/** Does this resource opt a find/get read op into the resource-template path? `as:"resource"` is only
 *  honored on read ops — elsewhere it is inert here (a verify warning's job to flag). Returns the
 *  opted-in op + its entry, or null. */
function resourceFindEntry(
  m: ResourceModel,
):
  | { op: string; entry: { describe: string; shape?: readonly string[] } }
  | null {
  for (const op of ["find", "get"]) {
    const entry = m.mcp[op] as {
      describe: string;
      shape?: readonly string[];
      as?: "resource";
    } | undefined;
    if (entry?.as === "resource") return { op, entry };
  }
  return null;
}

/** The resource-template URI for a model — `<module>/<resource>/{id}` (12-mcp §6), the `/`-joined
 *  mirror of the `__` tool name. */
export function resourceUriTemplate(m: ResourceModel): string {
  return `${RESOURCE_SCHEME}${m.module}/${m.name}/{id}`;
}

/** The resource-template catalog (`resources/templates/list`, 12-mcp §6), capability-filtered for this
 *  identity exactly like `tools/list` (§5): a template gated by a perm the actor lacks is omitted. The
 *  read perm is the same `effectiveOpPolicy`→`requiredPerm` the tool filter reads, so the two surfaces
 *  can never disagree about visibility. */
export function resourceTemplates(
  app: App,
  actor: Actor | null,
): McpResourceTemplate[] {
  const out: McpResourceTemplate[] = [];
  for (const m of app.model) {
    const r = resourceFindEntry(m);
    if (!r) continue;
    const perm = requiredPerm(effectiveOpPolicy(m, r.op));
    if (perm !== null && !can(actor, perm)) continue; // §5: invisible, not 403 — closes the enumeration oracle
    // an auto-CRUD resource read rides the `find` projection, so it advertises what it DELIVERS; a custom-op
    // read returns the handler's own contract, whose advertised shape is the declared pick alone.
    const shape = r.op in m.operations
      ? r.entry.shape
      : readToolShape(m, "find", r.entry.shape);
    out.push({
      uriTemplate: resourceUriTemplate(m),
      name: `${m.module}/${m.name}`,
      description: r.entry.describe,
      ...(shape ? { shape } : {}),
    });
  }
  return out;
}

/** Reverse an app-resource URI `<module>/<resource>/{id}` to its parts, or null when it is not exactly
 *  three non-empty `/`-segments (the resource analogue of `parseToolName`). */
export function parseResourceUri(
  uri: string,
): { module: string; resource: string; id: string } | null {
  const parts = uri.split("/");
  if (parts.length !== 3 || parts.some((p) => p === "")) return null;
  return { module: parts[0]!, resource: parts[1]!, id: parts[2]! };
}

/** The `resources/read` content envelope (12-mcp §6) — the projected (redacted, shaped) entity at a URI.
 *  An invisible-or-absent row gives the SAME `notFound` the `find` tool gives, so a read can never
 *  confirm a row exists in a scope the actor can't see. */
export interface McpResourceContent {
  readonly uri: string;
  readonly mimeType: "application/json";
  readonly data: Record<string, unknown>;
}

/** Read one app-resource by URI (`resources/read <module>/<resource>/{id}`, 12-mcp §6). MIRRORS the
 *  `find` case of `callMcpTool`: same rowPolicy, same single-site `list` read, then `redactAll` →
 *  `applyShape` — no new unredacted path. A row the actor cannot see, or an op not opted into
 *  `as:"resource"`, is `notFound` (defeats id-enumeration probing). */
export async function readResource(
  app: App,
  db: Db & Transactor,
  ctx: ReadCtx,
  uri: string,
  rowPolicies?: Readonly<Record<string, RowPolicy<Record<string, unknown>>>>,
  kms?: Kms,
  // threaded so a custom-op resource read gets the SAME `ctx.datasource(name)` surface the get
  // tool gets (mcp-call.ts).
  datasources?: Datasources,
): Promise<Result<McpResourceContent>> {
  // the semantics scheme is structurally separate — the app-resource read NEVER handles it (no skip-auth branch).
  if (isSemanticsUri(uri)) {
    return err(
      "validation",
      `'${uri}' is a '${SEMANTICS_SCHEME}' URI — read it via the ungated semantics handler, not the app-resource path`,
    );
  }
  const parsed = parseResourceUri(uri);
  if (!parsed) {
    return err(
      "validation",
      `malformed resource URI '${uri}' — expected '<module>/<resource>/{id}'`,
    );
  }
  const m = app.model.find((x) =>
    x.module === parsed.module && x.name === parsed.resource
  );
  if (!m) {
    return err(
      "notFound",
      `no resource '${parsed.resource}' in module '${parsed.module}'`,
    );
  }
  const r = resourceFindEntry(m);
  // a resource NOT opted into `as:"resource"` is invisible at the resource axis — the surface is curated.
  if (!r) {
    return err(
      "notFound",
      `'${parsed.module}/${parsed.resource}' is not exposed as an MCP resource`,
    );
  }
  // A custom op (get/find in m.operations, not auto-CRUD find) carries its own policy + handler that the
  // raw list-by-id path skips — route through the SAME dispatch the get tool uses, or a permless actor reads a forbidden row.
  if (r.op in m.operations) {
    // the URI `{id}` addresses ONE entity — thread it as the op's ambient subject exactly as the tool
    // door does (mcp-call.ts); a collection op gets no subject.
    const subject = !opIsCollection(m, r.op)
      ? { resource: m.name, id: parsed.id }
      : undefined;
    const surface = opSurfaceFactory(
      app,
      ctx,
      m.module,
      kms,
      subject,
      datasources,
    )(db);
    // No idempotency key: `resources/read` is a URI GET with no argument channel, and `resourceFindEntry`
    // admits find/get reads only — a read never claims a key (the pipeline arms the claim on writes).
    const res = await dispatchOp(
      { operations: dispatchOperations(m) },
      r.op,
      db,
      ctx,
      { id: parsed.id },
      undefined,
      surface,
      { module: m.module, resource: m.name, origin: "mcp" },
    );
    // forbidden/notFound both collapse to `resource not found` at the serve edge — no confirm-exists oracle.
    if (!res.ok) return res as Result<McpResourceContent>;
    // read order (12-mcp §6): handler result → the op door's chokepoint (sensitive masked, withheld columns
    // dropped, over the whole app) → curated shape — same as the get tool.
    const data = shapeOpValue(
      egressOp(app.model, res.value, { mask: true }),
      r.entry.shape,
    );
    if (data === null || typeof data !== "object") {
      return err("notFound", `no ${m.name} '${parsed.id}'`);
    }
    return ok({
      uri,
      mimeType: "application/json",
      data: data as Record<string, unknown>,
    });
  }
  const rp = resolveRowPolicy(m, rowPolicies);
  try {
    // the SAME read the `find` tool runs, through the same projection. One row max; an invisible/absent
    // row → notFound (masking).
    const rows = projectRead(
      m,
      "find",
      redactAll(m, await list(db, m, ctx, rp, { id: parsed.id }, kms)),
      r.entry.shape,
    );
    if (rows.length === 0) {
      return err("notFound", `no ${m.name} '${parsed.id}'`);
    }
    return ok({ uri, mimeType: "application/json", data: rows[0]! });
  } catch (e) {
    return err("internal", String(e));
  }
}

// ── `hazelnut-semantics://` — the framework-public, un-gated semantics resource scheme (12-mcp §6) ──────
// A structurally separate URI scheme + handler that never touches the op-pipeline: it reads only the
// static invariant catalog (no DB, no actor, no `ctx`), so it is provably row-free and safe un-filtered.
// Body is `explainInvariant`, the same projection `hazelnut explain <id>` and 09-verifier.md §explain use.

export const SEMANTICS_SCHEME = "hazelnut-semantics://";

/** The `hazelnut-semantics://<key>` resource content (12-mcp §6) — the row-free semantics/explain
 *  projection for one invariant id, safe to serve to any principal. */
export interface McpSemanticsContent {
  readonly uri: string;
  readonly mimeType: "application/json";
  readonly explanation: Explanation;
}

/** Is this a `hazelnut-semantics://` URI? Routes a read to the ungated semantics handler vs the gated
 *  app-resource path — the two schemes share no read branch. */
export function isSemanticsUri(uri: string): boolean {
  return uri.startsWith(SEMANTICS_SCHEME);
}

/** Read a `hazelnut-semantics://<key>` resource (12-mcp §6) — the framework-public, ungated semantics
 *  surface. Takes no db/actor/ctx by construction (a row-touching read is unrepresentable). An unknown
 *  key is still a well-formed `Explanation` with `known:false` (a catalog miss, never a row probe). */
export async function readSemanticsResource(
  uri: string,
): Promise<Result<McpSemanticsContent>> {
  if (!isSemanticsUri(uri)) {
    return err("validation", `not a '${SEMANTICS_SCHEME}' URI: '${uri}'`);
  }
  const key = uri.slice(SEMANTICS_SCHEME.length);
  if (key === "") return err("validation", `empty semantics key in '${uri}'`);
  // Lazy AND unanalyzable, both deliberately. This is the one served-runtime path that reaches a
  // tooling-phase module, and it is optional by design — absent, the app surface is unaffected.
  //
  // The specifier is BUILT at runtime rather than written as a literal. A literal dynamic specifier is still
  // part of the module graph: it survives into whatever the consumer deploys, so this one edge dragged the
  // whole verify catalog (11 files) into a served process that never calls it. Built at runtime it is
  // unanalyzable, stays out of the graph, and still resolves when the module IS present.
  //
  // The shape is DECLARED because a runtime-built specifier types as `any` — without the cast the call site
  // is silently untyped. And the catch discriminates: only the module being ABSENT is the expected degrade;
  // a module that is present but throws is a real failure and must not read as "not shipped".
  let explainInvariant: (id: string) => Explanation;
  try {
    const spec = ["..", "verify", "explain.ts"].join("/");
    ({ explainInvariant } = await import(spec) as {
      explainInvariant: (id: string) => Explanation;
    });
  } catch (e) {
    const absent = e instanceof TypeError &&
      /Module not found|Cannot find module/i.test(e.message);
    if (!absent) throw e;
    return err(
      "internal",
      "the semantics catalog is not present in this build (the verify envelope is not shipped); the app surface is unaffected",
    );
  }
  return ok({
    uri,
    mimeType: "application/json",
    explanation: explainInvariant(key),
  });
}
