import {
  thrownDiagnostic,
  thrownMessage,
  thrownText,
} from "../core/throw-value.ts";
import { declaredUniqueClause } from "../data/pg-error-map.ts";
import {
  fileGrant,
  fileUploadGrant,
  mcpGrantedFileFields,
} from "../features/file-grant.ts";
import { cancelTask, pollTask, taskSubmitter } from "../runtime/tasks.ts";
import { cancelWorkflow, inspectWorkflow } from "../runtime/workflow.ts";
import { wireJson } from "../core/wire-json.ts";
import { crudWriteDenied } from "../authz/auth.ts";
import { validLookupId } from "../core/filter-value.ts";
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
  errorKind,
  ok,
  redactWireError,
  type Result,
  resultError,
} from "../core/pipeline.ts";
import { opSurfaceFactory } from "../data/data.ts";
import { restoreOptionsInput } from "../data/restore-input.ts";
import {
  finishResourceCreate,
  prepareResourceCreate,
  resourceInputSchema,
} from "../data/resource-input.ts";
import { VersionPreconditionError } from "../data/repo-version-token.ts";
import type { Datasources } from "../data/datasources.ts";
import {
  type Db,
  dbFault,
  integrityFault,
  type Transactor,
  withDeadlockRetry,
} from "../data/db.ts";
import {
  countRows,
  create,
  decodeCursor,
  drainFileGc,
  drainReEmbed,
  emptyPatchWouldWrite,
  INLINE_REEMBED_TIMEOUT_MS,
  list,
  type ReadCtx,
  remove,
  restore,
  update,
} from "../data/repo.ts";
import {
  EMPTY_PATCH_MESSAGE,
  IMMUTABLE_FIELD_MESSAGE,
  parsePatch,
  strictify,
  TREE_CYCLE_MESSAGE,
} from "../data/schema.ts";
import type { StorageDriver } from "../data/storage.ts";
import type { EmbeddingProvider } from "../features/embed.ts";
import type { Kms } from "../features/encrypt.ts";
import { egressOp, redactAll, redactionSet } from "../features/redact.ts";
import {
  isBinaryView,
  runFormActorDenied,
  runViewForMcp,
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
  mcpReadSelection,
  mcpResourceModel,
  opIsIdempotent,
  parseToolName,
  projectRead,
  shapeOpValue,
  viewQueryParser,
} from "./mcp-tooldefs.ts";
import {
  countQueryParser,
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
import { loggableError } from "../core/loggable-error.ts";
import {
  observeTransactionRetries,
  ownTransactionRetrySpan,
  transactionRetryAttrs,
} from "../core/transaction-retry-observation.ts";

/** Keep the paging token inside the same positive projection as the rows. A cursor is a serialized sort-key
 *  tuple; when that tuple is hidden, offset continuation stays available but the key itself must not escape. */
function projectCursorEnvelope(
  envelope: ListEnvelope,
  items: Record<string, unknown>[],
): ListEnvelope {
  const { nextCursor, ...page } = envelope;
  const cursorTuple = nextCursor === undefined ? [] : decodeCursor(nextCursor);
  const final = items.at(-1);
  const cursorVisible = nextCursor !== undefined && final !== undefined &&
    cursorTuple.every(([field, value]) => {
      if (!Object.hasOwn(final, field)) return false;
      // The MCP `defineView.shape` may keep a key name but transform its value. A cursor containing the
      // source value would still disclose it, so compare the JSON wire value, not just the property name.
      return JSON.stringify(wireJson(final[field])) === JSON.stringify(value);
    });
  return {
    ...page,
    items,
    ...(cursorVisible ? { nextCursor } : {}),
  };
}

/** Emit the §6 ProvenanceRecord + OTel span for an auto-CRUD write (create/update/delete bypass
 *  `dispatchOp`/`runOp`, so they need their own emission, mirroring `runOp`'s one-record-one-span-per-op).
 *  Fire-and-forget: drained on every path, ok or thrown; `txOutcome` mirrors the tx's actual commit/rollback. */
export async function crudProvenance<T>(
  m: ResourceModel,
  verb: "create" | "update" | "delete" | "restore",
  ctx: ReadCtx & { readonly traceId?: string }, // serve threads the per-request wire id
  origin: ProvenanceOrigin,
  work: () => Promise<T>,
  bulk?: { readonly mode: "atomic" | "continue"; readonly total: number },
): Promise<T> {
  const opName = `${m.name}.${verb}`;
  const startedAt = performance.now();
  // emit one §6 record (committed on a clean return, rolled-back on a throw) — by construction, on every path.
  const drain = (
    outcome: "ok" | "err",
    txOutcome: "committed" | "rolled-back",
    thrown?: unknown,
    counts?: { readonly succeeded: number; readonly failed: number },
  ): void => {
    try {
      const hint = thrown !== null && typeof thrown === "object"
        ? (thrown as { clause?: unknown }).clause
        : undefined;
      const declaredHint = typeof hint === "string" && (m.unique.some((cols) =>
          hint === `${m.name}.unique(${cols.join(", ")})`
        ) ||
          Boolean(
            m.features.scope && m.features.singleton &&
              hint === `${m.name}.unique(scope_key)`,
          ))
        ? hint
        : undefined;
      const clause = declaredUniqueClause(thrown, m) ?? declaredHint;
      getLogSink().drain(assembleProvenance({
        actor: ctx.actor,
        scope: ctx.scope,
        attrs: transactionRetryAttrs(
          bulk
            ? {
              "bulk.mode": bulk.mode,
              "bulk.total": bulk.total,
              "bulk.succeeded": counts?.succeeded ?? 0,
              "bulk.failed": counts?.failed ?? bulk.total,
              "bulk.partial": (counts?.succeeded ?? 0) > 0 &&
                (counts?.failed ?? bulk.total) > 0,
            }
            : {},
        ),
        op: { op: opName, module: m.module, resource: m.name },
        origin,
        outcome,
        ...(outcome === "err"
          ? {
            kind: dbFault(thrown)?.kind ?? errorKind(thrown),
            ...(clause ? { clause } : {}),
            message: `${opName} failed`,
          }
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
  return await observeTransactionRetries(() =>
    withSpan(getTracer(), `op:${opName}`, async (span) => {
      ownTransactionRetrySpan(span);
      try {
        const value = await work();
        if (bulk) {
          const result = value as {
            readonly ok: true;
            readonly value: {
              readonly succeeded: readonly string[];
              readonly failed: readonly {
                readonly error: { readonly kind: string };
              }[];
            };
          };
          const counts = {
            succeeded: result.value.succeeded.length,
            failed: result.value.failed.length,
          };
          drain(
            counts.failed ? "err" : "ok",
            counts.failed && !counts.succeeded ? "rolled-back" : "committed",
            counts.failed ? result.value.failed[0]!.error : undefined,
            counts,
          );
        } else drain("ok", "committed");
        return value;
      } catch (e) {
        drain("err", "rolled-back", e); // the repo tx threw → it rolled back; re-throw unchanged (the caller owns err→status)
        throw e;
      }
    }, {
      ...(ctx.traceId ? { trace_id: ctx.traceId } : {}),
      origin,
      module: m.module,
      resource: m.name,
    })
  );
}

/** Dispatch an MCP tool call (`tools/call`) — resolve `<module>__<resource>__<op>` and run the same path a
 *  REST caller would, so both projections share one error contract: rowPolicy always enforced (§101, never
 *  `all()`), a unique clash is `conflict`, a missing-row update/delete is `notFound`. */
/** A view/`ctx.reads` validation throw (mixed after+offset) must not collapse to `internal`. */
function mcpThrown(e: unknown): Result<never> {
  const fault = integrityFault(e);
  if (fault !== undefined) return err(fault.kind, fault.message);
  const classified = resultError(e);
  if (
    classified.code === "kdf/overloaded" ||
    classified.code === "version/precondition-required" ||
    classified.code?.startsWith("kms/")
  ) return { ok: false, error: classified };
  const kind = errorKind(e);
  if (kind !== "internal") {
    return err(kind, thrownDiagnostic(e));
  }
  return err("internal", thrownText(e));
}

export async function callMcpTool(
  app: App,
  db: Db & Transactor,
  ctx: ReadCtx,
  name: string,
  args: Record<string, unknown>,
  views: readonly ViewDecl[] = app.views ?? [],
  kms?: Kms,
  // the off-box storage driver, threaded so the MCP hard-delete door drains the `_file_gc` job it enqueues
  // (mirrors serve.ts's HTTP-door drain). Bound from `cfg.storage`; absent on a pure stdio call → a no-op
  // (the job stays durable for a later drain).
  storage?: StorageDriver | null,
  // the live external-datasource registry (05-runtime.md §datasources), threaded so a custom op over MCP
  // gets the same `ctx.datasource(name)` surface as HTTP; absent on stdio → `ctx.datasource` throws loud.
  datasources?: Datasources,
  // the embedding seam, threaded so an MCP create drains `_vector_reembed` the same way HTTP POST does
  // (mirrors serve-routes.ts). Bound from `cfg.embed`; absent on a pure stdio call → a no-op (the job
  // stays durable for a later drain).
  embed?: EmbeddingProvider | null,
): Promise<Result<unknown>> {
  const parsed = parseToolName(name);
  // a malformed/stale tool name is the agent picking a wrong or removed tool — steer it to re-fetch (§8).
  if (!parsed) {
    return err(
      "validation",
      `malformed tool name '${name}' — the tool surface may have changed; ${STEER_NEXT_ACTION}`,
    );
  }
  const taskDoor = (parsed.op === "task_poll" || parsed.op === "task_cancel") &&
    (app.tasks ?? []).some((task) =>
      task.name === parsed.resource &&
      (task.module ?? "app") === parsed.module &&
      Boolean(parsed.op === "task_poll" ? task.mcp?.poll : task.mcp?.cancel)
    );
  const workflowDoor =
    (parsed.op === "workflow_inspect" || parsed.op === "workflow_cancel") &&
    (app.workflows ?? []).some((workflow) =>
      workflow.name === parsed.resource &&
      (workflow.module ?? "app") === parsed.module &&
      Boolean(
        parsed.op === "workflow_inspect"
          ? workflow.mcp?.inspect
          : workflow.mcp?.cancel,
      )
    );
  if (taskDoor || workflowDoor) {
    const input = z.object({ id: z.string() }).strict().safeParse(args);
    if (!input.success) {
      return err("validation", "async tool requires exactly an id string");
    }
    const submitter = taskSubmitter(ctx.actor);
    try {
      if (parsed.op === "task_poll" || parsed.op === "task_cancel") {
        const task = (app.tasks ?? []).find((value) =>
          value.name === parsed.resource &&
          (value.module ?? "app") === parsed.module
        );
        if (!task) return err("notFound", "task not found");
        if (parsed.op === "task_cancel") {
          return await cancelTask(
            db,
            input.data.id,
            ctx.scope,
            submitter,
            task.name,
          );
        }
        const status = await pollTask(
          db,
          input.data.id,
          ctx.scope,
          submitter,
          storage ?? undefined,
          task.name,
        );
        if (!status) return err("notFound", "task not found");
        return ok(
          status.error
            ? {
              ...status,
              error: redactWireError({
                kind: errorKind({ kind: status.error.kind }),
                message: status.error.message,
              }),
            }
            : status,
        );
      }
      const workflow = (app.workflows ?? []).find((value) =>
        value.name === parsed.resource &&
        (value.module ?? "app") === parsed.module
      );
      if (!workflow) return err("notFound", "workflow not found");
      return parsed.op === "workflow_inspect"
        ? await inspectWorkflow(
          db,
          input.data.id,
          workflow.name,
          ctx.scope,
          submitter,
        )
        : await cancelWorkflow(
          db,
          input.data.id,
          workflow.name,
          ctx.scope,
          submitter,
        );
    } catch (error) {
      return mcpThrown(error);
    }
  }
  if (
    (parsed.op === "file_grant" || parsed.op === "file_upload_grant") &&
    app.model.some((model) =>
      model.module === parsed.module && model.name === parsed.resource &&
      mcpGrantedFileFields(model).length > 0
    )
  ) {
    const owners = app.model.filter((value) =>
      value.module === parsed.module && value.name === parsed.resource &&
      mcpGrantedFileFields(value).length > 0
    );
    const model = owners.length === 1 ? owners[0] : undefined;
    if (!model || mcpGrantedFileFields(model).length === 0) {
      return err("notFound", "file grant not found");
    }
    const input = z.object({
      id: z.string(),
      field: z.string(),
      ttl: z.number().optional(),
    }).strict().safeParse(args);
    if (!input.success) {
      return err(
        "validation",
        "file grant requires id, field and optional ttl",
      );
    }
    try {
      return await (parsed.op === "file_upload_grant"
        ? fileUploadGrant
        : fileGrant)(
          db,
          model,
          ctx,
          input.data.id,
          input.data.field,
          storage,
          kms,
          input.data.ttl,
          mcpGrantedFileFields(model),
        );
    } catch (error) {
      return mcpThrown(error);
    }
  }
  // §6: a view tool (`<module>__<view>__view`) dispatches before the resource lookup — `parsed.resource` is
  // a view name here, narrowed to `columns`, offset-first pagination + strict query parsing (mcp/strict-input).
  if (parsed.op === VIEW_OP_SEGMENT) {
    // the cross-source run-form view dispatches under the flat `app__<view>__view` FQN — no single `over`,
    // so it resolves first. Same curation gates as the over-form (mcp: + non-binary, dispatchable == advertised).
    const runForm = parsed.module === "app"
      ? views.find((v) =>
        v.name === parsed.resource &&
        (typeof v.run === "function" || v.query !== undefined)
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
      const input = runForm.query
        ? { success: true as const, data: args }
        : strictify(
          runForm.input ?? z.object({}),
        ).safeParse(args);
      if (!input.success) {
        return steerValidation(
          input.error,
          "run-form view input failed validation (the tool's inputSchema is the view's typed filter)",
        );
      }
      try {
        // Run bodies retain their redacted facade; declared queries retain one
        // internal result-row sentinel before this cap. Neither gets invented
        // caller paging or a continuation for arbitrary computations.
        const rows = await runViewForMcp(
          db,
          app,
          runForm,
          ctx,
          input.data,
        ) as Array<Record<string, unknown>>;
        const items = applyShape(rows.slice(0, LIST_LIMIT_MAX), runForm.shape);
        return ok({
          items,
          page: { limit: LIST_LIMIT_MAX, offset: 0, returned: items.length },
          hasMore: rows.length > LIST_LIMIT_MAX,
        });
      } catch (e) {
        if (e instanceof z.ZodError) {
          return steerValidation(
            e,
            "run-form view input failed validation (the tool's inputSchema is the view's typed filter)",
          );
        }
        return mcpThrown(e);
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
      const items = applyShape(redactAll(src, env.items), view.shape);
      return ok(projectCursorEnvelope(env, items));
    } catch (e) {
      return mcpThrown(e);
    }
  }
  const m = mcpResourceModel(app, parsed);
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
    if (
      echoed !== undefined &&
      (typeof echoed !== "number" || !Number.isInteger(echoed))
    ) {
      return err(
        "validation",
        `invalid tool-version echo on '${name}': _toolVersion must be a JSON integer; received ${typeof echoed} ${
          JSON.stringify(echoed)
        }. Keep the current tools/list result and send its value as a number — re-listing cannot fix this type error.`,
      );
    }
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
  // the model's declared/injected rowPolicy (resolveRowPolicy). A missing policy still
  // falls back to all() — that is the public door, not a claim that HTTP and MCP share one resolver.
  const rp = resolveRowPolicy(m);
  try {
    const dispatchName = (parsed.op === "count" || parsed.op === "restore") &&
        Object.hasOwn(m.operations, parsed.op)
      ? "__custom__"
      : parsed.op;
    switch (dispatchName) {
      // read order (12-mcp §101): strict-parse → rowPolicy → read → redact → project → shape → envelope.
      // strict-parse rejects an unknown filter/sort/query key loudly (mcp/strict-input) — never a silent
      // drop; the projection is the HTTP twin's, so the agent door is never the wider one.
      case "list": {
        const q = listQueryParser(m, m.mcp[parsed.op]?.shape).safeParse(args);
        if (!q.success) {
          return steerValidation(
            q.error,
            "list query failed validation (unknown key or out-of-range limit/offset)",
          );
        }
        const env = await listQuery(
          db,
          m,
          ctx,
          rp,
          q.data as ListQuery,
          kms,
          mcpReadSelection(m, "list", m.mcp[parsed.op]?.shape),
        );
        const shape = m.mcp[parsed.op]?.shape;
        const items = projectRead(m, "list", redactAll(m, env.items), shape);
        return ok(projectCursorEnvelope(env, items));
      }
      case "find": {
        // strict envelope parse (mcp/strict-input): reject an unknown/typo'd top-level key loudly instead of
        // silently dropping it. A temporal find also admits its explicit ISO asOf instant.
        const env = z.object({
          id: z.string(),
          ...(m.features.temporal
            ? { asOf: z.iso.datetime({ offset: true }).optional() }
            : {}),
        }).strict().safeParse(args);
        if (!env.success) {
          return steerValidation(env.error, "input failed validation");
        }
        if (!validLookupId(m, env.data.id)) {
          return err("notFound", "resource not found");
        }
        const rows = projectRead(
          m,
          "find",
          redactAll(
            m,
            await list(
              db,
              m,
              ctx,
              rp,
              { id: env.data.id },
              kms,
              undefined,
              typeof env.data.asOf === "string" ? env.data.asOf : undefined,
              mcpReadSelection(m, "find", m.mcp[parsed.op]?.shape),
            ),
          ),
          m.mcp[parsed.op]?.shape,
        );
        if (rows.length === 0) {
          return err("notFound", `no ${m.name} '${env.data.id}'`);
        }
        return ok(rows);
      }
      case "count": {
        const query = countQueryParser(m).safeParse(args);
        if (!query.success) {
          return steerValidation(query.error, "count query failed validation");
        }
        const q = query.data as Pick<ListQuery, "filter" | "asOf" | "search">;
        return ok({
          count: await countRows(
            db,
            m,
            ctx,
            rp,
            q.filter ?? {},
            kms,
            q.asOf,
            q.search,
          ),
        });
      }
      case "restore": {
        if (
          crudWriteDenied(
            ctx.actor,
            m.name,
            "update",
            crudWriteGated(m, "restore"),
          )
        ) return err("forbidden", "policy denied");
        const input = z.object({
          id: z.string(),
          options: restoreOptionsInput(m).optional(),
        }).strict().safeParse(args);
        if (!input.success) {
          return steerValidation(
            input.error,
            "restore input failed validation",
          );
        }
        const restored = await crudProvenance(
          m,
          "restore",
          ctx,
          "mcp",
          () =>
            withDeadlockRetry(() =>
              crudWriteTx(
                db,
                (tx) =>
                  restore(tx, m, ctx, input.data.id, kms, input.data.options),
                ctx.signal,
              )
            ),
        );
        return restored.restored
          ? ok(restored)
          : err("notFound", `${m.name} not found`);
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
        // MCP tracks `current` (multi-version.md): the pin reshapes HTTP routes only, never a tool's input
        const body = args;
        // mcp/strict-input + the agent surface must validate (the repo does not) — reject unknown/bad keys loudly
        const prepared = prepareResourceCreate(m, body, { wire: true });
        if (!prepared.success) {
          return err("validation", "input failed validation");
        }
        // one tx wraps the INSERT + rollup UPDATE + tree-closure + `_audit` INSERT (05-runtime.md
        // §op-pipeline) — a failure after the main write rolls the business row back too.
        const id = await crudProvenance(
          m,
          "create",
          ctx,
          "mcp",
          () =>
            withDeadlockRetry(() =>
              crudWriteTx(
                db,
                async (tx) =>
                  create(
                    tx,
                    m,
                    ctx,
                    await finishResourceCreate(tx, prepared.plan),
                    kms,
                  ),
                ctx.signal,
              )
            ),
        );
        // vector re-embed: same post-commit drain as HTTP POST. Failure must not fail the
        // committed create — swallow + log, the relay owns the durable job.
        if (m.vector && embed) {
          try {
            await drainReEmbed(db, app.model, embed, {
              only: {
                module: m.module,
                resource: m.name,
                id,
                scope: m.features.scope ? ctx.scope : undefined,
              },
              effectTimeoutMs: INLINE_REEMBED_TIMEOUT_MS,
              signal: ctx.signal,
            });
          } catch (e) {
            console.error(
              "[hazelnut] inline re-embed drain after a committed create failed (durable job persists; the standing relay will drain it):",
              loggableError(e),
            );
          }
        }
        return ok({ id });
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
        if (m.features.versioning && args.version === undefined) {
          throw new VersionPreconditionError();
        }
        // strict envelope parse (mcp/strict-input): a typo'd top-level key must never silently no-op as
        // `notFound`. A stamp/bump resource accepts an omitted patch as an explicit touch.
        const patchInput = z.record(z.string(), z.unknown());
        const patchEnvelope = emptyPatchWouldWrite(m)
          ? patchInput.optional()
          : patchInput;
        const envSchema = m.features.versioning
          ? z.object({
            id: z.string(),
            version: z.number().int().nonnegative(),
            patch: patchEnvelope,
          }).strict()
          : z.object({
            id: z.string(),
            patch: patchEnvelope,
          }).strict();
        const env = envSchema.safeParse(args);
        if (!env.success) {
          return steerValidation(
            env.error,
            "input failed validation (envelope) — check for a renamed/typo'd top-level key",
          );
        }
        const patchBody = env.data.patch;
        // parsePatch (schema.ts): strict `.partial()` validation, then only caller-sent keys survive — an
        // absent field's `.default(...)` must not re-stamp the column (nor trip the FSM `status` guard below).
        const patch = parsePatch(
          resourceInputSchema(m, true, true),
          patchBody ?? {},
        );
        if (!patch.success) {
          return steerValidation(patch.error, "patch failed validation");
        }
        if (
          Object.keys(patch.data).length === 0 && !emptyPatchWouldWrite(m)
        ) {
          return err("validation", EMPTY_PATCH_MESSAGE);
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
                ), ctx.signal)
            ),
        );
        // a patch touching a field-level `immutable` frozen field is a conflict (set-once) — ahead of the
        // stale/notFound checks so it surfaces as conflict, never a misleading notFound (04-features.md §immutable).
        if (r.frozen) {
          return err("conflict", IMMUTABLE_FIELD_MESSAGE);
        }
        if (r.stale) {
          return err("stale", "version-CAS lost — re-read and re-apply");
        }
        if (r.cycle) return err("conflict", TREE_CYCLE_MESSAGE);
        if (!r.updated) return err("notFound", `no ${m.name} '${env.data.id}'`);
        if (storage) {
          try {
            await drainFileGc(db, storage);
          } catch (error) {
            console.warn(
              "[hazelnut] post-commit file GC deferred",
              loggableError(error),
            );
          }
        }
        const { stale: _stale, ...ack } = r;
        return ok(ack);
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
        if (m.features.versioning && args.version === undefined) {
          throw new VersionPreconditionError();
        }
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
        const { deleted, stale, version } = await crudProvenance(
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
                ctx.signal,
              )
            ),
        );
        if (stale) {
          return err("stale", "version-CAS lost — re-read and re-apply");
        }
        // a hard-delete enqueues a `_file_gc` job in the (now committed) delete tx — drain it here
        // (post-commit, mirrors serve.ts's HTTP-door drain); `storage` null ⇒ no-op (a stdio call with no driver).
        if (deleted && app.model.some((model) => model.files.length > 0)) {
          try {
            await drainFileGc(db, storage ?? null);
          } catch (e) {
            console.error(
              "[hazelnut] inline file-gc drain after a committed delete failed (durable job persists; the standing relay will drain it):",
              loggableError(e),
            );
          }
        }
        // The delete caller is already authorized for this resource, but it still needs to know whether the
        // successful mutation is reversible. `soft` is declaration-level lifecycle truth, never row data.
        return deleted
          ? ok({
            deleted: true,
            soft: Boolean(m.features.softDelete),
            ...(version !== undefined ? { version } : {}),
          })
          : err("notFound", `no ${m.name} '${env.data.id}'`);
      }
      default:
        if (parsed.op in m.operations) {
          // the reserved idempotency channel — the agent-side twin of the HTTP `Idempotency-Key` header.
          // Only an op that declares `idempotent: true` owns this transport slot; on every other op the same
          // spelling remains ordinary authored input and must reach mcp/strict-input unchanged. Blank is
          // absent, never a claim on the empty key.
          const rawIdem =
            (args as Record<string, unknown>)[IDEMPOTENCY_KEY_ARG];
          let idempotencyKey: string | undefined;
          if (
            opIsIdempotent(parsed.op, m.operations ?? {}) &&
            typeof rawIdem === "string"
          ) {
            const { [IDEMPOTENCY_KEY_ARG]: _peeled, ...rest } = args;
            args = rest;
            idempotencyKey = rawIdem.trim() === "" ? undefined : rawIdem.trim();
          }
          // bind the data/transition/query/modules surface to this op's resource module (05-runtime.md §ctx).
          // An instance op carries its subject `:id` in the tool input → thread `{ resource, id }` so
          // `ctx.transition(to)` binds to it; a collection op (mints the resource) gets no subject. Classify
          // by the SAME combined signal the HTTP surface mounts on — explicit `at:"collection"` OR the
          // structural no-`id`-input fallback — so an explicit collection op whose input legitimately carries
          // `id` (the minted resource's id) is not mis-bound to an instance subject (03-api-shape.md §http-routes).
          const subjectId = (args as Record<string, unknown>).id;
          const subject =
            (!opIsCollection(m, parsed.op) && subjectId !== undefined)
              ? { resource: m.name, id: String(subjectId) }
              : undefined;
          const surface = opSurfaceFactory(
            app,
            ctx,
            m,
            kms,
            subject,
            datasources,
            { storage: storage ?? undefined, signal: ctx.signal },
          )(db);
          // dispatch through the default-deny carrier (app.ts §dispatchOperations) — the same composition the
          // HTTP route consumes, so a policy-omitting MCP-curated op runs deny-by-default, not unauthenticated.
          const r = await dispatchOp(
            { ...m, operations: dispatchOperations(m) },
            parsed.op,
            db,
            ctx,
            args,
            idempotencyKey,
            surface,
            {
              module: m.module,
              resource: m.name,
              origin: "mcp",
              redactedAttrs: redactionSet(m),
              redactionMaskStyle: m.maskStyle,
            },
            true,
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
          if (r.error.kind === "validation") {
            const steered = steerOpaque(r.error.message);
            if (!steered.ok) {
              // Steering changes the safe explanation, not the refusal's framework identity/hints.
              return {
                ok: false,
                error: { ...r.error, message: steered.error.message },
              };
            }
          }
          return r;
        }
        return err("notFound", `no op '${parsed.op}' on '${m.name}'`);
    }
  } catch (e) {
    // mirror REST/pipeline: a database refusal is deterministic (409/400 + DLQ), never retryable internal,
    // and its message is the fixed class copy — never Postgres's text naming a table or a value.
    const fault = dbFault(e);
    if (fault !== undefined) {
      return err(fault.kind, fault.message, {
        clause: declaredUniqueClause(e, m),
      });
    }
    const classified = resultError(e);
    if (
      classified.code === "kdf/overloaded" ||
      classified.code === "transaction/scope-overlap" ||
      classified.code === "version/precondition-required" ||
      classified.code?.startsWith("kms/")
    ) return { ok: false, error: classified };
    const kind = errorKind(e);
    if (kind === "validation" && parsed.op === "create") {
      return steerOpaque(
        thrownMessage(e, "input failed validation"),
      );
    }
    if (kind !== "internal") {
      return err(kind, thrownDiagnostic(e));
    }
    return err("internal", thrownText(e));
  }
}
