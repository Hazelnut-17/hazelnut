/**
 * The API judge provider registry (09-verifier.md §judge) — select a shipped judge by name and supply its key;
 * the framework wires the adapter with that provider's own rules baked in. An exotic provider drops to the
 * raw `apiJudgeProvider` seam.
 *
 * HTTP transports only. This module is runtime-phase, so a provider that SPAWNS would put `--allow-run` of a
 * non-`deno` binary inside the consumer's served process; the agent-CLI judges are `judge/judge-cli.ts §cliJudge`.
 */
import { apiJudgeProvider } from "./judge-api.ts";
import { geminiTransport } from "./judge-gemini.ts";
import { type JudgeProvider, requireJudgeKey } from "./judge-providers.ts";

/** The shipped, name-selectable API judge providers. An exotic one uses the raw `apiJudgeProvider` seam. */
export type JudgeProviderName = "gemini";

export interface JudgeProviderConfig {
  /** The provider's API key. Required — an API judge has no other authentication path. */
  readonly apiKey?: string;
  /** Model override (gemini defaults to `gemini-2.5-flash`). */
  readonly model?: string;
  /** Extra abstain retries (default 2 — these live judges are flaky; 0 disables). */
  readonly retries?: number;
  /** API base override (e.g. pin the Vertex express endpoint for gemini). */
  readonly endpoint?: string;
}

/** Select a shipped API judge provider by name; the returned `JudgeProvider` is labeled with that name (the
 *  verify summary reads it). Throws if a key-needing provider has none. */
export function judgeProvider(
  name: JudgeProviderName,
  config: JudgeProviderConfig = {},
): JudgeProvider {
  const retries = config.retries ?? 2;
  let built: JudgeProvider;
  switch (name) {
    case "gemini":
      built = apiJudgeProvider({
        model: config.model || "gemini-2.5-flash", // `||` (not `??`) so an EMPTY-string model (e.g. `GEMINI_MODEL=`) also falls to the default
        transport: geminiTransport(requireJudgeKey("gemini", config.apiKey), {
          ...(config.endpoint ? { endpoint: config.endpoint } : {}),
        }),
        retries,
      });
      break;
  }
  return { ...built, name }; // label by the selected provider name (the verify summary reads `provider`)
}
