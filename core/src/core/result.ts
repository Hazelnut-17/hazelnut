// The Result vocabulary — the one closed error/success surface every layer speaks (05-runtime.md
// §op-pipeline, the err.kind 8-union). A leaf module (imports only db.ts's error predicate), so
// ok/err never drags op-pipeline machinery into the importer's value graph.
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
 *  the pipeline maps it to `timeout`, not `internal` (05-runtime.md §error-classification). */
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
 * (`policy denied`; password-auth's `invalid credentials`, vague precisely to avoid user enumeration) or a
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
