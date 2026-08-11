/** Authz seam + typed permission vocabulary (13-authz.md). The framework owns the typed vocabulary,
 *  `can(actor, key)`, and the one resolution path (`defineAuth({ resolvers })` → first non-null wins).
 *  How claims get populated — roles, agent credentials, IdP, ABAC — is a seam; recipes plug in as resolvers. */

export type PermKey = string;

export interface Actor {
  readonly id: string;
  readonly type: "user" | "agent" | "system";
  readonly claims: ReadonlySet<PermKey>; // resolved once at authn; the check is O(1) thereafter
  readonly onBehalfOf?: string; // agent-acting-for-user provenance
}

/** The anonymous actor — what an all-null resolver chain yields. Never has any claim. */
export const ANON: Actor = { id: "anonymous", type: "user", claims: new Set() };

/** The free `can(actor, key)` is `actor.claims.has(key)` (the sole check — the `Actor` carries no `.can`
 *  method); a null/anon actor can do nothing. */
export function can(actor: Actor | null, key: PermKey): boolean {
  return actor !== null && actor.claims.has(key);
}

/** True iff this caller has proven nothing. Anonymous has TWO shapes on the read path — `null` (no auth seam)
 *  and the non-null `ANON` floor (every resolver returned null) — so a rowPolicy meaning "signed in only" MUST
 *  branch on this: `actor !== null` admits ANON, and `all()` behind that test serves the whole table.
 *  Matched by id, not identity, so a spread or re-minted anonymous principal still reads as anonymous. */
export function isAnonymous(actor: Actor | null): boolean {
  return actor === null || actor.id === ANON.id;
}

/** Module-private brand, held as SET MEMBERSHIP rather than a property: an object SPREAD, `Object.assign`
 *  and `structuredClone` all copy own symbol keys, and none of them can copy membership of a closed-over set. */
const SYSTEM_ACTORS = new WeakSet<Actor>();

/** A framework-mediated "act as system" principal for internal work outside a request (purge jobs, the
 *  outbox relay, migrations). Carries provenance; `logic/` may NEVER fabricate one — only the framework
 *  mints it. Holds no claim — its bypass is declared per op (`scope/system-bypass-declared`), never automatic. */
export function systemActor(reason: string): Actor {
  // frozen so the ONE branded object cannot be re-pointed at a claim set after minting; `withTenant`'s
  // binding is a WeakMap, so nothing legitimate writes to an actor.
  const actor: Actor = Object.freeze({
    id: "system",
    type: "system",
    claims: new Set<PermKey>(),
    onBehalfOf: `system:${reason}`,
  });
  SYSTEM_ACTORS.add(actor);
  return actor;
}

/** True iff the actor is the framework's branded system principal (the predicate the rowPolicy write-bypass
 *  checks). Membership AND the no-claim shape: freezing leaves `claims.add(...)` as the last mutation, and a
 *  system principal that acquired a claim gives up the bypass rather than compounding it. */
export function isSystem(actor: Actor | null): boolean {
  return actor !== null && SYSTEM_ACTORS.has(actor) && actor.claims.size === 0;
}

/** Construct a user actor with an explicit claim set — the common shape in resolvers and tests. */
export function userActor(id: string, claims: readonly PermKey[] = []): Actor {
  return { id, type: "user", claims: new Set(claims) };
}

// ── multi-tenant opt-in recipe (13-authz.md §7): a tenancy layer atop the generic scope core ──────────
// A resolver stamps the actor's tenant id; a `withinScope` fragment narrows reads to it, off a recipe-side WeakMap, so the core `Actor` stays tenancy-agnostic.

/** The recipe's actor→tenant binding — a WeakMap so the core `Actor` type gains no tenant field. An
 *  actor with no binding has no tenant (tenant-agnostic / cross-tenant). */
const tenantBinding = new WeakMap<Actor, string>();

/** Stamp an actor with its resolved tenant id (the recipe resolver calls this) and return the same actor,
 *  so it composes in a resolver chain — the tenant id lives off-actor, in the WeakMap. */
export function withTenant<A extends Actor>(actor: A, tenantId: string): A {
  tenantBinding.set(actor, tenantId);
  return actor;
}

/** Read an actor's recipe-bound tenant id, or `null` for an unbound/cross-tenant principal. `withinScope`
 *  (where.ts) threads this into `withinScope`, reusing the generic scope-narrowing fragment. */
export function tenantOf(actor: Actor | null): string | null {
  return actor === null ? null : tenantBinding.get(actor) ?? null;
}

/** Recipe sugar: a user actor pre-stamped with its tenant id — the common shape in a tenant resolver/test. */
export function tenantActor(
  id: string,
  tenantId: string,
  claims: readonly PermKey[] = [],
): Actor {
  return withTenant(userActor(id, claims), tenantId);
}

type PermVocab<T extends Record<string, readonly string[]>> = {
  readonly [K in keyof T]: { readonly [A in T[K][number]]: PermKey };
};

/** The typed permission vocabulary: `definePerms({ post: ["read","create"] })` → `perms.post.read ===
 *  "post:read"`, the same `<resource>:<action>` wire form the verifier auto-seeds and `claims` holds
 *  (13-authz.md §2) — so `can()`'s exact-string match lands. Only declared permissions compile. */
export function definePerms<const T extends Record<string, readonly string[]>>(
  spec: T,
): PermVocab<T> {
  const out = {} as Record<string, Record<string, PermKey>>;
  for (const resource of Object.keys(spec)) {
    out[resource] = {};
    for (const action of spec[resource]!) {
      out[resource]![action] = `${resource}:${action}`;
    }
  }
  return out as PermVocab<T>;
}

// ── derivePerms: derive the 80%, declare the 20% (13-authz.md §2) ────────────────────────────────

/** The five CRUD verbs every resource auto-seeds a `<resource>:<verb>` permission for (13-authz.md §2).
 *  The single canonical source — verify.ts and the HTTP/OpenAPI/surface-lock projections import this (or
 *  `CRUD_VERB_SET`), so the derived vocabulary and every CRUD-route skip stay byte-identical. */
export const CRUD_VERBS = [
  "list",
  "find",
  "create",
  "update",
  "delete",
] as const;
export type CrudVerb = (typeof CRUD_VERBS)[number];

/** The same five verbs as a `ReadonlySet` (`CRUD_VERB_SET.has(op)`), for the HTTP/OpenAPI/surface-lock
 *  projections to skip CRUD routes. Built from `CRUD_VERBS` — one source, no re-declared copies to drift. */
export const CRUD_VERB_SET: ReadonlySet<string> = new Set(CRUD_VERBS);

/** The minimal `derivePerms` input — the slice of a `ResourceDecl` the vocabulary derives from. A full
 *  `defineResource` decl structurally satisfies it, so `derivePerms(decl)` accepts the whole
 *  `... as const satisfies ResourceDecl` (13-authz.md §open-tails). */
export interface PermSource {
  readonly name: string;
  readonly operations?: Readonly<Record<string, unknown>>;
  readonly capabilities?: readonly string[];
}

/** The derived typed vocabulary for one resource — `{ list, find, …, <customOp>, <capability> }`, each
 *  value the `<name>:<key>` colon string. Literal keys flow from the decl, so `perms.viewInactive` compiles
 *  and `perms.typo` does not. */
export type DerivedPerms<D extends PermSource> = {
  readonly [
    K in
      | CrudVerb
      | (keyof D["operations"] & string)
      | (D["capabilities"] extends readonly string[] ? D["capabilities"][number]
        : never)
  ]: PermKey;
};

// roster/engine extracted into cohesive submodules, re-exported so importers stay stable.
