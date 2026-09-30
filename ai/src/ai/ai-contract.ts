// The AI-family type contract: JudgeClient/LLMClient Ports and the LLMCall/Eval/Guardrail declaration
// shapes the runtime config surface types against (core/config.ts, core/app-define.ts), split from the
// judge/ value tooling, which re-exports these. The verify module remains the barrel.
import { Verdict } from "@hazelnut/core/core/module-spi.ts";
import type { z } from "zod";

export interface JudgeRequest {
  readonly systemPrompt: string;
  readonly code: string;
  /** Optional repo root for a local judge that needs to inspect the graded source tree. */
  readonly workingDirectory?: string;
  /** Aborted when a framework-owned judge deadline expires. Honour it to stop provider I/O; ignored, the
   *  caller still stops waiting and treats the judge as abstained. */
  readonly signal?: AbortSignal;
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
  /** What a FAILING check does: `true` blocks the output (`err("forbidden")`), absent ⇒ the output is
   *  returned and flagged. Absence selects the permissive tier, so a guardrail that must stop an answer
   *  reaching the caller says so here. A near-miss cannot fail open silently: a typo'd key is rejected by
   *  this type, and past a cast, boot throws naming it. */
  readonly safetyClass?: boolean;
  /** Opt in to the LLM-judge residual on this guardrail (absent ⇒ the `checks` above are the whole rung). */
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
  /** Render primitive request text from the validated input (the framework checks the runtime result too). */
  readonly prompt: (input: z.infer<I>) => string;
  /** An optional model id override (carried into `valueProvenance` when known); absent ⇒ the client's default. */
  readonly model?: string;
  /** Per-call wait (ms) for `complete`. Absent ⇒ `DEFAULT_LLM_DEADLINE_MS` (120s, same floor as the judge
   *  residual). `0` opts out. A hung Port becomes `err("timeout")`; `req.signal` is aborted so a client that
   *  honours it can cancel the underlying request. The race itself only stops waiting. */
  readonly deadlineMs?: number;
  readonly guardrail?: GuardrailDecl<O>;
}

export interface LLMCompletionRequest {
  readonly prompt: string;
  /** Omitted when the client should choose its configured default. */
  readonly model?: string;
  /** Aborted when the call's deadline elapses. Honour it to cancel the provider request; ignored, the
   *  framework still stops waiting and returns `timeout`. */
  readonly signal?: AbortSignal;
}

export interface LLMCompletionResult {
  readonly text: string;
  readonly tokens?: number;
  readonly model?: string;
}

/** Closed, non-sensitive operator categories an injected LLM client may use to classify a thrown provider
 *  failure. Raw errors, provider messages, credentials, and response bodies never enter provenance. */
export type LLMFailureCategory =
  | "authentication"
  | "authorization"
  | "rate_limit"
  | "invalid_request"
  | "unavailable"
  | "network"
  | "configuration"
  | "provider";

export interface LLMClient {
  readonly complete: (
    req: LLMCompletionRequest,
  ) => Promise<LLMCompletionResult>;
  /** Optional synchronous projection from a provider exception to a closed safe category. Unknown values or
   *  a classifier that throws remain generic. The exception is passed only to this app-owned callback. */
  readonly classifyFailure?: (error: unknown) => LLMFailureCategory | undefined;
}

export interface GoldenItem<I extends z.ZodTypeAny> {
  readonly label?: string;
  /** The value supplied at the call boundary, before the declared schema parses/transforms it. */
  readonly input: z.input<I>;
}

export interface RubricVerdict {
  readonly pass: boolean;
  readonly note?: string;
  /** Ignored. Escalation is `!pass` plus a declared `judgeRubric` and a configured judge. */
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
