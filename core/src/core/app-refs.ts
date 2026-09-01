// Barrel re-exports keep import sites stable.
import { requires } from "../authz/auth.ts";
import type { RollupKind } from "./faces.ts";
import type { Where } from "./where.ts";
import { z } from "zod";

/** A partial unique constraint (04-features.md §unique): `{ cols, where }` mints `CREATE UNIQUE INDEX ... WHERE
 *  <predicate>`, so uniqueness holds only over rows the predicate admits. `where` is boot-validated
 *  local-non-encrypted-only (`unique/partial-predicate-local`); a plain `string[]` entry stays a full unique. */
export interface UniqueSpec {
  readonly cols: readonly string[];
  readonly where: Where<Record<string, unknown>>;
}

/** `defineResource` is pure data; `createApp` composes the model in memory (never codegen to disk) and
 *  strict-parses every declaration (`decl/unknown-key`), so a typo'd key is a loud boot failure, not a silent no-op. */
export type OnDelete = "restrict" | "cascade" | "set-null";
export interface RefSpec<To extends string = string> {
  readonly to: To; // the referenced resource name (FK → its id); a literal at the decl site, a string in the model
  readonly onDelete?: OnDelete; // undeclared → NO ACTION (canon default); cascade/set-null emitted as declared
  readonly external?: true; // set ONLY by refById(): a by-id target outside the model — skips target-exists + FK emit
}

/** `ref(decl)` — the type-safe reference. You MUST import the target declaration; the return carries its
 *  literal name as the FK target, so a typo'd target is a compile error, never a runtime boot failure. */
export function ref<D extends { readonly name: string }>(
  decl: D,
  opts?: { readonly onDelete?: OnDelete },
): RefSpec<D["name"]> {
  return opts?.onDelete
    ? { to: decl.name, onDelete: opts.onDelete }
    : { to: decl.name };
}

/** `refById("ext.table")` — the escape hatch for external/unmodeled by-id targets (e.g. `auth.user`) with no
 *  declaration to import. `external:true` skips `references/target-exists` and FK DDL emission (no in-schema
 *  table to reference), and carries no `onDelete` for the same reason. */
export function refById<S extends string>(table: S): RefSpec<S> {
  return { to: table, external: true };
}

export interface RelateSpec<To extends string = string> {
  readonly to: To; // the related resource name — a literal at the decl site, a string in the model
}

/** `manyToMany(decl)` — the type-safe relation. You MUST import the target declaration, so a typo'd target
 *  is a compile error, never a runtime boot failure. The container key (`relates: { courses: manyToMany(course) }`)
 *  is inert — junctions derive from the sorted resource pair, not the key. */
export function manyToMany<D extends { readonly name: string }>(
  decl: D,
): RelateSpec<D["name"]> {
  return { to: decl.name };
}

/** A maintained-aggregate spec (03-api-shape.md §8; 02-dsl.md §rollup). `count` carries the aggregated child
 *  resource name for every kind (the carrier key the model reads); `field` is the child column non-count kinds
 *  aggregate. count/sum → `number` (default 0); avg/min/max → `number | null` (NULL on the empty set). */
export interface RollupSpec<Of extends string = string> {
  readonly count: Of; // the aggregated child resource name — a literal at the decl site, a string in the model
  readonly kind?: RollupKind; // the aggregate kind (absent ⇒ "count" — the bare `count()` shape)
  readonly field?: string; // the child column avg/sum/min/max aggregate (required for non-count kinds)
}

/** `count(decl)` — the type-safe count rollup. The child decl must be imported, so a typo'd target is a
 *  compile error, never a runtime boot failure. */
export function count<D extends { readonly name: string }>(
  decl: D,
): RollupSpec<D["name"]> & { readonly kind: "count" } {
  return { count: decl.name, kind: "count" };
}

/** `sum(decl, field)` — a maintained SUM over a child column (03-api-shape.md §8). `number`, default 0 on
 *  the empty set. Same type-safety as `count`: the child decl must be imported (a typo does not compile). */
export function sum<D extends { readonly name: string }>(
  decl: D,
  field: string,
): RollupSpec<D["name"]> & { readonly kind: "sum" } {
  return { count: decl.name, kind: "sum", field };
}

/** `avg(decl, field)` — a maintained AVG over a child column. `number | null` (NULL on the empty set), so
 *  removing the last child resets the column to NULL — never a stale or fabricated 0. */
export function avg<D extends { readonly name: string }>(
  decl: D,
  field: string,
): RollupSpec<D["name"]> & { readonly kind: "avg" } {
  return { count: decl.name, kind: "avg", field };
}

/** `min(decl, field)` — a maintained MIN over a child column. `number | null` (NULL on the empty set). */
export function min<D extends { readonly name: string }>(
  decl: D,
  field: string,
): RollupSpec<D["name"]> & { readonly kind: "min" } {
  return { count: decl.name, kind: "min", field };
}

/** `max(decl, field)` — a maintained MAX over a child column. `number | null` (NULL on the empty set). */
export function max<D extends { readonly name: string }>(
  decl: D,
  field: string,
): RollupSpec<D["name"]> & { readonly kind: "max" } {
  return { count: decl.name, kind: "max", field };
}

/** `owns` — the parent-side owned-child relation (02-dsl.md §owns). The parent declares a named relation
 *  (`owns: { gallery: hasMany(galleryImage) }`); the FK lives on the child table, and createApp fills
 *  `ResourceModel.parent`/`parentFk`. It adds a named eager-load accessor (05-runtime.md §repo-vs-op) and
 *  cardinality — `hasOne` enforces at most one child via a UNIQUE on the child's parent FK. */
export type Cardinality = "one" | "many";
export interface OwnsSpec<To extends string = string> {
  readonly to: To; // the owned child resource name — a literal at the decl site, a string in the model
  readonly cardinality: Cardinality; // hasOne → "one" (UNIQUE on the child parent-FK); hasMany → "many"
  readonly unique?: readonly (readonly string[])[]; // child-collection unique tuples (04-features.md §unique) — the framework auto-prepends the parent FK
}

/** `hasMany(decl, { unique? })` — an owned child collection (parent → N children). You MUST import the
 *  child declaration (a typo'd target is a compile error). The optional `unique` tuple gets the parent FK
 *  auto-prepended (`unique:[["staffId"]]` → `UNIQUE (<parent>_id, staffId)`, 04-features.md §unique). */
export function hasMany<D extends { readonly name: string }>(
  decl: D,
  opts?: { readonly unique?: readonly (readonly string[])[] },
): OwnsSpec<D["name"]> {
  return opts?.unique
    ? { to: decl.name, cardinality: "many", unique: opts.unique }
    : { to: decl.name, cardinality: "many" };
}

/** `hasOne(decl)` — an owned single child (parent → exactly one child). You MUST import the child declaration.
 *  The FK is on the child, as for `hasMany`; a UNIQUE on the child's parent-FK column makes "exactly one" by
 *  construction, so a second child row for the same parent is a duplicate-key reject. */
export function hasOne<D extends { readonly name: string }>(
  decl: D,
): OwnsSpec<D["name"]> {
  return { to: decl.name, cardinality: "one" };
}

/** One curated MCP tool projection (12-mcp §5) — the agent face is opt-in. */
export interface McpEntry {
  readonly describe: string; // the authored agent-facing sentence
  readonly shape?: readonly string[]; // typed output field-pick — narrows what the tool returns
  readonly confirm?: boolean; // surfaces the host's human-in-the-loop elicitation for a destructive op
  // opts a find/get read into the resource-template path `<module>/<resource>/{id}` (12-mcp §6), served
  // via `resources/read`; read dispatch inherits the find tool's policy/rowPolicy/sensitive/shape gate
  readonly as?: "resource";
  // the declared per-tool version (12-mcp §tool-versioning). `echo:"required"` is the high-blast-radius
  // opt-in: every call must echo `_toolVersion: v` and a stale echo fails loud at validate.
  readonly version?: { readonly v: number; readonly echo?: "required" };
}
/** The curated agent surface: which ops/reads project as MCP tools at all. An op absent from `mcp` is
 *  invisible to agents — curation is mandatory and declared (12-mcp §13: naive co-projection explodes). */
export type McpCuration = Readonly<Record<string, McpEntry>>;

/** The route's authz mode: `"public"` mounts + skips op.policy; `"policy"` mounts + runs op.policy
 *  (deny-by-default). rowPolicy/scope are always injected regardless (03-api-shape.md §3). */
export type HttpMode = "public" | "policy";

/** One `http` route value (03-api-shape.md §3): the bare mode string (`"public"`/`"policy"`, the 90% write
 *  form), or the object form:
 *   - `at:"collection"` — a custom op that mints the resource (no `:id` yet → `POST /<plural>/<op>`); its
 *     policy takes `(actor)` with no `resource` arg. Additive — the structural fallback (`input` has no `id`)
 *     still detects an op that omits it.
 *   - `external:true` — the route is mounted but framework op-policy is not injected (an upstream gateway/IdP
 *     already authorized the caller); rowPolicy/scope still apply. The route-level analogue of `refById`'s `external`.
 *   - `columns:[...]` — the positive wire projection (03-api-shape.md §wire-projection), **required** on the
 *     read verbs (`list`/`find`) whenever that verb is HTTP-exposed; a short-form string (or an
 *     object with no `columns`) boot-refuses as `http/columns-required`. An MCP-only read (no http twin)
 *     still falls back to id + schema keys until it grows its own required projection.
 *  `policy` defaults to `"policy"` (deny-by-default) when the object form is not `external`. */
export type HttpRoute = HttpMode | {
  readonly at?: "collection";
  readonly policy?: HttpMode;
  readonly external?: true;
  readonly authnFirst?: boolean;
  readonly columns?: readonly string[];
};

/** Is this route flipped to validate-first (`authnFirst:false` — 05-runtime.md §op-pipeline authn ordering)?
 *  The strict input parse then runs before the authn chain (fail-fast on a malformed body), trading away the
 *  default no-schema-leak posture. The per-actor throttle keys on the anon bucket during the pre-parse phase. */
export function routeAuthnDeferred(route: HttpRoute | undefined): boolean {
  return typeof route === "object" && route.authnFirst === false;
}

/** The authz mode of an `http` route value, normalized across both forms. An object's `policy` defaults to
 *  `"policy"` (deny-by-default) when unspecified. `external` is a separate axis (`isExternalRoute`), not folded
 *  into `"public"` here — a public read drops rowPolicy, an external read keeps it. */
export function httpPolicyMode(route: HttpRoute): HttpMode {
  return typeof route === "string" ? route : (route.policy ?? "policy");
}

/** Is this `http` read route public (bare `"public"`, or `{ policy: "public" }`)? The signal the mcp
 *  read-protection escape reads: a public http twin means the curated mcp tool needs no rowPolicy. `undefined`
 *  (no http twin) is not public — mcp has no `public` opt-out of its own, so it stays protected. Single-sourced
 *  so the verifier (`mcp/read-protected`) and the served-boot guard never disagree. */
export function isPublicRoute(route: HttpRoute | undefined): boolean {
  return route !== undefined && httpPolicyMode(route) === "public";
}

/** Is this `http` route the explicit collection-op form (`{ at:"collection" }`, 03-api-shape.md §3)? The
 *  authoritative signal — it WINS over the structural `input`-has-no-`id` fallback (`isCollectionOp`), which
 *  only catches the implicit form. Every dispatch surface reads the SAME combined `isCollectionRoute ||
 *  isCollectionOp` (serve, OpenAPI, MCP subject-binding), so an explicit collection op whose input carries
 *  `id` (the minted resource's id) is classified identically everywhere — no cross-surface drift. */
export function isCollectionRoute(route: HttpRoute | undefined): boolean {
  return typeof route === "object" && route.at === "collection";
}

/** A collection-level custom op (03-api-shape.md §3) mints the resource — no `:id` exists yet. Structural
 *  signal: the op's `input` ZodObject carries no `id` field (non-ZodObject input is treated as an instance op,
 *  conservative). Shared by all three dispatch surfaces (serve/mcp/cross-module) so `ctx.transition(to)` binds
 *  the subject identically on each. */
export function isCollectionOp(opDecl: unknown): boolean {
  const input = (opDecl as { input?: unknown } | null)?.input;
  if (!(input instanceof z.ZodObject)) return false;
  return !("id" in input.shape);
}

/** The ONE collection-op classifier every dispatch surface reads (serve, OpenAPI, MCP tool, MCP resource,
 *  cross-module `ctx.modules`): explicit `http:{ at:"collection" }` WINS over the structural no-`id`-input
 *  fallback. Route every subject-binding decision through this so no surface can classify one op two ways —
 *  hand-combining the two signals per call site is how the drift recurs (03-api-shape.md §3). */
export function opIsCollection(
  model: {
    readonly http?: Readonly<Partial<Record<string, HttpRoute>>>;
    readonly operations: Readonly<Record<string, unknown>>;
  },
  opName: string,
): boolean {
  return isCollectionRoute(model.http?.[opName]) ||
    isCollectionOp(model.operations[opName]);
}

/** Is this `http` route an externally-authorized edge (`{ external:true }`)? The route is mounted but exempt
 *  from framework op-policy injection (03-api-shape.md §3) — an upstream gateway/IdP/webhook-signature is the
 *  authority. The serve layer reads this to skip the policy gate while still injecting rowPolicy/scope. */
export function isExternalRoute(route: HttpRoute | undefined): boolean {
  return typeof route === "object" && route.external === true;
}

/** The read verbs that return a row, so the only ones a wire projection can narrow. A write returns an
 *  id/updated envelope and a custom op's return is the handler's own contract — neither is the column space. */
export const WIRE_READ_VERBS = ["list", "find"] as const;
export type WireReadVerb = typeof WIRE_READ_VERBS[number];

/** The minimal model slice the wire projection reads — kept structural so `app-refs` never imports the
 *  model type (the cycle `app-types` → `app-refs` forbids). */
interface WireProjectionSource {
  readonly schema: z.ZodObject<z.ZodRawShape>;
  readonly http: Readonly<Partial<Record<string, HttpRoute>>>;
}

/** The declared `columns` of an `http` route value, or undefined for the bare-mode/undeclared forms. */
export function routeColumns(
  route: HttpRoute | undefined,
): readonly string[] | undefined {
  return typeof route === "object" ? route.columns : undefined;
}

/** The DECLARED wire column list of a read verb (03-api-shape.md §wire-projection). Compose refuses an
 *  exposed read with no `columns` (`http/columns-required`); the schema-keys fallback below is only a
 *  defensive floor for an unreachable path. A framework-minted column reaches the wire only by name.
 *  What a response actually carries is this minus the redaction set (`servedColumnsOf`, features/redact.ts). */
export function wireColumnsOf(
  m: WireProjectionSource,
  verb: WireReadVerb,
): readonly string[] {
  const declared = routeColumns(m.http[verb]);
  if (declared !== undefined) return declared;
  return [...new Set(["id", ...Object.keys(m.schema.shape)])]; // defensive floor; exposed reads never reach it
}

/** Line heads of a `CREATE TABLE` body that declare a constraint, not a column. */
const CONSTRAINT_HEADS: ReadonlySet<string> = new Set([
  "FOREIGN",
  "CHECK",
  "EXCLUDE",
  "UNIQUE",
  "PRIMARY",
  "CONSTRAINT",
]);

/** The physical columns of a resource's table, read back out of the `CREATE TABLE` the framework emitted.
 *  Reading the DDL rather than re-listing the features is what keeps the mint list from drifting; the boot
 *  guard's own copy is a mirror, pinned equal to this one by the mirror ratchet. */
export function physicalColumnsOf(ddl: string): ReadonlySet<string> {
  const out = new Set<string>();
  const open = ddl.indexOf("(\n  ");
  const close = ddl.indexOf("\n)");
  if (open < 0 || close < open) return out;
  for (const line of ddl.slice(open + 4, close).split(",\n  ")) {
    const head = /^"?([A-Za-z_][A-Za-z0-9_]*)"?\s/.exec(line);
    if (!head || CONSTRAINT_HEADS.has(head[1]!.toUpperCase())) continue;
    out.add(head[1]!);
  }
  return out;
}

/** The model slice the op-door subtraction reads — the projection source plus the emitted table. */
interface OpDoorSource extends WireProjectionSource {
  readonly ddl: string;
}

/** The names one resource's own read routes serialize — `id` + its schema keys + whatever its `columns` name. */
function servedByOwn(m: OpDoorSource): Set<string> {
  const served = new Set<string>(["id", ...Object.keys(m.schema.shape)]);
  for (const verb of WIRE_READ_VERBS) {
    for (const c of wireColumnsOf(m, verb)) served.add(c);
  }
  return served;
}

/** The columns a CUSTOM OP's result may never carry (03-api-shape.md §wire-projection): every column the
 *  DERIVER minted that no read route of ITS OWN resource projects. An op's return is the handler's own
 *  contract, so the framework mints nothing at that door — it subtracts only names it added itself, and that
 *  resource's own read route naming one in `columns` puts it back.
 *
 *  The argument is the whole model LIST, never one resource: a handler reaches every resource of the app
 *  (`ctx.data`, `ctx.modules`, raw `ctx.query`), so a set keyed on the op's owner let a sibling resource's
 *  minted columns — `scope_key`, `created_by_id`, `deleted_at` — out of the door built to subtract them.
 *  The fold is PER MODEL and the results union: `∪ₘ (physical(m) \ served(m))`, never
 *  `∪ₘ physical(m) \ ∪ₘ served(m)`. The second is strictly weaker — a resource naming `created_at` in its own
 *  `columns` would un-withhold it at EVERY OTHER resource's op door, so an unrelated file's declaration
 *  disarmed this one. The residual cost is the same name collision the redaction union already buys
 *  (`features/redact.ts §egressOp`): a column withheld at A stays withheld at every op door. */
export function withheldFromOpsOf(
  models: readonly OpDoorSource[],
): Set<string> {
  const out = new Set<string>();
  for (const m of models) {
    const served = servedByOwn(m);
    for (const c of physicalColumnsOf(m.ddl)) if (!served.has(c)) out.add(c);
  }
  return out;
}

/** One resource whose OWN declared field names the app-wide op-door fold withholds. */
export interface OpDoorNameCollision {
  readonly resource: string;
  /** the declared schema keys this app's fold subtracts, sorted */
  readonly fields: readonly string[];
  /** the other resources whose DDL minted those names, sorted — who to rename against */
  readonly minters: readonly string[];
}

/**
 * Where the app-wide op-door fold and a resource's OWN declaration disagree (03-api-shape.md
 * §op-door-projection): resource B declares `version` as a business field, sibling A mints `version` from
 * `features:{versioning}`, and the union withholds it at EVERY op door — so B's op returns the shape its
 * declaration promised MINUS three fields, and nothing said so.
 *
 * The union is the right (fail-closed) side and this does not soften it — exempting a name some resource
 * declares would let an attacker re-open a sibling's `scope_key` by declaring a field of that name. What was
 * missing is the SIGNAL, so this reports the disagreement and `opDoorCollisionWarnings` below is what every
 * composition door prints. A resource's own minted column can never appear here: `deriveDDL`
 * already refuses a declaration colliding with a column its OWN features mint, so every entry is
 * cross-resource, and the only remedies are cross-resource — rename the field, or rename against the minter.
 */
export function opDoorNameCollisions(
  models: readonly (OpDoorSource & { readonly name: string })[],
): OpDoorNameCollision[] {
  const withheld = withheldFromOpsOf(models);
  if (withheld.size === 0) return [];
  const out: OpDoorNameCollision[] = [];
  for (const m of models) {
    const fields = Object.keys(m.schema.shape).filter((f) => withheld.has(f))
      .sort();
    if (fields.length === 0) continue;
    const minters = models
      .filter((o) =>
        o.name !== m.name &&
        fields.some((f) =>
          physicalColumnsOf(o.ddl).has(f) && !servedByOwn(o).has(f)
        )
      )
      .map((o) => o.name).sort();
    out.push({ resource: m.name, fields, minters });
  }
  return out;
}

/**
 * The op door's WHOLE withheld set, enumerated for the reader (03-api-shape.md §op-door-projection). The
 * collision report below is keyed on DECLARED schema keys, and the fold is not: it deletes by name from
 * whatever a handler returns, so a hand-built DTO key — `created_at` on a response the author invented —
 * is inside the fold's domain and outside the report's. This line's domain IS the fold's, by construction.
 */
export function opDoorWithheldNotice(
  models: readonly (OpDoorSource & {
    readonly operations: Readonly<Record<string, unknown>>;
  })[],
): string | null {
  // an app with no custom op has no op door, so the fold costs it nothing and the line would be noise
  if (!models.some((m) => Object.keys(m.operations).length > 0)) return null;
  const withheld = [...withheldFromOpsOf(models)].sort();
  if (withheld.length === 0) return null;
  return `[hazelnut] this app's custom-op door WITHHOLDS the name(s) ${
    withheld.join(", ")
  } — a custom op's handler returning a key of one of those names loses it from the wire, at every object level, whether the value came from a row or the handler invented it. Framework-minted columns leave a custom op only where a read verb of their own resource projects them (03-api-shape.md §op-door-projection); name your response fields outside this set.`;
}

/**
 * Every boot line the op door prints: the withheld enumeration above, then one per name collision — naming
 * the withheld fields and who mints them. A WARNING and not a refusal, because the fold has no local
 * remedy: the name is withheld by a SIBLING's DDL, so `columns:[…]` on the declaring resource cannot put it
 * back (the fold unions the withholdings, never the servings) and the only answers are a rename on one side
 * or the other. Refusing would make a legitimate pair of declarations un-bootable with nothing to write
 * that fixes it.
 */
export function opDoorCollisionWarnings(
  models: readonly (OpDoorSource & {
    readonly name: string;
    readonly operations: Readonly<Record<string, unknown>>;
  })[],
): string[] {
  const notice = opDoorWithheldNotice(models);
  return (notice === null ? [] : [notice]).concat(
    opDoorNameCollisions(models).map((c) =>
      `[hazelnut] resource '${c.resource}' declares the field(s) ${
        c.fields.join(", ")
      }, and this app's custom-op door WITHHOLDS ${
        c.fields.length === 1 ? "that name" : "those names"
      } — ${
        c.minters.length === 0
          ? "another resource mints it as a framework column"
          : `resource(s) ${c.minters.join(", ")} mint ${
            c.fields.length === 1 ? "it" : "them"
          } as framework columns`
      } and the op door subtracts every minted name app-wide, so an op returning a '${c.resource}' row hands the caller the rest of the row WITHOUT ${
        c.fields.join(", ")
      }. The fold is deliberate and app-wide (a per-resource exemption would let a declared field re-open a sibling's scope_key), so \`columns:\` cannot put ${
        c.fields.length === 1 ? "it" : "them"
      } back: rename the field on '${c.resource}', or drop the feature that mints ${
        c.fields.length === 1 ? "that column" : "those columns"
      } elsewhere. The resource's OWN list/find routes are unaffected — they are minted from '${c.resource}'s projection.`
    ),
  );
}

/** The minimal model slice the dispatch-boundary default-policy composition reads — the resource name, the
 *  verbatim author `operations`, and the two surface maps that decide which ops are exposed at policy level. */
interface OpExposureSource {
  readonly name: string;
  readonly operations: Readonly<Record<string, unknown>>;
  readonly http: Readonly<Partial<Record<string, HttpRoute>>>;
  readonly mcp: McpCuration;
}

/** True iff `opName` is exposed at `"policy"` (deny-by-default) level on either surface: an HTTP route in
 *  `policy` mode that is not `external`, or any MCP curation entry (MCP has no `public`/`external` opt-out).
 *  The single predicate `dispatchOperations` and the MCP capability filter share, so the two can never disagree. */
export function isPolicyExposedOp(
  m: OpExposureSource,
  opName: string,
): boolean {
  const route = m.http[opName];
  const httpPolicyLevel = route !== undefined &&
    httpPolicyMode(route) === "policy" && !isExternalRoute(route);
  return httpPolicyLevel || opName in m.mcp;
}

/** The effective policy for one op (13-authz.md §authz-seam): an explicit `op.policy` wins; else, a custom op
 *  exposed at policy level gets the auto-seeded `requires("<name>:<op>")` default-deny (the same key
 *  `derivePerms` mints); else `undefined`. Applies only to custom ops — a CRUD verb is never in `m.operations`,
 *  so it stays governed by the CRUD faces (`http/exposed-has-policy`, read-protected). The single source the
 *  dispatch carrier and the MCP capability filter both read. */
export function effectiveOpPolicy(
  m: OpExposureSource,
  opName: string,
): unknown {
  if (!(opName in m.operations)) return undefined; // CRUD verb (or unknown) — not a default-deny custom op
  const decl = m.operations[opName];
  // `policy: null` is the written public door (02-dsl.md) — `!= null` used to collapse it onto the
  // default-deny seed. Presence of the key is the decision; only an absent key inherits.
  if (typeof decl === "object" && decl !== null && "policy" in decl) {
    return (decl as { policy?: unknown }).policy;
  }
  return isPolicyExposedOp(m, opName)
    ? requires(`${m.name}:${opName}`)
    : undefined;
}

/** Compose the dispatch `operations` map — the author's verbatim decls with a deny-by-default policy injected
 *  for every policy-exposed op that omits its own (03-api-shape.md §custom-op-binding; 13-authz.md §authz-seam).
 *  Without this, an op exposed via a policy-mode http/mcp route with no declared policy would run
 *  unauthenticated. `m.operations` itself stays verbatim (the verifier reads that); only the dispatch carrier
 *  gets the injected default. An op exposed only `http:"public"` is unaffected (not policy-exposed). */
export function dispatchOperations(
  m: OpExposureSource,
): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [opName, decl] of Object.entries(m.operations)) {
    const effective = effectiveOpPolicy(m, opName);
    out[opName] = effective != null && typeof decl === "object" && decl !== null
      ? { ...(decl as object), policy: effective }
      : decl;
  }
  return out;
}
