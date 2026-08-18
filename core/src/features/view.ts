import type { ZodType } from "zod";
import type { App, ResourceModel } from "../core/app.ts";
import { tableOf } from "../core/app-define.ts";
import type { OnlyKnownKeys } from "../core/config.ts";
import type { Db } from "../data/db.ts";
import {
  actorGateDenies,
  buildReadWhere,
  cursorKey,
  encodeCursor,
  orderedPageTail,
  type ReadCtx,
  type RowPolicy,
} from "../data/repo.ts";
import { dropSensitiveAll } from "./redact.ts";
import { all, type Where } from "../core/where.ts";
import type { Actor } from "../authz/auth.ts";

/** The view's `output` contract marker (02-dsl.md §defineView line 72): `json()` (default) — a row set,
 *  projection/narrowing applies; `binary()` — a blob (Excel/PDF/CSV), so those guarantees do not apply. */
export type ViewOutput = { readonly kind: "json" } | {
  readonly kind: "binary";
};
/** `json()` — the default view output: the projection is a narrowed row set (projection guarantees apply). */
export function json(): ViewOutput {
  return { kind: "json" };
}
/** `binary()` — the view yields a blob (Excel/PDF/CSV), not a row set: flips off the column-projection /
 *  narrowing demand (canon line 72 — a blob has no columns to narrow). */
export function binary(): ViewOutput {
  return { kind: "binary" };
}
/** True iff a view's output is `binary()` — a blob, so the verifier must never demand projection/narrowing on it. */
export function isBinaryView(view: ViewDecl): boolean {
  return view.output?.kind === "binary";
}

/** Thrown by `runView` when a run-form view's actor gate denies the caller. The MCP door short-circuits via
 *  `runFormActorDenied` before reaching here; a typed error so a direct caller fails loud, not a silent open read. */
export class ViewForbiddenError extends Error {
  constructor(viewName: string) {
    super(
      `view '${viewName}' — policy denied (its rowPolicy returned none() for this actor)`,
    );
    this.name = "ViewForbiddenError";
  }
}

/** The run-form view's actor gate (13-authz.md §defineView-cross-source-row-visibility): the required
 *  `rowPolicy` doubles as the gate since there's no table to apply it to — `none()` at the top level denies,
 *  anything else allows (nested `none()` inside `and(...)` reads as allow); a throwing `rowPolicy` fails closed. */
export function runFormActorDenied(
  view: ViewDecl,
  actor: Actor | null,
): boolean {
  if (typeof view.run !== "function") return false; // over-form gates via its WHERE, not here
  return actorGateDenies(view.rowPolicy, actor);
}

/** The view's curated agent face (12-mcp §6): `defineView` projects to a read-tool via one field `mcp?:
 *  { describe }` — same shape as the op field. A view with no `mcp` is invisible to agents (safe default). */
export interface ViewMcpEntry {
  readonly describe: string;
}

/** The view's opt-in HTTP face. Absent ⇒ no route. `policy: "public"` admits an anonymous caller into
 *  `runView` (the view's own `rowPolicy` still gates); `"policy"` refuses anonymous before dispatch. */
export interface ViewHttpEntry {
  readonly policy: "public" | "policy";
}

/** `defineView` — a read-only projection over a resource: narrows with its own `where`, selects `columns`,
 *  but always runs through the full read WHERE-stack (scope/softDelete/expiry/temporal/rowPolicy), so it can
 *  never widen visibility past what the caller may read. `mcp` opts it into the MCP read-tool surface (12-mcp §6). */
export interface ViewDecl<Row = Record<string, unknown>> {
  readonly name: string;
  // the resource this view reads — the single-`over` projection sugar. Optional: a cross-source `run`-form
  // view (02-dsl.md §defineView) has no source table and supplies `sources`+`run` instead; runView dispatches.
  readonly over?: string;
  readonly where?: (ctx: ReadCtx) => Where<Row>; // an extra caller-where narrowing (composed into the stack)
  readonly columns?: readonly string[]; // projected columns (default: all)
  readonly rowPolicy?: RowPolicy<Row>; // row policy applied for the view (default: match-all)
  // the cross-source live projection form (02-dsl.md §defineView lines 64-86): `sources` is the only legal
  // cross-module read path (`boundary/cross-read-narrowed`), carried opaquely — the join is hand-written in `run`.
  readonly sources?: readonly unknown[];
  // `input`: the typed filter schema (`z.object({…})`). When `run` is present, `runView` validates the caller's
  // input against this before dispatch — an invalid filter fails loud, never reaches the hand-written query.
  readonly input?: ZodType;
  // `run`: the hand-written aggregate/join. The framework derives nothing here — it validates `input`, calls
  // `run(ctx, input)`, and relies on `sources` for narrowing. Writes inside `run` are forbidden (`tx/read-op-no-write`).
  readonly run?: (
    ctx: ViewRunCtx,
    input: unknown,
  ) => Promise<Array<Record<string, unknown>>>;
  // `output`: `json()` (default — a narrowed row set) | `binary()` (Excel/PDF/CSV — a blob, flips off the
  // verifier's column-projection/narrowing demand). Absent ⇒ json().
  readonly output?: ViewOutput;
  readonly mcp?: ViewMcpEntry; // opt-in agent read-tool (absent ⇒ invisible to agents)
  readonly http?: ViewHttpEntry; // opt-in HTTP GET /views/<name> (absent ⇒ no route)
  // the read-view's function escape (12-mcp §5): `shape` does compute/rename over the row, must be total, pure,
  // and actor-agnostic (`mcp/shape-is-pure`), and runs after sensitive-redaction so a dropped field can't re-enter.
  readonly shape?: (row: Record<string, unknown>) => Record<string, unknown>;
}

// `ViewDecl<Row>` stays the first conjunct so `Row` keeps its inference site; `D` carries the caller's own
// literal so the exactness conjunct can see the keys it actually wrote.
export function defineView<Row = Record<string, unknown>, D = unknown>(
  decl: ViewDecl<Row> & OnlyKnownKeys<D, ViewDecl<Row>>,
): ViewDecl<Row> {
  return decl;
}

/** The framework-owned declaration keys of `defineView` (the `decl/unknown-key` meta-schema): compile-bound
 *  to `ViewDecl` via `Record<keyof ViewDecl, true>`, so an added field with no map entry is a `deno check` error. */
const VIEW_DECL_KEY_MAP: Record<keyof ViewDecl, true> = {
  name: true,
  over: true,
  where: true,
  columns: true,
  rowPolicy: true,
  sources: true,
  input: true,
  run: true,
  output: true,
  mcp: true,
  http: true,
  shape: true,
};
export const VIEW_DECL_KEYS: ReadonlySet<string> = new Set(
  Object.keys(VIEW_DECL_KEY_MAP),
);

/** `decl/unknown-key` for `defineView` (03-api-shape.md §Universal, 10-invariants.md §decl/unknown-key): an
 *  unknown framework key is a loud boot fail with a did-you-mean steer (`policy` → `rowPolicy`); only key positions
 *  are strict — `rowPolicy`/`where`/`run`/`shape` bodies stay transparent. Returns one message per offending key. */
export function checkViewUnknownKeys(view: ViewDecl): string[] {
  const errs: string[] = [];
  const name = (view as { name?: string }).name ?? "?";
  for (const k of Object.keys(view)) {
    if (VIEW_DECL_KEYS.has(k)) continue;
    const steer = k === "policy"
      ? " — a view's authz is 'rowPolicy' (for a run-form view it is the actor gate, `(actor) => cond ? all() : none()`; for an over-form view it is the row filter)"
      : "";
    errs.push(
      `decl/unknown-key: unknown declaration key '${k}' on view '${name}'${steer}`,
    );
  }
  return errs;
}

/** Resolve a view's source resource model, or throw the same loud error `runView` raises. */
function modelOf(app: App, view: ViewDecl): ResourceModel {
  const model = app.model.find((m) => m.name === view.over);
  if (!model) {
    throw new Error(
      `view '${view.name}' is over unknown resource '${view.over}'`,
    );
  }
  return model;
}

/**
 * A table-form view's projection: its declared `columns`, else `id` + the SOURCE's declared schema keys.
 * There is no `SELECT *` default — a wire shape read off the physical table makes every column the DERIVER
 * mints (`created_at`, `version`, `deleted_at`, `scope_key`) a function of a storage switch, so flipping
 * `features:{ timestamps }` would widen a live agent tool. The projection is POSITIVE at this door exactly
 * as it is at the CRUD read door (03-api-shape.md §wire-projection).
 */
export function viewColumnsOf(
  view: ViewDecl,
  model: ResourceModel,
): readonly string[] {
  if (view.columns && view.columns.length > 0) return [...view.columns];
  return [...new Set(["id", ...Object.keys(model.schema.shape)])];
}

/** The view's MCP tool name — `<module>__<view>__view`. A view is always a tool (12-mcp §6, no addressable
 *  id), occupying the op-segment with literal `view` so the FQN stays three-segment and `parseToolName`-reversible. */
export const VIEW_OP_SEGMENT = "view";
export function viewToolName(app: App, view: ViewDecl): string {
  // a cross-source run-form view has no single `over` model to inherit a module from — it is by nature a
  // cross-module aggregate, so it lives under the flat "app" module FQN (deterministic, reorder-proof).
  if (typeof view.run === "function") {
    return resourceToolName("app", view.name, VIEW_OP_SEGMENT);
  }
  return resourceToolName(
    modelOf(app, view).module,
    view.name,
    VIEW_OP_SEGMENT,
  );
}

/** The resource-op tool FQN — `<module>__<resource>__<op>` (12-mcp §5). Lives here (upstream of `mcp/`) so the
 *  compose-time collision scan and catalog emission derive every name through one join, never two that could drift. */
export function resourceToolName(
  module: string,
  resource: string,
  op: string,
): string {
  return `${module}__${resource}__${op}`;
}

/** The views that project to the MCP catalog: `mcp`-opted, non-binary (a binary() view is a blob — never a
 *  tool, 12-mcp §6). The one filter `viewToolDefs` and the collision scan share. */
export function mcpVisibleViews(
  views: readonly ViewDecl[],
): (ViewDecl & { mcp: NonNullable<ViewDecl["mcp"]> })[] {
  return views.filter((
    v,
  ): v is ViewDecl & { mcp: NonNullable<ViewDecl["mcp"]> } =>
    v.mcp !== undefined && !isBinaryView(v)
  );
}

/** Views that opted into HTTP. Binary output is MCP-shaped (a blob); the HTTP opt-in is the JSON row set. */
export function httpVisibleViews(
  views: readonly ViewDecl[],
): (ViewDecl & { http: NonNullable<ViewDecl["http"]> })[] {
  return views.filter((
    v,
  ): v is ViewDecl & { http: NonNullable<ViewDecl["http"]> } =>
    v.http !== undefined && !isBinaryView(v)
  );
}

/** The one HTTP path for an opted-in view — `GET /views/<name>`. Single-sourced so serve, OpenAPI, and the
 *  HTTP lock cannot drift. */
export function viewHttpPath(view: { readonly name: string }): string {
  return `/views/${view.name}`;
}

/** Every derived MCP tool FQN — resource ops ∪ view tools — for the compose-time injectivity scan (`mcp/tool-
 *  name-collision`, core/app.ts). Rides the same producers the catalog uses, so it can't drift from `tools/list`. */
export function mcpToolNames(app: App): string[] {
  const names: string[] = [];
  for (const m of app.model) {
    for (const op of Object.keys(m.mcp)) {
      names.push(resourceToolName(m.module, m.name, op));
    }
  }
  for (const v of mcpVisibleViews(app.views ?? [])) {
    names.push(viewToolName(app, v));
  }
  return names;
}

/**
 * Run a view. Two coexisting forms (02-dsl.md §defineView): the cross-source `run`-form derives nothing —
 * it validates `input`, then dispatches to the hand-written `run(ctx, input)`, narrowed/authz'd via `sources`
 * (not a single-table WHERE-stack); the single-`over` form resolves the resource, applies the WHERE-stack +
 * the view's narrowing, and projects `columns`.
 */
export async function runView<Row = Record<string, unknown>>(
  db: Db,
  app: App,
  view: ViewDecl<Row>,
  ctx: ReadCtx,
  input?: unknown,
): Promise<Array<Partial<Row>>> {
  // the run-path (load-bearing dispatch): validate the typed filter, then call the hand-written aggregate/join.
  // The framework derives nothing here — no table, no WHERE-stack — so this branch never touches modelOf/buildReadWhere.
  if (typeof view.run === "function") {
    // The run-form view's required rowPolicy is the "who may run" gate (no table to apply a Where to);
    // none() denies — checked here so a direct caller can never get an ungated cross-owner aggregate.
    if (runFormActorDenied(view as ViewDecl, ctx.actor)) {
      throw new ViewForbiddenError(view.name);
    }
    const validated = view.input ? view.input.parse(input) : input;
    // Cross-source row-visibility (13-authz.md §defineView-cross-source-row-visibility): ctx.reads.<view> is
    // the only door, carrying buildReadWhere's non-actor conjuncts; the producer's own rowPolicy is not re-applied.
    const enriched: ViewRunCtx = {
      ...ctx,
      reads: crossSourceReads(db, app, view as ViewDecl, ctx),
    };
    const rows = await view.run(enriched, validated);
    return rows as Array<Partial<Row>>;
  }
  const model = modelOf(app, view as ViewDecl);
  const rowPolicy = view.rowPolicy ?? (() => all<Row>());
  const caller = view.where ? view.where(ctx) : all<Row>();
  const { sql, params } = buildReadWhere(model, ctx, rowPolicy, caller);
  const cols = viewColumnsOf(view as ViewDecl, model).map((c) => `"${c}"`).join(
    ", ",
  );
  const r = await db.query<Record<string, unknown>>(
    `SELECT ${cols} FROM ${tableOf(model)} WHERE ${sql}`,
    params,
  );
  // the redaction chokepoint every other read egress passes — the over-form's projection derives from
  // the model, so its output redact set (sensitive ∪ encrypted) is the model's.
  return dropSensitiveAll(model, r.rows) as Array<Partial<Row>>;
}

/** The cross-source read facade a run-form view's `run` body receives as `ctx.reads`: each entry is a
 *  `sources` producer view, bound so a read routes through `runViewQuery` → `buildReadWhere` (the producer's
 *  non-actor conjuncts). Keyed by producer view name; there is no raw-table door — only the stacked read. */
export type ViewReadsFacade = Record<
  string,
  (q: ViewQuery) => Promise<ViewEnvelope>
>;

/** The ctx a run-form view's `run(ctx, input)` body receives: the base `ReadCtx` plus the `reads` facade
 *  `runView` threads on — the only sanctioned cross-source read door, typed so a run body reads
 *  `ctx.reads.<producer>(q)` without a cast. Deliberately not the full op `RichCtx`: a view run cannot mutate. */
export type ViewRunCtx = ReadCtx & { readonly reads: ViewReadsFacade };

/** A `sources` entry, parsed tolerantly: the framework carries `sources` opaquely, but the row-visibility
 *  wiring needs the producer view name. Unrecognized shapes degrade to `{}` (inert — no throw). */
interface SourceRef {
  readonly resource?: string;
  readonly view?: string;
}
function asSourceRef(s: unknown): SourceRef {
  if (s !== null && typeof s === "object") {
    const o = s as Record<string, unknown>;
    return {
      resource: typeof o.resource === "string" ? o.resource : undefined,
      view: typeof o.view === "string" ? o.view : undefined,
    };
  }
  return {};
}

/** Builds the read facade: for each `sources` producer view, binds a reader through `runViewQuery` →
 *  `buildReadWhere`, dropping sensitive/encrypted fields (13-authz.md §defineView-cross-source-row-visibility). */
function crossSourceReads(
  db: Db,
  app: App,
  view: ViewDecl,
  ctx: ReadCtx,
): ViewReadsFacade {
  const out: ViewReadsFacade = {};
  const views = app.views ?? [];
  for (const raw of view.sources ?? []) {
    const ref = asSourceRef(raw);
    if (!ref.view) continue; // an opaque/unrecognized source ref → no stacked reader (inert)
    const producer = views.find((v) =>
      v.name === ref.view && v.over !== undefined
    );
    if (!producer) continue; // a sources entry naming no over-form producer view is inert (boot loud-checks dangling)
    const srcModel = app.model.find((m) => m.name === producer.over);
    out[ref.view] = async (q: ViewQuery): Promise<ViewEnvelope> => {
      // the load-bearing conjunct read: runViewQuery → buildReadWhere applies scope/softDelete/expiry/temporal.
      const env = await runViewQuery(
        db,
        app,
        producer,
        ctx,
        q,
        READS_LIMIT_MAX,
      );
      if (!srcModel) return env;
      return {
        ...env,
        items: dropSensitiveAll(srcModel, env.items) as Array<
          Record<string, unknown>
        >,
      };
    };
  }
  return out;
}

const READS_LIMIT_MAX = 100; // mirrors data.ts readsOf / mcp.ts LIST_LIMIT_MAX (the per-read cap a view tool enforces).

/** Producer resources a run-form view's `sources` read that declare a `rowPolicy` (13-authz.md
 *  §defineView-cross-source-row-visibility) — the producer's rowPolicy is deliberately not re-applied, so this
 *  flags the coarse gate for review. Empty ⇒ no protected producer. */
export function protectedProducersOf(app: App, view: ViewDecl): string[] {
  if (typeof view.run !== "function") return []; // the advisory is the cross-source run-form's row-visibility boundary
  const views = app.views ?? [];
  const protectedNames = new Set<string>();
  for (const raw of view.sources ?? []) {
    const ref = asSourceRef(raw);
    // resolve the producer resource: a `sources` entry may name it directly (`resource`) or via the producer view's `over`.
    let producerResource = ref.resource;
    if (!producerResource && ref.view) {
      const producer = views.find((v) =>
        v.name === ref.view && v.over !== undefined
      );
      producerResource = producer?.over;
    }
    if (!producerResource) continue;
    const model = app.model.find((m) => m.name === producerResource);
    if (model && typeof model.rowPolicy === "function") {
      protectedNames.add(producerResource);
    }
  }
  return [...protectedNames];
}

/** The view read-tool query — keyset-or-offset pagination over the narrowed projection (12-mcp §6). The
 *  view's own `where` is the narrowing (not agent-supplied), so the agent supplies only page controls. */
export interface ViewQuery {
  readonly limit?: number;
  readonly offset?: number;
  /** Opaque keyset cursor (a prior page's `nextCursor`) — opt into stable pagination; supersedes `offset`. */
  readonly after?: string;
}

/** The mandatory read-tool result envelope (12-mcp §6) — the same shape the default `list` tool returns, so
 *  a view tool is indistinguishable from a CRUD list tool to an agent. `hasMore` is explicit; count is absent. */
export interface ViewEnvelope {
  readonly items: Array<Record<string, unknown>>;
  readonly page: {
    readonly limit: number;
    readonly offset: number;
    readonly returned: number;
  };
  readonly hasMore: boolean;
  readonly nextOffset?: number;
  /** Opaque keyset cursor for the next page (12-mcp §6) — present iff `hasMore`; feed back as `after`. The
   *  view walks `id` (the source's stable key), included in the cursor even when the projection omits it. */
  readonly nextCursor?: string;
}

/** Run a view as a read-tool (12-mcp §6): the same WHERE-stack + narrowing `runView` uses, with keyset-or-
 *  offset pagination layered on (over-fetch `limit+1` for `hasMore`, no count-oracle). Output is
 *  `viewColumnsOf` — the declared `columns`, else `id` + the source's schema keys — so no column the DERIVER
 *  minted reaches the wire and a storage switch cannot widen a live tool. Pagination walks `id` (stable
 *  uuidv7 key); when the projection omits it, it's selected for the cursor then stripped from output. */
export async function runViewQuery(
  db: Db,
  app: App,
  view: ViewDecl,
  ctx: ReadCtx,
  q: ViewQuery,
  limitMax: number,
): Promise<ViewEnvelope> {
  const model = modelOf(app, view);
  const limit = q.limit ?? limitMax;
  const offset = q.offset ?? 0;
  const rowPolicy = (view.rowPolicy ?? (() => all())) as RowPolicy<
    Record<string, unknown>
  >;
  const caller = (view.where ? view.where(ctx) : all()) as Where<
    Record<string, unknown>
  >;
  const { sql, params } = buildReadWhere(model, ctx, rowPolicy, caller);
  // the view walks `id`; when its projection omits `id`, SELECT it anyway for the cursor, then strip it below —
  // the output contract stays exactly the view's projection, id is cursor-internal (never over-returned).
  const projected = viewColumnsOf(view, model);
  const idInjected = !projected.includes("id");
  const cols = (idInjected ? [...projected, "id"] : projected)
    .map((c) => `"${c}"`).join(", ");
  const key = cursorKey({ orderBy: ["id"] }, model); // id keyset (validated against the sortable columns)
  const tail = orderedPageTail({
    key,
    dir: "asc",
    after: q.after,
    offset,
    limit: limit + 1,
  }, params);
  const r = await db.query<Record<string, unknown>>(
    `SELECT ${cols} FROM ${tableOf(model)} WHERE ${sql}${tail}`,
    params,
  );
  const hasMore = r.rows.length > limit;
  const rows = (hasMore ? r.rows.slice(0, limit) : r.rows) as Array<
    Record<string, unknown>
  >;
  const last = rows[rows.length - 1] as Record<string, unknown> | undefined;
  const nextCursor = hasMore && last
    ? encodeCursor(key.map((c) => [c, last[c]] as const))
    : undefined;
  // strip the cursor-only `id` so the output is exactly the view's projected columns (never a leak).
  const items = idInjected ? rows.map(({ id: _id, ...rest }) => rest) : rows;
  return {
    items,
    page: { limit, offset, returned: items.length },
    hasMore,
    ...(hasMore && q.after === undefined ? { nextOffset: offset + limit } : {}),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}
