import { loggableError } from "./loggable-error.ts";

const REPEAT_INTERVAL_MS = 60_000;
const REPEAT_COUNT = 100;
const FAILURE =
  "[hazelnut] in-process relay drain failed (rows persist for the next tick):";
const REPEATED =
  "[hazelnut] in-process relay drain failures repeated (rows persist for the next tick):";
const RECOVERED = "[hazelnut] in-process relay drain recovered:";
const ERROR_FIELDS = [
  "name",
  "message",
  "code",
  "schema",
  "table",
  "column",
  "constraint",
  "routine",
  "stack",
] as const;

/** Only the existing rendered diagnostic fields enter a private comparison key. Unknown objects remain distinct:
 * never enumerate a driver error or invoke a user object's serializer to discover extra fields. */
function comparisonKey(
  error: unknown,
  rendered: unknown,
  depth = 0,
): string | null {
  if (error instanceof Error) {
    const safe = rendered as Record<string, unknown>;
    const parts = ERROR_FIELDS.map((field) =>
      typeof safe[field] === "string" ? safe[field] : null
    );
    if (depth < 4 && Object.hasOwn(safe, "cause")) {
      const cause = comparisonKey(error.cause, safe.cause, depth + 1);
      if (cause === null) return null;
      parts.push(cause);
    }
    return JSON.stringify(parts);
  }
  if (
    error === null || error === undefined || typeof error === "string" ||
    typeof error === "number" || typeof error === "boolean"
  ) return JSON.stringify([typeof error, rendered]);
  return null;
}

/** One loop's bounded log state. This never decides whether to retry or whether the app is ready. */
export function relayDrainLog(
  sinks: {
    now: () => number;
    log: (message: string, detail: unknown) => void;
  } = {
    now: Date.now,
    log: (message, detail) => console.error(message, detail),
  },
  labels = { failure: FAILURE, repeated: REPEATED, recovered: RECOVERED },
) {
  let outage: {
    since: number;
    totalFailures: number;
    repeatedFailures: number;
    key: string | null;
    lastReportAt: number;
    pendingRepeats: number;
  } | undefined;
  const summarize = (reason: "interval" | "count" | "changed", at: number) => {
    if (!outage || outage.pendingRepeats === 0) return;
    sinks.log(labels.repeated, {
      reason,
      repeatedFailures: outage.pendingRepeats,
      totalFailures: outage.totalFailures,
      elapsedMs: Math.max(0, at - outage.since),
    });
    outage.pendingRepeats = 0;
    outage.lastReportAt = at;
  };
  return {
    failed(error: unknown): void {
      const rendered = loggableError(error);
      const key = comparisonKey(error, rendered);
      const at = sinks.now();
      if (!outage) {
        outage = {
          since: at,
          totalFailures: 0,
          repeatedFailures: 0,
          key: null,
          lastReportAt: at,
          pendingRepeats: 0,
        };
      }
      outage.totalFailures++;
      if (key !== null && outage.key === key) {
        outage.repeatedFailures++;
        outage.pendingRepeats++;
        if (outage.pendingRepeats >= REPEAT_COUNT) summarize("count", at);
        else if (at - outage.lastReportAt >= REPEAT_INTERVAL_MS) {
          summarize("interval", at);
        }
        return;
      }
      summarize("changed", at);
      outage.key = key;
      outage.lastReportAt = at;
      sinks.log(labels.failure, rendered);
    },
    recovered(): void {
      if (!outage) return;
      sinks.log(labels.recovered, {
        totalFailures: outage.totalFailures,
        repeatedFailures: outage.repeatedFailures,
        elapsedMs: Math.max(0, sinks.now() - outage.since),
      });
      outage = undefined;
    },
  };
}
