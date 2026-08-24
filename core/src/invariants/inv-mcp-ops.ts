// Barrel re-exports keep import sites stable.
import type { ResourceModel } from "../core/app.ts";
import { isPublicRoute } from "../core/app-refs.ts";
import { idxOf } from "./model-index.ts";
import type { Invariant } from "../core/verifier-contract.ts";
import type { Violation } from "../core/structural-violation.ts";
import { resourceRegistrationFindings } from "../core/resource-registered.ts";

/** `mcp/read-protected` (mcp-surface twin of `policy/read-protected`, 10-invariants.md §policy/read-protected):
 *  an mcp read projection (`list`/`find`) must be either public or covered by a `rowPolicy`. Escapes: a
 *  rowPolicy exists, or the http twin is deliberately `"public"`. Otherwise a curated read tool with no
 *  rowPolicy leaks the whole table to a remote, untrusted, injectable agent. */
export const mcpReadProtected: Invariant = {
  id: "mcp/read-protected",
  check(ctx) {
    const m = ctx.resource;
    if (m.hasRowPolicy) return [];
    return (["list", "find"] as const)
      .filter((read) => read in m.mcp && !isPublicRoute(m.http[read]))
      .map((read) => ({
        id: "mcp/read-protected",
        resource: m.name,
        message:
          `mcp curates a '${read}' read tool but the resource declares no rowPolicy and its http '${read}' read is not "public" — every row is visible to any remote agent that can call the tool (a whole-table leak to an untrusted caller); declare a rowPolicy, or mark the http read "public" if the rows are genuinely public`,
      }));
  },
};

/** `mcp/confirm-on-destructive` (12-mcp.md §confirm): an mcp tool curating `delete` must set `confirm:true`
 *  so the host surfaces human-in-the-loop elicitation — without it an autonomous agent can hard-delete a row
 *  with no human approval. */
export const mcpConfirmOnDestructive: Invariant = {
  id: "mcp/confirm-on-destructive",
  check(ctx) {
    const m = ctx.resource;
    const del = m.mcp["delete"];
    if (del && del.confirm !== true) {
      return [{
        id: "mcp/confirm-on-destructive",
        resource: m.name,
        message:
          "mcp curates a 'delete' tool without confirm:true — an autonomous agent could hard-delete a row with no human-in-the-loop; a destructive mcp tool must set confirm:true",
      }];
    }
    return [];
  },
};

/** An op declaration (`op({...})`) carried verbatim in `m.operations` as `unknown`. Reads only the two
 *  structural slots these checks need — `policy` and `handler` — narrowing without `as`/`any`. */
function asOpDecl(
  v: unknown,
): { readonly policy?: unknown; readonly handler?: unknown } {
  return v !== null && typeof v === "object"
    ? (v as Record<string, unknown>)
    : {};
}
/** An op is exposed iff its name is projected onto an HTTP route key or an MCP tool key. An op absent from
 *  both is internal (cross-module/in-process only), outside the surface authz floor `policy/required-op` guards. */
const isExposedOp = (m: ResourceModel, name: string): boolean =>
  name in m.http || name in m.mcp;

/** `policy/required-op` (advisory — 10-invariants.md §policy/required, op face): an exposed custom op with no
 *  `policy` is safe at runtime — the dispatch boundary auto-injects the convention-default permission
 *  `<resource>:<op>` (deny-by-default), so this is a discipline nudge, not a ship-block. The separate view-face
 *  check `policy/required` stays a ship-blocking error — a view with no rowPolicy is genuine unauthenticated access. */
export const policyRequiredOp: Invariant = {
  id: "policy/required-op",
  determinism: "runtime-assert", // advisory axis position → deriveBlocks yields "advisory" (never ship-block)
  check(ctx) {
    const m = ctx.resource;
    const out: Violation[] = [];
    for (const [name, decl] of Object.entries(m.operations)) {
      if (!isExposedOp(m, name)) continue;
      // an EXPLICIT `policy: null` is the written public door (the runtime reads it as public; only an
      // ABSENT key inherits the default refusal) — flagging it here is a false positive on a legal shape
      const d = asOpDecl(decl);
      if (!("policy" in d) && typeof d.policy !== "function") {
        out.push({
          id: "policy/required-op",
          resource: m.name,
          message:
            `exposed op '${name}' has no explicit policy — it is governed by the convention-default permission '${m.name}:${name}' (deny-by-default); declare a policy to state a custom rule (e.g. owner()/requires(...))`,
        });
      }
    }
    return out;
  },
};

/** `wiring/op-has-handler` (10-invariants.md §completeness): every declared op must carry a callable
 *  `handler` — without one, `dispatchOp` resolves the name, runs validate→policy, then has nothing to invoke. */
export const opHasHandler: Invariant = {
  id: "wiring/op-has-handler",
  check(ctx) {
    const m = ctx.resource;
    const out: Violation[] = [];
    for (const [name, decl] of Object.entries(m.operations)) {
      if (typeof asOpDecl(decl).handler !== "function") {
        out.push({
          id: "wiring/op-has-handler",
          resource: m.name,
          message:
            `op '${name}' has no handler — a declared op with no callable handler is a dangling wire: dispatch resolves the name but has nothing to run`,
        });
      }
    }
    return out;
  },
};

/** `refs/point-to-exposed` (10-invariants.md §completeness): every non-external reference (and `parent`) must
 *  point to a registered resource — an unsatisfiable FK otherwise. `createApp` rejects a dangling target at
 *  boot; this is the model-analysis backstop for a model composed/mutated without that boot pass. */
export const refsPointToExposed: Invariant = {
  id: "refs/point-to-exposed",
  check(ctx) {
    const m = ctx.resource;
    const registered = idxOf(ctx).names; // the per-run memo
    const out: Violation[] = [];
    const targets = [
      ...Object.entries(m.references).filter(([, r]) => !r.external).map((
        [field, r],
      ) => [field, r.to] as const),
      ...(m.parent ? [["parent", m.parent] as const] : []),
    ];
    for (const [field, to] of targets) {
      if (!registered.has(to)) {
        out.push({
          id: "refs/point-to-exposed",
          resource: m.name,
          message:
            `reference '${field}' targets '${to}' which is not a registered resource — the FK points at a table that does not exist`,
        });
      }
    }
    return out;
  },
};

/** `wiring/resource-registered` (10-invariants.md §completeness): each resource must be uniquely registered in
 *  three senses — (1) table identity: no two model entries share a (name, pgSchema), else the second silently
 *  shadows the first; (2) MCP/bare-name surface: two HTTP-exposed resources sharing a bare name collide even
 *  across schemas (tool address is schema-agnostic); (3) resolved HTTP route base (`path` or `/${name}s`):
 *  two exposed resources mounting the same base collide even with distinct names. Two internal (no-http)
 *  same-named resources are fine (schema-per-module). */
export const resourceRegistered: Invariant = {
  id: "wiring/resource-registered",
  check(ctx) {
    return resourceRegistrationFindings(
      ctx.resource,
      ctx.model,
      idxOf(ctx).registration,
    );
  },
};

// ── CAPABILITY VOCABULARY (the special non-CRUD permission keys; 13-authz.md §2) ──
// `capabilities` assembles a resource's non-CRUD permission keys as `<resource>:<key>`; these are
// model-analysis checks over `m.capabilities`, using the deriver-guard id scheme, not the canon roster's own.
