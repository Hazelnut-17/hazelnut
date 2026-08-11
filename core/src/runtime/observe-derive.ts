// Observability-seam convergence derivers (05-runtime.md §6): run record-primary and derive
// tracer/alarm/metrics signals from the one ProvenanceRecord stream via additive LogSink combinators
// composed at boot. Each deriver tees the record to `next`; a throwing sink is swallowed.
import type { LogSink, ProvenanceRecord } from "../core/ctx.ts";
import type { Tracer } from "../core/tracing.ts";
import type { Alarm, AlarmSink } from "./alarm.ts";

/** Derives one span per ProvenanceRecord through the Tracer seam, carrying the record's own trace
 *  identity as OTel-compatible attributes so a collector can join the derived span to the record stream. */
export function recordSpanExporter(tracer: Tracer, next?: LogSink): LogSink {
  return {
    drain(record: ProvenanceRecord): void {
      try {
        const name = [record.op.module, record.op.resource, record.op.op]
          .filter((x) => x !== undefined).join(".");
        const span = tracer.startSpan(name, {
          trace_id: record.envelope.traceId,
          span_id: record.envelope.spanId,
          ...(record.envelope.parentSpanId !== undefined
            ? { parent_span_id: record.envelope.parentSpanId }
            : {}),
          origin: record.origin,
          outcome: record.outcome,
          duration_ms: record.durationMs,
          ...(record.txOutcome !== undefined
            ? { tx_outcome: record.txOutcome }
            : {}),
          ...(record.envelope.scope !== null
            ? { scope: record.envelope.scope }
            : {}),
        });
        if (record.outcome === "err") {
          span.recordException(
            new Error(`${record.kind ?? "internal"}: ${record.message ?? ""}`),
          );
        }
        span.end();
      } catch {
        // fire-and-forget: a throwing tracer never blocks the record drain (05-runtime.md §6)
      }
      next?.drain(record);
    },
  };
}

/** One alarm-as-query rule: a predicate over the record stream + a windowed threshold. */
export interface RecordAlarmRule {
  readonly id: string; // the Alarm id raised (e.g. "op-error-rate")
  readonly level?: "warn" | "alarm"; // default "alarm"
  readonly where: (r: ProvenanceRecord) => boolean; // which records count toward the threshold
  readonly threshold?: number; // fire when ≥ N matching records inside the window (default 1)
  readonly windowMs?: number; // the sliding window (default 60_000)
  readonly detail?: (count: number, last: ProvenanceRecord) => string;
}

/** Alarm-as-query: evaluates declarative rules over the record stream and raises through AlarmSink,
 *  with hysteresis — `firing:true` raises once on threshold crossing, `firing:false` on next-drain
 *  recovery. Purely record-driven (no timer); a throwing sink is swallowed. */
export function alarmQuerySink(
  rules: readonly RecordAlarmRule[],
  sink: AlarmSink,
  next?: LogSink,
  now: () => number = Date.now,
): LogSink {
  const state = new Map<string, { hits: number[]; firing: boolean }>();
  const raise = (alarm: Alarm) => {
    try {
      sink.raise(alarm);
    } catch {
      // fire-and-forget
    }
  };
  return {
    drain(record: ProvenanceRecord): void {
      const at = now();
      for (const rule of rules) {
        const s = state.get(rule.id) ??
          state.set(rule.id, { hits: [], firing: false }).get(rule.id)!;
        const windowMs = rule.windowMs ?? 60_000;
        s.hits = s.hits.filter((t) => at - t < windowMs);
        let matched = false;
        try {
          matched = rule.where(record);
        } catch {
          // a throwing predicate counts as no match — a rule bug must not break the drain
        }
        if (matched) s.hits.push(at);
        const over = s.hits.length >= (rule.threshold ?? 1);
        if (over && !s.firing) {
          s.firing = true;
          raise({
            id: rule.id,
            level: rule.level ?? "alarm",
            firing: true,
            detail: rule.detail?.(s.hits.length, record) ??
              `${rule.id}: ${s.hits.length} matching record(s) within ${windowMs}ms`,
          });
        } else if (!over && s.firing) {
          s.firing = false;
          raise({
            id: rule.id,
            level: "ok",
            firing: false,
            detail: `${rule.id}: recovered (window drained under threshold)`,
          });
        }
      }
      next?.drain(record);
    },
  };
}

// ─── record→metrics deriver (05-runtime.md §6) ───────────────────────────────────────────────────

/** The metrics collector Port — the numeric sibling of Tracer/AlarmSink: the framework derives
 *  instruments, a deployment supplies the registry/exporter behind this two-method face. */
export interface MetricsCollector {
  count(
    name: string,
    attrs: Readonly<Record<string, string>>,
    value?: number,
  ): void;
  observe(
    name: string,
    attrs: Readonly<Record<string, string>>,
    value: number,
  ): void;
}

/** Derives the RED trio (Rate/Errors/Duration) from each ProvenanceRecord into `hazelnut.op` count
 *  and `hazelnut.op.duration_ms` observation. Attributes are bounded to declaration-derived names —
 *  never actor, scope, or free text — to avoid unbounded cardinality or a tenant key as a dimension. */
export function recordMetricsSink(
  collector: MetricsCollector,
  next?: LogSink,
): LogSink {
  return {
    drain(record: ProvenanceRecord): void {
      try {
        const attrs: Record<string, string> = {
          ...(record.op.module !== undefined
            ? { module: record.op.module }
            : {}),
          ...(record.op.resource !== undefined
            ? { resource: record.op.resource }
            : {}),
          op: record.op.op,
          origin: record.origin,
          outcome: record.outcome,
          ...(record.kind !== undefined ? { kind: record.kind } : {}),
        };
        collector.count("hazelnut.op", attrs);
        collector.observe("hazelnut.op.duration_ms", attrs, record.durationMs);
      } catch {
        // fire-and-forget: a throwing collector never blocks the record drain (05-runtime.md §6)
      }
      next?.drain(record);
    },
  };
}

/** One in-memory instrument snapshot — the key is `name{k=v,…}` with attrs sorted (stable identity). */
export interface MemoryMetrics {
  readonly counts: ReadonlyMap<string, number>;
  readonly observations: ReadonlyMap<string, readonly number[]>;
}

/** The in-process floor collector: dev/tests read `snapshot()`; a deployment swaps in its own
 *  OTel/Prometheus-backed collector through the same Port. Key = `name{attr=v,…}`, attrs sorted. */
export function memoryMetricsCollector(): MetricsCollector & {
  snapshot(): MemoryMetrics;
} {
  const counts = new Map<string, number>();
  const observations = new Map<string, number[]>();
  const keyOf = (
    name: string,
    attrs: Readonly<Record<string, string>>,
  ): string =>
    `${name}{${
      Object.keys(attrs).sort().map((k) => `${k}=${attrs[k]}`).join(",")
    }}`;
  return {
    count(name, attrs, value = 1) {
      const k = keyOf(name, attrs);
      counts.set(k, (counts.get(k) ?? 0) + value);
    },
    observe(name, attrs, value) {
      const k = keyOf(name, attrs);
      (observations.get(k) ?? observations.set(k, []).get(k)!).push(value);
    },
    snapshot() {
      return { counts, observations };
    },
  };
}
