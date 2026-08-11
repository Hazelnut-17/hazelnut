/**
 * The AI module's `ctx` members — typed without `declare module`.
 *
 * JSR refuses module / global augmentation in a published package (`globalTypeAugmentation`). Core's
 * `RichCtx` stays the merge-target for in-tree tooling that still needs ambient widen; this package
 * widens by intersection instead so `@hazelnut/ai` can publish. Runtime injection is unchanged:
 * `llmCtxExtras` still spreads `llm` / `llmBudget` onto the composed ctx.
 */
import type { RichCtx } from "@hazelnut/core/core/ctx-surface.ts";
import type { LLMBudget, LLMSurface } from "./llm.ts";

/** Members this module injects onto every op ctx via `llmCtxExtras`. */
export interface AiCtxMembers {
  /**
   * `ctx.llm.call(decl, input)` — the one door business logic reaches a model through: validate input →
   * render prompt → invoke the swappable `LLMClient` Port → validate output. Attaches a token budget, a
   * `valueProvenance` model-origin stamp into `ctx.log`, and the `purity/no-external-io` egress.
   */
  readonly llm: LLMSurface;
  /** The op-level LLM token budget — the per-op accumulator every `ctx.llm.call` charges, keyed by the
   *  attribution principal (`onBehalfOf`/actor id/`anonymous`). The provenance drain reads its roll-up. */
  readonly llmBudget: LLMBudget;
}

/** Core's `RichCtx` plus this module's injected members. */
export type AiRichCtx = RichCtx & AiCtxMembers;
