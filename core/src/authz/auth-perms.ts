// Barrel re-exports keep import sites stable.
import { z } from "zod";
import {
  type Actor,
  ANON,
  can,
  CRUD_VERBS,
  type DerivedPerms,
  type PermKey,
  type PermSource,
} from "./auth-core.ts";
import type { OnlyKnownKeys } from "../core/config.ts";

/** Derive the typed permission vocabulary for a resource (13-authz.md §2): the five CRUD verbs plus every
 *  `operations`/`capabilities` key, minted to `<name>:<key>` wire form. Reads only `decl` — never
 *  `rowPolicy` — so declaring perms cannot cycle with the policy. */
export function derivePerms<const D extends PermSource>(
  decl: D,
): DerivedPerms<D> {
  const out = {} as Record<string, PermKey>;
  const keys = new Set<string>([
    ...CRUD_VERBS,
    ...Object.keys(decl.operations ?? {}),
    ...(decl.capabilities ?? []),
  ]);
  for (const key of keys) out[key] = `${decl.name}:${key}`;
  return out as DerivedPerms<D>;
}

// ── group / implies: one expansion mechanism, resolved transitively once at auth (13-authz.md §2) ──

/** A permission bundle (13-authz.md §2): holding the bundle key (e.g. `manage`) grants every member.
 *  A bundle and `implies` are the same mechanism — a key expands to a set; only authoring intent differs. */
export interface Bundle {
  readonly __bundle: true;
  readonly members: readonly PermKey[];
}

/** Declare a bundle of permissions (13-authz.md §2) — composed into a resolver's vocab via
 *  `buildExpansion({ bundles: {...} })`, never a resource-decl key. */
export function group(...members: PermKey[]): Bundle {
  return { __bundle: true, members };
}

/** True iff `x` is a `group(...)` bundle (the discriminator the expansion-graph builder reads). */
export function isBundle(x: unknown): x is Bundle {
  return typeof x === "object" && x !== null &&
    (x as { __bundle?: unknown }).__bundle === true;
}

/** The expansion graph: a directed edge `key → {keys it grants}`, fed by `group` bundles and `implies`
 *  edges (13-authz.md §2). Resolved to a transitive closure once at auth, so `can()` stays O(1). */
export type ImpliesMap = Readonly<Record<PermKey, readonly PermKey[]>>;

/** Build the expansion graph from declared `bundles` (group keys → members) and `implies` edges
 *  (`{ edit: ["view"] }`) — both become outgoing edges of the same graph. */
export function buildExpansion(
  spec: {
    readonly bundles?: Readonly<Record<PermKey, Bundle>>;
    readonly implies?: ImpliesMap;
  },
): Map<PermKey, Set<PermKey>> {
  const graph = new Map<PermKey, Set<PermKey>>();
  const add = (from: PermKey, to: PermKey) => {
    let set = graph.get(from);
    if (!set) graph.set(from, set = new Set());
    set.add(to);
  };
  for (const [key, bundle] of Object.entries(spec.bundles ?? {})) {
    for (const member of bundle.members) add(key, member);
  }
  for (const [key, targets] of Object.entries(spec.implies ?? {})) {
    for (const target of targets) add(key, target);
  }
  return graph;
}

/** Expand granted keys transitively over the bundle/implies graph, once, at auth (13-authz.md §2/§4).
 *  Cycle-safe; the closure is the snapshot a resolver writes into `claims`. */
export function expandClaims(
  granted: Iterable<PermKey>,
  graph: Map<PermKey, Set<PermKey>>,
): Set<PermKey> {
  const out = new Set<PermKey>();
  const stack = [...granted];
  while (stack.length > 0) {
    const key = stack.pop()!;
    if (out.has(key)) continue; // already expanded → cycle-safe + idempotent
    out.add(key);
    for (const next of graph.get(key) ?? []) {
      if (!out.has(next)) stack.push(next);
    }
  }
  return out;
}

// ── the unified resolution path: grants → expand → snapshot into claims (13-authz.md §4) ──────

/** The vocabulary spec a resolver resolves grants against — the `bundles`/`implies` edges (`buildExpansion`'s
 *  input). Built once per app at boot; each actor's grants are snapshotted through it, so `can()` stays O(1). */
export type VocabSpec = Parameters<typeof buildExpansion>[0];

/** The single resolution path (13-authz.md §4): union the actor's granted keys across all roles/credentials,
 *  then expand the bundle/implies closure once over the vocabulary graph — union happens before the closure,
 *  so expansion sees the full grant. Identical for humans and agents. */
export function resolveClaims(
  granted: Iterable<PermKey>,
  graph: Map<PermKey, Set<PermKey>>,
): Set<PermKey> {
  return expandClaims(granted, graph);
}

/** Build a resolver's expansion graph once, returning a reusable per-actor snapshotter:
 *  `snapshot(id, type, grantedKeys)` → an `Actor` whose `claims` is the closure (13-authz.md §4).
 *  Composition, not role inheritance, so cycles cannot arise; cache the snapshot, or re-run per request. */
export function claimResolver(
  vocab: VocabSpec,
): (
  id: string,
  type: Actor["type"],
  granted: Iterable<PermKey>,
  onBehalfOf?: string,
) => Actor {
  const graph = buildExpansion(vocab);
  return (id, type, granted, onBehalfOf) => ({
    id,
    type,
    claims: resolveClaims(granted, graph),
    ...(onBehalfOf !== undefined ? { onBehalfOf } : {}),
  });
}

/** An op policy carrying the permission it checks: `(actor) => can(actor, key)` with `permKey` exposed,
 *  so the §5 capability filter can decide tool visibility statically. */
export interface PermPolicy {
  (actor: Actor | null): boolean;
  readonly permKey: PermKey;
}

/** An op policy that requires a permission — `op({ policy: requires(perms.post.create) })`. */
export function requires(key: PermKey): PermPolicy {
  return Object.assign((actor: Actor | null) => can(actor, key), {
    permKey: key,
  });
}

/** True iff the actor holds every key (the conjunction). A null/anon actor holds none, so `canAll(null,…)`
 *  is false for any non-empty list; the empty list is vacuously true (no requirement). */
export function canAll(actor: Actor | null, keys: Iterable<PermKey>): boolean {
  for (const k of keys) if (!can(actor, k)) return false;
  return true;
}

/** True iff the actor holds at least one key (the disjunction). A null/anon actor holds none, so
 *  `canAny(null,…)` is false; the empty list is also false — fail-closed, never a vacuous grant. */
export function canAny(actor: Actor | null, keys: Iterable<PermKey>): boolean {
  for (const k of keys) if (can(actor, k)) return true;
  return false;
}

/** An op policy requiring all of several permissions. Carries no single `permKey`, so the §5 capability
 *  filter leaves the tool visible and gates at call time; it carries `permKeys` so `authz/key-resolves`
 *  still validates every key — a dangling one fails the build. */
export function requiresAll(
  ...keys: PermKey[]
): (actor: Actor | null) => boolean {
  return Object.assign((actor: Actor | null) => canAll(actor, keys), {
    permKeys: keys,
  });
}

/** An op policy requiring any of several permissions (the bundle-OR shape). Like `requiresAll`, runtime-only
 *  for filtering but validated via `permKeys`; `requiresAny()` with no keys denies everyone (fail-closed). */
export function requiresAny(
  ...keys: PermKey[]
): (actor: Actor | null) => boolean {
  return Object.assign((actor: Actor | null) => canAny(actor, keys), {
    permKeys: keys,
  });
}

// `permKey()` two-stage lazy-seal (13-authz.md §open-tails): unsealed at declaration (wire-format only);
// `createApp` seals it post-assembly, so an unknown scope fails validation, never grants a phantom key.

/** The per-instance seal state: `null` = unsealed (wire-format only), a `Set` = sealed (vocabulary-validated). */
interface PermKeySeal {
  vocab: ReadonlySet<string> | null;
}

const PERMKEY_SEAL = Symbol.for("hazelnut.permKey.seal");

/** A schema field holding one permission key from the app's derived vocabulary — wire-format until
 *  `createApp` seals it, vocabulary-validated after. Use as `scopes: z.array(permKey())` or bare. */
export function permKey(): ReturnType<typeof buildPermKeySchema> {
  return buildPermKeySchema();
}

/** The `permKey()` field schema: a string Zod schema carrying its seal cell. Explicit type (not inferred)
 *  so the return avoids Zod's slow-type inference (no-slow-types). */
type PermKeySchema = z.ZodType<string> & { [PERMKEY_SEAL]: PermKeySeal };
function buildPermKeySchema(): PermKeySchema {
  const seal: PermKeySeal = { vocab: null };
  const schema = z.string().superRefine((val, ctx) => {
    if (seal.vocab === null) return; // stage 1 — unsealed: wire-format only (pre-assembly / verify-time compose)
    if (!seal.vocab.has(val)) {
      ctx.addIssue({
        code: "custom",
        message:
          `unknown permission key '${val}' — not in this app's derived perms vocabulary (a granted scope must name a real permission)`,
      });
    }
  });
  return Object.assign(schema, { [PERMKEY_SEAL]: seal });
}

/** The post-assembly seal pass — `createApp` calls this once with the composed model and perms vocabulary.
 *  Walks every resource schema field and custom op `input` shape (both are validation boundaries a scope can
 *  arrive through), arming each `permKey()`'s seal cell. Re-sealing replaces the vocabulary in place. */
export function sealPermKeys(
  models: ReadonlyArray<
    {
      readonly schema: z.ZodObject<z.ZodRawShape>;
      readonly operations?: Readonly<Record<string, unknown>>;
    }
  >,
  vocab: readonly string[],
): void {
  const set: ReadonlySet<string> = new Set(vocab);
  const visit = (s: unknown, depth: number): void => {
    if (depth > 6 || s === null || typeof s !== "object") return;
    const seal = (s as Record<symbol, PermKeySeal | undefined>)[PERMKEY_SEAL];
    if (seal !== undefined) {
      seal.vocab = set;
      return;
    }
    // duck-typed unwrap of the common zod wrappers: array (`element`), optional/nullable (`unwrap()`),
    // default/pipe-like (`def.innerType`) — deep enough for the recipe shapes, bounded by `depth`.
    const wrapped = s as {
      element?: unknown;
      unwrap?: () => unknown;
      def?: {
        innerType?: unknown;
        valueType?: unknown;
        options?: readonly unknown[];
      };
      shape?: Record<string, unknown>;
      options?: readonly unknown[];
    };
    if (wrapped.element !== undefined) visit(wrapped.element, depth + 1);
    if (typeof wrapped.unwrap === "function") {
      try {
        visit(wrapped.unwrap(), depth + 1);
      } catch { /* not an unwrappable schema — nothing to seal beneath */ }
    }
    if (
      wrapped.def !== null && typeof wrapped.def === "object" &&
      wrapped.def.innerType !== undefined
    ) visit(wrapped.def.innerType, depth + 1);
    // descend into nested composite schemas too — a `permKey()` inside a nested object/record/union would
    // otherwise never be sealed, letting a phantom scope parse valid at the issuance boundary.
    if (wrapped.shape !== undefined && typeof wrapped.shape === "object") {
      for (const field of Object.values(wrapped.shape)) {
        visit(field, depth + 1);
      }
    }
    const unionOptions = wrapped.options ?? wrapped.def?.options;
    if (Array.isArray(unionOptions)) {
      for (const option of unionOptions) visit(option, depth + 1);
    }
    if (wrapped.def?.valueType !== undefined) {
      visit(wrapped.def.valueType, depth + 1);
    }
  };
  for (const m of models) {
    for (const field of Object.values(m.schema.shape)) visit(field, 0);
    // op input shapes: the pipeline's step-2 strict-parse boundary where an issuance op's scopes arrive.
    for (const decl of Object.values(m.operations ?? {})) {
      const input = decl !== null && typeof decl === "object"
        ? (decl as { input?: { shape?: Record<string, unknown> } }).input
        : undefined;
      if (input?.shape !== undefined && typeof input.shape === "object") {
        for (const field of Object.values(input.shape)) visit(field, 0);
      }
    }
  }
}

/** Read the single permission an op's policy reduces to, for filtering — the `permKey` a `requires(key)`
 *  carries, else null. A multi-perm policy has no single filter key; use `staticPermKeys` for validation. */
export function requiredPerm(policy: unknown): PermKey | null {
  if (typeof policy !== "function") return null;
  const key = (policy as { permKey?: unknown }).permKey;
  return typeof key === "string" ? key : null;
}

/** Every statically-known permission key an op's policy references: a `requires(key)`'s `permKey`, or a
 *  `requiresAll`/`requiresAny`'s `permKeys` list. `authz/key-resolves` validates these against the app
 *  vocabulary — a dangling key must fail the build, never a silent always-deny (13-authz.md §2). */
export function staticPermKeys(policy: unknown): PermKey[] {
  if (typeof policy !== "function") return [];
  const single = (policy as { permKey?: unknown }).permKey;
  if (typeof single === "string") return [single];
  const multi = (policy as { permKeys?: unknown }).permKeys;
  return Array.isArray(multi)
    ? multi.filter((k): k is string => typeof k === "string")
    : [];
}

/** The CRUD write verbs an auto-route default-denies when exposed at `"policy"` (13-authz.md §authz-seam) —
 *  the sibling of the `requires("<r>:<op>")` default custom ops get. `list`/`find` are excluded: a read's
 *  visibility is the row-policy's job, so gating it here would double-gate. */
export const CRUD_WRITE_VERBS: ReadonlySet<string> = new Set([
  "create",
  "update",
  "delete",
]);

/** The op-level default-deny verdict for an auto-CRUD write route: true means deny (403). A `gated`
 *  `create`/`update`/`delete` route requires the convention-seeded `<resource>:<verb>` perm, mirroring the
 *  custom-op `requires("<r>:<op>")` default. A `"public"`/external route is never gated (opt-out stays
 *  open); `list`/`find` are never gated here — visibility is the row-policy's job. */
export function crudWriteDenied(
  actor: Actor | null,
  resourceName: string,
  verb: string,
  gated: boolean,
): boolean {
  if (!gated || !CRUD_WRITE_VERBS.has(verb)) return false;
  return !can(actor, `${resourceName}:${verb}`);
}

/** One link in the auth chain: an actor, or `null` for "not my credential type → try the next". Sync OR
 *  async, the same convention `policy` uses — a resolver that decodes a signed token needs no await, and a
 *  seam that demands a Promise makes the simplest correct resolver a type error. `resolveActor` awaits either. */
export type AuthResolver<Req = unknown> = (
  req: Req,
) => Actor | null | Promise<Actor | null>;
export interface AuthConfig<Req = unknown> {
  readonly resolvers: ReadonlyArray<AuthResolver<Req>>;
}

/** Declare the ordered resolver chain (the auth seam). Recipes / IdP adapters plug in as resolvers. */
export function defineAuth<Req = unknown, D = unknown>(
  cfg: AuthConfig<Req> & OnlyKnownKeys<D, AuthConfig<Req>>,
): AuthConfig<Req> {
  return cfg;
}

/** Run the chain at the authn step: first non-null actor wins; an all-null chain is anonymous. */
export async function resolveActor<Req>(
  cfg: AuthConfig<Req>,
  req: Req,
): Promise<Actor> {
  for (const resolver of cfg.resolvers) {
    const actor = await resolver(req);
    if (actor) return actor;
  }
  return ANON;
}
