import { crudWriteDenied } from "../authz/auth.ts";
import { dispatchOperations, opIsCollection } from "../core/app-refs.ts";
import type { App, ResourceModel } from "../core/app.ts";
import {
  assembleProvenance,
  getLogSink,
  type ProvenanceOrigin,
} from "../core/ctx.ts";
import {
  crudWriteTx,
  dispatchOp,
  err,
  isExclusionViolation,
  isUniqueViolation,
  ok,
  type Result,
} from "../core/pipeline.ts";
import { opSurfaceFactory } from "../data/data.ts";
import type { Datasources } from "../data/datasources.ts";
import { type Db, type Transactor, withDeadlockRetry } from "../data/db.ts";
import {
  create,
  drainFileGc,
  list,
  type ReadCtx,
  remove,
  type RowPolicy,
  update,
} from "../data/repo.ts";
import { parsePatch, strictify } from "../data/schema.ts";
import type { StorageDriver } from "../data/storage.ts";
import type { Kms } from "../features/encrypt.ts";
import { egressOp, redactAll } from "../features/redact.ts";
import { createStatusGuardViolation } from "../features/transition.ts";
import {
  isBinaryView,
  runFormActorDenied,
  runView,
  runViewQuery,
  VIEW_OP_SEGMENT,
  type ViewDecl,
} from "../features/view.ts";
import { getTracer, withSpan } from "../core/tracing.ts";
import { resolveRowPolicy } from "./mcp-resource.ts";
import {
  applyShape,
  crudWriteGated,
  IDEMPOTENCY_KEY_ARG,
  parseToolName,
  projectRead,
  shapeOpValue,
  viewQueryParser,
} from "./mcp-tooldefs.ts";
import {
  LIST_LIMIT_MAX,
  type ListEnvelope,
  type ListQuery,
  listQuery,
  listQueryParser,
  STEER_NEXT_ACTION,
  steerOpaque,
  steerValidation,
} from "./mcp-wire.ts";
import { z } from "zod";

/** Emit the §6 ProvenanceRecord + OTel span for an auto-CRUD write (create/update/delete bypass
 *  `dispatchOp`/`runOp`, so they need their own emission, mirroring `runOp`'s one-record-one-span-per-op).
 *  Fire-and-forget: drained on every path, ok or thrown; `txOutcome` mirrors the tx's actual commit/rollback. */
export async function crudProvenance<T>(
  m: ResourceModel,
  verb: "create" | "update" | "delete",
  ctx: ReadCtx & { readonly traceId?: string }, // serve threads the per-request wire id
  origin: ProvenanceOrigin,
  work: () => Promise<T>,
): Promise<T> {
  const opName = `${m.name}.${verb}`;
  const startedAt = performance.now();
  // emit one §6 record (committed on a clean return, rolled-back on a throw) — by construction, on every path.
  const drain = (
    outcome: "ok" | "err",
    txOutcome: "committed" | "rolled-back",
  ): void => {
    try {
      getLogSink().drain(assembleProvenance({
        actor: ctx.actor,
        scope: ctx.scope,
        attrs: {},
        op: { op: opName, module: m.module, resource: m.name },
        origin,
        outcome,
        ...(outcome === "err"
          ? { kind: "internal" as const, message: `${opName} failed` }
          : {}),
        durationMs: Math.max(0, performance.now() - startedAt),
        txOutcome,
        // the threaded Hazelnut-Trace-Id joins the CRUD record; on a channel that carries none (stdio, a
        // direct call) a fresh id is synthesized so every record still has a correlation key.
        traceId: ctx.traceId ?? crypto.randomUUID(),
        spanId: crypto.randomUUID(),
      }));
    } catch {
      /* fire-and-forget: a broken sink never changes the mutation outcome */
    }
  };
  // one span per op (no-op until a tracer is installed) — the same `op:<name>` shape `dispatchOp` uses, so a
  // CRUD write is visible to a tracer exactly like a custom op.
  return await withSpan(getTracer(), `op:${opName}`, async () => {
    try {
      const value = await work();
      drain("ok", "committed");
      return value;
    } catch (e) {
      drain("err", "rolled-back"); // the repo tx threw → it rolled back; re-throw unchanged (the caller owns err→status)
      throw e;
    }
  });
}

/** Dispatch an MCP tool call (`tools/call`) — resolve `<module>__<resource>__<op>` and run the same path a
 *  REST caller would, so both projections share one error contract: rowPolicy always enforced (§101, never
 *  `all()`), a unique clash is `conflict`, a missing-row update/delete is `notFound`. */
export async function callMcpTool(
  app: App,
  db: Db & Transactor,
  ctx: ReadCtx,
  name: string,
  args: Record<string, unknown>,
  rowPolicies?: Readonly<Record<string, RowPolicy<Record<string, unknown>>>>,
  views: readonly ViewDecl[] = app.views ?? [],
  kms?: Kms,
  // the off-box storage driver, threaded so the MCP hard-delete door drains the `_file_gc` job it enqueues
  // (mirrors serve.ts's HTTP-door drain). Bound from `cfg.storage`; absent on a pure stdio call → a no-op
  // (the job stays durable for a later drain).
  storage?: StorageDriver | null,
  // the live external-datasource registry (05-runtime.md §datasources), threaded so a custom op over MCP
  // gets the same `ctx.datasource(name)` surface as HTTP; absent on stdio → `ctx.datasource` throws loud.
  datasources?: Datasources,
): Promise<Result<unknown>> {
  const parsed = parseToolName(name);
  // a malformed/stale tool name is the agent picking a wrong or removed tool — steer it to re-fetch (§8).
  if (!parsed) {
    return err(
      "validation",
      `malformed tool name '${name}' — the tool surface may have changed; ${STEER_NEXT_ACTION}`,
    );
  }
  // §6: a view tool (`<module>__<view>__view`) dispatches before the resource lookup — `parsed.resource` is
  // a view name here, narrowed to `columns`, offset-first pagination + strict query parsing (mcp/strict-input).
  if (parsed.op === VIEW_OP_SEGMENT) {
    // the cross-source run-form view dispatches under the flat `app__<view>__view` FQN — no single `over`,
    // so it resolves first. Same curation gates as the over-form (mcp: + non-binary, dispatchable == advertised).
    const runForm = parsed.module === "app"
      ? views.find((v) =>
        v.name === parsed.resource && typeof v.run === "function"
      )
      : undefined;
    if (runForm) {
      if (!runForm.mcp || isBinaryView(runForm)) {
        return err(
          "notFound",
          `no view tool '${parsed.resource}' in module '${parsed.module}'`,
        );
      }
      // the run-form view's required rowPolicy decides who may run it (no table for a Where, so a policy
      // returning none() is the deny). Refuse a denied actor with `forbidden` before validating input or running.
      if (runFormActorDenied(runForm, ctx.actor)) {
        return err("forbidden", "policy denied");
      }
      const input = runForm.input ? runForm.input.safeParse(args) : undefined;
      if (input && !input.success) {
        return steerValidation(
          input.error,
          "run-form view input failed validation (the tool's inputSchema is the view's typed filter)",
        );
      }
      try {
        // `runView` threads the sensitive-dropping `crossSourceReads` facade — the run body computes on
        // already-redacted reads (12-mcp §6); output is capped at LIST_LIMIT_MAX with an honest `hasMore`.
        const rows = await runView(
          db,
          app,
          runForm,
          ctx,
          input ? input.data : args,
        ) as Array<Record<string, unknown>>;
        const items = applyShape(rows.slice(0, LIST_LIMIT_MAX), runForm.shape);
        return ok({
          items,
          page: { limit: LIST_LIMIT_MAX, offset: 0, returned: items.length },
          hasMore: rows.length > LIST_LIMIT_MAX,
        });
      } catch (e) {
        return err("internal", String(e));
      }
    }
    const view = views.find((v) =>
      v.name === parsed.resource &&
      app.model.some((m) => m.name === v.over && m.module === parsed.module)
    );
    // §5 curation gate (dispatchable == advertised): dispatch refuses any view `viewToolDefs` would not
    // advertise (no `mcp` projection, or `binary()`) — else it's reachable by name while invisible in `tools/list`.
    if (!view || !view.mcp || isBinaryView(view)) {
      return err(
        "notFound",
        `no view tool '${parsed.resource}' in module '${parsed.module}'`,
      );
    }
    const q = viewQueryParser().safeParse(args);
    if (!q.success) {
      return steerValidation(
        q.error,
        "view query failed validation (unknown key or out-of-range limit/offset)",
      );
    }
    try {
      const env = await runViewQuery(
        db,
        app,
        view,
        ctx,
        q.data as { limit?: number; offset?: number; after?: string },
        LIST_LIMIT_MAX,
      );
      // read order (12-mcp §6): read → sensitive → shape. Redaction runs against the source model so a
      // `sensitive` column is masked before `shape`'s compute/rename can re-introduce it via a rename.
      const src = app.model.find((m) => m.name === view.over)!;
      return ok({
        ...env,
        items: applyShape(redactAll(src, env.items), view.shape),
      });
    } catch (e) {
      return err("internal", String(e));
    }
  }
  const m = app.model.find((x) =>
    x.module === parsed.module && x.name === parsed.resource
  );
  if (!m) {
    return err(
      "notFound",
      `no resource '${parsed.resource}' in module '${parsed.module}'`,
    );
  }
  // §5 curation gate (12-mcp §5 "curated, not co-projected"): dispatchable == advertised. An op not in
  // `m.mcp` is `notFound` here too, else MCP-by-name reaches an unadvertised, authz-uncovered surface.
  if (!(parsed.op in m.mcp)) {
    return err("notFound", `no tool '${parsed.op}' on '${m.name}'`);
  }
  // tool-version echo (12-mcp §tool-versioning): an echo:"required" tool makes every call prove which
  // surface it was generated against — a stale echo fails loud instead of running with rationalized args.
  const versionDecl = m.mcp[parsed.op]!.version;
  if (versionDecl?.echo === "required") {
    const echoed = args["_toolVersion"];
    if (echoed !== versionDecl.v) {
      return err(
        "validation",
        `stale tool-version echo on '${name}': the call carries _toolVersion ${
          JSON.stringify(echoed) ?? "<absent>"
        } but the live tool is v${versionDecl.v} — re-read tools/list and regenerate the call with _toolVersion: ${versionDecl.v}`,
      );
    }
    const { _toolVersion: _echoed, ...rest } = args;
    args = rest; // peel the echo before op input validation (mcp/strict-input rejects unknown keys)
  }
  // the declared/injected rowPolicy — the same resolution serve.ts uses; never the bypassing constant all()
  const rp = resolveRowPolicy(m, rowPolicies);
  try {
    switch (parsed.op) {
      // read order (12-mcp §101): strict-parse → rowPolicy → read → redact → project → shape → envelope.
      // strict-parse rejects an unknown filter/sort/query key loudly (mcp/strict-input) — never a silent
      // drop; the projection is the HTTP twin's, so the agent door is never the wider one.
      case "list": {
        const q = listQueryParser(m).safeParse(args);
        if (!q.success) {
          return steerValidation(
            q.error,
            "list query failed validation (unknown key or out-of-range limit/offset)",
          );
        }
        const env = await listQuery(db, m, ctx, rp, q.data as ListQuery, kms);
        const shape = m.mcp[parsed.op]?.shape;
        return ok(
          {
            ...env,
            items: projectRead(m, "list", redactAll(m, env.items), shape),
          } satisfies ListEnvelope,
        );
      }
      case "find": {
        // strict envelope parse (mcp/strict-input): reject an unknown/typo'd top-level key loudly instead of
        // silently dropping it. `find` takes exactly `{ id }`.
        const env = z.object({ id: z.string() }).strict().safeParse(args);
        if (!env.success) {
          return steerValidation(env.error, "input failed validation");
        }
        return ok(
          projectRead(
            m,
            "find",
            redactAll(m, await list(db, m, ctx, rp, { id: env.data.id }, kms)),
            m.mcp[parsed.op]?.shape,
          ),
        );
      }
      case "create": {
        // op-level default-deny: a curated create tool is gated by the convention-seeded `<r>:create` perm,
        // mirroring the custom-op default — a permless actor is `forbidden` (scope/rowPolicy applied below).
        if (
          crudWriteDenied(
            ctx.actor,
            m.name,
            "create",
            crudWriteGated(m, "create"),
          )
        ) return err("forbidden", "policy denied");
        // mcp/strict-input + the agent surface must validate (the repo does not) — reject unknown/bad keys loudly
        const parsed = strictify(m.schema).safeParse(args);
        if (!parsed.success) {
          return steerValidation(parsed.error, "input failed validation");
        }
        // FSM create guard — the shared rule (04-features.md §transitions; `createStatusGuardViolation`),
        // one home for both projections so the two surfaces cannot drift.
        const fsmErr = createStatusGuardViolation(
          m,
          parsed.data as Record<string, unknown>,
        );
        if (fsmErr) return err("validation", fsmErr);
        // one tx wraps the INSERT + rollup UPDATE + tree-closure + `_audit` INSERT (05-runtime.md
        // §op-pipeline) — a failure after the main write rolls the business row back too.
        return ok({
          id: await crudProvenance(
            m,
            "create",
            ctx,
            "mcp",
            () =>
              withDeadlockRetry(() =>
                crudWriteTx(db, (tx) =>
                  create(
                    tx,
                    m,
                    ctx,
                    parsed.data as Record<string, unknown>,
                    kms,
                  ))
              ),
          ),
        });
      }
      case "update": {
        if (
          crudWriteDenied(
            ctx.actor,
            m.name,
            "update",
            crudWriteGated(m, "update"),
          )
        ) return err("forbidden", "policy denied"); // op-level default-deny
        // strict envelope parse (mcp/strict-input): a typo'd top-level key must never silently no-op as
        // `notFound`. A versioning resource requires `version` (CAS precondition); `patch` is required.
        const envSchema = m.features.versioning
          ? z.object({
            id: z.string(),
            version: z.number().int().nonnegative(),
            patch: z.record(z.string(), z.unknown()),
          }).strict()
          : z.object({
            id: z.string(),
            patch: z.record(z.string(), z.unknown()),
          }).strict();
        const env = envSchema.safeParse(args);
        if (!env.success) {
          return steerValidation(
            env.error,
            "input failed validation (envelope) — check for a renamed/typo'd top-level key",
          );
        }
        // parsePatch (schema.ts): strict `.partial()` validation, then only caller-sent keys survive — an
        // absent field's `.default(...)` must not re-stamp the column (nor trip the FSM `status` guard below).
        const patch = parsePatch(m.schema, env.data.patch);
        if (!patch.success) {
          return steerValidation(patch.error, "patch failed validation");
        }
        // `status` on a `transitions` resource is FSM-controlled, never a raw CRUD update — loud-reject a
        // status-carrying patch (the agent must use the transition tool) rather than silently no-op it.
        if (
          Object.keys(m.transitions).length > 0 &&
          "status" in (patch.data as Record<string, unknown>)
        ) {
          return err(
            "validation",
            "status changes go through the transition tool, not update",
          );
        }
        // optimistic-lock: the expected `version` is the envelope's required field for a versioning
        // resource (the CAS precondition); a non-versioning resource passes undefined (CAS off).
        let expectedVersion: number | undefined;
        if (m.features.versioning) {
          expectedVersion = (env.data as Record<string, unknown>)
            .version as number; // required+validated by the versioning envelope above
        }
        // one tx wraps the UPDATE + its `_audit` INSERT (commit-or-rollback together); `crudProvenance`
        // emits the one §6 record + span the op-pipeline would.
        const r = await crudProvenance(
          m,
          "update",
          ctx,
          "mcp",
          () =>
            withDeadlockRetry(() =>
              crudWriteTx(db, (tx) =>
                update(
                  tx,
                  m,
                  ctx,
                  env.data.id,
                  patch.data as Record<string, unknown>,
                  expectedVersion,
                  kms,
                ))
            ),
        );
        // a patch touching a field-level `immutable` frozen field is a conflict (set-once) — ahead of the
        // stale/notFound checks so it surfaces as conflict, never a misleading notFound (04-features.md §immutable).
        if (r.frozen) {
          return err("conflict", "field is immutable — set-once, never re-set");
        }
        if (r.stale) {
          return err("stale", "version-CAS lost — re-read and re-apply");
        }
        if (!r.updated) return err("notFound", `no ${m.name} '${env.data.id}'`);
        return ok(r);
      }
      case "delete": {
        if (
          crudWriteDenied(
            ctx.actor,
            m.name,
            "delete",
            crudWriteGated(m, "delete"),
          )
        ) return err("forbidden", "policy denied"); // op-level default-deny
        // strict envelope parse + version-CAS on delete: a typo'd top-level key is a loud `validation`; a
        // versioning resource requires the expected `version` so a stale delete is refused, not silently succeeding.
        const envSchema = m.features.versioning
          ? z.object({
            id: z.string(),
            version: z.number().int().nonnegative(),
          }).strict()
          : z.object({ id: z.string() }).strict();
        const env = envSchema.safeParse(args);
        if (!env.success) {
          return steerValidation(env.error, "input failed validation");
        }
        const expectedVersion = m.features.versioning
          ? (env.data as Record<string, unknown>).version as number
          : undefined;
        // one tx wraps the (soft) delete + the rollup decrement + the `_audit` INSERT (commit-or-rollback);
        // `crudProvenance` emits the one §6 record + span the op-pipeline would.
        const { deleted, stale } = await crudProvenance(
          m,
          "delete",
          ctx,
          "mcp",
          () =>
            withDeadlockRetry(() =>
              crudWriteTx(
                db,
                (tx) =>
                  remove(tx, m, ctx, env.data.id, undefined, expectedVersion),
              )
            ),
        );
        if (stale) {
          return err("stale", "version-CAS lost — re-read and re-apply");
        }
        // a hard-delete enqueues a `_file_gc` job in the (now committed) delete tx — drain it here
        // (post-commit, mirrors serve.ts's HTTP-door drain); `storage` null ⇒ no-op (a stdio call with no driver).
        if (deleted && m.files.length > 0) {
          await drainFileGc(db, storage ?? null);
        }
        return deleted
          ? ok({ deleted: true })
          : err("notFound", `no ${m.name} '${env.data.id}'`);
      }
      default:
        if (parsed.op in m.operations) {
          // the reserved idempotency channel — the agent-side twin of the HTTP `Idempotency-Key` header.
          // Peeled here (mcp/strict-input rejects unknown keys at validate) and threaded into the pipeline's
          // claim, so `defineOp({ idempotent: true })` is armed over MCP exactly as it is over HTTP; blank
          // is absent, never a claim on the empty key.
          const rawIdem =
            (args as Record<string, unknown>)[IDEMPOTENCY_KEY_ARG];
          let idempotencyKey: string | undefined;
          if (typeof rawIdem === "string") {
            const { [IDEMPOTENCY_KEY_ARG]: _peeled, ...rest } = args;
            args = rest;
            idempotencyKey = rawIdem.trim() === "" ? undefined : rawIdem.trim();
          }
          // bind the data/transition/query/modules surface to this op's resource module (05-runtime.md §ctx).
          // An instance op carries its subject `:id` in the tool input → thread `{ resource, id }` so
          // `ctx.transition(to)` binds to it; a collection op (mints the resource) gets no subject. Classify
          // by the SAME combined signal the HTTP surface mounts on — explicit `at:"collection"` OR the
          // structural no-`id`-input fallback — so an explicit collection op whose input legitimately carries
          // `id` (the minted resource's id) is not mis-bound to an instance subject (03-api-shape.md §3).
          const subjectId = (args as Record<string, unknown>).id;
          const subject =
            (!opIsCollection(m, parsed.op) && subjectId !== undefined)
              ? { resource: m.name, id: String(subjectId) }
              : undefined;
          const surface = opSurfaceFactory(
            app,
            ctx,
            m.module,
            kms,
            subject,
            datasources,
          )(db);
          // dispatch through the default-deny carrier (app.ts §dispatchOperations) — the same composition the
          // HTTP route consumes, so a policy-omitting MCP-curated op runs deny-by-default, not unauthenticated.
          const r = await dispatchOp(
            { operations: dispatchOperations(m) },
            parsed.op,
            db,
            ctx,
            args,
            idempotencyKey,
            surface,
            { module: m.module, resource: m.name, origin: "mcp" },
          );
          if (r.ok) {
            // the op door's chokepoint (12-mcp §6: mask) — `sensitive` masked, and every framework-minted
            // column no read route projects dropped, over the WHOLE app because a handler reaches every
            // resource; the advertised `shape` applies inside it (over-fetch closed, 12-mcp §5).
            return ok(
              shapeOpValue(
                egressOp(app.model, r.value, { mask: true }),
                m.mcp[parsed.op]?.shape,
              ),
            );
          }
          // a custom op's strict-input failure reaches the agent as a `validation` err without the ZodError
          // here — re-encode it with the steer next-action so a stale arg carries "re-fetch and retry" (§8).
          return r.error.kind === "validation"
            ? steerOpaque(r.error.message)
            : r;
        }
        return err("notFound", `no op '${parsed.op}' on '${m.name}'`);
    }
  } catch (e) {
    // mirror REST/pipeline: a unique clash is a deterministic conflict (409 + DLQ), not retryable internal (500 + retry)
    if (isUniqueViolation(e)) {
      return err("conflict", "unique constraint violated");
    }
    if (isExclusionViolation(e)) {
      return err("conflict", "validity windows overlap (temporal noOverlap)");
    }
    return err("internal", String(e));
  }
}
