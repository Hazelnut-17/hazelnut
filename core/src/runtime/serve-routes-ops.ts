// serve.ts custom-op route registration — the resource's declared `operations` HTTP surface.
import type { ResourceModel } from "../core/app.ts";
import { CRUD_VERB_SET as CRUD_VERBS } from "../authz/auth.ts";
import {
  dispatchOperations,
  httpPolicyMode,
  isExternalRoute,
  opIsCollection,
  routeAuthnDeferred,
} from "../core/app-refs.ts";
import type { HttpRoute } from "../core/app.ts";
import { dispatchOp, httpStatus, redactWireError } from "../core/pipeline.ts";
import { opSurfaceFactory } from "../data/data.ts";
import type { Transactor } from "../data/db.ts";
import type { ReadCtx } from "../data/repo.ts";
import { egressOp } from "../features/redact.ts";
import { validationDetail, validationIssues } from "../core/validation.ts";
import { strictify } from "../data/schema.ts";
import { jsonBodyErrorMessage, parseJsonBody } from "./serve-json.ts";
import {
  type AuthVars,
  type HttpRow,
  idempotencyKeyOf,
  routeBase,
  type ServeConfig,
} from "./serve-helpers.ts";
import type { z } from "zod";
import type { Hono } from "hono";
import type { RouteCtx } from "./serve-routes.ts";

export function registerResourceOps(
  router: Hono<{ Variables: AuthVars }>,
  m: ResourceModel,
  rctx: RouteCtx,
): void {
  const { cfg, ctxOf, deferAuthn, lateCtxOf } = rctx;
  const base = routeBase(m);
  const dispatchOps = dispatchOperations(m);
  for (const op of Object.keys(m.http)) {
    if (CRUD_VERBS.has(op) || !(op in m.operations)) continue; // skip CRUD verbs and any non-op `http` key
    // collection detection (03-api-shape.md §3): `http:{ <op>:{ at:"collection" } }` is the canonical signal;
    // the structural `input`-has-no-`id` fallback catches a collection op that omits it.
    const collection = opIsCollection(m, op);
    // external edge (03-api-shape.md §3): an upstream gateway/IdP already authorized the caller, so the
    // deny-by-default op-policy gate is skipped — ONLY that gate; rowPolicy/scope still apply.
    const external = isExternalRoute(m.http[op] as HttpRoute);
    // `http:"public"` (03-api-shape.md §custom-op-binding) is an explicit opt-out of the op-policy gate,
    // including the injected default — the MCP surface keeps its own gate on the same op regardless.
    const publicRoute = httpPolicyMode(m.http[op] as HttpRoute) === "public";
    // `external` and `public` are NOT the same relaxation, and collapsing them is what broke this.
    // `external:true` means an upstream gateway already authorized the caller, so it skips the gate outright,
    // declared policy included (an always-deny op still skips that one gate).
    // `public` only means NO PERMISSION IS REQUIRED — so it strips the INJECTED deny-by-default and never an
    // author-declared `policy`. A declared policy is not
    // always an authz gate: `passwordLogin` bills the per-identifier brute-force throttle from it, because the
    // policy step is the pipeline's only PRE-TX step. Stripping it on `http:"public"` — the shape the login
    // recipe documents — made that throttle dead on the served route while its own unit tests, which call
    // `.handler` directly, stayed green. `effectiveOpPolicy` already puts a declared policy ahead of the
    // default, and a public-only op is not policy-exposed, so there is no default to strip in that case.
    const declaredPolicy =
      (m.operations[op] as { readonly policy?: unknown } | undefined)?.policy;
    const carrier = external || (publicRoute && declaredPolicy == null)
      ? {
        operations: {
          ...dispatchOps,
          [op]: { ...(dispatchOps[op] as object), policy: undefined },
        },
      }
      : { operations: dispatchOps };
    // one dispatch core, parameterized on whether a path `:id` is merged in. An instance op's path `:id`
    // is authoritative — merged over the body so a mismatched body `id` can never re-target it; a collection
    // op dispatches the raw body. `dispatchOp` strict-parses against `op.input`, shared with MCP.
    const runOpRoute = async (
      ctx: ReadCtx,
      raw: HttpRow,
      idempotencyKey?: string,
    ) => {
      const db = cfg.db as ServeConfig["db"] & Transactor;
      // bind the data/transition/query/modules surface to this op's resource module (05-runtime.md §ctx);
      // the pipeline rebinds data/transition/query to the op's own tx at build-ctx time.
      // an instance op's authoritative subject is `{ this resource, the route :id }`, so `ctx.transition(to)`
      // binds to the auth-gated route row (no confused-deputy); a collection op mints, so has no subject.
      const subject = collection
        ? undefined
        : { resource: m.name, id: String(raw.id) };
      const surface = opSurfaceFactory(
        cfg.app,
        ctx,
        m.module,
        cfg.kms,
        subject,
        cfg.datasources,
      )(db);
      // the `Idempotency-Key` header (03-api-shape.md §HTTP contract) is load-bearing ONLY for an op
      // declaring `idempotent:true`; a key on a non-idempotent op is inert, and an idempotent op with no
      // header runs un-deduped.
      // thread the §6 provenance descriptor (05-runtime.md §6): the op's owning module/resource + HTTP
      // origin, so a custom-op record self-identifies like every other op (CRUD threads it via `crudProvenance`).
      const r = await dispatchOp(
        carrier,
        op,
        db,
        ctx,
        raw,
        idempotencyKey,
        surface,
        { module: m.module, resource: m.name, origin: "http" },
      );
      // the op door's chokepoint — `sensitive` plus every framework-minted column no read route projects,
      // over the WHOLE app: a handler reaches every resource, so `m`'s own sets are not the exposure.
      return r.ok
        ? {
          body: { result: egressOp(cfg.app.model, r.value) } as const,
          status: 200 as const,
        }
        : {
          body: { error: redactWireError(r.error) },
          status: httpStatus(r.error.kind),
        };
    };
    // validate-first flip (05-runtime.md §op-pipeline authn ordering; `authnFirst:false`): the op's strict
    // input parse runs before the resolver chain, so a malformed body 400s with zero authn round-trips;
    // `lateCtxOf` resolves after, same fail-closed 503. The pipeline still re-validates on dispatch.
    // op-level deprecation wire encoding (03-api-shape.md §9): `{deprecated?, sunset?, replacedBy?}` emits
    // RFC 9745 `Deprecation` + RFC 8594 `Sunset` (+ `Link rel="successor-version"`), mirroring serve.ts.
    const dep = m.operations[op] as {
      deprecated?: string;
      sunset?: string;
      replacedBy?: string;
    };
    const setDeprecation = (c: { res: { headers: Headers } }): void => {
      if (dep.deprecated) {
        c.res.headers.set(
          "Deprecation",
          `@${Math.floor(new Date(dep.deprecated).getTime() / 1000)}`,
        );
      }
      if (dep.sunset) {
        c.res.headers.set("Sunset", new Date(dep.sunset).toUTCString());
      }
      if (dep.replacedBy) {
        c.res.headers.append(
          "Link",
          `<${base}/${dep.replacedBy}>; rel="successor-version"`,
        );
      }
    };
    const deferred = routeAuthnDeferred(m.http[op] as HttpRoute);
    const opInput = (m.operations[op] as { input?: z.ZodType } | undefined)
      ?.input;
    const earlyParse = (
      payload: HttpRow,
    ): { ok: true } | { ok: false; body: unknown } => {
      if (!opInput) return { ok: true }; // no declared input → nothing to fail-fast against
      const parsed = strictify(opInput).safeParse(payload);
      if (parsed.success) return { ok: true };
      return {
        ok: false,
        body: {
          error: {
            kind: "validation",
            message: validationDetail("input failed validation", parsed.error),
          },
          issues: validationIssues(parsed.error),
        },
      };
    };
    if (collection) {
      if (deferred) deferAuthn("POST", `${base}/${op}`);
      router.post(`${base}/${op}`, async (c) => {
        const parsed = await parseJsonBody(c);
        if (!parsed.ok) {
          return c.json({
            error: "validation",
            message: jsonBodyErrorMessage(parsed.reason),
          }, 400); // a garbled body 400s, never runs the op on non-JSON
        }
        const body = parsed.value as HttpRow;
        let ctx: ReadCtx;
        if (deferred) {
          const early = earlyParse(body);
          if (!early.ok) {
            return c.json(early.body as Record<string, unknown>, 400);
          }
          const late = await lateCtxOf(c);
          if (late instanceof Response) return late;
          ctx = late;
        } else ctx = ctxOf(c);
        const { body: out, status } = await runOpRoute(
          ctx,
          body,
          idempotencyKeyOf(c),
        );
        const res = c.json(out, status); // collection op: no `:id` — the body IS the mint input
        setDeprecation(c);
        return res;
      });
    } else {
      if (deferred) deferAuthn("POST", `${base}/:id/${op}`);
      router.post(`${base}/:id/${op}`, async (c) => {
        const parsed = await parseJsonBody(c);
        if (!parsed.ok) {
          return c.json({
            error: "validation",
            message: jsonBodyErrorMessage(parsed.reason),
          }, 400);
        }
        const body = parsed.value as HttpRow;
        const merged = { ...body, id: c.req.param("id") };
        let ctx: ReadCtx;
        if (deferred) {
          const early = earlyParse(merged);
          if (!early.ok) {
            return c.json(early.body as Record<string, unknown>, 400);
          }
          const late = await lateCtxOf(c);
          if (late instanceof Response) return late;
          ctx = late;
        } else ctx = ctxOf(c);
        const { body: out, status } = await runOpRoute(
          ctx,
          merged,
          idempotencyKeyOf(c),
        );
        const res = c.json(out, status); // instance op: the path `:id` is authoritative over the body
        setDeprecation(c);
        return res;
      });
    }
  }
}
