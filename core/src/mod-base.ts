// @hazelnut/core — the ROOT barrel: the `core` CONCERN, not a rung. Rung and group are independent axes —
// rung 1 already reaches `hazelnut/query` for `all`/`none` — so what sits here is the core group's declared
// membership: the authoring verbs, the Result seam, the authz vocabulary, and the model and db types they
// name. Every other concern is a named subpath (`hazelnut/query`, `/async`, `/crypto`, `/faces`, `/schema`) whose
// membership `scripts/surface-groups.ts` declares as an equality against
// this file.

// side-effect only: serve.ts installs the router factory (`setRouterFactory(createRouter)`) at load — a
// barrel-only consumer must still load it, but the bare `import` keeps `createRouter` off the barrel.
import "./runtime/serve.ts";

// ── authoring vocabulary (`define*`) + the app entry ───────────────────────────────────────────────────────
export {
  createApp,
  dataMigration,
  defineConfig,
  defineVersion,
} from "./core/app.ts";
export { defineModule, defineResource } from "./core/app-define.ts";
export type { App } from "./core/app-define.ts";
export { defineOp } from "./core/faces-ctx.ts";
export { binary, defineView, json } from "./features/view.ts"; // json()/binary() are defineView output markers, used inline as `output: binary()`
export type { ViewOutput } from "./features/view.ts";
export { defineAuth } from "./authz/auth-perms.ts";
export { definePerms } from "./authz/auth.ts";

// ── the op-pipeline surface + Result ───────────────────────────────────────────────────────────────────────
export type { Handler, OpDecl, OpDef } from "./core/pipeline.ts";
export { err, ok } from "./core/result.ts";
export type { Result } from "./core/result.ts";
// `runOp` is intentionally off-barrel: drive an op via `testCtx.runOp(op, input, { actor? })`
// (hazelnut/test.ts).
export type { Ctx } from "./core/faces-ctx.ts";
export type { ResourceModel } from "./core/app-types.ts";

export type { ReadCtx, RowPolicy } from "./data/repo.ts";
export { applySchema } from "./data/migrate.ts";
export { pgliteDb, postgresDb } from "./data/db.ts";
export type { Db, Transactor } from "./data/db.ts";
// The storage seam sits beside the db seam, not with the query vocabulary: both are things a project
// CONSTRUCTS at boot and hands to `createApp`. `file()` — declaring a column that holds bytes — is `query`'s.
export { localDriver } from "./data/storage.ts";
export type { StorageDriver } from "./data/storage.ts";

// ── features: transitions, auth/perms, encryption, throttle ────────────────────────────────────────────────
export { transition } from "./features/transition.ts";
export { can, userActor } from "./authz/auth.ts";
// off-barrel: the tenancy recipe `tenantActor`/`tenantOf`/`withTenant` (authz/auth.ts) is a business
// concept the "no tenant/org in core" pin excludes — reach it at `hazelnut/authz/auth.ts`.
export type { Actor, PermKey } from "./authz/auth.ts";
export {
  derivePerms,
  requires,
  requiresAll,
  requiresAny,
} from "./authz/auth-perms.ts"; // derivePerms = canonical typed perms path; definePerms is the manual-vocabulary escape
// the bundle/`implies` expansion tools an app composes into its own auth resolver (13-authz.md §permission-vocabulary):
// `claimResolver(vocab)` builds an actor whose `claims` closure resolves through `group`/`implies` once, so `can()` stays O(1).
export { buildExpansion, claimResolver, group } from "./authz/auth-perms.ts";
export type { Bundle, ImpliesMap } from "./authz/auth-perms.ts";

// Published direct-path seams: `createRouter` at `hazelnut/runtime/serve.ts` (the caller owns
// `resolveCtx`), trusted raw repository helpers at `hazelnut/data/repo.ts`, and actor helpers at
// `hazelnut/authz/auth.ts`. Prefer `hazelnut/test.ts` for consumer fixtures and operation tests.
