// The AI-family type contract: JudgeClient/LLMClient Ports and the LLMCall/Eval/Guardrail declaration
// shapes the runtime config surface types against (core/config.ts, core/app-define.ts), split from the
// judge/ value tooling, which re-exports these. The verify module remains the barrel.
import { Verdict } from "@hazelnut/core/core/module-spi.ts";
import type { z } from "zod";

export interface JudgeRequest {
  readonly systemPrompt: string;
  readonly code: string;
}

export interface JudgeClient {
  readonly judge: (req: JudgeRequest) => Promise<Verdict>;
  /** The abstain channel — `null` when the judge could not answer (timeout / unreachable / malformed). A
   *  client without it has only `judge`, whose every answer is a real verdict, so a caller that fails closed
   *  on uncertainty (a safety-class guardrail) cannot see the difference; a throw reads as abstain instead. */
  readonly judgeRaw?: (req: JudgeRequest) => Promise<Verdict | null>;
  readonly name?: string;
}

export interface GuardrailCheckResult {
  readonly ok: boolean;
  readonly reason?: string;
}
export type GuardrailCheck<O extends z.ZodTypeAny = z.ZodTypeAny> = (
  output: z.infer<O>,
) => GuardrailCheckResult;

export interface GuardrailDecl<O extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly checks: ReadonlyArray<GuardrailCheck<O>>;
  readonly safetyClass?: boolean;
  readonly judge?: boolean;
  /** The app-owned rubric system prompt the LLM-judge residual judges against (absent ⇒ the L0 judge prompt). */
  readonly judgeRubric?: string;
  /** Per-call deadline (ms) for the LLM-judge residual on this guardrail (absent ⇒ `DEFAULT_JUDGE_DEADLINE_MS`).
   *  A hung judge times out to abstain — safety-class ⇒ fail-closed (deny), advisory ⇒ skip — never hangs the op. */
  readonly judgeDeadlineMs?: number;
}

export interface LLMCallDecl<
  I extends z.ZodTypeAny = z.ZodTypeAny,
  O extends z.ZodTypeAny = z.ZodTypeAny,
> {
  readonly name: string;
  readonly input: I;
  readonly output: O;
  /** Render the request text from the validated input (the framework validates against `input` first). */
  readonly prompt: (input: z.infer<I>) => string;
  /** The default model id for this call (carried into the `valueProvenance` stamp); absent ⇒ the client's. */
  readonly model?: string;
  readonly guardrail?: GuardrailDecl<O>;
}

export interface LLMCompletionRequest {
  readonly prompt: string;
  readonly model: string;
}

export interface LLMCompletionResult {
  readonly text: string;
  readonly tokens?: number;
  readonly model?: string;
}

export interface LLMClient {
  readonly complete: (
    req: LLMCompletionRequest,
  ) => Promise<LLMCompletionResult>;
}

export interface GoldenItem<I extends z.ZodTypeAny> {
  readonly label?: string;
  readonly input: z.infer<I>;
}

export interface RubricVerdict {
  readonly pass: boolean;
  readonly note?: string;
  readonly useJudge?: boolean;
}

export interface EvalRubric<I extends z.ZodTypeAny, O extends z.ZodTypeAny> {
  /** Deterministic score for one (validated) call output against its golden item — the first pass. */
  readonly score: (output: z.infer<O>, item: GoldenItem<I>) => RubricVerdict;
  /** Optional LLM-judge residual prompt for an item escalated to the judge (rendered from output+item). */
  readonly judgeRubric?: (output: z.infer<O>, item: GoldenItem<I>) => string;
}

export interface EvalDecl<
  I extends z.ZodTypeAny = z.ZodTypeAny,
  O extends z.ZodTypeAny = z.ZodTypeAny,
> {
  readonly name: string;
  readonly call: LLMCallDecl<I, O>;
  readonly goldenSet: ReadonlyArray<GoldenItem<I>>;
  readonly rubric: EvalRubric<I, O>;
  /** The aggregate pass-rate (0..1) the golden set must meet or beat; below it is a regression. Absent ⇒ no gate. */
  readonly baseline?: number;
}
