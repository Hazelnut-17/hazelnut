// Barrel re-exports keep import sites stable.
import type { Actor } from "../authz/auth.ts";
import type { JsonScalar } from "./ctx.ts";
import type { ErrKind } from "./pipeline.ts";

/**
 * The injected clock (05-runtime.md §ctx `now`). A handler reads wall-clock time through `ctx.now()`,
 * never `Date.now()` directly, so logic is deterministic under test (inject a frozen clock) and the one
 * time-source is explicit. The default is the real clock; the pipeline lets a caller override it.
 */
export type Clock = () => Date;

/**
 * `ctx.log` — the structured-provenance decoration face (05-runtime.md §6). There is deliberately no
 * `info`/`warn`/`error` level API: one op produces one canonical record; `set(key, value)` decorates its
 * `attrs`, which the pipeline drains into the `ProvenanceRecord` — never a logger, just a sink contract.
 */
export interface OpLog {
  set(key: string, value: JsonScalar | JsonScalar[]): void;
  /** The accumulated decorations — what the pipeline drain reads (a live view of the one record's attrs). */
  readonly attrs: Readonly<Record<string, JsonScalar | JsonScalar[]>>;
}

/**
 * Construct a fresh `OpLog` over a private accumulator. One instance is threaded across a single op's
 * before → handler → after (so every `ctx.log.set` lands in the same canonical record), then drained.
 */
export function makeOpLog(): OpLog {
  const attrs: Record<string, JsonScalar | JsonScalar[]> = {};
  return {
    set(key, value) {
      attrs[key] = value;
    },
    get attrs() {
      return attrs;
    },
  };
}

// ── §6 ProvenanceRecord + the logSink Port ─────────────────────────────────────────────────────────

// `ProvenanceRecord.kind` reuses the canonical `ErrKind` (pipeline.ts), imported type-only — no runtime
// import cycle. The closed union has one source (`ERR_KINDS` ↔ `ErrKind`); every consumer derives from it.

/**
 * `Responsible` ties a failure to a responsible declaration (05-runtime.md §6; unified with the verifier's
 * `Violation.responsible`, 09-verifier.md). The floor mints `kind:"unknown"` for an err with no finer
 * attributor; `null` = no fault (an `ok` record carries none).
 */
export type Responsible =
  | { readonly kind: "logic"; readonly file?: string; readonly opId?: string }
  | { readonly kind: "declaration"; readonly ref?: { readonly clause: string } }
  | {
    readonly kind: "cross";
    readonly consumer?: string;
    readonly producer?: string;
    readonly via?: string;
  }
  | { readonly kind: "unknown"; readonly why?: string };

/** The `origin` union (05-runtime.md §6) — additive-frozen, same discipline as the err-kind union. */
export type ProvenanceOrigin =
  | "http"
  | "mcp"
  | "cross-module"
  | "subscriber"
  | "worker"
  | "cron";

/**
 * `ProvenanceRecord` (05-runtime.md §6) — one per op, assembled by the pipeline and drained to the `logSink`
 * Port. `responsible` is never null on err (`kind:"unknown"` is the honest floor); `message == err.message`
 * inherits `errors/no-internal-leak`. Field names are OTel-compatible.
 */
export interface ProvenanceRecord {
  readonly envelope: {
    readonly traceId: string;
    readonly spanId: string;
    readonly parentSpanId?: string; // cross-hop is gated on the tracer (§5.1) — absent on the per-op-minted floor
    readonly actor: {
      readonly id: string;
      readonly type: "user" | "agent" | "system";
      readonly onBehalfOf?: string;
    } | null; // null = anonymous; claims excluded (internal authz structure, §6)
    readonly scope: string | null; // null = crossScope (declarative, 13-authz.md §crossScope)
  };
  readonly op: {
    readonly module?: string;
    readonly resource?: string;
    readonly op: string;
  };
  readonly origin: ProvenanceOrigin;
  readonly outcome: "ok" | "err";
  readonly kind?: ErrKind; // set IFF outcome === "err"
  readonly durationMs: number;
  readonly txOutcome?: "committed" | "rolled-back" | "none";
  readonly responsible?: Responsible; // never null on err; absent on ok
  readonly message?: string; // == err.message on err (inherits no-internal-leak); absent on ok
  readonly attrs?: Readonly<Record<string, JsonScalar | JsonScalar[]>>; // ctx.log.set accumulation
}

/**
 * The `logSink` Port (05-runtime.md §6) — the framework owns the contract, never a logger. It is
 * process-global (like `setTracer`/`setAlarmSink`), not a `createApp` boot seam; wire a real sink via
 * `setLogSink(...)` at boot. `drain` is fire-and-forget void — a throwing sink never blocks/rolls back the op.
 */
export interface LogSink {
  drain(record: ProvenanceRecord): void;
}

/**
 * The default sink — stderr-JSON, OTel-compatible field names (05-runtime.md §6): tamper-evident not proof
 * (14-trust-gradient.md). A throw inside `JSON.stringify`/`console.error` is the drain's problem to swallow.
 * A `ProvenanceRecord` carries actor/scope ids, so wire a redacting `setLogSink` before shipping stderr off-box.
 */
export const stderrJsonSink: LogSink = {
  drain(record) {
    console.error(JSON.stringify(record));
  },
};

/**
 * The explicit `noop` sink (05-runtime.md §6) — discards every record, and on first use logs a loud
 * `"provenance sink: noop (records discarded)"` line once, so a silently-lost stream is never invisible.
 */
export function noopSink(): LogSink {
  let booted = false;
  return {
    drain() {
      if (!booted) {
        booted = true;
        console.error("provenance sink: noop (records discarded)");
      }
    },
  };
}

/**
 * The active logSink — the single install point (mirrors `tracing.ts setTracer/getTracer`); a deployment
 * calls `setLogSink(...)` directly at boot, not a `createApp` boot seam. Process-global by design (one
 * log stream per process), deliberately asymmetric with per-app `backpressure`. Defaults to stderr-JSON.
 */
let activeLogSink: LogSink = stderrJsonSink;
export function setLogSink(sink: LogSink): void {
  activeLogSink = sink;
}
export function getLogSink(): LogSink {
  return activeLogSink;
}

/**
 * Assembles the §6 `ProvenanceRecord` from live op facts, pure (no I/O). The envelope's actor projects only
 * `id`/`type`/`onBehalfOf` (claims excluded by construction — never the internal authz structure); scope is
 * `null` when empty (crossScope). `outcome`/`kind`/`responsible`/`message` derive from the op `Result`.
 */
export function assembleProvenance(args: {
  readonly actor: Actor | null;
  readonly scope: string;
  readonly attrs: Readonly<Record<string, JsonScalar | JsonScalar[]>>;
  readonly op: {
    readonly module?: string;
    readonly resource?: string;
    readonly op: string;
  };
  readonly origin: ProvenanceOrigin;
  readonly outcome: "ok" | "err";
  readonly kind?: ErrKind;
  readonly message?: string;
  readonly durationMs: number;
  readonly txOutcome?: "committed" | "rolled-back" | "none";
  readonly traceId: string;
  readonly spanId: string;
}): ProvenanceRecord {
  const a = args.actor;
  // the provenance triple — claims are deliberately not projected (internal authz structure, §6)
  const actor = a === null ? null : {
    id: a.id,
    type: a.type,
    ...(a.onBehalfOf !== undefined ? { onBehalfOf: a.onBehalfOf } : {}),
  };
  const isErr = args.outcome === "err";
  return {
    envelope: {
      traceId: args.traceId,
      spanId: args.spanId,
      actor,
      scope: args.scope === "" ? null : args.scope,
    },
    op: args.op,
    origin: args.origin,
    outcome: args.outcome,
    ...(isErr && args.kind !== undefined ? { kind: args.kind } : {}),
    durationMs: args.durationMs,
    ...(args.txOutcome !== undefined ? { txOutcome: args.txOutcome } : {}),
    // never null on err — the honest floor is kind:"unknown" (the finer attributors are build-sequenced)
    ...(isErr
      ? { responsible: { kind: "unknown" as const, why: args.kind } }
      : {}),
    ...(isErr && args.message !== undefined ? { message: args.message } : {}),
    attrs: args.attrs,
  };
}
