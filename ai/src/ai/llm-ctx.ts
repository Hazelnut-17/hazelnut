/**
 * `ctx.llm` — composed here and INJECTED into the core op-ctx (05-runtime.md §app-llm-seam).
 *
 * `buildOpCtx` ships in the public core artifact, so it cannot import this seam: that static edge is what put
 * the whole App-LLM seam into a package with no surface to reach it from. Core names one opaque hook
 * (`CtxExtras`) and spreads whatever a module injects; this module is the injection. Types widen by
 * intersection (`AiRichCtx`), not `declare module` — JSR refuses the latter in a published package.
 */
import { Clock, OpLog } from "@hazelnut/core/core/module-spi.ts";
import { err } from "@hazelnut/core";
import type { Actor } from "@hazelnut/core/authz/auth.ts";
import type { CtxExtras, RichCtx } from "@hazelnut/core/core/ctx-surface.ts";
import { buildOpCtx } from "@hazelnut/core/core/ctx-surface.ts";
import type { JudgeClient, LLMCallDecl } from "./ai-contract.ts";
import type { AiRichCtx } from "./ctx-module.ts";
import {
  accumulateValueProvenance,
  attributionPrincipal,
  checkLLMCallKeys,
  checkLLMCallValues,
  isLLMCallRegistry,
  LLM_FAILURE_CATEGORY_KEY,
  type LLMBudget,
  type LLMCallRegistry,
  type LLMCap,
  type LLMClient,
  type LLMSurface,
  makeLLMBudget,
  runLLMCall,
  snapshotLLMCallRoster,
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
 * token budget, and a model-origin stamp into `ctx.log`. Provider network behavior belongs to the injected
 * client; this surface does not restrict other I/O in a handler. A `defineLLMCall` guardrail
 * (09-verifier.md §eval) fail-closes on a safety failure, else is advisory only.
 */
export function buildLLMSurface(
  base: {
    readonly actor: Actor | null;
    readonly transactionActive?: boolean;
  },
  log: OpLog,
  budget: LLMBudget,
  clock: Clock,
  client: LLMClient,
  registry: LLMCallRegistry,
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
  const flagFailureCategory = (
    category: import("./ai-contract.ts").LLMFailureCategory,
  ) => {
    const prior = log.attrs[LLM_FAILURE_CATEGORY_KEY];
    log.set(
      LLM_FAILURE_CATEGORY_KEY,
      typeof prior === "string"
        ? [prior, category]
        : Array.isArray(prior)
        ? [...prior, category]
        : category,
    );
  };
  return {
    call: (decl, input) => {
      const registered = registry.resolve(decl);
      if (registered === undefined) {
        return Promise.resolve(
          err(
            "forbidden",
            "llm/call-unregistered: ctx.llm.call accepts only a defineLLMCall registered in the app's llmCalls roster",
          ),
        );
      }
      if (base.transactionActive === true) {
        return Promise.resolve(
          err(
            "forbidden",
            "llm/transaction-open: ctx.llm.call cannot run while this operation holds a database transaction; call it from a transaction-free operation, then persist its result in a separate write operation (workflow/step contexts do not expose ctx.llm)",
          ),
        );
      }
      // Registration maps the exact typed declaration identity to a snapshot with the same schema objects;
      // preserve that identity's I/O type face after the runtime membership check.
      return runLLMCall(registered as typeof decl, input, {
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
        flagFailureCategory,
      });
    },
  };
}

/**
 * The `CtxExtras` factory carrying `ctx.llm` + `ctx.llmBudget` onto every op ctx.
 *
 * One budget per op log: the pipeline rebuilds the ctx per before/handler/after step but threads the
 * same `log`, so the cap bounds the operation rather than resetting at each rebuild. A second request
 * mints a new log and a new budget. `client` is REQUIRED — every model result reaching an op traces to
 * one injected, per-app Port, so there is no path by which a caller gets fake output without having asked
 * for it.
 */
type LLMCtxExtrasOptions =
  & {
    readonly client: LLMClient;
    /** The optional LLM-judge residual client for a guardrail's `judge` opt-in (BYO, never bundled).
     *  Absent ⇒ a `judge:true` guardrail runs its deterministic checks only. */
    readonly judgeClient?: JudgeClient;
    /** The per-op spend ceiling every call is checked against. One budget per op log, so the cap
     *  bounds before + handler + after together. Absent ⇒ the born-on floors; `false` ⇒ the
     *  deliberate uncapped opt-out. */
    readonly cap?: LLMCap | false;
  }
  & (
    | {
      readonly registry: LLMCallRegistry;
      readonly calls?: never;
    }
    | {
      readonly calls: ReadonlyArray<LLMCallDecl>;
      readonly registry?: never;
    }
  );

export function llmCtxExtras(opts: LLMCtxExtrasOptions): CtxExtras {
  if (opts === undefined || opts === null || typeof opts !== "object") {
    throw new Error(
      "llm/decl-invalid: llmCtxExtras requires a client and exactly one of registry or calls",
    );
  }
  if ((opts.registry === undefined) === (opts.calls === undefined)) {
    throw new Error(
      "llm/decl-invalid: llmCtxExtras requires exactly one of registry or calls",
    );
  }
  const registry = opts.registry ?? snapshotLLMCallRoster(opts.calls);
  if (!isLLMCallRegistry(registry)) {
    throw new Error(
      "llm/decl-invalid: llmCtxExtras requires a framework call registry",
    );
  }
  const rosterErrors = [...registry.errors];
  for (const call of registry.calls) {
    rosterErrors.push(...checkLLMCallValues(call), ...checkLLMCallKeys(call));
  }
  if (rosterErrors.length > 0) {
    throw new Error(rosterErrors.join("\n"));
  }
  const budgets = new WeakMap<object, LLMBudget>();
  return ({ actor, log, now, transactionActive }) => {
    let llmBudget = budgets.get(log);
    if (llmBudget === undefined) {
      llmBudget = makeLLMBudget();
      budgets.set(log, llmBudget);
    }
    return {
      llm: buildLLMSurface(
        { actor, transactionActive },
        log,
        llmBudget,
        now,
        opts.client,
        registry,
        opts.judgeClient,
        opts.cap,
      ),
      llmBudget,
    };
  };
}
