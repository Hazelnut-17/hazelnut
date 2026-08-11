/**
 * The AI module's view of `App` — the members this module composes onto the core-composed app.
 *
 * Separate from the verify module's merge because the two modules run in different PHASES. `ai` is
 * runtime-phase: `ctx.llm` answers inside a request, so its members must be reachable from the process that
 * SERVES. The verify module is tooling-phase and must not be. Merged together, a consumer could not have one
 * without the other, and declaring `llm` meant loading the verifier into production.
 *
 * Typed as an intersection (not `declare module`): JSR refuses module / global augmentation in a published
 * package (`globalTypeAugmentation`), including in a `.d.ts`. The published `@hazelnut/ai` entry therefore
 * exports `App = CoreApp & AiAppMembers` so holding the type does not require ambient merge.
 */
import type { App as CoreApp } from "@hazelnut/core/core/app-define.ts";
import type { LLMCallDecl, LLMClient } from "./ai-contract.ts";

/** Members this module adds onto core's `App`. Named once so import-site teeth can set-equal over them. */
export interface AiAppMembers {
  // Composed `defineLLMCall` declarations (05-runtime.md §4.3), reached by the catalog/metadata + verifier.
  readonly llmCalls?: ReadonlyArray<LLMCallDecl>;
  // The App-LLM seam binding — `ctx.llm` reaches this client through the injected `ctxExtras`;
  // `setLLMClient`/`getLLMClient` is the app-less test-seam default only.
  readonly llm?: { readonly client?: LLMClient };
}

/** The module members on `AiAppMembers`, as data — the single source the import-site tooth derives from. */
export const AI_APP_MEMBERS = ["llmCalls", "llm"] as const;

/** Core's `App` plus this module's members — the type `createApp` from this package returns. */
export type App = CoreApp & AiAppMembers;
