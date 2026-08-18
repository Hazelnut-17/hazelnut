/**
 * The reified `Where<R>` Condition algebra: type safety at construction, while the runtime `Node`
 * carries `unknown` values for the SQL lowering.
 */
import { type Actor, can, CRUD_VERB_SET } from "../authz/auth.ts";
import { isAnonymous } from "../authz/auth-core.ts";

export type CmpOp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "like";

/** The `exists`-over-relation correlation (13-authz.md §8, rung-A grant recipe) — self-described on the
 *  node so lowering needs no `App` model; lowers to one `EXISTS` (`lower.ts §lowerInto`). */
export interface ExistsRelation {
  readonly via: string; // the grant relation/table name (an ordinary app resource, §8)
  readonly rowCol: string; // the outer row column the grant joins back to (default "id"; `on:` overrides → "studioId")
  readonly viaRowCol: string; // the grant column holding the outer-row id
  readonly viaActorCol: string; // the grant column holding the actor id
  readonly actorId: string; // the resolved actor id value (the per-actor binding)
  readonly roleCol?: string; // optional permission-level column on the grant (§8 `.withRole`)
  readonly role?: string; // the required role value when `roleCol` is set
  // The grant table inherits the trust stack (13-authz.md §8): when it declares softDelete/expiry, the
  // same conjuncts the outer read applies MUST ride inside the `exists`, so a revoked or expired grant stops granting.
  readonly viaSoftDelete?: boolean; // the grant resource declares `features:{ softDelete:true }` (revoke = soft-delete)
  readonly viaExpiry?: boolean; // the grant resource declares `features:{ expiry:true }` (time-boxed grant)
}

export type Node =
  | {
    readonly kind: "cmp";
    readonly op: CmpOp;
    readonly col: string;
    readonly value: unknown;
  }
  | {
    readonly kind: "inArray";
    readonly col: string;
    readonly values: readonly unknown[];
  }
  | { readonly kind: "isNull"; readonly col: string }
  | { readonly kind: "and"; readonly parts: readonly Node[] }
  | { readonly kind: "or"; readonly parts: readonly Node[] }
  | { readonly kind: "not"; readonly part: Node }
  | { readonly kind: "exists"; readonly rel: ExistsRelation }
  | { readonly kind: "all"; readonly shared?: true }
  | { readonly kind: "none" };

export interface Condition<Row> {
  readonly node: Node;
  readonly __row?: (row: Row) => void;
}

export interface Field<Row, K extends keyof Row> {
  readonly __col: K & string;
  readonly __row?: (row: Row) => void;
}

export type Fields<Row, Enc extends keyof Row = never> = {
  readonly [K in Exclude<keyof Row, Enc> & string]: Field<Row, K>;
};

type ComparableKeys<Row> = {
  [K in keyof Row]-?: NonNullable<Row[K]> extends
    number | bigint | Date | string ? K : never;
}[keyof Row];
type StringKeys<Row> = {
  [K in keyof Row]-?: NonNullable<Row[K]> extends string ? K
    : never;
}[keyof Row];

const cond = <Row>(node: Node): Condition<Row> => ({ node });

export const eq = <Row, K extends keyof Row>(
  f: Field<Row, K>,
  value: NonNullable<Row[K]>,
): Condition<Row> => cond({ kind: "cmp", op: "eq", col: f.__col, value });
export const ne = <Row, K extends keyof Row>(
  f: Field<Row, K>,
  value: NonNullable<Row[K]>,
): Condition<Row> => cond({ kind: "cmp", op: "ne", col: f.__col, value });
/** The comparator shape `gt`/`gte`/`lt`/`lte` share — an explicit public-API type so the barrel export carries
 *  no inferred (slow) type (no-slow-types). */
export type Comparator = <Row, K extends ComparableKeys<Row>>(
  f: Field<Row, K>,
  value: NonNullable<Row[K]>,
) => Condition<Row>;
const cmp = (op: CmpOp): Comparator =>
<Row, K extends ComparableKeys<Row>>(
  f: Field<Row, K>,
  value: NonNullable<Row[K]>,
): Condition<Row> => cond({ kind: "cmp", op, col: f.__col, value });
export const gt: Comparator = cmp("gt");
export const gte: Comparator = cmp("gte");
export const lt: Comparator = cmp("lt");
export const lte: Comparator = cmp("lte");
export const like = <Row, K extends StringKeys<Row>>(
  f: Field<Row, K>,
  value: string,
): Condition<Row> => cond({ kind: "cmp", op: "like", col: f.__col, value });
export const inArray = <Row, K extends keyof Row>(
  f: Field<Row, K>,
  values: readonly NonNullable<Row[K]>[],
): Condition<Row> => cond({ kind: "inArray", col: f.__col, values });
export const isNull = <Row, K extends keyof Row>(
  f: Field<Row, K>,
): Condition<Row> => cond({ kind: "isNull", col: f.__col });
export const and = <Row>(...parts: Condition<Row>[]): Condition<Row> =>
  cond({ kind: "and", parts: parts.map((p) => p.node) });
export const or = <Row>(...parts: Condition<Row>[]): Condition<Row> =>
  cond({ kind: "or", parts: parts.map((p) => p.node) });
export const not = <Row>(part: Condition<Row>): Condition<Row> =>
  cond({ kind: "not", part: part.node });
export const all = <Row>(): Condition<Row> => cond({ kind: "all" });
export const none = <Row>(): Condition<Row> => cond({ kind: "none" });
/**
 * The DELIBERATELY-UNIFORM answer: these rows, for every caller who got this far, on purpose. `shared()` is
 * every row; `shared(cond)` is the same decision over a caller-independent subset (a catalogue's published
 * rows, a tenant's shared queue). Both lower exactly as the un-marked form does — `TRUE`, `TRUE AND <cond>`
 * — and differ only in being a written decision. A rowPolicy handing two distinct claim-holders the SAME
 * rows is either a uniform read the author meant or the leak `policy/read-protected` exists to refuse, and
 * nothing in the lowered condition tells those apart. This is how the author says which.
 */
export const shared = <Row>(inner?: Condition<Row>): Condition<Row> =>
  inner === undefined ? cond({ kind: "all", shared: true }) : cond({
    kind: "and",
    parts: [{ kind: "all", shared: true }, inner.node],
  });

/** Did the AUTHOR declare this answer uniform? The `shared()` marker standing as a top-level CONJUNCT —
 *  `shared()` itself, or the `and` `shared(inner)` mints. Shallow on purpose: under `or`/`not` the marker
 *  no longer says what the answer is, so it earns nothing and the author writes the blessed shape. */
export function declaresShared(node: Node): boolean {
  if (node.kind === "all") return node.shared === true;
  return node.kind === "and" &&
    node.parts.some((p) => p.kind === "all" && p.shared === true);
}

export type Shorthand<Row, Enc extends keyof Row = never> = {
  readonly [K in Exclude<keyof Row, Enc> & string]?: Row[K];
};
export type Where<Row, Enc extends keyof Row = never> =
  | Shorthand<Row, Enc>
  | Condition<Row>;

export const fields = <Row, Enc extends keyof Row = never>(): Fields<
  Row,
  Enc
> => new Proxy({}, { get: (_t, p) => ({ __col: p }) }) as Fields<Row, Enc>;

/** Normalize a `Where` (shorthand or built Condition) to a Node. */
export function toNode<Row, Enc extends keyof Row = never>(
  w: Where<Row, Enc>,
): Node {
  if ("node" in w) return w.node;
  const parts: Node[] = [];
  for (const [col, value] of Object.entries(w)) {
    if (value === undefined) continue;
    parts.push(
      value === null
        ? { kind: "isNull", col }
        : { kind: "cmp", op: "eq", col, value },
    );
  }
  return parts.length ? { kind: "and", parts } : { kind: "all" };
}

// ── exists-over-relation: the rung-A grant recipe (13-authz.md §8) ──────────────────────────────

/** The minimal actor identity `relate(a)` correlates on — reads only `a.id`; the full `Actor` (auth.ts)
 *  structurally satisfies it, so a rowPolicy's `Actor|null` passes through unchanged. */
export interface GrantActor {
  readonly id: string;
}

/** Options for `relate(a).via(grant, opts)` — the join shape and the trust-stack of the §8 grant table. */
export interface RelateOpts {
  /** The outer row column the grant joins back to. Default `"id"`; a multi-hop names it (`on: "studioId"`). */
  readonly on?: string;
  /** The grant column holding the outer-row id. Default `"resourceId"` (the recipe's canonical FK name). */
  readonly rowFk?: string;
  /** The grant column holding the actor id. Default `"userId"` (the §8 actor FK). */
  readonly actorFk?: string;
  /** The grant resource declares `features:{ softDelete:true }` (revoke = soft-delete the grant); when set,
   *  the EXISTS rides `<grant>.deleted_at IS NULL`, so a revoked grant stops granting (13-authz.md §8 — the
   *  grant inherits the trust stack). */
  readonly softDelete?: boolean;
  /** The grant resource declares `features:{ expiry:true }` — a time-boxed grant; when set, the EXISTS rides
   *  `<grant>.expires_at IS NULL OR <grant>.expires_at > now()`, so an expired grant stops granting
   *  (13-authz.md §8 — the grant inherits the trust stack). */
  readonly expiry?: boolean;
}

/** A `relate(a).via(...)` result — a `Condition`, additionally `.withRole(r)` narrows the grant to one role. */
export interface RelateCondition<Row> extends Condition<Row> {
  /** Narrow to a permission level: the §8 `role` column on the grant (`view`/`edit`), checked in the same
   *  `EXISTS` (not a second table); default column `"role"`. */
  withRole(role: string, roleCol?: string): RelateCondition<Row>;
}

/** A `relate(a)` binding — `relate(a).via("scriptShare")` / `relate(a).via("studioMember", { on: "studioId" })`;
 *  builds an `exists`-over-relation Condition where the actor sees this row iff a grant row in `via` links it
 *  (by `on`/`rowFk`) to the actor (by `actorFk`) — the blessed §8 shape, one canonical helper per app. */
export interface RelateBuilder {
  via<Row = Record<string, unknown>>(
    grant: string,
    opts?: RelateOpts,
  ): RelateCondition<Row>;
}

function relateCondition<Row>(rel: ExistsRelation): RelateCondition<Row> {
  const base = cond<Row>({ kind: "exists", rel }) as Condition<Row>;
  return {
    ...base,
    withRole(role: string, roleCol = "role"): RelateCondition<Row> {
      return relateCondition<Row>({ ...rel, roleCol, role });
    },
  };
}

/** The fail-closed grant ceiling for an absent actor id (13-authz.md §8) — a `none()`-backed Condition
 *  whose `.withRole()` returns itself; never emits `exists` correlating on `""`, by construction. */
function failClosedRelate<Row>(): RelateCondition<Row> {
  const base = none<Row>();
  const self: RelateCondition<Row> = { ...base, withRole: () => self };
  return self;
}

/** The blessed grant helper (13-authz.md §8): `relate(a).via("<grant>"[, { on, rowFk, actorFk }])[.withRole(r)]`;
 *  a `null`/absent or empty-id `a` short-circuits to `none()` (false), fail-closed by construction — never
 *  by trusting that no grant row carries an empty actor id (the §8 fail-closed pin). */
export function relate(actor: GrantActor | null): RelateBuilder {
  // the ANON floor correlates on a SHARED id every anonymous caller presents — no grant, fail closed
  const actorId = actor != null && isAnonymous(actor as Actor)
    ? ""
    : actor?.id ?? "";
  return {
    via<Row = Record<string, unknown>>(
      grant: string,
      opts: RelateOpts = {},
    ): RelateCondition<Row> {
      if (actorId === "") return failClosedRelate<Row>(); // anonymous / empty id → no grant matches, fail-closed
      return relateCondition<Row>({
        via: grant,
        rowCol: opts.on ?? "id",
        viaRowCol: opts.rowFk ?? "resourceId",
        viaActorCol: opts.actorFk ?? "userId",
        actorId,
        viaSoftDelete: opts.softDelete, // revoke = soft-delete the grant → it stops granting (§8)
        viaExpiry: opts.expiry, // a time-boxed grant → it stops granting once expired (§8)
      });
    },
  };
}

// ── rowPolicy fragments: pure, parameterized, reusable cross-cutting policies (13-authz.md §3) ────

/** A rowPolicy fragment (13-authz.md §3): `(actor) => Condition` taking the real `Actor|null` so
 *  anonymous is handled by-construction; a derived read auto-injects it, a custom read re-calls it. */
export type Fragment<Row> = (actor: Actor | null) => Condition<Row>;

/** `owned(field)` — the canonical ownership fragment (13-authz.md §3): the actor sees a row iff its
 *  `field` equals the actor's `id`; anonymous (`null`) is fail-closed to `none()` (`authz/fail-closed`),
 *  not `eq(field, "")`, which could match a row with an empty owner value. */
export function owned<Row, K extends keyof Row>(
  field: Field<Row, K>,
): Fragment<Row> {
  return (actor) =>
    // anonymous (either shape — null or the ANON floor) owns nothing: a shared "anonymous" id would make
    // every anonymous caller a co-owner of every anonymous-created row
    actor === null || isAnonymous(actor)
      ? none<Row>()
      : eq<Row, K>(field, actor.id as NonNullable<Row[K]>);
}

/** `withinScope(field, of)` — the per-actor scope fragment (13-authz.md §3/§7) atop the coarse `scope`
 *  partition; anonymous or an absent/empty scope value fails closed to `none()`, never `eq(field, "")`. */
export function withinScope<Row, K extends keyof Row>(
  field: Field<Row, K>,
  of: (actor: Actor) => string | null | undefined,
): Fragment<Row> {
  return (actor) => {
    if (actor === null || isAnonymous(actor)) return none<Row>();
    const value = of(actor);
    return value == null || value === ""
      ? none<Row>()
      : eq<Row, K>(field, value as NonNullable<Row[K]>);
  };
}

/** Compose fragments by and — every fragment's ceiling must admit the row (the intersection); `andPolicy()`
 *  with no fragment is `all()` (the empty and, matching `lowerInto`'s law) — the §3 combinator, not a new
 *  algebra node; the result is itself a `Fragment`, so composition nests arbitrarily. */
export function andPolicy<Row>(...frags: Fragment<Row>[]): Fragment<Row> {
  return (actor) =>
    frags.length === 0 ? all<Row>() : and<Row>(...frags.map((fr) => fr(actor)));
}

/** Compose fragments by or — any fragment's ceiling admitting the row admits it (the union; the §8
 *  owner-or-shared shape); `orPolicy()` with no fragment is `none()` (the empty or — fail-closed: an
 *  un-composed policy denies, never silently admits all rows). */
export function orPolicy<Row>(...frags: Fragment<Row>[]): Fragment<Row> {
  return (actor) =>
    frags.length === 0 ? none<Row>() : or<Row>(...frags.map((fr) => fr(actor)));
}

/** Lifts a `relate(a).via(...)` grant (13-authz.md §8) into a `Fragment` so it composes with
 *  `owned`/`withinScope`; anonymous actor → `none()` (fail-closed). */
export function sharedVia<Row>(
  build: (actor: Actor) => Condition<Row>,
): Fragment<Row> {
  return (actor) => actor === null ? none<Row>() : build(actor);
}

/** Does this lowered node stand for a vacuous TRUE (`all` / the empty and)? An UNDER-approximation on
 *  purpose — an undecidable shape reads as narrowing, so a caller can only ever miss a leak, never refuse
 *  a policy that does narrow. `isMatchNone` is the dual the `not` arm needs. */
export function isMatchAll(node: Node): boolean {
  switch (node.kind) {
    case "all":
      return true;
    case "and":
      return node.parts.every(isMatchAll); // the empty AND lowers to TRUE
    case "or":
      return node.parts.some(isMatchAll);
    case "not":
      return isMatchNone(node.part);
    default:
      return false;
  }
}

/** The dual — a vacuous FALSE (`none` / the empty or / `inArray([])`). Exported because "this answer
 *  exposes nobody" is a verdict the boot guards need, and `kind === "none"` is one spelling of four. */
export function isMatchNone(node: Node): boolean {
  switch (node.kind) {
    case "none":
      return true;
    case "inArray":
      return node.values.length === 0;
    case "or":
      return node.parts.every(isMatchNone); // the empty OR lowers to FALSE
    case "and":
      return node.parts.some(isMatchNone);
    case "not":
      return isMatchAll(node.part);
    default:
      return false;
  }
}

/** Module-private registry, held as WeakMap MEMBERSHIP rather than a property: a look-alike `Symbol()`, a
 *  `Symbol.for()`, a string prop and an `Object.getOwnPropertySymbols` harvest all miss a map they cannot reach. */
const DECLARED_RAMPS = new WeakMap<object, string>();

/** The escalation key a `ramp` branches on, or `undefined` for any policy this module did not mint. The
 *  KEY, not a yes/no: an exemption that cannot name what it exempts cannot measure whether it applies. */
export function declaredRampKey(policy: unknown): string | undefined {
  return typeof policy === "function" ? DECLARED_RAMPS.get(policy) : undefined;
}

/** True iff this policy came from a framework constructor whose SHAPE is the declaration (`ramp`) — the
 *  membership face of `declaredRampKey`, one registry behind both. */
export function isDeclaredUniform(policy: unknown): boolean {
  return declaredRampKey(policy) !== undefined;
}

/**
 * A frozen structural COPY of a lowered node — every field read exactly once, into a literal. A ramp's
 * refusal is a construction-time snapshot, so re-reading the caller's graph at call time would make it a
 * suggestion: `raised.node = all().node`, an in-place `kind` flip, and a `get node()` handing the checker a
 * narrow condition and the runtime a match-all all take the same route. `value` stays by reference (a leaf
 * this cannot deep-copy) — it cannot widen a node to match-all, which is the whole subject of the check.
 */
function snapshotNode(node: Node): Node {
  switch (node.kind) {
    case "cmp":
      return Object.freeze(
        { kind: "cmp", op: node.op, col: node.col, value: node.value } as const,
      );
    case "inArray":
      return Object.freeze(
        {
          kind: "inArray",
          col: node.col,
          values: Object.freeze([...node.values]),
        } as const,
      );
    case "isNull":
      return Object.freeze({ kind: "isNull", col: node.col } as const);
    case "and":
      return Object.freeze(
        {
          kind: "and",
          parts: Object.freeze(node.parts.map(snapshotNode)),
        } as const,
      );
    case "or":
      return Object.freeze(
        {
          kind: "or",
          parts: Object.freeze(node.parts.map(snapshotNode)),
        } as const,
      );
    case "not":
      return Object.freeze(
        { kind: "not", part: snapshotNode(node.part) } as const,
      );
    case "exists":
      return Object.freeze(
        { kind: "exists", rel: Object.freeze({ ...node.rel }) } as const,
      );
    case "all":
      return Object.freeze(
        node.shared === true
          ? { kind: "all", shared: true } as const
          : { kind: "all" } as const,
      );
    case "none":
      return Object.freeze({ kind: "none" } as const);
    default: {
      const unknownNode: never = node;
      throw new Error(
        `ramp(): a branch carries a Where node this module did not mint — ${
          JSON.stringify(unknownNode)
        }. Build both branches with the "hazelnut/query" constructors.`,
      );
    }
  }
}

/** Refuse the ramp that IS the claim gate. Keyed on a DERIVED CRUD claim, every grantee of that verb holds
 *  the key, so a match-all `raised` hands them all the same whole table — `shared()` is how that is declared. */
function refuseClaimGateRamp(key: string, raised: Node): void {
  const verb = key.slice(key.lastIndexOf(":") + 1);
  if (!CRUD_VERB_SET.has(verb) || !isMatchAll(raised)) return;
  if (declaresShared(raised)) return;
  throw new Error(
    `ramp("${key}", ...): the raised branch lowers to match-all and '${key}' is a DERIVED CRUD claim — every caller granted that verb holds it, so this ramp is exactly the claim gate \`can(actor, "${key}") ? all() : ...\` that policy/read-protected refuses: the claim becomes the whole gate and every grantee reads, patches and deletes every other grantee's rows. Raise to a narrowing condition instead (owned / withinScope / relate on "hazelnut/query"), or key the ramp on a declared escalation capability (capabilities:["viewAll"] yields "<resource>:viewAll"), which is what an escalation ramp is for. If every holder of '${key}' is MEANT to see every row (a catalogue, a directory), pass shared() as the raised branch — it lowers identically and is the written decision.`,
  );
}

/** The escalation ramp (13-authz.md §3): `raised` when the actor holds a typed capability, else `floor`
 *  — branches on the capability, never a role name; `can(null, key)` is false, so anonymous takes `floor`.
 *  Registered with its KEY, so the two-claim-holder probe can measure whether this ramp raises anyone above
 *  the ordinary grantees it is asked about instead of trusting that it does (`core/model-guards.ts`). */
export function ramp<Row>(
  key: string,
  raised: Condition<Row>,
  floor: Condition<Row>,
): Fragment<Row> {
  // the ramp serves the SNAPSHOT it was checked on, never the caller's object — one read, frozen, checked,
  // handed out, so no post-construction edit and no getter can separate the refusal from what runs.
  const raisedC = Object.freeze({ node: snapshotNode(raised.node) });
  const floorC = Object.freeze({ node: snapshotNode(floor.node) });
  refuseClaimGateRamp(key, raisedC.node);
  const f = (actor: Actor | null) =>
    can(actor, key) ? raisedC as Condition<Row> : floorC as Condition<Row>;
  DECLARED_RAMPS.set(f, key);
  return f;
}
