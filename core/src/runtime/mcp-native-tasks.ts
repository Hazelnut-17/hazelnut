import { can, isAnonymous } from "../authz/auth.ts";
import type { App } from "../core/app.ts";
import { errorKind, redactWireError } from "../core/result.ts";
import { type Db, withDeadlockRetry } from "../data/db.ts";
import type { ReadCtx } from "../data/repo.ts";
import type { StorageDriver } from "../data/storage.ts";
import {
  nativeTaskMarkerKey,
  type NativeTaskReceipt,
  nativeTaskSubject,
} from "./native-task-receipt.ts";
import { parseToolName } from "../mcp/mcp-tooldefs.ts";
import { toolCallError, toolCallOk } from "../mcp/mcp-wire.ts";
import { z } from "zod";
import {
  cancelTask,
  pollTask,
  submitBoundTask,
  taskSubmitter,
} from "./tasks.ts";

const lifetime = 7 * 24 * 60 * 60 * 1000;
const unavailable = () => ({
  error: { code: -32602, message: "task not found" },
});

export function nativeTaskForTool(app: App, name: string) {
  const p = parseToolName(name);
  if (p?.op !== "task_execute") return undefined;
  return (app.tasks ?? []).find((t) =>
    t.name === p.resource &&
    (t.module ?? "app") === p.module && t.mcp?.submit && t.mcp.poll &&
    t.mcp.cancel
  );
}

export async function nativeTaskSubmit(
  app: App,
  db: Db,
  ctx: ReadCtx,
  name: string,
  args: unknown,
  storage?: StorageDriver | null,
) {
  const task = nativeTaskForTool(app, name);
  if (!task?.mcp?.submit || !can(ctx.actor, task.mcp.submit.gate)) {
    return {
      result: toolCallError({
        kind: "notFound",
        message: "task tool not found",
      }),
    };
  }
  const input = z.strictObject({
    input: z.unknown(),
    _idempotencyKey: z.string().trim().min(1),
  }).safeParse(args);
  if (
    !input.success || !args || typeof args !== "object" ||
    !Object.hasOwn(args, "input")
  ) {
    return {
      result: toolCallError({
        kind: "validation",
        message: "task execution requires input and a nonblank idempotency key",
      }),
    };
  }
  const submitted = await withDeadlockRetry(() =>
    submitBoundTask(
      app,
      db,
      task,
      ctx,
      input.data.input,
      JSON.stringify([
        ctx.actor?.onBehalfOf ?? null,
        input.data._idempotencyKey,
      ]),
      "mcp-native-task",
    )
  );
  if (!submitted.ok) return { result: toolCallError(submitted.error) };
  const id = submitted.value.taskId;
  return await nativeTaskRequest(
    app,
    db,
    ctx,
    "tasks/get",
    id,
    storage,
    true,
  );
}

export async function nativeTaskRequest(
  app: App,
  db: Db,
  ctx: ReadCtx,
  method: string,
  id: unknown,
  storage?: StorageDriver | null,
  creating = false,
) {
  if (
    isAnonymous(ctx.actor) || typeof id !== "string" ||
    !z.uuid().safeParse(id).success
  ) return unavailable();
  const row = (await db.query<{ metadata: string; created: string }>(
    `SELECT i.result::text AS metadata, t.created_at::text AS created
     FROM "_idempotency" i JOIN "_tasks" t ON t.id=$2
     WHERE i.key=$1 AND i.result IS NOT NULL AND i.created_at > now()-interval '7 days'
       AND t.created_at > now()-interval '7 days' AND t.scope_key=$3 AND t.submitter=$4`,
    [nativeTaskMarkerKey(id), id, ctx.scope, taskSubmitter(ctx.actor)],
  )).rows[0];
  if (!row) return unavailable();
  let mark: NativeTaskReceipt;
  try {
    mark = JSON.parse(row.metadata);
  } catch {
    return unavailable();
  }
  if (mark.subject !== nativeTaskSubject(ctx.actor, ctx.scope)) {
    return unavailable();
  }
  const task = (app.tasks ?? []).find((t) =>
    t.name === mark.name && (t.module ?? "app") === mark.module &&
    t.mcp?.submit && t.mcp.poll && t.mcp.cancel
  );
  if (!task?.mcp?.submit || !can(ctx.actor, task.mcp.submit.gate)) {
    return unavailable();
  }
  if (method === "tasks/update") return { result: { resultType: "complete" } };
  if (method === "tasks/cancel") {
    if (mark.terminalError) return { result: { resultType: "complete" } };
    const cancelled = await cancelTask(
      db,
      id,
      ctx.scope,
      taskSubmitter(ctx.actor),
      task.name,
      nativeTaskMarkerKey(id),
    );
    return cancelled.ok
      ? { result: { resultType: "complete" } }
      : unavailable();
  }
  const observed = await pollTask(
    db,
    id,
    ctx.scope,
    taskSubmitter(ctx.actor),
    storage ?? undefined,
    task.name,
    nativeTaskMarkerKey(id),
  );
  if (!observed?.nativeUpdatedAt) return unavailable();
  const state = observed.status === "succeeded" || observed.status === "failed"
    ? "completed"
    : observed.status === "cancelled"
    ? "cancelled"
    : "working";
  const data = {
    resultType: creating ? "task" : "complete",
    taskId: id,
    status: state,
    createdAt: new Date(row.created).toISOString(),
    lastUpdatedAt: new Date(observed.nativeUpdatedAt).toISOString(),
    ttlMs: lifetime,
    pollIntervalMs: 1000,
    ...(observed.message ? { statusMessage: observed.message } : {}),
    ...(state === "completed"
      ? {
        result: {
          ...(observed.status === "failed"
            ? toolCallError(
              redactWireError({
                kind: errorKind({ kind: observed.error?.kind }),
                message: observed.error?.message ?? "task failed",
              }),
            )
            : toolCallOk(
              observed.resultUrl
                ? { resultUrl: observed.resultUrl }
                : { result: observed.result },
            )),
          resultType: "complete",
        },
      }
      : {}),
  };
  return { result: data };
}
