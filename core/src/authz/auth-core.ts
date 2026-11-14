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

/** A runtime-readonly Set view. Neither valueOf nor forEach may reveal the backing Set. */
function immutableSet(
  values: Iterable<string>,
  label: string,
): ReadonlySet<string> {
  const source = new Set(values);
  Object.preventExtensions(source);
  return new Proxy(source, {
    get(target, key, receiver) {
      if (key === "add" || key === "delete" || key === "clear") {
        return () => {
          throw new TypeError(`${label} is immutable`);
        };
      }
      if (key === "forEach") {
        return (
          callback: (
            value: string,
            value2: string,
            set: ReadonlySet<string>,
          ) => void,
          thisArg?: unknown,
        ) =>
          target.forEach((value) =>
            callback.call(thisArg, value, value, receiver)
          );
      }
      if (key === "valueOf") return () => receiver;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** The anonymous actor — what an all-null resolver chain yields. Never has any claim. Frozen like
 *  `systemActor`: ANON is process-shared, so a mutable claims Set would be one `add` away from
 *  permanently upgrading EVERY anonymous caller. */
export const ANON: Actor = Object.freeze({
  id: "anonymous",
  type: "user",
  claims: immutableSet([], "ANON claims"),
});

/** The free `can(actor, key)` is `actor.claims.has(key)` (the sole check — the `Actor` carries no `.can`
 *  method); a null or anonymous actor can do nothing — even a reminted `userActor("anonymous", …)` with
 *  a non-empty claims set (ANON-RESOLVER-FORGE): the reserved id is claim-less by construction. */
export function can(actor: Actor | null, key: PermKey): boolean {
  return actor !== null && !isAnonymous(actor) && actor.claims.has(key);
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

/** Construct a user actor with an explicit claim set — the common shape in resolvers and tests.
 *  The reserved anonymous id always yields the process-shared `ANON` floor (claim-less); a resolver
 *  that tries `userActor("anonymous", […perms])` cannot mint a forged principal. */
export function userActor(id: string, claims: readonly PermKey[] = []): Actor {
  if (id === ANON.id) return ANON;
  return { id, type: "user", claims: new Set(claims) };
}

// ── multi-tenant opt-in recipe (13-authz.md §scope-vs-rowpolicy): a tenancy layer atop the generic scope core ──────────
// A resolver stamps the actor's tenant id; a `withinScope` fragment narrows reads to it, off a recipe-side WeakMap, so the core `Actor` stays tenancy-agnostic.

/** The recipe's actor→tenant binding — a WeakMap so the core `Actor` type gains no tenant field. An
 *  actor with no binding has no tenant (tenant-agnostic / cross-tenant). */
const tenantBinding = new WeakMap<Actor, string>();
/** Per-invocation identities must not be rebound by application logic. */
const sealedActors = new WeakSet<Actor>();

/** Stamp an authenticated actor with its resolved tenant id (the recipe resolver calls this) and return
 *  the same actor, so it composes in a resolver chain — the tenant id lives off-actor, in the WeakMap.
 *  Anonymous principals are deliberately never bound, even if a resolver accidentally calls this: a
 *  tenant recipe must fail closed for them. The binding belongs to this exact object identity; a spread,
 *  Object.assign, or structured clone is a new actor and must be bound again after its identity is settled. */
export function withTenant<A extends Actor>(actor: A, tenantId: string): A {
  if (typeof tenantId !== "string") {
    throw new TypeError("tenant id must be a string");
  }
  if (isAnonymous(actor)) return actor;
  if (sealedActors.has(actor)) {
    throw new TypeError("cannot rebind a sealed actor's tenant");
  }
  tenantBinding.set(actor, tenantId);
  return actor;
}

/** Read an actor's recipe-bound tenant id, or `null` for anonymous, unbound, or cross-tenant principals.
 *  `withinScope` (where.ts) threads this into the generic scope-narrowing fragment. */
export function tenantOf(actor: Actor | null): string | null {
  return actor === null || isAnonymous(actor)
    ? null
    : tenantBinding.get(actor) ?? null;
}

/** Clone extension data rather than sharing mutable authorization state with logic.
 * The Actor contract permits ordinary data extensions; exotic stateful objects,
 * accessors and functions cannot be made safely immutable across an invocation. */
function snapshotActorData(
  value: unknown,
  seen: WeakMap<object, unknown>,
): unknown {
  if (
    value === null || (typeof value !== "object" && typeof value !== "function")
  ) return value;
  if (typeof value === "function") {
    throw new TypeError(
      "actor/snapshot-unsupported: actor extension functions are not supported",
    );
  }
  const prior = seen.get(value);
  if (prior !== undefined) return prior;
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) {
    throw new TypeError(
      "actor/snapshot-unsupported: actor extensions must contain only plain data and arrays",
    );
  }
  const copy: Record<PropertyKey, unknown> | unknown[] = Array.isArray(value)
    ? []
    : Object.create(proto);
  seen.set(value, copy);
  if (Array.isArray(value) && Array.isArray(copy)) copy.length = value.length;
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === "length") continue;
    const desc = Object.getOwnPropertyDescriptor(value, key)!;
    if (!("value" in desc)) {
      throw new TypeError(
        "actor/snapshot-unsupported: actor extension accessors are not supported",
      );
    }
    Object.defineProperty(copy, key, {
      value: snapshotActorData(desc.value, seen),
      enumerable: desc.enumerable,
      writable: true,
      configurable: true,
    });
  }
  return Object.freeze(copy);
}

/** Snapshot the verified authority for one invocation. The resolver's original
 * remains live for future authorization, but application code cannot rewrite
 * this invocation's principal, claims or tenant binding. */
export function snapshotActor(
  actor: Actor | null,
  allowMissingClaims = false,
): Actor | null {
  if (actor === null) return null;
  if (sealedActors.has(actor)) {
    if (
      !allowMissingClaims && actor.type !== "user" && actor.type !== "agent" &&
      actor.type !== "system"
    ) {
      throw new TypeError(
        "actor/snapshot-invalid: actor identity fields are invalid",
      );
    }
    return actor;
  }
  const actorId: unknown = actor.id;
  if (
    typeof actorId !== "string" || actorId.trim() === "" || actorId === ANON.id
  ) return ANON;
  const actorType: unknown = actor.type;
  const onBehalfOf: unknown = actor.onBehalfOf;
  const tenant = tenantBinding.get(actor);
  const systemBrand = SYSTEM_ACTORS.has(actor);
  if (
    typeof actorType !== "string" || actorType === "" ||
    (!allowMissingClaims && actorType !== "user" && actorType !== "agent" &&
      actorType !== "system") ||
    (onBehalfOf !== undefined && typeof onBehalfOf !== "string")
  ) {
    throw new TypeError(
      "actor/snapshot-invalid: actor identity fields are invalid",
    );
  }
  // Inherited custom properties cannot be captured as stable data without
  // invoking arbitrary prototype behavior or changing its semantics.
  const visitedPrototypes = new WeakSet<object>();
  for (
    let proto = Object.getPrototypeOf(actor);
    proto && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto)
  ) {
    if (visitedPrototypes.has(proto)) {
      throw new TypeError("actor/snapshot-unsupported: cyclic actor prototype");
    }
    visitedPrototypes.add(proto);
    for (const key of Reflect.ownKeys(proto)) {
      if (
        key !== "constructor" && key !== "id" && key !== "type" &&
        key !== "claims" && key !== "onBehalfOf"
      ) {
        throw new TypeError(
          "actor/snapshot-unsupported: inherited actor extensions are not supported",
        );
      }
    }
  }
  const sourceClaims = actor.claims;
  if (sourceClaims == null && !allowMissingClaims) {
    throw new TypeError(
      "actor/snapshot-invalid: claims must be a ReadonlySet of strings",
    );
  }
  const claims = sourceClaims ?? new Set<string>();
  if (
    typeof claims.has !== "function" ||
    typeof claims[Symbol.iterator] !== "function" ||
    !Number.isSafeInteger(claims.size) || claims.size < 0
  ) {
    throw new TypeError(
      "actor/snapshot-invalid: claims must be a ReadonlySet of strings",
    );
  }
  const entries = [...claims];
  if (
    entries.length !== claims.size ||
    entries.some((claim) => typeof claim !== "string" || !claims.has(claim)) ||
    new Set(entries).size !== entries.length
  ) {
    throw new TypeError(
      "actor/snapshot-invalid: claims must be a consistent ReadonlySet of strings",
    );
  }
  const extra: Record<PropertyKey, unknown> = {};
  const seen = new WeakMap<object, unknown>();
  for (const key of Reflect.ownKeys(actor)) {
    if (
      key === "id" || key === "type" || key === "claims" || key === "onBehalfOf"
    ) continue;
    const desc = Object.getOwnPropertyDescriptor(actor, key)!;
    if (!("value" in desc)) {
      throw new TypeError(
        "actor/snapshot-unsupported: actor extension accessors are not supported",
      );
    }
    Object.defineProperty(extra, key, {
      value: snapshotActorData(desc.value, seen),
      enumerable: desc.enumerable,
      writable: true,
      configurable: true,
    });
  }
  const snapshotObject = Object.defineProperties(
    {},
    Object.getOwnPropertyDescriptors(extra),
  );
  Object.assign(snapshotObject, {
    id: actorId,
    type: actorType,
    claims: immutableSet(entries, "actor claims"),
    ...(onBehalfOf === undefined ? {} : { onBehalfOf }),
  });
  const snapshot = Object.freeze(snapshotObject) as Actor;
  if (tenant !== undefined) tenantBinding.set(snapshot, tenant);
  if (systemBrand && entries.length === 0) SYSTEM_ACTORS.add(snapshot);
  sealedActors.add(snapshot);
  return snapshot;
}

/** Preserve a structural context's own properties and prototype while replacing
 * its actor with the immutable invocation snapshot. Custom context methods are
 * trusted integration code and retain their ordinary receiver semantics. */
export function snapshotContext<C extends { readonly actor?: Actor | null }>(
  ctx: C,
): C {
  const descriptors: Record<string, PropertyDescriptor> = Object
    .getOwnPropertyDescriptors(ctx);
  // Native private slots live on the original instance, not on a prototype
  // clone. Bind inherited integration methods/getters to their original trusted
  // receiver while the handler-facing `actor` remains the sealed snapshot.
  const visitedPrototypes = new WeakSet<object>();
  for (
    let proto = Object.getPrototypeOf(ctx);
    proto && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto)
  ) {
    if (visitedPrototypes.has(proto)) {
      throw new TypeError(
        "actor/snapshot-unsupported: cyclic context prototype",
      );
    }
    visitedPrototypes.add(proto);
    for (const key of Reflect.ownKeys(proto)) {
      if (
        key === "constructor" || key === "actor" ||
        Object.hasOwn(descriptors, key)
      ) continue;
      const desc = Object.getOwnPropertyDescriptor(proto, key)!;
      if (typeof desc.value === "function") desc.value = desc.value.bind(ctx);
      if (desc.get) desc.get = desc.get.bind(ctx);
      if (desc.set) desc.set = desc.set.bind(ctx);
      Object.defineProperty(descriptors, key, {
        value: desc,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  descriptors.actor = {
    value: snapshotActor(ctx.actor ?? null),
    enumerable: true,
    writable: false,
    configurable: false,
  };
  return Object.defineProperties(
    Object.create(Object.getPrototypeOf(ctx)),
    descriptors,
  ) as C;
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
 *  (13-authz.md §permission-vocabulary) — so `can()`'s exact-string match lands. Only declared permissions compile. */
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

// ── derivePerms: derive the 80%, declare the 20% (13-authz.md §permission-vocabulary) ────────────────────────────────

/** The five CRUD verbs every resource auto-seeds a `<resource>:<verb>` permission for (13-authz.md §permission-vocabulary).
 *  The single canonical source — verify.ts and the HTTP/OpenAPI/surface-lock projections import this (or
 *  `CRUD_VERB_SET`), so the derived vocabulary and every CRUD-route skip stay byte-identical. */
export const CRUD_VERBS = Object.freeze(
  [
    "list",
    "find",
    "create",
    "update",
    "delete",
  ] as const,
);
export type CrudVerb = (typeof CRUD_VERBS)[number];

/** The consumer alias for a read grant. Seeded by `derivePerms` so `requires("<r>:read")` resolves;
 *  not an HTTP verb — `CRUD_VERB_SET` does not contain it, and GET stays row-policy-gated. */
export const CRUD_READ_ALIAS = "read" as const;

/** The same five verbs as a runtime-immutable `ReadonlySet` (`CRUD_VERB_SET.has(op)`), for the
 *  HTTP/OpenAPI/surface-lock projections to skip CRUD routes. Built from `CRUD_VERBS` — one source. */
export const CRUD_VERB_SET: ReadonlySet<string> = immutableSet(
  CRUD_VERBS,
  "CRUD_VERB_SET",
);

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
      | typeof CRUD_READ_ALIAS
      | (keyof D["operations"] & string)
      | (D["capabilities"] extends readonly string[] ? D["capabilities"][number]
        : never)
  ]: PermKey;
};

// roster/engine extracted into cohesive submodules, re-exported so importers stay stable.
