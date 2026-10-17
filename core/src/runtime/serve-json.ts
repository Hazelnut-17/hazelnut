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

/** Why a JSON request body was refused — each maps to a client-fixable 400. */
export type BodyRefusal =
  | "malformed"
  | "too-deep"
  | "content-type"
  | "cross-site"
  | "not-object";

/** The result of parsing ONE JSON request body: the parsed value, or a client-fixable rejection reason. */
export type ParsedBody = { readonly ok: true; readonly value: unknown } | {
  readonly ok: false;
  readonly reason: BodyRefusal;
};

const JSON_CONTENT_TYPE = /^application\/json\s*(;|$)/i;

/** Parses + validates ONE JSON request body — the CSRF floor of every write door. An empty body is `{}`
 *  only when nothing a browser can forge without a preflight sent it: a non-JSON Content-Type (every HTML
 *  form) or a cross-site request with no `Authorization` is refused, empty or not. */
export async function parseJsonBody(
  c: {
    readonly req: {
      readonly text: () => Promise<string>;
      readonly header?: (name: string) => string | undefined;
    };
  },
  opts: { readonly object?: boolean; readonly maxDepth?: number } = {},
): Promise<ParsedBody> {
  const text = await c.req.text();
  const ct = c.req.header?.("content-type")?.trim() || undefined;
  if (ct !== undefined && !JSON_CONTENT_TYPE.test(ct)) {
    return { ok: false, reason: "content-type" };
  }
  if (text.trim() === "") {
    if (
      ct === undefined &&
      c.req.header?.("sec-fetch-site") === "cross-site" &&
      c.req.header?.("authorization") === undefined
    ) return { ok: false, reason: "cross-site" };
    return { ok: true, value: {} };
  }
  if (ct === undefined) return { ok: false, reason: "content-type" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (exceedsJsonDepth(value, opts.maxDepth ?? MAX_JSON_DEPTH)) {
    return { ok: false, reason: "too-deep" };
  }
  if (
    opts.object === true &&
    (value === null || typeof value !== "object" || Array.isArray(value))
  ) return { ok: false, reason: "not-object" };
  return { ok: true, value };
}

/** The loud-400 message for a rejected JSON body. HTTP doors pair it with `error:"validation"`. */
export function jsonBodyErrorMessage(reason: BodyRefusal): string {
  if (reason === "too-deep") return "request nested too deeply";
  if (reason === "content-type") {
    return "request Content-Type must be application/json";
  }
  if (reason === "cross-site") {
    return "a cross-site write must send a JSON body with Content-Type application/json";
  }
  if (reason === "not-object") return "request body must be a JSON object";
  return "request body is not valid JSON";
}
