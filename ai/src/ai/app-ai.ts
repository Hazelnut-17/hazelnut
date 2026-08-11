/**
 * `createApp` / `defineConfig` for the AI module — the core entry plus the config keys this module owns.
 *
 * This module is RUNTIME-phase: `ctx.llm` answers inside a request, so an app that declares a call needs
 * this composition in the process that SERVES. That is the whole reason it is not folded into the verify
 * module's entry: composed together, declaring `llm` dragged the verifier, the principle roster and the
 * judge into production — 54 runtime module files where this layer costs 6.
 */
import {
  type BootSeams,
  createApp as coreCreateApp,
  type CreateAppConfig,
  groupDeclErrors,
  NoUnknownKeys,
  segmentErr,
} from "@hazelnut/core/core/module-spi.ts";
import type { CtxExtras } from "@hazelnut/core/core/ctx-surface.ts";
import type { App } from "./app-module.ts"; // CoreApp & AiAppMembers — the published type face (no ambient merge)
import type { JudgeClient, LLMCallDecl, LLMClient } from "./ai-contract.ts";
import { checkLLMCallKeys } from "./llm.ts";
import { LLM_CAP_KNOBS, type LLMCap } from "./llm-provenance.ts";
import { llmCtxExtras } from "./llm-ctx.ts";

/** The config keys this module ADDS to `CreateAppConfig`. Named once, as data, so a reach tooth is a
 *  set-equality over it rather than a hand-kept list. */
export const AI_CONFIG_KEYS = ["llmCalls", "llm"] as const;

/** The full AI-module `createApp` config: every core knob plus this module's own. */
export interface AiAppConfig extends CreateAppConfig {
  readonly llmCalls?: ReadonlyArray<LLMCallDecl>;
  readonly llm?: {
    readonly client?: LLMClient;
    /** The guardrail's LLM-judge residual (`defineLLMCall({ guardrail: { judge: true } })`). Without a door
     *  here the guardrail's judge branch was unreachable in every served app and fell through to ALLOW —
     *  `defineConfig` is exact, so a consumer could not add the key, and injecting `llmCtxExtras` by hand
     *  collides with this module's own ctx contributor. */
    readonly judgeClient?: JudgeClient;
    /** The per-op, per-principal `ctx.llm` spend ceiling — same containment shape as `schedulingCap`:
     *  declared here, threaded at boot, enforced before the model is reached, and BORN-ON like that
     *  sibling. Absent (or a knob left out) ⇒ that ceiling's floor; `false` ⇒ the deliberate uncapped
     *  opt-out, the only shape under which a handler loop bills unbounded paid calls. */
    readonly cap?: LLMCap | false;
  };
}
type _AiKeysComplete = Exclude<
  Exclude<keyof AiAppConfig, keyof CreateAppConfig>,
  (typeof AI_CONFIG_KEYS)[number]
> extends never ? true
  : never; // a new module key missing from AI_CONFIG_KEYS is a compile error, not a silently untested key
const _keysComplete: _AiKeysComplete = true;
void _keysComplete;

/** The boot guards over this module's own declarations — the `decl/unknown-key` strict-parse discipline
 *  `defineResource` gets, plus the `llm/client-required` fail-closed refuse. Thrown BEFORE the core entry
 *  composes anything, so a bad declaration never reaches a live relay or router. */
export function guardAiDecls(config: AiAppConfig, booted: boolean): void {
  const errs: string[] = [];
  const llmCalls = config.llmCalls ?? [];
  for (const c of llmCalls) {
    const e = segmentErr(c.name, "llm call");
    if (e) errs.push(e);
    errs.push(...checkLLMCallKeys(c));
  }
  // `llm/cap-invalid` — a ceiling that is not a finite, non-negative number never fires: every comparison
  // against NaN is false, so `cap: { maxCalls: Number(Deno.env.get("LLM_MAX")) }` with the var unset reads as
  // a configured cap and enforces nothing. A dead ceiling is worse than a declared absence, so it refuses.
  // Folds the knob roster rather than a literal list, so a new ceiling is validated the day it exists.
  const declaredCap = config.llm?.cap;
  if (declaredCap !== undefined && declaredCap !== false) {
    for (const k of Object.keys(LLM_CAP_KNOBS) as (keyof LLMCap)[]) {
      const v = declaredCap[k];
      if (v !== undefined && !(Number.isFinite(v) && v >= 0)) {
        errs.push(
          `llm/cap-invalid: defineConfig({ llm: { cap: { ${k} } } }) is ${v} — a ceiling must be a finite number >= 0, or every comparison against it is false and the cap silently enforces nothing`,
        );
      }
    }
  }
  if (errs.length > 0) throw new Error(groupDeclErrors(errs));
  // llm/client-required — a `defineLLMCall` app with no client silently returns the rendered prompt as fake
  // 'model output' stamped source:"model". Model-independent, so it refuses here rather than in the
  // model-derived guard set core owns. SERVED PATH ONLY, exactly as the model-derived guards are: the
  // pure-model path (verify/migrate/catalog) never runs a call, so refusing it would break every
  // model-only reader of a declared app.
  if (booted && llmCalls.length > 0 && config.llm?.client === undefined) {
    throw new Error(
      `llm/client-required: the app declares defineLLMCall(s) but no LLM client is configured — pass defineConfig({ llm: { client } }) with a real LLMClient (or the testCtx fixture in tests). Refusing to boot: with no client every ctx.llm.call would silently return the rendered prompt as fake 'model output' and stamp it source:"model" into provenance.`,
    );
  }

  // Same posture, one rung down: a guardrail can opt into an LLM-judge residual, and with no judge client
  // that branch cannot decide — and `runGuardrail` falls through to ALLOW. A `safetyClass` guardrail whose
  // judge is wired-but-broken fail-CLOSES, so a never-wired one silently fail-opening is the asymmetry this
  // refuses. Served path only, exactly as above.
  if (
    booted && config.llm?.judgeClient === undefined &&
    llmCalls.some((c) =>
      (c as { readonly guardrail?: { readonly judge?: boolean } }).guardrail
        ?.judge === true
    )
  ) {
    throw new Error(
      `llm/judge-client-required: a defineLLMCall declares guardrail: { judge: true } but no judge client is configured — pass defineConfig({ llm: { judgeClient } }). Refusing to boot: with no judge that guardrail cannot decide and would ALLOW the output, while the same guardrail with a broken judge refuses it.`,
    );
  }
}

/** The client bound to `ctx.llm` when the app configures none — every call REFUSES, loudly and by the same
 *  `llm/client-required` name the boot guard uses. Absence MUST be loud: the deleted process-global default
 *  answered with the echoed prompt, which `runLLMCall` then stamped `source:"model"` into provenance. */
export const REFUSING_LLM_CLIENT: LLMClient = {
  complete: () => {
    throw new Error(
      `llm/client-required: ctx.llm.call reached a model with no LLM client configured — pass defineConfig({ llm: { client } }) with a real LLMClient (or the testCtx fixture in tests). Refusing rather than answering: a stand-in would return the rendered prompt as fake 'model output' and stamp it source:"model" into provenance.`,
    );
  },
};

export function createApp(
  config: AiAppConfig,
  boot: BootSeams,
): App & { readonly fetch: (req: Request) => Response | Promise<Response> };
export function createApp(config: AiAppConfig): App;
export function createApp(config: AiAppConfig, boot?: BootSeams): App {
  guardAiDecls(config, boot !== undefined);
  const { llmCalls, llm, ...core } = config;
  // `ctx.llm` reaches the app's own client through the injected-members seam core exposes — the client is
  // per-app on the closure, never a process global, so two apps in one process cannot clobber each other's.
  // APPENDED to whatever the caller passed rather than merged by hand: the hand-merge here was a spread, so
  // a caller who happened to inject the same member name lost it silently. `buildOpCtx` folds the list and
  // refuses a collision loud instead.
  const theirs = core.ctxExtras === undefined
    ? []
    : Array.isArray(core.ctxExtras)
    ? core.ctxExtras
    : [core.ctxExtras as CtxExtras];
  const ctxExtras: readonly CtxExtras[] = [
    ...theirs,
    llmCtxExtras({
      client: llm?.client ?? REFUSING_LLM_CLIENT,
      ...(llm?.judgeClient ? { judgeClient: llm.judgeClient } : {}),
      // `!== undefined`, never truthiness: `cap: false` is the declared uncapped opt-out, and a truthy test
      // drops it — which silently re-imposes the floors the app just opted out of.
      ...(llm?.cap !== undefined ? { cap: llm.cap } : {}),
    }),
  ];
  const withSeam = { ...core, ctxExtras };
  const app = boot === undefined
    ? coreCreateApp(withSeam)
    : coreCreateApp(withSeam, boot);
  // Composed onto the SAME object the core entry closed the router over, so a served app and a model-only one
  // read one App. `Object.assign` (not a spread) is what makes that identity hold.
  return Object.assign(app, {
    llmCalls: llmCalls ?? [],
    ...(llm?.client ? { llm: { client: llm.client } } : {}),
  });
}

/** The typed identity entry for the AI module's config surface — `defineConfig`'s `<const C>` literal
 *  preservation, over `AiAppConfig` instead of the core `AppLevelConfig`. Exact over the module's own
 *  roster too, so a stray key is a compile error at the property, never a boot-time `decl/unknown-key`. */
export function defineConfig<const C extends AiAppConfig>(
  config: NoUnknownKeys<C, AiAppConfig>,
): C {
  return config;
}
