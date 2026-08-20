// The tracing seam (05-runtime.md; pins OpenTelemetry). Owns the Tracer/Span interface and the
// withSpan wrap-point the op-pipeline and relay drain both use; ships no OTel SDK — a deployment wires
// a real tracer via setTracer, and the default is a no-op (zero-cost when unwired).
import { AsyncLocalStorage } from "node:async_hooks";

export interface Span {
  setAttribute(key: string, value: string | number | boolean): void;
  recordException(error: unknown): void;
  end(): void;
}

export interface Tracer {
  startSpan(
    name: string,
    attributes?: Record<string, string | number | boolean>,
  ): Span;
}

/** The default tracer — does nothing, so an un-instrumented deployment pays nothing. */
export const noopTracer: Tracer = {
  startSpan: () => ({
    setAttribute: () => {},
    recordException: () => {},
    end: () => {},
  }),
};

// The single install point for opt-in tracing: a deployment calls setTracer(...) once at boot; until
// then getTracer() returns the no-op tracer (zero cost) that dispatchOp wraps every op in.
let activeTracer: Tracer = noopTracer;
export function setTracer(tracer: Tracer): void {
  activeTracer = tracer;
}
export function getTracer(): Tracer {
  return activeTracer;
}

/** Runs `fn` within a span (start → run → record any throw → always end) and re-throws unchanged (tracing
 *  only observes), inside its own forked AsyncLocalStorage context so concurrent ops never pop each other's
 *  carrier frames; the no-op tracer skips the context (zero-cost). */
export async function withSpan<T>(
  tracer: Tracer,
  name: string,
  fn: (span: Span) => Promise<T> | T,
  attributes?: Record<string, string | number | boolean>,
): Promise<T> {
  if (tracer === noopTracer) {
    return await fn(noopTracer.startSpan(name, attributes)); // zero-cost floor: no span state, no context
  }
  return await als.run([...stackOf()], async () => {
    const span = tracer.startSpan(name, attributes);
    try {
      return await fn(span);
    } catch (error) {
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  });
}

// ══ ambient trace-carrier — the W3C traceparent a span drives (05-runtime.md §5.1) ═══════════════

// Span has no traceparent accessor, so a real tracer pushes/pops the W3C carrier here from its
// span lifecycle; ctx.ts's buildTraceContext reads it so an emit inside a span stamps the row.

// Lives here, not ctx.ts, to avoid a value cycle (ctx → runtime/outbox → outbox-emit → ctx); the no-op
// tracer never touches the holder, so an uninstrumented run stamps no traceContext (the zero-cost floor).

/** The W3C trace carrier a span publishes — `traceparent` (`00-<trace>-<span>-<flags>`) plus optional
 *  `baggage`, both plain header-shaped strings so any OTel/W3C tracer can populate it without a core SDK. */
export interface TraceCarrier {
  readonly traceparent: string;
  readonly baggage?: string;
}

// Per-async-context (AsyncLocalStorage): withSpan forks the caller's stack so concurrent ops never pop
// each other's carrier frames. rootStack is the out-of-context fallback (e.g. the drain's pre-span push).
const als = new AsyncLocalStorage<TraceCarrier[]>();
const rootStack: TraceCarrier[] = [];
const stackOf = (): TraceCarrier[] => als.getStore() ?? rootStack;

/** Pushes the active span's W3C carrier (05-runtime.md §5.1); a real tracer calls this from startSpan
 *  and pops the matching frame from span.end(), so the holder always reflects the innermost live span. */
export function pushTraceparent(carrier: TraceCarrier): void {
  stackOf().push(carrier);
}

/** Pop the active span's carrier on `span.end()`, restoring the parent frame (05-runtime.md §5.1). */
export function popTraceparent(): void {
  const stack = stackOf();
  if (stack.length === 0) return; // no live frame — a stray pop must not eat a sibling's carrier
  stack.pop();
}

/** The active span's W3C carrier, or `undefined` when no instrumented span is live (the no-op floor). */
export function getCurrentTraceparent(): TraceCarrier | undefined {
  const stack = stackOf();
  return stack[stack.length - 1];
}
