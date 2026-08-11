/**
 * The Gemini vendor transport for the API judge (09-verifier.md §judge): no bundled SDK, no key (BYO). Google
 * gates the same models behind two key-authed doors (Developer API / Vertex express); a key scoped to one 403s
 * on the other, so this tries Developer first, falls back to Vertex on 403, and caches the winning door.
 */
import type { ApiTransport } from "./judge-api.ts";
import { safeFetch } from "@hazelnut/core/runtime/safe-fetch.ts";

/** The two key-authed Gemini doors (base URLs up to the models segment). */
export const GEMINI_DEVELOPER_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models";
export const GEMINI_VERTEX_EXPRESS_BASE =
  "https://aiplatform.googleapis.com/v1/publishers/google/models";

export interface GeminiOpts {
  /** Pin one base explicitly (skips auto-detection). Default: try Developer, fall back to Vertex express on 403. */
  readonly endpoint?: string;
}

/** Build a Gemini `ApiTransport` bound to `apiKey` (`model` rides in via `req.model`). On a non-2xx after any
 *  fallback, logs status+body then throws — `apiJudgeProvider` catches it as abstain. */
export function geminiTransport(
  apiKey: string,
  opts: GeminiOpts = {},
): ApiTransport {
  let resolvedBase: string | null = opts.endpoint ?? null; // the door that worked, cached across calls

  const post = (
    base: string,
    req: {
      model: string;
      systemPrompt: string;
      userContent: string;
      maxTokens?: number;
    },
  ): Promise<Response> =>
    // Through the SSRF floor, not a bare `fetch`. `redirect: "error"` is the load-bearing part here: the key
    // rides a CUSTOM header, and a custom header is NOT stripped on a cross-origin redirect the way
    // `Authorization` is — so a 3xx would hand `x-goog-api-key` to the redirect target. The floor also keeps
    // a caller-supplied `endpoint` on https and off the loopback/metadata ranges.
    safeFetch(`${base}/${req.model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: req.systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: req.userContent }] }],
        ...(req.maxTokens
          ? { generationConfig: { maxOutputTokens: req.maxTokens } }
          : {}),
      }),
    });

  return async (req) => {
    let base = resolvedBase ?? GEMINI_DEVELOPER_BASE;
    let res = await post(base, req);
    if (res.status === 403 && resolvedBase === null) {
      // the key doesn't open the Developer door (a Vertex-restricted key) → try the Vertex express door
      console.error(
        `[gemini-judge] Developer API 403 (key restricted?) — falling back to Vertex express`,
      );
      await res.body?.cancel();
      base = GEMINI_VERTEX_EXPRESS_BASE;
      res = await post(base, req);
    }
    if (!res.ok) {
      console.error(
        `[gemini-judge] ${res.status} ${res.statusText} (${base}): ${
          (await res.text()).slice(0, 300)
        }`,
      );
      throw new Error(`gemini ${res.status}`); // → apiJudgeProvider catches → ABSTAIN
    }
    resolvedBase = base; // remember the door that worked
    const data = await res.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    return (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "")
      .join("");
  };
}
