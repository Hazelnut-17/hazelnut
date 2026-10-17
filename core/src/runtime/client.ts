import type { Insertable, Updatable } from "../core/faces-shapes.ts";
import type { PhantomOf } from "../core/faces-ctx.ts";
import type { ResourceCreateInput } from "../data/db-default.ts";
import type { TaskStatus } from "./tasks.ts";
import type { WorkflowInspection } from "./workflow.ts";
import type { SortSpec } from "../data/read-page.ts";
import type { BrandedSchemaKeys, FileSchema } from "../data/schema-types.ts";
import {
  httpVisibleViews,
  type ViewDecl,
  viewHttpPath,
} from "../features/view.ts";
// hazelnutClient — a typed fetch client derived from the live config value, zero codegen. Speaks the
// framework's Result<T> error vocabulary and reproduces server wire conventions (routeBase,
// pagination) from the same sources the server uses.
import type { z } from "zod";
import type { ErrKind, OpDecl, Result } from "../core/pipeline.ts";
import { err, ERR_KINDS, ok } from "../core/pipeline.ts";
import type { ResourceDecl } from "../core/app-types.ts";
import { opIsCollection } from "../core/app-refs.ts";
import type { ExpiryCallerWritable, Row, TemporalOn } from "../core/faces.ts";
import type { SchemaNullableKeys } from "../core/schema-storage-types.ts";
import { routeBase } from "./serve-helpers.ts";

// ── type derivation (the face) ─────────────────────────────────────────────────────────────────────
type ClientDecls<C> =
  | (C extends { readonly resources: infer R extends readonly ResourceDecl[] }
    ? R[number]
    : never)
  | (C extends { readonly modules: infer M extends readonly unknown[] }
    ? M[number] extends infer Mod
      ? Mod extends
        { readonly resources: infer R2 extends readonly ResourceDecl[] }
        ? R2[number]
      : never
    : never
    : never);

/** Only HTTP owners contribute verbs/path metadata. Same-name internal declarations in another
 * module are legal; mixing them into the owner's face erases its type to unknown. */
type HttpOwner<D> = D extends { readonly http: infer H }
  ? keyof H extends never ? never : D
  : never;

type ClientOwner<D extends ResourceDecl, C> = [HttpOwner<D>] extends [never]
  ? unknown // Preserve the existing non-callable member for an internal-only resource.
  : ResourceClient<Extract<HttpOwner<D>, ResourceDecl>, C>;

type SchemaOutOf<D extends ResourceDecl> = D extends
  { readonly schema: infer S extends z.ZodType } ? z.output<S> : never;
type FeaturesOf<D extends ResourceDecl> = PhantomOf<D>;
/** Full row face (schema + feature columns) — the pool a wire projection picks from. */
type FullRowOf<D extends ResourceDecl> = Row<
  SchemaOutOf<D>,
  FeaturesOf<D>,
  SchemaNullableKeys<D["schema"]>
>;
/** JSON accepts ISO dates (or Dates serialized by fetch) and decimal bigint strings. This projection
 * changes only resource write inputs; the schema's native read and nullability witnesses stay separate. */
type WireWriteInput<T> = T extends Date ? Date | string
  : T extends bigint ? string
  : T extends object ? { [K in keyof T]: WireWriteInput<T[K]> }
  : T;
type InsertOf<D extends ResourceDecl> = Omit<
  WireWriteInput<
    Insertable<
      SchemaOutOf<D>,
      FeaturesOf<D>,
      ResourceCreateInput<D["schema"]>
    >
  >,
  // Per-row expiry is a ctx.data input; HTTP create/patch deliberately exclude this lifecycle field.
  ExpiryCallerWritable<FeaturesOf<D>> extends true ? "expires_at" : never
>;
type PatchOf<D extends ResourceDecl> = Partial<
  Pick<
    InsertOf<D>,
    Extract<keyof InsertOf<D>, keyof Updatable<InsertOf<D>, FeaturesOf<D>>>
  >
>;
type ReadInstant<D extends ResourceDecl> = TemporalOn<FeaturesOf<D>> extends
  true ? { readonly asOf?: string } : { readonly asOf?: never };
type ClientListQuery<D extends ResourceDecl> =
  & Omit<ListQuery, "asOf">
  & ReadInstant<D>;
type ClientRichQuery<D extends ResourceDecl> =
  & Omit<RichListQuery, "asOf">
  & ReadInstant<D>;
interface PageHints {
  readonly hasMore?: boolean;
  readonly nextOffset?: number;
  readonly nextCursor?: string;
}
type RestoreClientOptions<D extends ResourceDecl> =
  ExpiryCallerWritable<FeaturesOf<D>> extends true
    ? { readonly expires_at?: string | null }
    : Record<string, never>;

/** `sensitive` / `encrypted` field names from a declaration (list or `{ fields }` card). */
type DeclaredFieldNames<T> = T extends readonly (infer E)[]
  ? E extends string ? E : never
  : T extends { readonly fields: readonly (infer F)[] }
    ? F extends string ? F : never
  : never;
type RedactKeysOf<D extends ResourceDecl> =
  | (D extends { readonly sensitive: infer S } ? DeclaredFieldNames<S> : never)
  | (D extends { readonly encrypted: infer E } ? DeclaredFieldNames<E> : never);
/** App-wide redact key union — same names `egressOp` drops for sensitive ∪ encrypted (withheld framework
 *  columns are runtime-only and stay a shallow type gap). */
type AppRedactKeys<C> = RedactKeysOf<ClientDecls<C>>;

type RouteColumns<R> = R extends { readonly columns: readonly (infer Col)[] }
  ? Col extends string ? Col : never
  : never;
type VerbRoute<D extends ResourceDecl, V extends string> = D extends
  { readonly http: { readonly [K in V]: infer R } } ? R : never;

/**
 * HTTP list/find success shape: declared `columns` minus the redaction set (03-api-shape.md
 * §wire-projection) — not the full Zod output. A widened (non-literal) columns list falls back to the
 * full row minus redact keys so inference stays usable.
 */
type WireRowOf<D extends ResourceDecl, V extends "list" | "find"> =
  RouteColumns<VerbRoute<D, V>> extends infer Cols
    ? string extends Cols ? Omit<FullRowOf<D>, RedactKeysOf<D>>
    : [Cols] extends [never] ? Omit<FullRowOf<D>, RedactKeysOf<D>>
    : Omit<
      Pick<FullRowOf<D>, Extract<Cols, keyof FullRowOf<D>>>,
      RedactKeysOf<D>
    >
    : never;

/** Custom-op Out after the same key drops `egressOp` applies (deep by property name). */
type WireOpOut<Out, C> = Out extends readonly (infer _E)[]
  ? { readonly [I in keyof Out]: WireOpOut<Out[I], C> }
  : Out extends object ? {
      [K in keyof Out as K extends AppRedactKeys<C> ? never : K]: WireOpOut<
        Out[K],
        C
      >;
    }
  : Out;

export interface ListQuery {
  /** the caller-`where` "asked" filter — AND-composed beneath the server's own WHERE-stack, never replacing it */
  readonly where?: Record<string, unknown>;
  readonly limit?: number;
  readonly offset?: number;
  /** opaque keyset cursor from a prior page's `Hazelnut-Next-Cursor` */
  readonly after?: string;
  readonly search?: string;
  readonly sort?: SortSpec;
  readonly asOf?: string;
}

export interface RichListQuery extends Omit<ListQuery, "where"> {
  readonly filter?: Record<string, unknown>;
}

type ClientRegistry<C, Key extends string> =
  | (C extends {
    readonly [K in Key]: infer Values extends readonly {
      readonly name: string;
    }[];
  } ? Values[number]
    : never)
  | (C extends { readonly modules: readonly (infer Module)[] }
    ? Module extends {
      readonly [K in Key]: infer Values extends readonly {
        readonly name: string;
      }[];
    } ? Values[number]
    : never
    : never);
type HttpView<V> = V extends { readonly http: unknown }
  ? V extends { readonly output: { readonly kind: "binary" } } ? never : V
  : never;
type ViewRow<V, C> = V extends { readonly over: infer Name extends string }
  ? Extract<ClientDecls<C>, { readonly name: Name }> extends
    infer D extends ResourceDecl
    ? V extends { readonly columns: readonly (infer Key)[] } ? Omit<
        Pick<FullRowOf<D>, Extract<Key, keyof FullRowOf<D>>>,
        RedactKeysOf<D>
      >
    : Omit<FullRowOf<D>, RedactKeysOf<D>>
  : never
  : V extends ViewDecl<infer R> ? R
  : Record<string, unknown>;
type ViewReadArgs<V> = V extends
  { readonly query: { readonly input: infer S extends z.ZodType } }
  ? [input: z.input<S>]
  : V extends { readonly input: infer S extends z.ZodType }
    ? undefined extends z.input<S> ? [input?: z.input<S>] : [input: z.input<S>]
  : [input?: unknown];
type FileKeys<D extends ResourceDecl> = D["schema"] extends z.ZodObject<infer S>
  ? BrandedSchemaKeys<S, FileSchema> & string
  : never;
type ReadableFileKeys<D extends ResourceDecl> = Extract<
  FileKeys<D>,
  keyof WireRowOf<D, "find"> & string
>;

/** Mirrors `opIsCollection` (core/app-refs.ts), which is an OR: an explicit `at:"collection"` route, OR a
 *  ZodObject input carrying no `id` key. The type used to read only the first half, so an op declared
 *  `http: { ping: "public" }` with input `{ n }` served `POST /cards/ping` while the client typed it
 *  `(id, input)` — an author who trusted the type called the instance path and got a 404. A non-object
 *  input has no shape to inspect, which is the runtime's `false` too. */
type IsCollectionOp<H, In> = H extends { readonly at: "collection" } ? true
  : In extends object ? ("id" extends keyof In ? false : true)
  : false;

/** The only custom-op transport option a typed caller may send. It exists exactly when the declaration
 * opts into the idempotency store; a non-idempotent op would ignore the header, so its face must not
 * imply a replay guarantee. */
export interface IdempotencyOptions {
  readonly idempotencyKey?: string;
}

type IdempotencyArgs<O> = [O] extends [{ readonly idempotent: true }]
  ? [opts?: IdempotencyOptions]
  : [];

type OpFn<H, O, C> = O extends OpDecl<infer In, infer Out>
  ? IsCollectionOp<H, In> extends true ? (
      input: In,
      ...opts: IdempotencyArgs<O>
    ) => Promise<Result<WireOpOut<Out, C>>>
  : (
    id: string,
    input: In,
    ...opts: IdempotencyArgs<O>
  ) => Promise<Result<WireOpOut<Out, C>>>
  : never;

/** An optional `If-Match` value. Non-versioned CRUD calls may omit it; a versioned resource gets the
 * required `VersionedCasOptions` slot below. */
export interface CasOptions {
  readonly expectedVersion?: number | string;
}

/** CAS `If-Match` for a versioned update/delete (03-api-shape.md §HTTP contract). A live declaration
 * with `features: { versioning: true }` makes this argument mandatory, matching the server's 428 refusal
 * for a blind write. */
export interface VersionedCasOptions {
  readonly expectedVersion: number | string;
}

/** Preserve the short non-versioned CRUD call while making the already-required wire precondition visible
 * in the derived client face. A widened/non-literal declaration stays permissive because its feature state
 * is not statically knowable; `defineResource({ features: { versioning: true } })` retains the literal. */
type ClientCasArgs<D extends ResourceDecl> = D extends {
  readonly features: { readonly versioning: true };
} ? [opts: VersionedCasOptions]
  : [opts?: CasOptions];

/** Runtime extras the proxy still forwards on a custom-op call (`Idempotency-Key`).
 *  `If-Match` is CRUD update/delete only — serve does not read it on a custom op.
 *  The typed `OpFn` exposes only its `idempotencyKey` half, and only when the declaration is
 *  `idempotent:true`; this wider runtime object remains an implementation detail.
 *  CRUD create never sends these headers (serve 400s `Idempotency-Key` on POST create). */
export interface VerbOptions extends CasOptions, IdempotencyOptions {
  readonly ifNoneMatch?: string;
}

type ResourceClient<D extends ResourceDecl, C> =
  & (D extends { readonly http: { readonly list: unknown } } ? {
      query(
        q?: ClientRichQuery<D>,
        opts?: { readonly withCursor?: boolean },
      ): Promise<Result<WireRowOf<D, "list">[] & PageHints>>;
      list(
        q?: ClientListQuery<D>,
        opts?: { readonly withCursor?: boolean },
      ): Promise<
        Result<WireRowOf<D, "list">[] & PageHints>
      >;
    }
    : unknown)
  & (D extends {
    readonly searchable: readonly string[];
    readonly http: { readonly list: unknown };
  } ? {
      search(
        text: string,
        q?: Omit<ClientRichQuery<D>, "search">,
        opts?: { readonly withCursor?: boolean },
      ): Promise<Result<WireRowOf<D, "list">[] & PageHints>>;
    }
    : unknown)
  & (D extends { readonly http: { readonly find: unknown } } ? {
      /** `where` AND-composes with the path id (same `?where=` serve parses). `withEtag` surfaces the
       *  response's `ETag` (the CAS version) as a field on the value. `ifNoneMatch` is the only call
       *  that can see 304 — without it the success type is the row. */
      find(
        id: string,
        opts: {
          readonly where?: Record<string, unknown>;
          readonly asOf?: TemporalOn<FeaturesOf<D>> extends true ? string
            : never;
          readonly withEtag?: boolean;
          readonly ifNoneMatch: string;
        },
      ): Promise<
        Result<
          | (WireRowOf<D, "find"> & { readonly etag?: string })
          | { readonly notModified: true }
        >
      >;
      find(
        id: string,
        opts?: {
          readonly where?: Record<string, unknown>;
          readonly asOf?: TemporalOn<FeaturesOf<D>> extends true ? string
            : never;
          readonly withEtag?: boolean;
          readonly ifNoneMatch?: undefined;
        },
      ): Promise<Result<WireRowOf<D, "find"> & { readonly etag?: string }>>;
    }
    : unknown)
  & (D extends { readonly http: { readonly find: unknown } }
    ? [ReadableFileKeys<D>] extends [never] ? unknown : {
      fileGrant(
        id: string,
        field: ReadableFileKeys<D>,
        opts?: { readonly ttl?: number },
      ): Promise<
        Result<
          {
            readonly url: string;
            readonly ttl: number;
            readonly exists?: boolean;
            readonly metadata?: {
              readonly size: number;
              readonly contentType?: string;
            };
          }
        >
      >;
      fileUploadGrant(
        id: string,
        field: ReadableFileKeys<D>,
        opts?: { readonly ttl?: number },
      ): Promise<
        Result<
          { readonly url: string; readonly ttl: number; readonly method: "PUT" }
        >
      >;
    }
    : unknown)
  & (D extends { readonly http: { readonly create: unknown } } ? {
      // the wire create returns the id envelope, not the row (03-api-shape.md §wire-projection)
      create(
        input: InsertOf<D>,
      ): Promise<Result<{ readonly id: string; readonly etag?: string }>>;
    }
    : unknown)
  & (D extends { readonly http: { readonly update: unknown } } ? {
      update(
        id: string,
        patch: PatchOf<D>,
        ...opts: ClientCasArgs<D>
      ): Promise<
        Result<
          {
            readonly updated: boolean;
            readonly etag?: string;
            readonly version?: number;
            readonly updated_at?: string;
            readonly updated_by_type?: string | null;
            readonly updated_by_id?: string | null;
          }
        >
      >;
    }
    : unknown)
  & (D extends { readonly http: { readonly delete: unknown } } ? {
      // delete is 204-no-body on success; the Result value is void
      delete(
        id: string,
        ...opts: ClientCasArgs<D>
      ): Promise<
        Result<
          D extends {
            readonly features: {
              readonly versioning: true;
              readonly softDelete: true;
            };
          } ? { readonly version: number; readonly etag: string }
            : void
        >
      >;
    }
    : unknown)
  & (D extends { readonly http: { readonly count: unknown } }
    ? D extends { readonly operations: { readonly count: unknown } } ? unknown
    : {
      count(
        q?:
          & { readonly where?: Record<string, unknown> }
          & ReadInstant<D>
          & (D extends { readonly searchable: readonly string[] }
            ? { readonly search?: string }
            : { readonly search?: never }),
      ): Promise<Result<number>>;
    }
    : unknown)
  & (D extends {
    readonly features: { readonly softDelete: true };
    readonly http: { readonly restore: unknown };
  } ? D extends { readonly operations: { readonly restore: unknown } } ? unknown
    : {
      restore(
        id: string,
        options?: RestoreClientOptions<D>,
      ): Promise<
        Result<
          {
            readonly restored: true;
            readonly version?: number;
            readonly etag?: string;
          }
        >
      >;
    }
    : unknown)
  & (D extends { readonly operations: infer Ops; readonly http: infer H } ? {
      readonly [K in keyof Ops & keyof H & string]: OpFn<H[K], Ops[K], C>;
    }
    : unknown);

/** The whole typed surface: one member per declared resource, verbs filtered to the `http:`-exposed set. */
export type HazelnutClient<C> =
  & {
    readonly [K in ClientDecls<C>["name"] & string]: ClientOwner<
      Extract<ClientDecls<C>, { readonly name: K }>,
      C
    >;
  }
  & {
    readonly views: {
      readonly [V in HttpView<ClientRegistry<C, "views">> as V["name"]]: {
        read(...args: ViewReadArgs<V>): Promise<Result<ViewRow<V, C>[]>>;
      };
    };
    readonly tasks: {
      readonly [T in ClientRegistry<C, "tasks"> as T["name"]]: {
        poll(id: string): Promise<Result<TaskStatus>>;
        cancel(id: string): Promise<Result<{ cancelling: boolean }>>;
      };
    };
    readonly workflows: {
      readonly [W in ClientRegistry<C, "workflows"> as W["name"]]: {
        inspect(id: string): Promise<Result<WorkflowInspection>>;
        cancel(id: string): Promise<Result<{ cancelling: boolean }>>;
      };
    };
  };

// ── runtime (the thin proxy) ───────────────────────────────────────────────────────────────────────
export interface ClientOptions {
  /**
   * Auth / tracing headers. `If-Match`, `If-None-Match` and `Idempotency-Key` here are stripped — CAS / 304
   * preconditions belong only on the typed verb options (`expectedVersion` / `ifNoneMatch`), so a
   * global bag cannot overwrite or invent them.
   */
  readonly headers?: Readonly<Record<string, string>>;
  /** Defaults to global `fetch`. This is `fetch(url, init)`, NOT the served app's `(Request) => Response`:
   *  passing `app.fetch` directly throws inside the router. Wrap it —
   *  `fetchFn: (input, init) => app.fetch(new Request(input, init))`. */
  readonly fetchFn?: typeof fetch;
}

/** Drop request-specific concurrency/replay keys; only typed verb options own those headers. */
function passthroughHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (/^(?:if-(?:match|none-match)|idempotency-key)$/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

const KINDS: ReadonlySet<string> = new Set(ERR_KINDS);

interface ClientResource {
  readonly path: string | undefined;
  readonly collectionOps: ReadonlySet<string>;
  readonly customOps: ReadonlySet<string>;
  readonly httpVerbs: ReadonlySet<string>;
  readonly readableFiles: boolean;
}

/** Collect name → path + collection-op set from a flat or modular config so the proxy can call the same
 *  routeBase as serve, and instance ops with no input body do not arity-route onto the collection path. */
function resourceIndex(
  config: unknown,
): ReadonlyMap<string, ClientResource> {
  const out = new Map<string, ClientResource>();
  if (config === null || typeof config !== "object") {
    throw new Error(
      "hazelnutClient: config must be the same defineConfig / app config object used to boot the server — without it, `path` overrides cannot reach the wire",
    );
  }
  const c = config as {
    readonly resources?: readonly ResourceDecl[];
    readonly modules?: readonly {
      readonly resources?: readonly ResourceDecl[];
    }[];
  };
  const add = (r: ResourceDecl) => {
    if (Object.keys(r.http ?? {}).length === 0) return;
    const collectionOps = new Set<string>();
    const customOps = new Set(
      Object.keys(r.operations ?? {}).filter((name) =>
        Object.hasOwn(r.http ?? {}, name)
      ),
    );
    for (const reserved of ["then", "toJSON"]) {
      if (customOps.has(reserved)) {
        throw new Error(
          `hazelnutClient: '${r.name}.${reserved}' conflicts with JavaScript reflection`,
        );
      }
    }
    if (r.http?.list && customOps.has("query")) {
      throw new Error(
        `hazelnutClient: '${r.name}.query' conflicts with the rich-read client door`,
      );
    }
    if (r.http?.list && r.searchable?.length && customOps.has("search")) {
      throw new Error(
        `hazelnutClient: '${r.name}.search' conflicts with the searchable client door`,
      );
    }
    const model = { http: r.http, operations: r.operations ?? {} };
    for (const verb of Object.keys(r.http ?? {})) {
      if (opIsCollection(model, verb)) collectionOps.add(verb);
    }
    out.set(r.name, {
      path: r.path,
      collectionOps,
      customOps,
      httpVerbs: new Set(Object.keys(r.http ?? {})),
      readableFiles: Boolean(r.http?.find || r.http?.list),
    });
  };
  for (const r of c.resources ?? []) add(r);
  for (const m of c.modules ?? []) {
    for (const r of m.resources ?? []) add(r);
  }
  return out;
}

interface ResponseOptions {
  readonly unwrap?: boolean;
  readonly etag?: boolean;
  readonly cursor?: boolean;
  readonly deleteVersion?: boolean;
}
type Deferred<T> = T | (() => T);

function transportFailure(e: unknown): Result<never> {
  // BYO transports can throw arbitrary values, including errors with throwing accessors/coercion.
  // Formatting that failure must not become a second exception outside the Result boundary.
  try {
    return err(
      "internal",
      `client transport failure: ${e instanceof Error ? e.message : String(e)}`,
    );
  } catch {
    return err("internal", "client transport failure");
  }
}

async function toResult(
  send: () => Promise<Response>,
  options: Deferred<ResponseOptions> = {},
): Promise<Result<unknown>> {
  try {
    const opts = typeof options === "function" ? options() : options;
    const res = await send();
    if (res.status === 304) {
      // Conditional GET: empty body, success. Response.ok is false for 304, so this must not fall into
      // the error decoder (which would mint err("internal", "HTTP 304")).
      return ok({ notModified: true });
    }
    const text = await res.text();
    const body = text === "" ? undefined : (() => {
      try {
        return JSON.parse(text);
      } catch {
        return undefined;
      }
    })();
    if (res.ok) {
      if (opts.deleteVersion) {
        const tag = res.headers.get("ETag");
        if (tag && /^"\d+"$/.test(tag)) {
          return ok({
            version: Number(tag.slice(1, -1)),
            etag: tag.slice(1, -1),
          });
        }
      }
      // a custom op's success rides inside `{ result }` (03-api-shape.md §op-door-projection) — unwrap so the
      // typed face's Out is the value the caller holds, not a wrapper it never declared
      const value = opts.unwrap &&
          body !== null && typeof body === "object" && "result" in body
        ? (body as { result: unknown }).result
        : body;
      if (opts.etag) {
        const etag = res.headers.get("ETag");
        if (etag !== null && value !== null && typeof value === "object") {
          return ok({ ...(value as object), etag: etag.replace(/^"|"$/g, "") });
        }
      }
      if (opts.cursor && Array.isArray(value)) {
        const next = res.headers.get("Hazelnut-Next-Cursor");
        const more = res.headers.get("Hazelnut-Has-More");
        const offset = res.headers.get("Hazelnut-Next-Offset");
        return ok(Object.assign(value, {
          ...(next === null ? {} : { nextCursor: next }),
          ...(more === "true" || more === "false"
            ? { hasMore: more === "true" }
            : {}),
          ...(offset !== null && /^\d+$/.test(offset) &&
              Number.isSafeInteger(Number(offset))
            ? { nextOffset: Number(offset) }
            : {}),
        }));
      }
      return ok(value);
    }
    // The served envelope is `{ error: { kind, message } }`, and a kind is taken from the wire ONLY from
    // that object shape. Anything else — a proxy page, transport noise, a bare-string `error` — is
    // `internal`: a body this app did not serve must never be decoded into one of its kinds.
    const raw = (body as { error?: unknown })?.error;
    const kindOf = (k: unknown): k is ErrKind =>
      typeof k === "string" && KINDS.has(k);
    const obj = raw !== null && typeof raw === "object"
      ? raw as {
        kind?: unknown;
        message?: unknown;
        code?: unknown;
        retryAfter?: unknown;
        throttle?: unknown;
        clause?: unknown;
      }
      : null;
    const kind: ErrKind = obj !== null && kindOf(obj.kind)
      ? obj.kind
      : obj !== null && obj.kind === "rate_limited"
      ? "forbidden"
      : obj !== null && obj.kind === "auth_unavailable"
      ? "timeout"
      : obj !== null && obj.kind === "payload_too_large"
      ? "validation"
      : "internal";
    const rawMessage = obj?.message ?? (body as { message?: string })?.message;
    const message = typeof rawMessage === "string" && rawMessage.trim() !== ""
      ? rawMessage
      : `HTTP ${res.status}`;
    const retryAfter = Number(
      obj?.retryAfter ?? res.headers.get("Retry-After"),
    );
    const limit = Number(res.headers.get("RateLimit-Limit")),
      remaining = Number(res.headers.get("RateLimit-Remaining")),
      resetAfter = Number(res.headers.get("RateLimit-Reset"));
    const hasRate =
      ["RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset"].every((
        name,
      ) => res.headers.has(name)) &&
      [limit, remaining, resetAfter].every((value) =>
        Number.isFinite(value) && value >= 0
      );
    const traceId = res.headers.get("Hazelnut-Trace-Id");
    const throttle = obj?.throttle as {
      limit?: unknown;
      remaining?: unknown;
      reset?: unknown;
      scope?: unknown;
    } | undefined;
    const validThrottle = throttle?.scope === "credential" &&
      [throttle.limit, throttle.remaining, throttle.reset].every((n) =>
        typeof n === "number" && Number.isFinite(n) && n >= 0
      );
    return err(kind, message, {
      httpStatus: res.status,
      ...(typeof obj?.clause === "string" ? { clause: obj.clause } : {}),
      ...(traceId ? { traceId } : {}),
      ...(hasRate ? { rateLimit: { limit, remaining, resetAfter } } : {}),
      ...(validThrottle
        ? {
          throttle: throttle as {
            limit: number;
            remaining: number;
            reset: number;
            scope: "credential";
          },
        }
        : {}),
      ...(typeof obj?.code === "string"
        ? { code: obj.code }
        : obj && typeof obj.kind === "string" &&
            ["rate_limited", "auth_unavailable", "payload_too_large"].includes(
              obj.kind,
            )
        ? { code: obj.kind }
        : {}),
      ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfter } : {}),
    });
  } catch (e) {
    return transportFailure(e);
  }
}

/** Typed fetch client — pass the LIVE config (not only `typeof config`) so `path` reaches routeBase. */
export function hazelnutClient<C>(
  config: C,
  baseUrl: string,
  opts: ClientOptions = {},
): HazelnutClient<C> {
  const base = baseUrl.replace(/\/$/, "");
  const fetchFn = opts.fetchFn ?? fetch;
  const resources = resourceIndex(config);
  const registry = config as {
    views?: readonly ViewDecl[];
    tasks?: readonly { name: string }[];
    workflows?: readonly { name: string }[];
    modules?: readonly {
      views?: readonly ViewDecl[];
      tasks?: readonly { name: string }[];
      workflows?: readonly { name: string }[];
    }[];
  };
  const views = httpVisibleViews([
    ...(registry.views ?? []),
    ...(registry.modules ?? []).flatMap((module) => module.views ?? []),
  ]);
  const viewNames = new Set<string>();
  for (const view of views) {
    if (viewNames.has(view.name)) {
      throw new Error(
        `hazelnutClient: duplicate HTTP view '${view.name}' has an ambiguous bare path`,
      );
    }
    viewNames.add(view.name);
  }
  const tasks = [
    ...(registry.tasks ?? []),
    ...(registry.modules ?? []).flatMap((module) => module.tasks ?? []),
  ];
  const workflows = [
    ...(registry.workflows ?? []),
    ...(registry.modules ?? []).flatMap((module) => module.workflows ?? []),
  ];
  for (
    const [name, active] of [["views", views.length], ["tasks", tasks.length], [
      "workflows",
      workflows.length,
    ]] as const
  ) {
    if (active && resources.has(name)) {
      throw new Error(
        `hazelnutClient: HTTP resource '${name}' collides with its active capability namespace`,
      );
    }
  }

  const call = (
    method: string,
    path: string | (() => string),
    body?: unknown,
    verbOptions?: Deferred<VerbOptions | undefined>,
    ro?: Deferred<ResponseOptions>,
  ): Promise<Result<unknown>> =>
    toResult(
      () => {
        const vo = typeof verbOptions === "function"
          ? verbOptions()
          : verbOptions;
        return fetchFn(`${base}${typeof path === "function" ? path() : path}`, {
          method,
          headers: {
            ...passthroughHeaders(opts.headers),
            ...(body !== undefined
              ? { "content-type": "application/json" }
              : {}),
            ...(vo?.expectedVersion !== undefined &&
                (method === "PATCH" || method === "DELETE")
              ? { "If-Match": `"${String(vo.expectedVersion)}"` }
              : {}),
            ...(vo?.idempotencyKey !== undefined
              ? { "Idempotency-Key": vo.idempotencyKey }
              : {}),
            ...(vo?.ifNoneMatch !== undefined
              ? { "If-None-Match": vo.ifNoneMatch }
              : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
      },
      ro,
    );
  /** Custom operations never consume `If-Match`: their concurrency contract, if any, is declared in the
   * operation input. The typed face already excludes `expectedVersion`; keep an unsafe JS/cast call loud
   * too, rather than letting it look like a CAS request while POST drops the header. */
  const customOpCall = (
    path: string | (() => string),
    body: unknown,
    vo?: VerbOptions,
  ): Promise<Result<unknown>> => {
    try {
      if (vo?.expectedVersion !== undefined) {
        return Promise.resolve(
          err(
            "validation",
            "custom operations do not accept expectedVersion; declare their concurrency input explicitly",
          ),
        );
      }
      return call("POST", path, body, vo, { unwrap: true });
    } catch (e) {
      return Promise.resolve(transportFailure(e));
    }
  };
  const resourceProxy = (name: string) => {
    const meta = resources.get(name);
    if (!meta) return undefined;
    const rb = routeBase({ name, path: meta?.path });
    return new Proxy({}, {
      get: (_t, property: string | symbol) => {
        if (
          typeof property !== "string" || property === "then" ||
          property === "toJSON"
        ) return undefined;
        const verb = property;
        const readConvenience = (verb === "query" || verb === "search") &&
          meta.httpVerbs.has("list");
        const fileConvenience =
          (verb === "fileGrant" || verb === "fileUploadGrant") &&
          meta.readableFiles;
        if (!meta.httpVerbs.has(verb) && !readConvenience && !fileConvenience) {
          return undefined;
        }
        if (
          (verb === "query" || verb === "search") && !meta?.customOps.has(verb)
        ) {
          return (
            input: RichListQuery | string = {},
            extra?: RichListQuery | { withCursor?: boolean },
            options?: { withCursor?: boolean },
          ) => {
            try {
              const q = typeof input === "string"
                ? { ...(extra as RichListQuery | undefined), search: input }
                : input;
              const o = typeof input === "string"
                ? options
                : extra as { withCursor?: boolean } | undefined;
              return call(
                "QUERY",
                rb,
                q,
                undefined,
                () => ({ cursor: o?.withCursor === true }),
              );
            } catch (error) {
              return Promise.resolve(transportFailure(error));
            }
          };
        }
        if (verb === "fileGrant" && !meta?.customOps.has(verb)) {
          return (id: string, field: string, o?: { ttl?: number }) =>
            call(
              "GET",
              () =>
                `${rb}/${encodeURIComponent(id)}/${
                  encodeURIComponent(field)
                }/url${
                  o?.ttl === undefined
                    ? ""
                    : `?ttl=${encodeURIComponent(String(o.ttl))}`
                }`,
            );
        }
        if (verb === "fileUploadGrant" && !meta?.customOps.has(verb)) {
          return (id: string, field: string, o?: { ttl?: number }) =>
            call(
              "POST",
              () =>
                `${rb}/${encodeURIComponent(id)}/${
                  encodeURIComponent(field)
                }/upload-url${
                  o?.ttl === undefined
                    ? ""
                    : `?ttl=${encodeURIComponent(String(o.ttl))}`
                }`,
            );
        }
        if (verb === "list") {
          return (
            q: ListQuery = {},
            o?: { readonly withCursor?: boolean },
          ) => {
            try {
              if (q.search !== undefined) {
                const { where, ...rich } = q;
                return call(
                  "QUERY",
                  rb,
                  {
                    ...rich,
                    ...(where === undefined ? {} : { filter: where }),
                  },
                  undefined,
                  () => ({ cursor: o?.withCursor === true }),
                );
              }
              return call(
                "GET",
                () => {
                  const p = new URLSearchParams();
                  if (q.asOf !== undefined) p.set("asOf", q.asOf);
                  if (q.sort !== undefined) {
                    p.set("sort", JSON.stringify(q.sort));
                  }
                  if (q.where) p.set("where", JSON.stringify(q.where));
                  if (q.limit !== undefined) p.set("limit", String(q.limit));
                  if (q.offset !== undefined) p.set("offset", String(q.offset));
                  if (q.after !== undefined && q.after !== "") {
                    p.set("after", q.after);
                  }
                  const qs = p.toString();
                  return `${rb}${qs ? `?${qs}` : ""}`;
                },
                undefined,
                undefined,
                () => ({ cursor: o?.withCursor === true }),
              );
            } catch (error) {
              return Promise.resolve(transportFailure(error));
            }
          };
        }
        if (verb === "find") {
          return (
            id: string,
            o?: {
              readonly where?: Record<string, unknown>;
              readonly asOf?: string;
              readonly withEtag?: boolean;
              readonly ifNoneMatch?: string;
            },
          ) => {
            return call(
              "GET",
              () => {
                const p = new URLSearchParams();
                if (o?.where) p.set("where", JSON.stringify(o.where));
                if (o?.asOf !== undefined) p.set("asOf", o.asOf);
                const qs = p.toString();
                return `${rb}/${encodeURIComponent(id)}${qs ? `?${qs}` : ""}`;
              },
              undefined,
              () =>
                o?.ifNoneMatch !== undefined
                  ? { ifNoneMatch: o.ifNoneMatch }
                  : undefined,
              () => ({ etag: o?.withEtag === true }),
            );
          };
        }
        if (verb === "count" && !meta.customOps.has(verb)) {
          return (
            q: {
              where?: Record<string, unknown>;
              search?: string;
              asOf?: string;
            } = {},
          ) =>
            call("GET", () => {
              const params = new URLSearchParams();
              if (q.where !== undefined) {
                params.set("where", JSON.stringify(q.where));
              }
              if (q.search !== undefined) {
                params.set("search", q.search);
              }
              if (q.asOf !== undefined) params.set("asOf", q.asOf);
              const suffix = params.toString();
              return `${rb}/count${suffix ? `?${suffix}` : ""}`;
            }).then((result) =>
              result.ok ? ok((result.value as { count: number }).count) : result
            );
        }
        if (verb === "restore" && !meta.customOps.has(verb)) {
          return (id: string, options: Record<string, unknown> = {}) =>
            call(
              "POST",
              () => `${rb}/${encodeURIComponent(id)}/restore`,
              options,
              undefined,
              { etag: true },
            );
        }
        if (verb === "create") {
          // the write answers the version it just wrote; surface it so the next call needs no read
          return (input: unknown) =>
            call("POST", rb, input, undefined, { etag: true });
        }
        if (verb === "update") {
          return (id: string, patch: unknown, vo?: CasOptions) =>
            call("PATCH", () => `${rb}/${encodeURIComponent(id)}`, patch, vo, {
              etag: true,
            });
        }
        if (verb === "delete") {
          return (id: string, vo?: CasOptions) =>
            call(
              "DELETE",
              () => `${rb}/${encodeURIComponent(id)}`,
              undefined,
              vo,
              { deleteVersion: true },
            );
        }
        // custom op: `at` from the declaration, not arity — an instance op with no input is
        // `POST /:id/<op>`, never the collection path.
        if (meta?.collectionOps.has(verb)) {
          return (a: unknown, vo?: VerbOptions) =>
            customOpCall(`${rb}/${verb}`, a, vo);
        }
        return (a: unknown, b?: unknown, vo?: VerbOptions) =>
          customOpCall(
            () => `${rb}/${encodeURIComponent(String(a))}/${verb}`,
            b ?? {},
            vo,
          );
      },
    });
  };
  const namespaced = (family: "views" | "tasks" | "workflows") =>
    new Proxy({}, {
      get: (_target, name: string) => {
        if (
          typeof name !== "string" || name === "then" || name === "toJSON"
        ) return undefined;
        if (family === "views") {
          return {
            read: (input?: unknown) => {
              const view = views.find((value) => value.name === name);
              if (!view) {
                return Promise.resolve(err("notFound", "view not found"));
              }
              return call(
                "GET",
                () =>
                  `${viewHttpPath(view)}${
                    input === undefined
                      ? ""
                      : `?input=${encodeURIComponent(JSON.stringify(input))}`
                  }`,
              );
            },
          };
        }
        if (family === "tasks") {
          return {
            poll: (id: string) =>
              tasks.some((task) => task.name === name)
                ? call(
                  "GET",
                  () =>
                    `/tasks/${encodeURIComponent(id)}?name=${
                      encodeURIComponent(name)
                    }`,
                )
                : Promise.resolve(err("notFound", "task not found")),
            cancel: (id: string) =>
              tasks.some((task) => task.name === name)
                ? call(
                  "DELETE",
                  () =>
                    `/tasks/${encodeURIComponent(id)}?name=${
                      encodeURIComponent(name)
                    }`,
                )
                : Promise.resolve(err("notFound", "task not found")),
          };
        }
        return {
          inspect: (id: string) =>
            workflows.some((workflow) => workflow.name === name)
              ? call(
                "GET",
                () =>
                  `/workflows/${encodeURIComponent(name)}/${
                    encodeURIComponent(id)
                  }`,
              )
              : Promise.resolve(err("notFound", "workflow not found")),
          cancel: (id: string) =>
            workflows.some((workflow) => workflow.name === name)
              ? call(
                "DELETE",
                () =>
                  `/workflows/${encodeURIComponent(name)}/${
                    encodeURIComponent(id)
                  }`,
              )
              : Promise.resolve(err("notFound", "workflow not found")),
        };
      },
    });
  return new Proxy({}, {
    get: (_t, name: string | symbol) =>
      typeof name !== "string" || name === "then" || name === "toJSON"
        ? undefined
        : (name === "views" && views.length ||
            name === "tasks" && tasks.length ||
            name === "workflows" && workflows.length)
        ? namespaced(name as "views" | "tasks" | "workflows")
        : resourceProxy(name),
  }) as HazelnutClient<C>;
}
