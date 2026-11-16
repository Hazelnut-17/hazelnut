import { can, isAnonymous } from "../authz/auth.ts";
import type { App } from "../core/app.ts";
import { errorKind, redactWireError } from "../core/result.ts";
import { type Db, withDeadlockRetry } from "../data/db.ts";
import type { ReadCtx } from "../data/repo.ts";
import type { StorageDriver } from "../data/storage.ts";
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
const markerKey = (id: string) => JSON.stringify(["mcp-native-task", id]);
const subject = (ctx: ReadCtx) =>
  JSON.stringify([
    ctx.actor?.type,
    ctx.actor?.id,
    ctx.actor?.onBehalfOf ?? null,
    ctx.scope,
  ]);
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
  await db.query(
    `INSERT INTO "_idempotency" (key,result) VALUES ($1,$2::text::jsonb) ON CONFLICT (key) DO NOTHING`,
    [
      markerKey(id),
      JSON.stringify({
        subject: subject(ctx),
        name: task.name,
        module: task.module ?? "app",
      }),
    ],
  );
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
  const row =
    (await db.query<{ metadata: string; created: string; updated: string }>(
      `SELECT i.result::text AS metadata, t.created_at::text AS created,
       GREATEST(t.updated_at, COALESCE(p.updated_at,t.updated_at))::text AS updated
     FROM "_idempotency" i JOIN "_tasks" t ON t.id=$2
     LEFT JOIN "_task_progress" p ON p.task_id=t.id
     WHERE i.key=$1 AND i.result IS NOT NULL AND i.created_at > now()-interval '7 days'
       AND t.created_at > now()-interval '7 days' AND t.scope_key=$3 AND t.submitter=$4`,
      [markerKey(id), id, ctx.scope, taskSubmitter(ctx.actor)],
    )).rows[0];
  if (!row) return unavailable();
  let mark: { subject?: string; name?: string; module?: string };
  try {
    mark = JSON.parse(row.metadata);
  } catch {
    return unavailable();
  }
  if (mark.subject !== subject(ctx)) return unavailable();
  const task = (app.tasks ?? []).find((t) =>
    t.name === mark.name && (t.module ?? "app") === mark.module &&
    t.mcp?.submit && t.mcp.poll && t.mcp.cancel
  );
  if (!task?.mcp?.submit || !can(ctx.actor, task.mcp.submit.gate)) {
    return unavailable();
  }
  if (method === "tasks/update") return { result: { resultType: "complete" } };
  if (method === "tasks/cancel") {
    const cancelled = await cancelTask(
      db,
      id,
      ctx.scope,
      taskSubmitter(ctx.actor),
      task.name,
    );
    return cancelled.ok
      ? { result: { resultType: "complete" } }
      : unavailable();
  }
  const status = await pollTask(
    db,
    id,
    ctx.scope,
    taskSubmitter(ctx.actor),
    storage ?? undefined,
    task.name,
  );
  if (!status) return unavailable();
  const state = status.status === "succeeded" || status.status === "failed"
    ? "completed"
    : status.status === "cancelled"
    ? "cancelled"
    : "working";
  const data = {
    resultType: creating ? "task" : "complete",
    taskId: id,
    status: state,
    createdAt: new Date(row.created).toISOString(),
    lastUpdatedAt: new Date(row.updated).toISOString(),
    ttlMs: lifetime,
    pollIntervalMs: 1000,
    ...(status.message ? { statusMessage: status.message } : {}),
    ...(state === "completed"
      ? {
        result: status.status === "failed"
          ? toolCallError(
            redactWireError({
              kind: errorKind({ kind: status.error?.kind }),
              message: status.error?.message ?? "task failed",
            }),
          )
          : toolCallOk(
            status.resultUrl
              ? { resultUrl: status.resultUrl }
              : { result: status.result },
          ),
      }
      : {}),
  };
  return { result: data };
}
