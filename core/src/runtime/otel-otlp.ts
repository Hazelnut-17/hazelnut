// The OTLP/HTTP exporter (05-runtime.md §6) — the real wire behind the observability Ports the framework
// already ships. `core/tracing.ts` owns the `Tracer` seam and `observe-derive.ts` owns `MetricsCollector`;
// until now both defaulted to no-ops, so an un-instrumented deployment paid nothing and an INSTRUMENTED one
// had to hand-write an adapter. This module is that adapter, and nothing more: the framework still owns no
// SDK, no collector, and no dashboard — those are the deployment's (`17-non-goals.md`, `DEPLOY.md`).
//
// Three properties matter more than completeness here, because this sits on the hot path of every op:
//   1. it never throws into a request — an export failure is an observability outage, not an app outage;
//   2. it never blocks one — spans and metrics queue in memory and leave on a timer;
//   3. it never grows without bound — a queue that outruns the collector DROPS and says so, because an
//      exporter that OOMs the app it observes has done more damage than the missing telemetry.
import {
  popTraceparent,
  pushTraceparent,
  setTracer,
  type Span,
  type Tracer,
} from "../core/tracing.ts";
import { getLogSink, setLogSink } from "../core/ctx-provenance.ts";
import { type MetricsCollector, recordMetricsSink } from "./observe-derive.ts";
import { isForbiddenIp, safeFetch } from "./safe-fetch.ts";

export interface OtlpConfig {
  /** Collector base url — `/v1/traces` and `/v1/metrics` are appended (the OTLP/HTTP convention). */
  readonly endpoint: string;
  /** `service.name` on the exported resource; how the collector labels this app. */
  readonly serviceName: string;
  readonly serviceVersion?: string;
  /** Extra headers (an API key for a hosted collector). */
  readonly headers?: Readonly<Record<string, string>>;
  /** Export interval; the queue also flushes early when it fills. Default 5s. */
  readonly intervalMs?: number;
  /** Max queued spans / metric points before the exporter drops. Default 2048. */
  readonly maxQueue?: number;
  /** A collector on a private network (the usual `http://otel-collector:4318`) is the normal case, so both
   *  SSRF-floor opt-outs default ON for this seam — an operator-configured sidecar is not an SSRF vector.
   *  Set false to hold a public collector to the https + public-address floor. */
  readonly allowPrivateNetwork?: boolean;
  readonly allowInsecureHttp?: boolean;
  /** Injectable for tests — defaults to the SSRF-floor `safeFetch`. */
  readonly fetchFn?: (url: string, init: RequestInit) => Promise<Response>;
}

/** What the exporter dropped, so a deployment can alarm on its own blind spots. */
export interface OtlpStats {
  readonly exported: number;
  readonly dropped: number;
  readonly failures: number;
}

export interface OtlpObservability {
  readonly tracer: Tracer;
  readonly metrics: MetricsCollector;
  /** Force a flush — call before exit so the last window is not lost. */
  flush(): Promise<void>;
  /** Stop the timer and flush once. */
  shutdown(): Promise<void>;
  stats(): OtlpStats;
}

// ── OTLP JSON shapes (the subset this exporter emits) ────────────────────────────────────────────────
type AnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean };
interface KeyValue {
  key: string;
  value: AnyValue;
}
interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: KeyValue[];
  status?: { code: number; message?: string };
}
interface MetricPoint {
  attributes: KeyValue[];
  timeUnixNano: string;
  value: number;
  kind: "count" | "observe";
  name: string;
}

const hex = (bytes: number): string => {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
};

const nowNanos = (): string => `${BigInt(Date.now()) * 1_000_000n}`;

function toAnyValue(v: string | number | boolean): AnyValue {
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { intValue: `${v}` } : { doubleValue: v };
  }
  return { stringValue: v };
}

const toKeyValues = (
  attrs: Readonly<Record<string, string | number | boolean>>,
): KeyValue[] =>
  Object.entries(attrs).map(([key, value]) => ({
    key,
    value: toAnyValue(value),
  }));

/** A 32-hex trace id / 16-hex span id, or null — the record stream carries real ids as attributes, and
 *  adopting them is what joins a derived span to the ProvenanceRecord it came from. A malformed id is
 *  ignored rather than exported: a collector rejects the whole batch over one bad id. */
function adoptId(value: unknown, hexLen: number): string | null {
  if (typeof value !== "string") return null;
  // ProvenanceRecord ids are hyphenated UUIDs; OTel wants 32/16 hex. Stripping joins the span to
  // the record instead of minting a fresh identity the collector cannot correlate.
  const hex = value.replaceAll("-", "").toLowerCase();
  return new RegExp(`^[0-9a-f]{${hexLen}}$`).test(hex) ? hex : null;
}

/** Whether an endpoint's host is one the relaxed SSRF floor is MEANT for — an internal collector.
 *
 *  Syntactic only, deliberately: this runs at install, and resolving DNS to classify a host would turn a
 *  synchronous wiring call into a network round-trip. A private/loopback literal, `localhost`, or a bare
 *  service name (`otel-collector` — the compose/k8s shape) is internal; a dotted public hostname is not. */
function looksInternal(endpoint: string): boolean {
  let host: string;
  try {
    host = new URL(endpoint).hostname;
  } catch {
    return true; // unparseable: the exporter's own refusal path reports it; do not double-warn here
  }
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return isForbiddenIp(host);
  if (host.startsWith("[") || host.includes(":")) return true; // IPv6 literal — leave it to safeFetch
  return !host.includes("."); // bare service name ⇒ container/cluster-internal
}

/** Wires the OTLP exporter behind both Ports. Install with
 *  `setTracer(o.tracer)` + `recordMetricsSink(o.metrics)` (see `DEPLOY.md §observability`). */
export function otlpObservability(config: OtlpConfig): OtlpObservability {
  const intervalMs = config.intervalMs ?? 5_000;
  const maxQueue = config.maxQueue ?? 2048;
  const relaxPrivate = config.allowPrivateNetwork !== false;
  const relaxHttp = config.allowInsecureHttp !== false;
  const send = config.fetchFn ??
    ((url: string, init: RequestInit) =>
      safeFetch(url, init, {
        allowPrivateNetwork: relaxPrivate ? true : undefined,
        allowInsecureHttp: relaxHttp ? true : undefined,
      }));

  // This seam is the framework's ONE default-relaxed security floor: an operator-configured collector on the
  // internal network is the normal case, so both SSRF opt-outs default on. The relaxation is correct AND it
  // was silent — the only place in the framework that loosens a floor without saying so, while `launch`
  // explains every grant, `doctor` warns on `-A`, and the relay refuses a missing seam by name.
  //
  // So: speak exactly when the relaxation is load-bearing. An internal host is the sanctioned case and stays
  // quiet (a warning every boot is noise, and noise is how a real warning gets ignored); a PUBLIC endpoint
  // means the floor that would have caught a mistyped or attacker-supplied endpoint is off.
  if ((relaxPrivate || relaxHttp) && !looksInternal(config.endpoint)) {
    console.warn(
      `[hazelnut] installOtlp: the SSRF floor is RELAXED for '${config.endpoint}', which does not look ` +
        `internal — ${
          [
            relaxPrivate && "private/loopback egress allowed",
            relaxHttp && "plain-http egress allowed",
          ].filter(Boolean).join(", ")
        }. That default exists for an in-cluster collector. For a public one, ` +
        `pass allowPrivateNetwork:false / allowInsecureHttp:false to hold it to the https + public-address ` +
        `floor (DEPLOY.md §observability).`,
    );
  }

  const spans: OtlpSpan[] = [];
  const points: MetricPoint[] = [];
  let exported = 0;
  let dropped = 0;
  let failures = 0;

  const resource = {
    attributes: toKeyValues({
      "service.name": config.serviceName,
      ...(config.serviceVersion !== undefined
        ? { "service.version": config.serviceVersion }
        : {}),
    }),
  };

  /** Enqueue with a hard cap. Dropping the NEWEST keeps the already-queued window coherent, and the
   *  counter makes the loss visible instead of silent. */
  const enqueue = <T>(queue: T[], item: T): void => {
    if (queue.length >= maxQueue) {
      dropped++;
      return;
    }
    queue.push(item);
  };

  async function post(path: string, body: unknown): Promise<boolean> {
    try {
      const res = await send(`${config.endpoint.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...config.headers },
        body: JSON.stringify(body),
      });
      // The collector's own 4xx/5xx is a failure too — a 200-only check is what makes a silently
      // misconfigured endpoint look healthy for weeks.
      if (!res.ok) {
        failures++;
        return false;
      }
      // Drain the body; an undrained response leaks the connection in Deno.
      await res.body?.cancel();
      return true;
    } catch {
      failures++; // an unreachable collector must never surface as an app error
      return false;
    }
  }

  async function flush(): Promise<void> {
    if (spans.length > 0) {
      const batch = spans.splice(0, spans.length);
      const ok = await post("/v1/traces", {
        resourceSpans: [{
          resource,
          scopeSpans: [{ scope: { name: "hazelnut" }, spans: batch }],
        }],
      });
      if (ok) exported += batch.length;
    }
    if (points.length > 0) {
      const batch = points.splice(0, points.length);
      const ok = await post("/v1/metrics", {
        resourceMetrics: [{
          resource,
          scopeMetrics: [{
            scope: { name: "hazelnut" },
            metrics: toOtlpMetrics(batch),
          }],
        }],
      });
      if (ok) exported += batch.length;
    }
  }

  const timer = setInterval(() => void flush(), intervalMs);
  // The exporter must not be the reason a CLI verb or a test runner refuses to exit.
  Deno.unrefTimer(timer);

  const tracer: Tracer = {
    startSpan(name, attributes = {}) {
      // Adopt the record's own trace identity when the deriver supplies it, so the exported span and the
      // ProvenanceRecord row join on the same ids; mint otherwise.
      const traceId = adoptId(attributes.trace_id, 32) ?? hex(16);
      const spanId = adoptId(attributes.span_id, 16) ?? hex(8);
      const parentSpanId = adoptId(attributes.parent_span_id, 16);
      const startTimeUnixNano = nowNanos();
      const attrs: Record<string, string | number | boolean> = {
        ...attributes,
      };
      let status: { code: number; message?: string } | undefined;
      let ended = false;
      // The W3C carrier the outbox emit path stamps onto rows — `01` = sampled, matching what we export.
      pushTraceparent({ traceparent: `00-${traceId}-${spanId}-01` });
      const span: Span = {
        setAttribute(key, value) {
          attrs[key] = value;
        },
        recordException(error) {
          status = {
            code: 2, // STATUS_CODE_ERROR
            message: error instanceof Error ? error.message : String(error),
          };
        },
        end() {
          if (ended) return; // a double-end would pop a frame it does not own
          ended = true;
          popTraceparent();
          enqueue(spans, {
            traceId,
            spanId,
            ...(parentSpanId !== null ? { parentSpanId } : {}),
            name,
            kind: 1, // SPAN_KIND_INTERNAL
            startTimeUnixNano,
            endTimeUnixNano: nowNanos(),
            attributes: toKeyValues(attrs),
            ...(status !== undefined ? { status } : {}),
          });
        },
      };
      return span;
    },
  };

  const metrics: MetricsCollector = {
    count(name, attrs, value = 1) {
      enqueue(points, {
        name,
        kind: "count",
        value,
        attributes: toKeyValues(attrs),
        timeUnixNano: nowNanos(),
      });
    },
    observe(name, attrs, value) {
      enqueue(points, {
        name,
        kind: "observe",
        value,
        attributes: toKeyValues(attrs),
        timeUnixNano: nowNanos(),
      });
    },
  };

  return {
    tracer,
    metrics,
    flush,
    async shutdown() {
      clearInterval(timer);
      await flush();
    },
    stats: () => ({ exported, dropped, failures }),
  };
}

/** The one-line install (`DEPLOY.md §observability`): builds the exporter and wires BOTH seams — the
 *  op-pipeline's tracer, and a metrics tee onto whatever `LogSink` is already active.
 *
 *  It deliberately does NOT add `recordSpanExporter`: the op-pipeline already wraps every op in
 *  `withSpan(getTracer(), …)`, so a record-derived span on top would export each op twice. A process with
 *  no pipeline of its own (a standalone relay) is the case that wants `recordSpanExporter` instead — reach
 *  it at `hazelnut/runtime/observe-derive.ts` and compose it yourself.
 *
 *  Returns the handle so a deployment can `await o.shutdown()` in its SIGTERM path; without that, the last
 *  export window dies with the process. */
export function installOtlp(config: OtlpConfig): OtlpObservability {
  const o = otlpObservability(config);
  setTracer(o.tracer);
  setLogSink(recordMetricsSink(o.metrics, getLogSink()));
  return o;
}

/** Folds queued points into OTLP metric records: `count` → a monotonic delta Sum, `observe` → a Gauge.
 *  Delta temporality is the honest choice for a per-window queue — the exporter holds no cumulative state,
 *  so claiming cumulative would misreport every restart as a counter reset the collector must guess at. */
function toOtlpMetrics(batch: readonly MetricPoint[]): unknown[] {
  const byName = new Map<string, MetricPoint[]>();
  for (const p of batch) {
    // US separates the key halves — it occurs in neither a kind nor a metric name, so no two distinct
    // points collide into one group. Written as an escape: a raw control byte reads the file as binary
    // to ripgrep-based search (`rg`, GitHub code search, editor find-in-files), which then skips it.
    const key = `${p.kind}\u001f${p.name}`;
    (byName.get(key) ?? byName.set(key, []).get(key)!).push(p);
  }
  return Array.from(byName.values()).map((group) => {
    const first = group[0]!;
    const dataPoints = group.map((p) => ({
      attributes: p.attributes,
      timeUnixNano: p.timeUnixNano,
      startTimeUnixNano: p.timeUnixNano,
      ...(Number.isInteger(p.value)
        ? { asInt: `${p.value}` }
        : { asDouble: p.value }),
    }));
    return first.kind === "count"
      ? {
        name: first.name,
        sum: {
          dataPoints,
          aggregationTemporality: 1, // AGGREGATION_TEMPORALITY_DELTA
          isMonotonic: true,
        },
      }
      : { name: first.name, gauge: { dataPoints } };
  });
}
