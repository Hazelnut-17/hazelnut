// hazelnutClient — a typed fetch client derived from the live config value, zero codegen. Speaks the
// framework's Result<T> error vocabulary and reproduces server wire conventions (routeBase,
// pagination) from the same sources the server uses.
import type { z } from "zod";
import type { ErrKind, OpDecl, Result } from "../core/pipeline.ts";
import { err, ERR_KINDS, ok } from "../core/pipeline.ts";
import type { ResourceDecl } from "../core/app-types.ts";
import { opIsCollection } from "../core/app-refs.ts";
import type { Features, Row } from "../core/faces.ts";
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

type SchemaOutOf<D extends ResourceDecl> = D extends
  { readonly schema: infer S extends z.ZodType } ? z.output<S> : never;
type FeaturesOf<D extends ResourceDecl> = D extends
  { readonly features: infer F extends Features } ? F : Features;
/** Full row face (schema + feature columns) — the pool a wire projection picks from. */
type FullRowOf<D extends ResourceDecl> = Row<SchemaOutOf<D>, FeaturesOf<D>>;
type InsertOf<D extends ResourceDecl> = D extends
  { readonly schema: infer S extends z.ZodType } ? z.input<S> : never;

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
}

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
      list(
        q?: ListQuery,
        opts?: { readonly withCursor?: boolean },
      ): Promise<
        Result<WireRowOf<D, "list">[] & { readonly nextCursor?: string }>
      >;
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
          readonly withEtag?: boolean;
          readonly ifNoneMatch?: undefined;
        },
      ): Promise<Result<WireRowOf<D, "find"> & { readonly etag?: string }>>;
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
        patch: Partial<InsertOf<D>>,
        ...opts: ClientCasArgs<D>
      ): Promise<
        Result<{ readonly updated: boolean; readonly etag?: string }>
      >;
    }
    : unknown)
  & (D extends { readonly http: { readonly delete: unknown } } ? {
      // delete is 204-no-body on success; the Result value is void
      delete(
        id: string,
        ...opts: ClientCasArgs<D>
      ): Promise<Result<void>>;
    }
    : unknown)
  & (D extends { readonly operations: infer Ops; readonly http: infer H } ? {
      readonly [K in keyof Ops & keyof H & string]: OpFn<H[K], Ops[K], C>;
    }
    : unknown);

/** The whole typed surface: one member per declared resource, verbs filtered to the `http:`-exposed set. */
export type HazelnutClient<C> = {
  readonly [K in ClientDecls<C>["name"] & string]: ResourceClient<
    Extract<ClientDecls<C>, { readonly name: K }>,
    C
  >;
};

// ── runtime (the thin proxy) ───────────────────────────────────────────────────────────────────────
export interface ClientOptions {
  /**
   * Auth / tracing headers. `If-Match` and `If-None-Match` here are stripped — CAS / 304
   * preconditions belong only on the typed verb options (`expectedVersion` / `ifNoneMatch`), so a
   * global bag cannot overwrite or invent them.
   */
  readonly headers?: Readonly<Record<string, string>>;
  /** Defaults to global `fetch`. This is `fetch(url, init)`, NOT the served app's `(Request) => Response`:
   *  passing `app.fetch` directly throws inside the router. Wrap it —
   *  `fetchFn: (input, init) => app.fetch(new Request(input, init))`. */
  readonly fetchFn?: typeof fetch;
}

/** Drop CAS / conditional-GET keys from the constructor bag; verb options own those headers. */
function passthroughHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (/^if-(match|none-match)$/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

const KINDS: ReadonlySet<string> = new Set(ERR_KINDS);

interface ClientResource {
  readonly path: string | undefined;
  readonly collectionOps: ReadonlySet<string>;
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
    const collectionOps = new Set<string>();
    const model = { http: r.http, operations: r.operations ?? {} };
    for (const verb of Object.keys(r.http ?? {})) {
      if (opIsCollection(model, verb)) collectionOps.add(verb);
    }
    out.set(r.name, { path: r.path, collectionOps });
  };
  for (const r of c.resources ?? []) add(r);
  for (const m of c.modules ?? []) {
    for (const r of m.resources ?? []) add(r);
  }
  return out;
}

async function toResult(
  resP: Promise<Response>,
  opts: {
    readonly unwrap?: boolean;
    readonly etag?: boolean;
    readonly cursor?: boolean;
  } = {},
): Promise<Result<unknown>> {
  try {
    const res = await resP;
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
        if (next !== null) {
          return ok(Object.assign(value, { nextCursor: next }));
        }
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
      ? raw as { kind?: unknown; message?: unknown }
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
    return err(kind, message);
  } catch (e) {
    return err(
      "internal",
      `client transport failure: ${e instanceof Error ? e.message : String(e)}`,
    );
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
  const call = (
    method: string,
    path: string,
    body?: unknown,
    vo?: VerbOptions,
    ro?: {
      readonly unwrap?: boolean;
      readonly etag?: boolean;
      readonly cursor?: boolean;
    },
  ): Promise<Result<unknown>> =>
    toResult(
      fetchFn(`${base}${path}`, {
        method,
        headers: {
          ...passthroughHeaders(opts.headers),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
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
      }),
      ro,
    );
  /** Custom operations never consume `If-Match`: their concurrency contract, if any, is declared in the
   * operation input. The typed face already excludes `expectedVersion`; keep an unsafe JS/cast call loud
   * too, rather than letting it look like a CAS request while POST drops the header. */
  const customOpCall = (
    path: string,
    body: unknown,
    vo?: VerbOptions,
  ): Promise<Result<unknown>> => {
    if (vo?.expectedVersion !== undefined) {
      return Promise.resolve(
        err(
          "validation",
          "custom operations do not accept expectedVersion; declare their concurrency input explicitly",
        ),
      );
    }
    return call("POST", path, body, vo, { unwrap: true });
  };
  const resourceProxy = (name: string) => {
    const meta = resources.get(name);
    const rb = routeBase({ name, path: meta?.path });
    return new Proxy({}, {
      get: (_t, verb: string) => {
        if (verb === "list") {
          return (
            q: ListQuery = {},
            o?: { readonly withCursor?: boolean },
          ) => {
            const p = new URLSearchParams();
            if (q.where) p.set("where", JSON.stringify(q.where));
            if (q.limit !== undefined) p.set("limit", String(q.limit));
            if (q.offset !== undefined) p.set("offset", String(q.offset));
            if (q.after !== undefined && q.after !== "") {
              p.set("after", q.after);
            }
            const qs = p.toString();
            return call(
              "GET",
              `${rb}${qs ? `?${qs}` : ""}`,
              undefined,
              undefined,
              { cursor: o?.withCursor === true },
            );
          };
        }
        if (verb === "find") {
          return (
            id: string,
            o?: {
              readonly where?: Record<string, unknown>;
              readonly withEtag?: boolean;
              readonly ifNoneMatch?: string;
            },
          ) => {
            const p = new URLSearchParams();
            if (o?.where) p.set("where", JSON.stringify(o.where));
            const qs = p.toString();
            return call(
              "GET",
              `${rb}/${encodeURIComponent(id)}${qs ? `?${qs}` : ""}`,
              undefined,
              o?.ifNoneMatch !== undefined
                ? { ifNoneMatch: o.ifNoneMatch }
                : undefined,
              { etag: o?.withEtag === true },
            );
          };
        }
        if (verb === "create") {
          // the write answers the version it just wrote; surface it so the next call needs no read
          return (input: unknown) =>
            call("POST", rb, input, undefined, { etag: true });
        }
        if (verb === "update") {
          return (id: string, patch: unknown, vo?: CasOptions) =>
            call("PATCH", `${rb}/${encodeURIComponent(id)}`, patch, vo, {
              etag: true,
            });
        }
        if (verb === "delete") {
          return (id: string, vo?: CasOptions) =>
            call("DELETE", `${rb}/${encodeURIComponent(id)}`, undefined, vo);
        }
        // custom op: `at` from the declaration, not arity — an instance op with no input is
        // `POST /:id/<op>`, never the collection path.
        if (meta?.collectionOps.has(verb)) {
          return (a: unknown, vo?: VerbOptions) =>
            customOpCall(`${rb}/${verb}`, a, vo);
        }
        return (a: unknown, b?: unknown, vo?: VerbOptions) =>
          customOpCall(
            `${rb}/${encodeURIComponent(String(a))}/${verb}`,
            b ?? {},
            vo,
          );
      },
    });
  };
  return new Proxy({}, {
    get: (_t, name: string) => resourceProxy(name),
  }) as HazelnutClient<C>;
}
