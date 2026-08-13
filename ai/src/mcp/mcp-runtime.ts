// The MCP runtime projection (12-mcp.md §runtime-projection) — a pure, read-only view of the
// observability floor `outbox-relay.ts` already computes: `relay` (liveness + backlog) and `dlq` (depth +
// metadata only, never payload/trace_context/scope/row ids). Opt-in and gated (§3 pillar 3).
import { type Actor, can } from "../authz/auth.ts";
import { err, ok, type Result } from "../core/pipeline.ts";
import type { Db } from "../data/db.ts";
import {
  deadLetterDepth,
  relayLag,
  relayLiveness,
} from "../runtime/outbox-relay.ts";

/** The `defineConfig({ mcp: { runtime } })` shape — `gate` is the perm a caller must hold. */
export interface McpRuntimeConfig {
  readonly gate: string;
}

export const RUNTIME_RELAY_URI = "hazelnut-runtime://relay";
export const RUNTIME_DLQ_URI = "hazelnut-runtime://dlq";

export function isRuntimeUri(uri: string): boolean {
  return uri.startsWith("hazelnut-runtime://");
}

/** The `resources/list` entries for THIS identity — []` unless the runtime projection is declared AND the
 *  caller holds the gate (identity-scoped omission, mirroring `tools/list` — 12-mcp.md §5). */
export function runtimeResourceEntries(
  cfg: McpRuntimeConfig | undefined,
  actor: Actor | null,
): ReadonlyArray<
  { uri: string; name: string; description: string; mimeType: string }
> {
  if (!cfg || !can(actor, cfg.gate)) return [];
  return [
    {
      uri: RUNTIME_RELAY_URI,
      name: "relay",
      description:
        "Relay/outbox health: drain liveness, pending backlog, oldest pending age.",
      mimeType: "application/json",
    },
    {
      uri: RUNTIME_DLQ_URI,
      name: "dlq",
      description:
        "Dead-letter queue: total + per-topic depth and recent entries (metadata only, no payloads).",
      mimeType: "application/json",
    },
  ];
}

/** How many recent corpses the dlq projection lists — a fixed triage window, not a query surface (an agent
 *  needing more than the window is doing recovery, which is the operator CLI's job). */
const DLQ_RECENT_LIMIT = 20;

/** Read one runtime resource. Gate-fail and unknown-URI both collapse to the SAME `notFound` (the caller
 *  maps it to `-32002`), so the error is never a which-part-exists oracle. */
export async function readRuntimeResource(
  db: Db,
  relayState: { lastDrainAt: number | null } | undefined,
  actor: Actor | null,
  cfg: McpRuntimeConfig | undefined,
  uri: string,
): Promise<Result<{ uri: string; mimeType: string; text: string }>> {
  if (!cfg || !can(actor, cfg.gate)) {
    return err("notFound", "resource not found");
  }
  if (uri === RUNTIME_RELAY_URI) {
    const lastDrainAt = relayState?.lastDrainAt ?? null;
    const [lag, liveness] = [
      await relayLag(db),
      await relayLiveness(db, lastDrainAt),
    ];
    return ok({
      uri,
      mimeType: "application/json",
      text: JSON.stringify({
        health: liveness.health,
        lastDrainAt,
        pending: lag.pending,
        oldestPendingAt: lag.oldestPendingAt,
      }),
    });
  }
  if (uri === RUNTIME_DLQ_URI) {
    const depth = await deadLetterDepth(db);
    // metadata ONLY — deliberately no payload / trace_context / scope / aggregate ids (header comment).
    const { rows } = await db.query<{
      topic: string | null;
      kind: string | null;
      attempts: number | null;
      error: string | null;
      final_error_kind: string | null;
      dead_at: string | Date;
    }>(
      `SELECT topic, kind, attempts, error, final_error_kind, dead_at FROM "_outbox_dead" ORDER BY dead_at DESC LIMIT ${DLQ_RECENT_LIMIT}`,
    );
    return ok({
      uri,
      mimeType: "application/json",
      text: JSON.stringify({
        total: depth.total,
        byTopic: depth.byTopic,
        recent: rows.map((r) => ({
          topic: r.topic ?? "",
          kind: r.kind ?? "",
          attempts: r.attempts ?? 0,
          error: r.error ?? "",
          finalErrorKind: r.final_error_kind ?? "",
          deadAt: typeof r.dead_at === "string"
            ? r.dead_at
            : r.dead_at.toISOString(),
        })),
      }),
    });
  }
  return err("notFound", "resource not found");
}
