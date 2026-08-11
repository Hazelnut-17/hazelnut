// Shared JSON-body defense for the serve layer. INTERNAL, not re-exported through the public barrel.
// `parseJsonBody` is the one body parse the write doors share (`serve-routes.ts`, `serve-routes-ops.ts`),
// so no door can silently coerce a garbled body or skip the depth wall; `serve.ts` walls `/mcp` inline.

/** True iff `v` nests deeper than `max`. Bounds its own recursion at `max` levels, so a pathological body
 *  can never stack-overflow the check itself — the depth wall layered over the byte cap. */
export function exceedsJsonDepth(v: unknown, max: number): boolean {
  if (max < 0) return true;
  if (Array.isArray(v)) return v.some((x) => exceedsJsonDepth(x, max - 1));
  if (v !== null && typeof v === "object") {
    return Object.values(v as Record<string, unknown>).some((x) =>
      exceedsJsonDepth(x, max - 1)
    );
  }
  return false;
}

/** Nesting ceiling for every JSON body the framework parses. 64 sits far above any legitimate declaration/patch
 *  shape (trees are relational via `parent_id`, never nested JSON). */
export const MAX_JSON_DEPTH = 64;

/** The result of parsing ONE JSON request body: the parsed value, or a client-fixable rejection reason. */
export type ParsedBody = { readonly ok: true; readonly value: unknown } | {
  readonly ok: false;
  readonly reason: "malformed" | "too-deep";
};

/** Parses + validates ONE JSON request body. An empty body is a legit `{}` (all-optional op / empty patch);
 *  a non-empty malformed body or over-`MAX_JSON_DEPTH` nesting is a loud rejection, never silently coerced
 *  to `{}`. The caller maps the rejection to its surface's 400. */
export async function parseJsonBody(
  c: { readonly req: { readonly text: () => Promise<string> } },
  maxDepth = MAX_JSON_DEPTH,
): Promise<ParsedBody> {
  const text = await c.req.text();
  if (text.trim() === "") return { ok: true, value: {} }; // no body → {}; the pipeline validates
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (exceedsJsonDepth(value, maxDepth)) {
    return { ok: false, reason: "too-deep" };
  }
  return { ok: true, value };
}

/** The loud-400 message for a rejected JSON body. HTTP doors pair it with `error:"validation"`. */
export function jsonBodyErrorMessage(reason: "malformed" | "too-deep"): string {
  return reason === "too-deep"
    ? "request nested too deeply"
    : "request body is not valid JSON";
}
