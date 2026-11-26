import type { Actor } from "../authz/auth.ts";
import type { Db } from "../data/db.ts";

export type NativeTaskReceipt = {
  subject: string;
  name: string;
  module: string;
  terminalError?: {
    kind: string;
    message: string;
    updated: string;
    statusMessage: string | null;
  };
};

/** A native MCP receipt and its durable outcome live under the original task identity. */
export function nativeTaskMarkerKey(taskId: string): string {
  return JSON.stringify(["mcp-native-task", taskId]);
}

export function nativeTaskSubject(
  actor: Actor | null | undefined,
  scope: string,
): string {
  return JSON.stringify([
    actor?.type,
    actor?.id,
    actor?.onBehalfOf ?? null,
    scope,
  ]);
}

export async function writeNativeTaskReceipt(
  db: Db,
  id: string,
  receipt: NativeTaskReceipt,
): Promise<void> {
  await db.query(
    `INSERT INTO "_idempotency" (key,result) VALUES ($1,$2::text::jsonb) ON CONFLICT (key) DO NOTHING`,
    [nativeTaskMarkerKey(id), JSON.stringify(receipt)],
  );
}
