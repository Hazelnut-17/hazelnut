// The Result vocabulary — the one closed error/success surface every layer speaks (05-runtime.md
// §op-pipeline, the err.kind 8-union). A leaf module (imports only db.ts's error predicate), so
// ok/err never drags op-pipeline machinery into the importer's value graph. Pin: import-cycle-gate.test.ts.
import { isUniqueViolation } from "../data/db.ts";

export type Result<T> = { readonly ok: true; readonly value: T } | {
  readonly ok: false;
  readonly error: { readonly kind: ErrKind; readonly message: string };
};
export type ErrKind =
  | "notFound"
  | "forbidden"
  | "conflict"
  | "validation"
  | "business"
  | "internal"
  | "timeout"
  | "stale";

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const err = (kind: ErrKind, message: string): Result<never> => ({
  ok: false,
  error: { kind, message },
});

export type HttpStatus = 400 | 403 | 404 | 409 | 422 | 500 | 504;

/** Maps an err-kind to its canonical HTTP status; the switch is total over the closed 8-kind union —
 *  every op error reaches a real status, never a blanket 400. */
export function httpStatus(kind: ErrKind): HttpStatus {
  switch (kind) {
    case "validation":
      return 400;
    case "forbidden":
      return 403;
    case "notFound":
      return 404;
    case "conflict":
      return 409; // unique clash / illegal transition edge
    case "stale":
      return 409; // version-CAS loss — retryable, distinct from conflict
    case "business":
      return 422; // well-formed but violates a domain rule
    case "timeout":
      return 504; // per-op deadline overrun
    case "internal":
      return 500;
  }
}

/** True for a Postgres statement-timeout (SQLSTATE `57014`) — PG aborts and rolls back the query, so
 *  the pipeline maps it to `timeout`, not `internal` (05-runtime.md §timeout). */
export function isTimeoutError(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  if ((e as { code?: unknown }).code === "57014") return true;
  const msg = (e as { message?: unknown }).message;
  return typeof msg === "string" &&
    /statement timeout|canceling statement due to/i.test(msg);
}

// isUniqueViolation's true home is db.ts (avoids a layer-inverting repo→pipeline import); re-exported
// here so existing callers (serve/mcp) resolve unchanged.
export { isUniqueViolation };

/** The err.kind closed 8-union as a runtime roster, the single source metadata.ts reuses; `_ErrKindsComplete`
 *  below proves completeness — a missing member fails `deno check`. */
export const ERR_KINDS = [
  "notFound",
  "forbidden",
  "conflict",
  "validation",
  "business",
  "internal",
  "timeout",
  "stale",
] as const satisfies readonly ErrKind[];
type _AssertTrue<T extends true> = T;
type _ErrKindsComplete = _AssertTrue<
  Exclude<ErrKind, (typeof ERR_KINDS)[number]> extends never ? true : false
>;

/** Classifies a thrown failure into an err-kind for the relay's retry decision: an explicit `.kind` wins,
 *  else a known Postgres error maps (unique→conflict, timeout→timeout), else `internal` — kept retryable
 *  so a transient blip is never dead-lettered. */
export function errorKind(e: unknown): ErrKind {
  if (typeof e === "object" && e !== null) {
    const k = (e as { kind?: unknown }).kind;
    if (typeof k === "string" && (ERR_KINDS as readonly string[]).includes(k)) {
      return k as ErrKind;
    }
  }
  if (isUniqueViolation(e)) return "conflict";
  if (isTimeoutError(e)) return "timeout";
  return "internal";
}

/** Redacts an `internal` error's wire message (CWE-209 — it can carry DB schema), leaving the full detail in
 *  the server-side §6 ProvenanceRecord; apply at the response boundary, never at `err()` — other kinds already
 *  pass through unchanged. */
export function redactWireError<
  E extends { readonly kind: ErrKind; readonly message: string },
>(error: E): E {
  return error.kind === "internal"
    ? { ...error, message: "internal error" }
    : error;
}

/** The relay's retry-vs-DLQ decision (05-runtime §relay-mode): retryable kinds (internal/timeout/stale)
 *  back off and re-run; deterministic kinds go straight to the DLQ (a retry only re-burns tokens). */
export function classifyForRetry(kind: ErrKind): "retry" | "dlq" {
  switch (kind) {
    case "internal":
    case "timeout":
    case "stale":
      return "retry";
    case "conflict":
    case "validation":
    case "business":
    case "notFound":
    case "forbidden":
      return "dlq";
  }
}
