import type { z } from "zod";
import type { OnlyKnownKeys } from "@hazelnut/core/core/module-spi.ts";
// re-exported from the runtime AI contract so tooling import sites hold
export type {
  GuardrailCheck,
  GuardrailCheckResult,
  GuardrailDecl,
  LLMCallDecl,
  LLMClient,
  LLMCompletionRequest,
  LLMCompletionResult,
} from "./ai-contract.ts";
import type {
  LLMCallDecl,
  LLMClient,
  LLMCompletionRequest,
  LLMCompletionResult,
} from "./ai-contract.ts";
// the verify-judge seam (judge.ts) — the guardrail's optional LLM-judge residual reuses the same `JudgeClient`
// Port discipline. type-only: the guardrail closes over a caller-supplied client, never constructs one.

/**
 * The App-LLM seam floor (05-runtime.md §4.3 — `defineLLMCall` / `ctx.llm`), distinct from the verify-judge: a
 * thin Port keeping the actual provider (raw SDK or gateway) out of app code as a BYO seam. `ctx.llm.call`
 * attaches four call-site concerns the op-pipeline cannot otherwise see: token budget, the `valueProvenance`
 * model-origin stamp, PII-egress classification at `purity/no-external-io`, and the swappable injected Port.
 */

/**
 * `defineLLMCall({ name, input, output, prompt, model? })` — declares an app LLM call as a first-class
 * declaration (sibling of `defineView` / `defineReadModel` / `defineWorkflow`), pure data composed onto
 * `App.llmCalls` at `createApp` so the catalog + verifier can see it. `input`/`output` are Zod schemas, so
 * the contract derives from one source by composition, never codegen.
 */
/** One deterministic guardrail check — a cheap predicate over the schema-validated output. `ok === true` ⇒
 *  the output passes; runs before any judge residual, so a deterministic fail short-circuits the round-trip. */

/** The per-call guardrail declaration (the guardrail half of the eval-vs-guardrail boundary). `checks` run
 *  first, deterministic. `safetyClass: true` ⇒ a failure fail-closes (err, output blocked); falsy ⇒ advisory
 *  (output still returned, flagged into `ctx.log`). `judge` opts into the optional LLM-judge residual, run
 *  after the deterministic checks, against `judgeRubric` (absent ⇒ the framework's L0 prompt). */

/** The framework-owned key vocabulary for an LLM-call declaration — strict on framework keys so a typo'd key
 *  is a loud boot fail, mirroring `defineResource`'s `decl/unknown-key`. */
const LLM_CALL_KEYS: ReadonlySet<string> = new Set([
  "name",
  "input",
  "output",
  "prompt",
  "model",
  "guardrail",
]);

/** The framework-owned key vocabulary for the nested guardrail card. Validated too: a typo in the safety
 *  selector fails open (`safteyClass` isn't `safetyClass`, so the guardrail silently reads as advisory) with
 *  no boot error otherwise — a nested unknown key is as load-bearing as a top-level one. */
const GUARDRAIL_KEYS: ReadonlySet<string> = new Set([
  "checks",
  "safetyClass",
  "judge",
  "judgeRubric",
  "judgeDeadlineMs",
]);

/** `defineLLMCall(decl)` — the typed identity entry (pure data; composed at `createApp`). `I`/`O` are
 *  inferred from the `input`/`output` Zod schemas, so `prompt(input)` gets a typed `z.infer<I>`, never `unknown`. */
export function defineLLMCall<
  I extends z.ZodTypeAny,
  O extends z.ZodTypeAny,
  D = unknown,
>(
  decl: LLMCallDecl<I, O> & OnlyKnownKeys<D, LLMCallDecl<I, O>>,
): LLMCallDecl<I, O> {
  return decl;
}

/** Validate an LLM-call declaration's framework keys (the `createApp` boot guard reads this). Returns the
 *  list of unknown-key errors — a typo'd key is a loud boot fail, never a silent no-op. */
export function checkLLMCallKeys(decl: LLMCallDecl): string[] {
  const errs: string[] = [];
  for (const k of Object.keys(decl)) {
    if (!LLM_CALL_KEYS.has(k)) {
      errs.push(
        `unknown llm-call declaration key '${k}' on llm call '${decl.name}'`,
      );
    }
  }
  // recurse into the guardrail card: a nested typo (esp. `safteyClass` → fails open) is a loud boot fail too,
  // same `decl/unknown-key` discipline the top-level keys get.
  if (decl.guardrail && typeof decl.guardrail === "object") {
    for (const k of Object.keys(decl.guardrail)) {
      if (!GUARDRAIL_KEYS.has(k)) {
        errs.push(`unknown guardrail key '${k}' on llm call '${decl.name}'`);
      }
    }
  }
  return errs;
}

// ── The LLMClient Port (the thin JudgeClient-style async-call discipline) ───────────────────────────────

/** One completion request handed to the `LLMClient` Port — the rendered `prompt` text and the resolved
 *  `model` id. Deliberately the thin judge-`JudgeRequest` shape; the gateway's richer surface (system /
 *  messages / tools / temperature) is the wired client's concern, not the floor Port's. */

/** One completion result from the Port — the raw `text` the call's `output` schema parses, plus an optional
 *  `tokens` count (a client that omits it accumulates 0 — honest, never fabricated). `model` echoes which
 *  model actually answered; absent ⇒ the requested model is used for provenance. */

/** The `LLMClient` Port (the App-LLM seam) — a thin async interface mirroring `JudgeClient`'s `judge`. A
 *  deployment wires a real provider behind it; the floor supplies a deterministic stub
 *  (`makeFixtureLLMClient`). Never bundled — no cloud SDK lives in `src/`; the provider is a BYO Port. */

/** The deterministic fixture LLM client — the floor result source in tests (the real provider stays BYO).
 *  Defaults to echoing the rendered `prompt` as `text` with a word-count token count; a test needing a
 *  specific shape passes a `respond` mapper. Mirrors `makeFixtureJudgeClient`: zero-cost, no live model call. */
export function makeFixtureLLMClient(
  respond: (
    req: LLMCompletionRequest,
  ) => LLMCompletionResult | Promise<LLMCompletionResult> = (req) => ({
    text: req.prompt,
    tokens: req.prompt.trim() === ""
      ? 0
      : req.prompt.trim().split(/\s+/).length,
    // self-identify as the fixture so provenance reads `model:"fixture:<x>"`, never laundering the echoed
    // prompt into the audit trail under the real declared model name.
    model: `fixture:${req.model}`,
  }),
): LLMClient {
  return { complete: (req) => Promise.resolve(respond(req)) };
}

// The client reaches `ctx.llm` ONLY by injection (`defineConfig({ llm: { client } })` → `llmCtxExtras`), per-app
// on the closure. NEVER a process global with a fixture default: that served echoed prompt text as genuine model
// output, stamped `source:"model"` into provenance, with no configuration error anywhere.

// ── (2) valueProvenance — the trust-critical model-origin stamp ─────────────────────────────────────────

// extracted into cohesive submodules, re-exported so importers stay stable.
export * from "./llm-provenance.ts";
export * from "./llm-surface.ts";
