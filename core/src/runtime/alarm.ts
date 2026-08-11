/**
 * The runtime-assert rung + the AlarmSink Port (09-verifier.md §determinism-axis `runtime-assert`;
 * 05-runtime.md §5 "DLQ is observable"). `evaluateRuntimeAsserts` folds the outbox into
 * `phase:"runtime"` Violations against a live `Db`, outside the static `invariants[]` roster.
 */
import { tableOf } from "../core/app-define.ts";
import type { App, ResourceModel } from "../core/app.ts";
import type { Db } from "../data/db.ts";
import {
  type BackpressureState,
  classifyDlq,
  classifyLiveness,
  deadLetterDepth,
  type DlqAlarm,
  outboxBackpressureWatermark,
  relayLag,
  type RelayLiveness,
} from "./outbox.ts";
import { isVectorStale, sourceHash } from "../features/embed.ts";
import { isRuntimePhase, type Violation } from "../core/verifier-contract.ts";
import { docRefForRung } from "../core/docref.ts";
import { docsOnDisk } from "../core/docs-probe.ts";

/** The canonical id of the DLQ-drained runtime assert — the one live invariant this floor folds. */
export const DLQ_DRAINED_ID = "outbox/dlq-drained";

/** Build the `phase:"runtime"` Violation a runtime assert emits — mirrors `verify.ts enrich`'s shape but
 *  stamps `phase:"runtime"` so it never collides with a pre-ship finding. Pure constructor. */
export function runtimeViolation(id: string, message: string): Violation {
  const at = { file: "<runtime>", startLine: 1 };
  const responsible = {
    kind: "unknown" as const,
    why: "runtime-asserted over the live database, not a static declaration",
  };
  return {
    id,
    rung: "runtime-assert",
    blocks: "warn", // a runtime assert surfaces, it does not gate a build (the build already shipped)
    phase: "runtime",
    at,
    responsible,
    message,
    // Gated like the CLI render seam: this record reaches a deployment's AlarmSink, and a doc pointer is
    // only actionable when the docs sit beside the running framework. Absent, it is noise the reader cannot follow.
    docRef: docsOnDisk() ? docRefForRung("runtime-assert") : "",
    fingerprint: id, // id-granular (one live signal per id), not span-bucketed
    source: "verify",
  };
}

/** Default per-tick scan cap for the vector-staleness assert; a hit cap is reported, never silently
 *  truncated. Tunable via `defineConfig({ runtimeAsserts })`. */
const VECTOR_STALE_SCAN_CAP = 1000;

/** Per-deployment runtime-assert config (`defineConfig({ runtimeAsserts })` → `App.runtimeAsserts`):
 *  `exclude` turns named assert ids off; `vectorScanCap` bounds the staleness scan. Absent ⇒ full set,
 *  default cap. */
export interface RuntimeAssertsConfig {
  readonly exclude?: readonly string[];
  readonly vectorScanCap?: number;
}

/**
 * `vector/possibly-stale` — the first model-derived runtime assert. Vector staleness is a live property
 * (source text changed after embedding), so it can only be asserted against the running DB, never the
 * static model. Scans up to `scanCap` rows per vector-carrying resource, reusing the same
 * `sourceHash`/`isVectorStale` the read path uses so there is no SQL-side hash reimplementation.
 */
async function deriveVectorStaleAsserts(
  db: Db,
  model: ReadonlyArray<ResourceModel>,
  scanCap: number = VECTOR_STALE_SCAN_CAP,
): Promise<Violation[]> {
  const out: Violation[] = [];
  for (const m of model) {
    const v = m.vector;
    if (!v) continue;
    const rows = (await db.query<{ src: unknown; stored: string | null }>(
      `SELECT "${v.source}" AS src, "${v.field}_source_hash" AS stored FROM ${
        tableOf(m)
      } LIMIT ${Math.max(1, Math.floor(scanCap))}`,
    )).rows;
    let stale = 0;
    for (const r of rows) {
      // the same predicate isRowVectorStale uses — stored hash vs the hash of the current source text
      if (
        isVectorStale(
          r.stored,
          await sourceHash(r.src == null ? null : String(r.src)),
        )
      ) stale++;
    }
    if (stale > 0) {
      const bounded = rows.length >= scanCap
        ? ` (scan bounded to ${scanCap} rows — there may be more)`
        : "";
      out.push(runtimeViolation(
        "vector/possibly-stale",
        `${m.name}: ${stale} of ${rows.length} scanned row(s) carry a vector embedded from a source that no longer matches ('${v.source}' hash ≠ stored '${v.field}_source_hash')${bounded} — the async re-embed is behind or never ran. Drain/redrive the re-embed outbox topic.`,
      ));
    }
  }
  return out;
}

/**
 * Evaluate the runtime asserts against the live database (09-verifier.md §determinism-axis
 * `runtime-assert`). Standalone — a monitor / readiness handler / `Deno.cron` calls it; deliberately
 * absent from `invariants[]` since it reads a `Db`, not the composed model. Folds the app-singleton
 * `outbox/dlq-drained` assert with the model-derived per-resource asserts when `app` is passed;
 * omitting `app` runs the DLQ assert only.
 */
export async function evaluateRuntimeAsserts(
  db: Db,
  app?: App,
): Promise<Violation[]> {
  const cfg = app?.runtimeAsserts;
  const excluded = new Set(cfg?.exclude ?? []);
  const out: Violation[] = [];
  if (!excluded.has(DLQ_DRAINED_ID)) {
    const dlq = classifyDlq(await deadLetterDepth(db));
    if (dlq.firing) {
      const topic = dlq.worstTopic ?? "(unknown)";
      out.push(runtimeViolation(
        DLQ_DRAINED_ID,
        `the DLQ is not drained — ${dlq.total} dead-lettered message(s), worst topic '${topic}' (${dlq.worstTopicCount}). A runtime assert: the live \`_outbox_dead\` table is non-empty, so delivery is silently failing. Fix the cause and redrive (redriveDead).`,
      ));
    }
  }
  if (app) {
    const derived = await deriveVectorStaleAsserts(
      db,
      app.model,
      cfg?.vectorScanCap ?? VECTOR_STALE_SCAN_CAP,
    );
    out.push(...derived.filter((v) => !excluded.has(v.id)));
  }
  return out;
}

// ─── AlarmSink Port (opt-in, zero-cost no-op default) ──────────

/** A single alarm delivery. `id` names the signal (`outbox/dlq-drained`, `relay/liveness`, …); `firing` is
 *  the load-bearing bit (true → raise, false → clear); `level` grades it; `detail` is the actionable line. */
export interface Alarm {
  readonly id: string;
  readonly level: "ok" | "warn" | "alarm";
  readonly firing: boolean;
  readonly detail: string;
}

/** The opt-in alarm delivery Port; a deployment wires a real sink (OTel / PagerDuty / a log) once at
 *  boot via `setAlarmSink`. Defaults to a no-op, so an unwired deployment pays nothing. */
export interface AlarmSink {
  raise(alarm: Alarm): void;
}

/** The default sink — does nothing, so an un-instrumented deployment pays nothing. */
export const noopAlarmSink: AlarmSink = { raise: () => {} };

/** The single install point for opt-in alarm delivery; no-op until `setAlarmSink` is called. */
let activeAlarmSink: AlarmSink = noopAlarmSink;
export function setAlarmSink(sink: AlarmSink): void {
  activeAlarmSink = sink;
}
export function getAlarmSink(): AlarmSink {
  return activeAlarmSink;
}

/** The DLQ-alarm → `Alarm` projection (delivery only — `classifyDlq` already computed the signal). */
function dlqToAlarm(dlq: DlqAlarm): Alarm {
  const topic = dlq.worstTopic ?? "(none)";
  return {
    id: DLQ_DRAINED_ID,
    level: dlq.level,
    firing: dlq.firing,
    detail:
      `_outbox_dead depth ${dlq.total}, worst topic '${topic}' (${dlq.worstTopicCount})`,
  };
}

/** The relay-liveness → `Alarm` projection (delivery only — `classifyLiveness` already computed the signal). */
function livenessToAlarm(live: RelayLiveness): Alarm {
  return {
    id: "relay/liveness",
    level: live.health === "stalled"
      ? "alarm"
      : live.health === "lagging"
      ? "warn"
      : "ok",
    firing: !live.ready, // unhealthy/stalled → readiness probe fails → raise
    detail: `relay health '${live.health}', pending ${live.pending}, lag ${
      live.lagMs ?? 0
    }ms`,
  };
}

/**
 * Render every live relay-health signal into the wired `AlarmSink` (05-runtime.md §5 "DLQ is
 * observable"). Only delivers existing signals (`classifyDlq`, `classifyLiveness`, the fired
 * `evaluateRuntimeAsserts` Violations) into `sink.raise`; computes nothing new. `lastDrainAt: null`
 * means never drained — a fresh boot is not stalled.
 */
export async function renderAndRouteAlarms(
  db: Db,
  opts: {
    readonly lastDrainAt?: number | null;
    readonly sink?: AlarmSink;
    readonly app?: App;
    readonly backpressure?: BackpressureState;
  } = {},
): Promise<ReadonlyArray<Alarm>> {
  const sink = opts.sink ?? getAlarmSink();
  const raised: Alarm[] = [];
  const emit = (a: Alarm) => {
    sink.raise(a);
    raised.push(a);
  };

  const dlq = classifyDlq(await deadLetterDepth(db));
  if (dlq.firing) emit(dlqToAlarm(dlq));

  const { pending, oldestPendingAt } = await relayLag(db);
  const live = classifyLiveness({
    now: Date.now(),
    lastDrainAt: opts.lastDrainAt ?? null,
    oldestPendingAt,
    pending,
  });
  if (!live.ready) emit(livenessToAlarm(live));

  // producer-backpressure watermark (05-runtime.md §5.1 §backpressure), same `pending` read and watermark
  // the emit wall uses, firing from 50% so a wired pager hears the climb before emits start refusing.
  const watermark = outboxBackpressureWatermark(opts.backpressure);
  if (watermark !== false && pending >= watermark / 2) {
    emit({
      id: "outbox/backlog-watermark",
      level: pending >= watermark ? "alarm" : "warn",
      firing: true,
      detail: pending >= watermark
        ? `outbox ready-backlog ${pending} AT/OVER the ${watermark} watermark — emits are REFUSING (timeout) until the relay drains`
        : `outbox ready-backlog ${pending} over 50% of the ${watermark} watermark — emits start refusing at the watermark`,
    });
  }

  // only deliver `phase:"runtime"` findings, so a pre-ship finding never leaks onto the live alarm channel.
  for (const v of await evaluateRuntimeAsserts(db, opts.app)) {
    if (!isRuntimePhase(v)) continue;
    emit({ id: v.id, level: "alarm", firing: true, detail: v.message });
  }

  return raised;
}
