// hazelnutClient — a typed fetch client derived from the live config value, zero codegen.
// Speaks the framework's Result<T> error vocabulary and reproduces server wire conventions (routeBase,
// pagination) from the same sources the server uses. Design:
import type { z } from "zod";
import type { ErrKind, OpDecl, Result } from "../core/pipeline.ts";
import { err, ERR_KINDS, ok } from "../core/pipeline.ts";
import type { ResourceDecl } from "../core/app-types.ts";
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
}

type OpFn<H, O> = O extends OpDecl<infer In, infer Out>
  ? H extends { readonly at: "collection" }
    ? (input: In) => Promise<Result<Out>>
  : (id: string, input: In) => Promise<Result<Out>>
  : never;

type ResourceClient<D extends ResourceDecl> =
  & (D extends { readonly http: { readonly list: unknown } }
    ? { list(q?: ListQuery): Promise<Result<RowOf<D>[]>> }
    : unknown)
  & (D extends { readonly http: { readonly find: unknown } }
    ? { find(id: string): Promise<Result<RowOf<D>>> }
    : unknown)
  & (D extends { readonly http: { readonly create: unknown } }
    ? { create(input: InsertOf<D>): Promise<Result<RowOf<D>>> }
    : unknown)
  & (D extends { readonly http: { readonly update: unknown } } ? {
      update(
        id: string,
        patch: Partial<InsertOf<D>>,
      ): Promise<Result<RowOf<D>>>;
    }
    : unknown)
  & (D extends { readonly http: { readonly delete: unknown } }
    ? { delete(id: string): Promise<Result<unknown>> }
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
  readonly fetchFn?: typeof fetch; // inject a router-backed fetch in tests; defaults to global fetch
}

const KINDS: ReadonlySet<string> = new Set(ERR_KINDS);

/** Collect name → path from a flat or modular config so the proxy can call the same routeBase as serve. */
function pathByName(config: unknown): ReadonlyMap<string, string | undefined> {
  const out = new Map<string, string | undefined>();
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
  for (const r of c.resources ?? []) out.set(r.name, r.path);
  for (const m of c.modules ?? []) {
    for (const r of m.resources ?? []) out.set(r.name, r.path);
  }
  return out;
}

async function toResult(resP: Promise<Response>): Promise<Result<unknown>> {
  try {
    const res = await resP;
    const text = await res.text();
    const body = text === "" ? undefined : (() => {
      try {
        return JSON.parse(text);
      } catch {
        return undefined;
      }
    })();
    if (res.ok) return ok(body);
    // the served error envelope is `{ error: <err.kind>, message? }` — map onto the closed union; anything
    // outside it (proxy pages, transport noise) collapses to `internal`, never an invented kind.
    const kind = typeof (body as { error?: unknown })?.error === "string" &&
        KINDS.has((body as { error: string }).error)
      ? (body as { error: string }).error as ErrKind
      : "internal";
    const message = (body as { message?: string })?.message ??
      `HTTP ${res.status}`;
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
  const paths = pathByName(config);
  const call = (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Result<unknown>> =>
    toResult(fetchFn(`${base}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...opts.headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }));
  const resourceProxy = (name: string) => {
    const rb = routeBase({ name, path: paths.get(name) });
    return new Proxy({}, {
      get: (_t, verb: string) => {
        if (verb === "list") {
          return (q: ListQuery = {}) => {
            const p = new URLSearchParams();
            if (q.where) p.set("where", JSON.stringify(q.where));
            if (q.limit !== undefined) p.set("limit", String(q.limit));
            if (q.offset !== undefined) p.set("offset", String(q.offset));
            const qs = p.toString();
            return call("GET", `${rb}${qs ? `?${qs}` : ""}`);
          };
        }
        if (verb === "find") {
          return (id: string) => call("GET", `${rb}/${encodeURIComponent(id)}`);
        }
        if (verb === "create") {
          return (input: unknown) => call("POST", rb, input);
        }
        if (verb === "update") {
          return (id: string, patch: unknown) =>
            call("PATCH", `${rb}/${encodeURIComponent(id)}`, patch);
        }
        if (verb === "delete") {
          return (id: string) =>
            call("DELETE", `${rb}/${encodeURIComponent(id)}`);
        }
        // custom op: collection form takes (input); instance form takes (id, input) — disambiguated by arity
        return (a: unknown, b?: unknown) =>
          b === undefined
            ? call("POST", `${rb}/${verb}`, a)
            : call("POST", `${rb}/${encodeURIComponent(String(a))}/${verb}`, b);
      },
    });
  };
  return new Proxy({}, {
    get: (_t, name: string) => resourceProxy(name),
  }) as HazelnutClient<C>;
}
