import { DeclaredUniqueError } from "../data/pg-error-map.ts";
// The Result vocabulary — the one closed error/success surface every layer speaks (05-runtime.md
// §op-pipeline, the err.kind 8-union). A leaf module (imports only db.ts's error predicate), so
// ok/err never drags op-pipeline machinery into the importer's value graph.
import {
  integrityFault,
  isForeignKeyViolation,
  isUniqueViolation,
} from "../data/db.ts";
import { KmsError } from "../features/kms-error.ts";
import { VersionPreconditionError } from "../data/repo-version-token.ts";

export type Result<T> = { readonly ok: true; readonly value: T } | {
  readonly ok: false;
  readonly error: ResultError;
};
/** Additive framework retry signals; the closed err.kind vocabulary stays unchanged. */
export interface ErrorHints {
  /** Exact current-resource declared unique tuple, absent for unknown constraints. */
  readonly clause?: string;
  /** Client-observed transport metadata, absent on an in-process Result. */
  readonly httpStatus?: number;
  readonly traceId?: string;
  readonly rateLimit?: {
    readonly limit: number;
    readonly remaining: number;
    readonly resetAfter: number;
  };
  readonly code?: string;
  readonly retryAfter?: number;
  readonly throttle?: {
    readonly limit: number;
    readonly remaining: number;
    readonly reset: number;
    readonly scope: "credential";
  };
}
export interface ResultError extends ErrorHints {
  readonly kind: ErrKind;
  readonly message: string;
}
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
export const err = (
  kind: ErrKind,
  message: string,
  hints?: ErrorHints,
): Result<never> => ({
  ok: false,
  error: { kind, message, ...hints },
});

export type HttpStatus = 400 | 403 | 404 | 409 | 422 | 429 | 500 | 503 | 504;

/** Preserve the safe, fixed retry signal on a thrown KDF gate refusal across every catch boundary. */
export function resultError(error: unknown): ResultError {
  if (error instanceof DeclaredUniqueError) {
    return { kind: error.kind, message: error.message, clause: error.clause };
  }
  if (error instanceof VersionPreconditionError) {
    return { kind: error.kind, message: error.message, code: error.code };
  }
  if (error instanceof KmsError) {
    return {
      kind: error.kind,
      message: error.message,
      code: error.code,
      ...(error.retryAfter !== undefined
        ? { retryAfter: error.retryAfter }
        : {}),
    };
  }
  const kind = errorKind(error);
  const overloaded = kind === "timeout" && typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "kdf/overloaded";
  return overloaded
    ? {
      kind,
      message: "password hashing is saturated; retry after the indicated delay",
      code: "kdf/overloaded",
      retryAfter: 1,
    }
    : { kind, message: String(error) };
}

/** Credential lockout is a transport throttle, carried under the existing forbidden kind. */
export function resultHttpStatus(error: ResultError): HttpStatus {
  return error.code === "kms/unavailable"
    ? 503
    : error.code === "auth/throttled" && error.kind === "forbidden"
    ? 429
    : httpStatus(error.kind);
}

/** Headers shared by op, CRUD and KDF overload responses. */
export function resultRetryHeaders(error: ResultError): Record<string, string> {
  const headers: Record<string, string> = {};
  if (
    error.retryAfter !== undefined && Number.isFinite(error.retryAfter) &&
    error.retryAfter > 0
  ) {
    headers["Retry-After"] = String(Math.ceil(error.retryAfter));
  }
  if (error.throttle) {
    headers["RateLimit-Limit"] = String(error.throttle.limit);
    headers["RateLimit-Remaining"] = String(error.throttle.remaining);
    headers["RateLimit-Reset"] = String(
      Math.max(1, Math.ceil(error.throttle.reset - Date.now() / 1000)),
    );
  }
  return headers;
}

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
      return 409; // unique/FK clash / illegal transition edge
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
 *  the pipeline maps it to `timeout`, not `internal` (05-runtime.md §error-classification). */
export function isTimeoutError(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  if ((e as { code?: unknown }).code === "57014") return true;
  const msg = (e as { message?: unknown }).message;
  return typeof msg === "string" &&
    /statement timeout|canceling statement due to/i.test(msg);
}

/** True for Postgres insufficient-resources (SQLSTATE class `53`, e.g. `53200` out of shared lock memory): the
 *  engine rolled the statement back for want of a shared resource, a transient condition a retry can clear. */
export function isResourceExhausted(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const code = (e as { code?: unknown }).code;
  if (typeof code === "string" && code.startsWith("53")) return true;
  const msg = (e as { message?: unknown }).message;
  return typeof msg === "string" && /out of shared memory/i.test(msg);
}

/** The message a resource-exhausted abort carries to the caller. */
export const RESOURCE_EXHAUSTED_MESSAGE =
  "the database ran out of a shared resource (lock or memory) — retry the request";

// Engine predicates live in db.ts (avoids a layer-inverting repo→pipeline import); re-exported here so
// existing callers (serve/mcp) resolve unchanged.
export { isForeignKeyViolation, isUniqueViolation };

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
 *  else a known Postgres error maps (unique/FK→conflict, timeout→timeout), else `internal` — kept retryable
 *  so a transient blip is never dead-lettered. */
export function errorKind(e: unknown): ErrKind {
  if (typeof e === "object" && e !== null) {
    const k = (e as { kind?: unknown }).kind;
    if (typeof k === "string" && (ERR_KINDS as readonly string[]).includes(k)) {
      return k as ErrKind;
    }
  }
  if (integrityFault(e) !== undefined) return "conflict";
  if (isTimeoutError(e)) return "timeout";
  if (isResourceExhausted(e)) return "timeout";
  return "internal";
}

/**
 * Kinds whose WIRE message is emptied, whoever produced it — the framework, or an app's own `err()`.
 *
 * `notFound` is the load-bearing member and the reason this is enforced rather than conventional: a reason
 * there is an existence oracle, and an app's `err("notFound", "widget 5 not found")` is one exactly as well
 * as a framework message would be. It also costs nothing to blank — the caller supplied the id they asked
 * about, so the message told them only what they already knew. `stale` / `timeout` have nothing the status
 * has not said.
 *
 * `forbidden` is deliberately NOT here, and that is a narrowing made against evidence rather than an
 * oversight. Every denial the framework itself authors carries a message that is either generic by design
 * (`policy denied`; password-auth's `invalid credentials` / `invalid refresh token`, vague precisely
 * to avoid user enumeration; its credential/source throttle carries a retry signal) or a
 * non-row diagnostic (`llm call 'x': budget exceeded, at most 2` names a declaration and a config value).
 * Blanking those buys no secrecy and costs a developer the reason their own configured cap fired. The
 * residue is real and accepted: an app writing `err("forbidden", "widget 5 belongs to someone else")` can
 * still leak, so the handbook tells an op author to keep those messages free of what a policy hides.
 *
 * Also absent, each for its own reason: `validation` describes the caller's OWN input; `business` is an
 * app's domain refusal and explaining it is the entire point; `conflict` is served both ways (a UNIQUE
 * clash names its clause); `internal` collapses to a fixed literal rather than `""`, so a trace id has
 * something to sit beside.
 */
export const WIRE_SILENT_KINDS: ReadonlySet<ErrKind> = new Set<ErrKind>([
  "notFound",
  "stale",
  "timeout",
]);

/**
 * The wire message a caller may see. `internal` collapses to a fixed literal (CWE-209 — it can carry DB
 * schema) and every `WIRE_SILENT_KINDS` member to `""`; the full detail stays in the server-side §6
 * ProvenanceRecord. Apply at the RESPONSE BOUNDARY, never at `err()` — the message is still what logging,
 * the relay's retry decision and a handler's own control flow read.
 *
 * This is the rule's only home. It used to be a convention held by a scan of the framework's own
 * `errorBody(` call sites, which said nothing about the doors that pass an app's `err()` straight through —
 * a custom op, a bulk write, an MCP tool call — so one resource answered a single-row miss silently and the
 * bulk miss with a sentence. Two contracts, same resource, decided by which door you knocked on.
 */
export function redactWireError<
  E extends { readonly kind: ErrKind; readonly message: string },
>(error: E): E {
  if (
    error.kind === "timeout" &&
    (error as E & ErrorHints).code === "kdf/overloaded"
  ) {
    return {
      ...error,
      message: "password hashing is saturated; retry after the indicated delay",
    };
  }
  if (error.kind === "internal") {
    return { ...error, message: "internal error" };
  }
  return WIRE_SILENT_KINDS.has(error.kind) && error.message !== ""
    ? { ...error, message: "" }
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
