// hazelnutClient — a typed fetch client derived from the live config value, zero codegen. Speaks the
// framework's Result<T> error vocabulary and reproduces server wire conventions (routeBase,
// pagination) from the same sources the server uses.
import type { z } from "zod";
import type { ErrKind, OpDecl, Result } from "../core/pipeline.ts";
import { err, ERR_KINDS, ok } from "../core/pipeline.ts";
import type { ResourceDecl } from "../core/app-types.ts";
import { opIsCollection } from "../core/app-refs.ts";
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

type RowOf<D extends ResourceDecl> = D extends
  { readonly schema: infer S extends z.ZodType }
  ? z.output<S> & { readonly id: string }
  : never;
type InsertOf<D extends ResourceDecl> = D extends
  { readonly schema: infer S extends z.ZodType } ? z.input<S> : never;

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

type OpFn<H, O> = O extends OpDecl<infer In, infer Out>
  ? IsCollectionOp<H, In> extends true ? (input: In) => Promise<Result<Out>>
  : (id: string, input: In) => Promise<Result<Out>>
  : never;

/** CAS `If-Match` for a versioned update/delete (03-api-shape.md §HTTP contract). */
export interface CasOptions {
  readonly expectedVersion?: number | string;
}

/** Runtime extras the proxy still forwards on a custom-op call (`If-Match`, `Idempotency-Key`).
 *  The typed `OpFn` does not take this object — a typed idempotency argument is a later face.
 *  CRUD create never sends these headers (serve 400s `Idempotency-Key` on POST create). */
export interface VerbOptions extends CasOptions {
  readonly idempotencyKey?: string;
  readonly ifNoneMatch?: string;
}

type ResourceClient<D extends ResourceDecl> =
  & (D extends { readonly http: { readonly list: unknown } } ? {
      list(
        q?: ListQuery,
        opts?: { readonly withCursor?: boolean },
      ): Promise<Result<RowOf<D>[] & { readonly nextCursor?: string }>>;
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
          | (RowOf<D> & { readonly etag?: string })
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
      ): Promise<Result<RowOf<D> & { readonly etag?: string }>>;
    }
    : unknown)
  & (D extends { readonly http: { readonly create: unknown } } ? {
      // the wire create returns the id envelope, not the row (03-api-shape.md §wire-projection)
      create(
        input: InsertOf<D>,
      ): Promise<Result<{ readonly id: string }>>;
    }
    : unknown)
  & (D extends { readonly http: { readonly update: unknown } } ? {
      update(
        id: string,
        patch: Partial<InsertOf<D>>,
        opts?: CasOptions,
      ): Promise<Result<{ readonly updated: boolean }>>;
    }
    : unknown)
  & (D extends { readonly http: { readonly delete: unknown } } ? {
      // delete is 204-no-body on success; the Result value is void
      delete(
        id: string,
        opts?: CasOptions,
      ): Promise<Result<void>>;
    }
    : unknown)
  & (D extends { readonly operations: infer Ops; readonly http: infer H } ? {
      readonly [K in keyof Ops & keyof H & string]: OpFn<H[K], Ops[K]>;
    }
    : unknown);

/** The whole typed surface: one member per declared resource, verbs filtered to the `http:`-exposed set. */
export type HazelnutClient<C> = {
  readonly [K in ClientDecls<C>["name"] & string]: ResourceClient<
    Extract<ClientDecls<C>, { readonly name: K }>
  >;
};

// ── runtime (the thin proxy) ───────────────────────────────────────────────────────────────────────
export interface ClientOptions {
  readonly headers?: Readonly<Record<string, string>>;
  /** Defaults to global `fetch`. This is `fetch(url, init)`, NOT the served app's `(Request) => Response`:
   *  passing `app.fetch` directly throws inside the router. Wrap it —
   *  `fetchFn: (input, init) => app.fetch(new Request(input, init))`. */
  readonly fetchFn?: typeof fetch;
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
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(vo?.expectedVersion !== undefined
            ? { "If-Match": `"${String(vo.expectedVersion)}"` }
            : {}),
          ...(vo?.idempotencyKey !== undefined
            ? { "Idempotency-Key": vo.idempotencyKey }
            : {}),
          ...(vo?.ifNoneMatch !== undefined
            ? { "If-None-Match": vo.ifNoneMatch }
            : {}),
          ...opts.headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
      ro,
    );
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
          return (input: unknown) => call("POST", rb, input);
        }
        if (verb === "update") {
          return (id: string, patch: unknown, vo?: CasOptions) =>
            call("PATCH", `${rb}/${encodeURIComponent(id)}`, patch, vo);
        }
        if (verb === "delete") {
          return (id: string, vo?: CasOptions) =>
            call("DELETE", `${rb}/${encodeURIComponent(id)}`, undefined, vo);
        }
        // custom op: `at` from the declaration, not arity — an instance op with no input is
        // `POST /:id/<op>`, never the collection path.
        if (meta?.collectionOps.has(verb)) {
          return (a: unknown, vo?: VerbOptions) =>
            call("POST", `${rb}/${verb}`, a, vo, { unwrap: true });
        }
        return (a: unknown, b?: unknown, vo?: VerbOptions) =>
          call(
            "POST",
            `${rb}/${encodeURIComponent(String(a))}/${verb}`,
            b ?? {},
            vo,
            { unwrap: true },
          );
      },
    });
  };
  return new Proxy({}, {
    get: (_t, name: string) => resourceProxy(name),
  }) as HazelnutClient<C>;
}
