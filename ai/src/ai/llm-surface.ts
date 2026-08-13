import { err, ok, type Result } from "@hazelnut/core/core/module-spi.ts";
import { validationDetail } from "@hazelnut/core/core/validation.ts";
import type { JudgeClient } from "./ai-contract.ts";
import {
  guardrailSystemPrompt,
  rawVerdict,
  taintedCodeBlock,
} from "./judge-prompt.ts";
import { DEFAULT_JUDGE_DEADLINE_MS, withDeadline } from "./judge-deadline.ts";
import {
  capBreach,
  type LLMBudget,
  type LLMCap,
  modelProvenance,
  resolveLLMCap,
  type ValueProvenance,
} from "./llm-provenance.ts";
import type {
  GuardrailCheckResult,
  GuardrailDecl,
  LLMCallDecl,
  LLMClient,
  LLMCompletionResult,
} from "./llm.ts";
import type { z } from "zod";

/**
 * The per-op `ctx.llm` surface (sibling of `ctx.emit` / `ctx.queue`). `ctx.llm.call(decl, input)` is the one
 * door an app's business logic reaches a model through — a declared external effect over a swappable Port.
 * `ctx.ts` binds this onto the rich ctx; the call core (`runLLMCall`) lives here standalone and testable.
 */
export interface LLMSurface {
  call<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
    decl: LLMCallDecl<I, O>,
    input: z.infer<I>,
  ): Promise<Result<z.infer<O>>>;
}

/** The seam dependencies `runLLMCall` closes over — the swappable client, the budget + provenance-stamp sink
 *  (`ctx.log`), the attribution principal + actor source, and the injected clock. Bound by `ctx.ts
 *  buildLLMSurface` from the live ctx; isolated here so the call core is unit-testable. */
export interface LLMSurfaceDeps {
  readonly client: LLMClient;
  readonly budget: LLMBudget;
  /** The per-op ceiling the budget is read against before each call (`defineConfig({ llm: { cap } })`).
   *  Absent ⇒ the born-on floors; `false` ⇒ the deliberate uncapped opt-out. */
  readonly cap?: LLMCap | false;
  readonly principal: string;
  readonly actorId?: string;
  readonly onBehalfOf?: string;
  /** Drop the model-origin stamp into the op's provenance accumulator (`ctx.log.set`). */
  readonly stampProvenance: (p: ValueProvenance) => void;
  readonly now: () => Date;
  /** The optional LLM-judge residual client for a guardrail's `judge` opt-in (same BYO `JudgeClient` Port the
   *  verifier uses, never bundled). Absent ⇒ deterministic checks only, residual skipped as a clean no-op. */
  readonly judgeClient?: JudgeClient;
  /** Flag an advisory (non-safety) guardrail failure into the op's `ctx.log` (the output is still returned). */
  readonly flagAdvisory?: (key: string, value: string) => void;
}

/** The reserved `ctx.log` key an advisory (non-safety) guardrail failure lands under, mirroring
 *  `VALUE_PROVENANCE_KEY`. A safety-class failure never lands here — it fail-closes instead (the err is the
 *  signal), the output never returned. */
export const GUARDRAIL_ADVISORY_KEY = "guardrailAdvisory" as const;

/**
 * The LLM-call core (05-runtime.md op-pipeline — async, can fail/timeout): validate input → check the spend
 * ceiling → render the prompt → invoke the `LLMClient` Port (a throw/timeout maps to `err("timeout")`, other
 * throws to `err("internal")`) → stamp `valueProvenance` + charge the token budget before output validation
 * (the spend and egress happened even if the output is later rejected — honest attribution) → validate the
 * output schema.
 */
export async function runLLMCall<
  I extends z.ZodTypeAny,
  O extends z.ZodTypeAny,
>(
  decl: LLMCallDecl<I, O>,
  input: z.infer<I>,
  deps: LLMSurfaceDeps,
): Promise<Result<z.infer<O>>> {
  const parsedIn = decl.input.safeParse(input);
  if (!parsedIn.success) {
    // through the one value-free wire mapper: a raw `ZodError.message` dumps whatever rides the issue (a
    // check's `params` carries the rejected value), and a `validation` err reaches the caller unredacted.
    return err(
      "validation",
      validationDetail(
        `llm call '${decl.name}': invalid input`,
        parsedIn.error,
      ),
    );
  }

  // The ceiling is read BEFORE the Port: charging after the answer records spend, it cannot refuse it, so an
  // uncapped handler loop bills every call it makes. Resolved HERE — the one layer every door into the call
  // reaches — so an omitted `cap` at any layer above still composes with the born-on floors, and `undefined`
  // means the app declared `cap: false`. A refused call reaches no model, stamps no provenance and charges
  // nothing. `forbidden` is the denial member — the same face the safety guardrail blocks through.
  const cap = resolveLLMCap(deps.cap);
  if (cap !== undefined) {
    const breach = capBreach(cap, deps.budget.spentBy(deps.principal));
    if (breach !== null) {
      return err("forbidden", `llm call '${decl.name}': ${breach}`);
    }
  }
  // The slot is taken HERE — in the same synchronous block as the check, and before the first `await`. A
  // handler that fans out (`await Promise.all(items.map(i => ctx.llm.call(decl, i)))`) is the natural batch
  // shape, and with the count advanced only after the answer every one of those calls read the same
  // pre-call total and every one of them passed. It is also why a call that fails at the Port still counts:
  // the egress happened, and a ceiling that only counts successes never advances on a failing provider.
  deps.budget.reserve(deps.principal);

  const requestedModel = decl.model ?? "default";
  const prompt = decl.prompt(parsedIn.data);

  let result: LLMCompletionResult;
  try {
    result = await deps.client.complete({ prompt, model: requestedModel });
  } catch (e) {
    // a throw/timeout from the Port — a per-call deadline overrun maps to the `timeout` err-kind; any other
    // throw is `internal`, classified exactly as a write-tx failure would be.
    const kind = isTimeout(e) ? "timeout" : "internal";
    return err(
      kind,
      `llm call '${decl.name}': ${
        kind === "timeout"
          ? "the model call exceeded its deadline"
          : "the model call failed"
      }`,
    );
  }

  // stamp the model-origin before output validation: the egress + spend happened, so provenance/budget
  // reflect it even if the output is then rejected (honest attribution, never silently dropped).
  const answeringModel = result.model ?? requestedModel;
  const provenance = modelProvenance({
    call: decl.name,
    model: answeringModel,
    at: deps.now(),
    actor: deps.actorId,
    onBehalfOf: deps.onBehalfOf,
  });
  deps.stampProvenance(provenance);
  // charge the actor's token budget (0 when the client surfaced no usage — honest, never fabricated).
  deps.budget.charge(deps.principal, result.tokens ?? 0);

  const parsedOut = decl.output.safeParse(result.text);
  if (!parsedOut.success) {
    // same value-free mapper: the value rejected here is the RAW MODEL TEXT, which the wire never carries.
    return err(
      "validation",
      validationDetail(
        `llm call '${decl.name}': model output failed the output schema`,
        parsedOut.error,
      ),
    );
  }

  // the runtime guardrail (09-verifier.md §eval — the guardrail half of the eval-vs-guardrail boundary):
  // per-request, on this validated output, after provenance/budget — never aggregates a golden set or
  // compares a baseline (that is the eval half). A safety-class failure fail-closes; a non-safety failure is
  // advisory (flagged, output still returned). Absent ⇒ the output is returned as-is.
  if (decl.guardrail !== undefined) {
    const outcome = await runGuardrail(decl.guardrail, parsedOut.data, deps);
    if (!outcome.ok) {
      if (decl.guardrail.safetyClass === true) {
        // fail-closed for the safety class — the unsafe output is blocked, never returned. err.kind "forbidden"
        // is the denial/blocked-by-policy member (vs "business", an app-authored domain rule) — the safety
        // gate is framework-enforced, so the denial face is the truer fit.
        return err(
          "forbidden",
          `llm call '${decl.name}': blocked by safety guardrail — ${
            outcome.reason ?? "failed a safety check"
          }`,
        );
      }
      // advisory (non-safety) — flag the failure into ctx.log; the output is still returned (never blocked).
      deps.flagAdvisory?.(
        GUARDRAIL_ADVISORY_KEY,
        `${decl.name}: ${outcome.reason ?? "guardrail failed (advisory)"}`,
      );
    }
  }

  return ok(parsedOut.data);
}

/**
 * Run a call's guardrail on its validated output. Deterministic checks run first, in order — the first
 * failure short-circuits, so the LLM-judge residual is never reached once a deterministic check has failed.
 * Only when every check passes and `judge` is opted-in does the residual run (a `fail` verdict fails the
 * guardrail). No judge client wired ⇒ a clean skip. A judge abstain fails closed for the safety class
 * (deny-on-uncertainty) but is a clean skip for the advisory class.
 */
export async function runGuardrail<O extends z.ZodTypeAny>(
  guardrail: GuardrailDecl<O>,
  output: z.infer<O>,
  deps: Pick<LLMSurfaceDeps, "judgeClient">,
): Promise<GuardrailCheckResult> {
  // (1) deterministic checks first — the first failure short-circuits (the judge residual is not reached).
  for (const check of guardrail.checks) {
    // an app-authored check that THROWS is a failed check, never an escaped exception: the declared class
    // decides the direction, so a throwing advisory guardrail still returns its (flagged) output.
    let r: GuardrailCheckResult;
    try {
      r = check(output);
    } catch (e) {
      r = {
        ok: false,
        reason: `guardrail check threw: ${
          e instanceof Error ? e.message : String(e)
        }`,
      };
    }
    if (!r.ok) {
      return {
        ok: false,
        ...(r.reason !== undefined ? { reason: r.reason } : {}),
      };
    }
  }
  // (2) the optional LLM-judge residual — only reached when every deterministic check passed. Read the
  // abstain-aware raw verdict (`rawVerdict` → null on abstain), not `judgeClient.judge` (which folds a
  // timeout / unreachable / malformed abstain into a vacuous pass — a fail-open). For the safety class an
  // abstain blocks the output (deny-on-uncertainty, 09-verifier.md §eval); for the advisory class a broken
  // judge is a clean skip. Same abstain-fail-closed pattern as `eval.ts scoreItem` + `runJudgeReport`.
  if (guardrail.judge === true && deps.judgeClient !== undefined) {
    const systemPrompt = guardrail.judgeRubric ?? guardrailSystemPrompt();
    // Bound the residual per-request: a hung BYO `JudgeClient` times out to `null` = abstain, so a safety
    // class fail-closes and an advisory class cleanly skips, instead of hanging the live op. Same
    // `withDeadline` discipline as eval.ts + `runJudgeReport`; `judgeDeadlineMs` tunes it per guardrail.
    const raw = await withDeadline(
      rawVerdict(deps.judgeClient, {
        systemPrompt,
        // the output is fed to the judge as data to analyze (the OWASP-LLM01 tainted-data envelope), never as
        // instructions, reusing the verify judge's `taintedCodeBlock` fence so a crafted output cannot steer
        // the residual.
        code: taintedCodeBlock(
          typeof output === "string" ? output : JSON.stringify(output),
        ),
      }),
      guardrail.judgeDeadlineMs ?? DEFAULT_JUDGE_DEADLINE_MS,
    );
    if (raw === null) {
      // abstain — the judge could not answer. Safety class ⇒ fail-closed (deny-on-uncertainty); advisory ⇒ a
      // clean skip (fall through to the deterministic pass — a broken best-effort residual never blocks).
      if (guardrail.safetyClass === true) {
        return { ok: false, reason: "judge abstained" };
      }
    } else if (raw.verdict === "fail") {
      return {
        ok: false,
        reason: `llm-judge residual flagged the output${
          raw.findings[0] ? `: ${raw.findings[0].message}` : ""
        }`,
      };
    }
  }
  return { ok: true };
}

/** A best-effort timeout discriminator for a Port throw (mirrors pipeline.ts's `isTimeoutError` posture
 *  without importing it — a name/message match on the shape a real client surfaces on deadline). */
function isTimeout(e: unknown): boolean {
  if (e instanceof Error) {
    if (e.name === "TimeoutError" || e.name === "AbortError") return true;
    if (/\btimed? ?out\b/i.test(e.message)) return true;
  }
  return false;
}
