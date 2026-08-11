/**
 * `ctx.llm` — composed here and INJECTED into the core op-ctx (05-runtime.md §4.3).
 *
 * `buildOpCtx` ships in the public core artifact, so it cannot import this seam: that static edge is what put
 * the whole App-LLM seam into a package with no surface to reach it from. Core names one opaque hook
 * (`CtxExtras`) and spreads whatever a module injects; this module is the injection. Types widen by
 * intersection (`AiRichCtx`), not `declare module` — JSR refuses the latter in a published package.
 */
import { Clock, OpLog } from "@hazelnut/core/core/module-spi.ts";
import type { Actor } from "@hazelnut/core/authz/auth.ts";
import type { CtxExtras, RichCtx } from "@hazelnut/core/core/ctx-surface.ts";
import { buildOpCtx } from "@hazelnut/core/core/ctx-surface.ts";
import type { JudgeClient } from "./ai-contract.ts";
import type { AiRichCtx } from "./ctx-module.ts";
import {
  accumulateValueProvenance,
  attributionPrincipal,
  type LLMBudget,
  type LLMCap,
  type LLMClient,
  type LLMSurface,
  makeLLMBudget,
  runLLMCall,
  VALUE_PROVENANCE_KEY,
  type ValueProvenance,
} from "./llm.ts";

export type { AiCtxMembers, AiRichCtx } from "./ctx-module.ts";

/** Narrow a composed ctx that received `llmCtxExtras` to the AI members — runtime already carries them. */
export function asAiCtx(ctx: RichCtx): asserts ctx is AiRichCtx {
  if (!("llm" in ctx) || !("llmBudget" in ctx)) {
    throw new Error(
      "asAiCtx: ctx is missing llm / llmBudget — pass llmCtxExtras into buildOpCtx (or use buildAiOpCtx)",
    );
  }
}

/** `buildOpCtx` plus this module's injected members, typed as `AiRichCtx`. */
export function buildAiOpCtx(
  ...args: Parameters<typeof buildOpCtx>
): AiRichCtx {
  const ctx = buildOpCtx(...args);
  asAiCtx(ctx);
  return ctx;
}

/**
 * Builds the `ctx.llm` surface: `call(decl, input)` runs `runLLMCall` with the swappable client, the op's
 * token budget, a model-origin stamp into `ctx.log`, and the declared `purity/no-external-io` egress. A
 * `defineLLMCall` guardrail (09-verifier.md §eval) fail-closes on a safety failure, else is advisory only.
 */
export function buildLLMSurface(
  base: { readonly actor: Actor | null },
  log: OpLog,
  budget: LLMBudget,
  clock: Clock,
  client: LLMClient,
  judgeClient?: JudgeClient,
  cap?: LLMCap | false,
): LLMSurface {
  const principal = attributionPrincipal(base.actor);
  // Each ctx.llm.call appends its model-origin stamp under the one reserved key (never a plain overwrite),
  // so N calls in one op yield N stamps; a single call keeps the string shorthand, a second promotes to a list.
  const stampProvenance = (p: ValueProvenance) =>
    log.set(
      VALUE_PROVENANCE_KEY,
      accumulateValueProvenance(log.attrs[VALUE_PROVENANCE_KEY], p),
    );
  // A non-safety (advisory) guardrail failure lands in the same ctx.log provenance accumulator (no parallel
  // store) — the audit/oversight layer reads it back under the reserved key, like the provenance stamp.
  const flagAdvisory = (key: string, value: string) => log.set(key, value);
  return {
    call: (decl, input) =>
      runLLMCall(decl, input, {
        client,
        budget,
        ...(cap !== undefined ? { cap } : {}),
        principal,
        ...(base.actor !== null ? { actorId: base.actor.id } : {}),
        ...(base.actor?.onBehalfOf !== undefined
          ? { onBehalfOf: base.actor.onBehalfOf }
          : {}),
        stampProvenance,
        now: clock,
        ...(judgeClient !== undefined ? { judgeClient } : {}),
        flagAdvisory,
      }),
  };
}

/**
 * The `CtxExtras` factory carrying `ctx.llm` + `ctx.llmBudget` onto every op ctx.
 *
 * One budget per built ctx, matching the pre-injection behaviour exactly: the pipeline rebuilds the ctx per
 * step and never threaded a budget across those rebuilds either. `client` is REQUIRED — every model result
 * reaching an op traces to one injected, per-app Port, so there is no path by which a caller gets fake output
 * without having asked for it.
 */
export function llmCtxExtras(
  opts: {
    readonly client: LLMClient;
    /** The optional LLM-judge residual client for a guardrail's `judge` opt-in (BYO, never bundled).
     *  Absent ⇒ a `judge:true` guardrail runs its deterministic checks only. */
    readonly judgeClient?: JudgeClient;
    /** The per-op spend ceiling every call is checked against. One budget per built ctx, so the cap bounds
     *  one op's handler — which is the loop that had nothing stopping it. Absent ⇒ the born-on floors;
     *  `false` ⇒ the deliberate uncapped opt-out. */
    readonly cap?: LLMCap | false;
  },
): CtxExtras {
  return ({ actor, log, now }) => {
    const llmBudget = makeLLMBudget();
    return {
      llm: buildLLMSurface(
        { actor },
        log,
        llmBudget,
        now,
        opts.client,
        opts.judgeClient,
        opts.cap,
      ),
      llmBudget,
    };
  };
}
