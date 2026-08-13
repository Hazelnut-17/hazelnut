// The one Zod-issues → wire-detail mapper: every validation door (op-pipeline validate, HTTP body parse,
// MCP tool-input steer, parse-at-emit) renders through this pair, so a rejected input tells the caller the
// offending path + issue code instead of a bare "input failed validation" that forces guess-and-retry.
import type { z } from "zod";

/** One agent-actionable validation issue: where (`path`, dot-joined; `(root)` for a top-level shape
 *  issue), what (`code`, the zod issue code), and zod's value-free standard `message`. */
export interface ValidationIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

/** Maps a ZodError to a redaction-safe issue list (path + zod's code/message only, never the submitted
 *  value) — one entry per issue, with unrecognized_keys fanned out to one entry per offending key. */
export function validationIssues(error: z.ZodError): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  for (const issue of error.issues) {
    // unrecognized_keys carries the key names
    const keys = (issue as { readonly keys?: readonly string[] }).keys;
    if (Array.isArray(keys) && keys.length > 0) {
      for (const k of keys) {
        out.push({
          path: [...issue.path.map(String), String(k)].join("."),
          code: issue.code,
          message: issue.message,
        });
      }
      continue;
    }
    out.push({
      path: issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)",
      code: issue.code,
      message: issue.message,
    });
  }
  return out;
}

/** The one-string rendering for the `err.message` channel: `<what>: <path>: <code> — <message>; …`. */
export function validationDetail(what: string, error: z.ZodError): string {
  const parts = validationIssues(error).map((i) =>
    `${i.path}: ${i.code}${i.message ? ` — ${i.message}` : ""}`
  );
  return `${what}: ${parts.join("; ")}`;
}

/** Levenshtein edit distance (pure) — backs every did-you-mean: the closest sibling key to a typo'd
 *  selector segment. Small inputs (object key names), so the O(n·m) DP is fine. */
function editDistance(a: string, b: string): number {
  const dp = Array.from(
    { length: a.length + 1 },
    (_, i) => [i, ...Array(b.length).fill(0)],
  );
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost,
      );
    }
  }
  return dp[a.length]![b.length]!;
}

/** The closest candidate key to `miss` (the did-you-mean target), or undefined when nothing is reasonably
 *  close (distance > ~⅓ the length — never suggest a wild guess). */
export function didYouMean(
  miss: string,
  candidates: readonly string[],
): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = editDistance(miss, c);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best !== undefined && bestD <= Math.max(2, Math.ceil(miss.length / 3))
    ? best
    : undefined;
}
