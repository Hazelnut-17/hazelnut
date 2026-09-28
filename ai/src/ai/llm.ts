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
  LLMFailureCategory,
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
 * The App-LLM seam floor (05-runtime.md §app-llm-seam — `defineLLMCall` / `ctx.llm`), distinct from the verify-judge: a
 * thin Port keeping the actual provider (raw SDK or gateway) behind an app-supplied seam. `ctx.llm.call`
 * attaches call-site behavior such as the token budget and `valueProvenance` model-origin stamp; the app's
 * injected client owns provider transport and network behavior.
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
  "deadlineMs",
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

/** The immutable, app-local LLM declaration roster. The resolver accepts only the original declaration
 *  identities supplied by the consumer (or their frozen snapshots exposed on App.llmCalls), and always
 *  returns the exact snapshot that was validated at composition. */
export interface LLMCallRegistry {
  readonly calls: ReadonlyArray<LLMCallDecl>;
  readonly errors: ReadonlyArray<string>;
  resolve(declaration: unknown): LLMCallDecl | undefined;
}

const llmCallRegistries = new WeakSet<object>();

/** Snapshot a call roster once without invoking declaration accessors. App composition validates this same
 *  snapshot and injects its resolver into `ctx.llm`, so a getter/proxy cannot present one guardrail at boot
 *  and a different one at execution. */
export function snapshotLLMCallRoster(input: unknown): LLMCallRegistry {
  const errors: string[] = [];
  const aliases = new WeakMap<object, LLMCallDecl>();
  const calls: LLMCallDecl[] = [];
  const snapshotRecord = (
    value: unknown,
    label: string,
  ): Record<string, unknown> | undefined => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`llm/decl-invalid: ${label} must be a data record`);
      return undefined;
    }
    let descriptors: PropertyDescriptorMap;
    try {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        errors.push(`llm/decl-invalid: ${label} must be a plain data record`);
        return undefined;
      }
      descriptors = Object.getOwnPropertyDescriptors(value);
    } catch {
      errors.push(
        `llm/decl-invalid: ${label} properties could not be inspected`,
      );
      return undefined;
    }
    const record = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") {
        errors.push(`llm/decl-invalid: ${label} cannot contain symbol keys`);
        continue;
      }
      const descriptorEntry = Object.getOwnPropertyDescriptor(
        descriptors,
        key,
      );
      const descriptor = descriptorEntry?.value as
        | PropertyDescriptor
        | undefined;
      if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
        errors.push(
          `llm/decl-invalid: ${label}.${key} must be a data property, not an accessor`,
        );
        continue;
      }
      record[key] = descriptor.value;
    }
    return record;
  };

  const snapshotArray = (
    value: unknown,
    label: string,
  ): readonly unknown[] | undefined => {
    let isArray: boolean;
    try {
      isArray = Array.isArray(value);
    } catch {
      errors.push(`llm/decl-invalid: ${label} could not be inspected`);
      return undefined;
    }
    if (!isArray) {
      errors.push(`llm/decl-invalid: ${label} must be an array`);
      return undefined;
    }
    let descriptors: PropertyDescriptorMap;
    try {
      descriptors = Object.getOwnPropertyDescriptors(value);
    } catch {
      errors.push(
        `llm/decl-invalid: ${label} properties could not be inspected`,
      );
      return undefined;
    }
    const descriptorRecord = Object.getOwnPropertyDescriptor(
      descriptors,
      "length",
    );
    const lengthDescriptor = descriptorRecord?.value as
      | PropertyDescriptor
      | undefined;
    const length = lengthDescriptor?.value;
    if (typeof length !== "number" || !Number.isSafeInteger(length)) {
      errors.push(`llm/decl-invalid: ${label} length is invalid`);
      return undefined;
    }
    const values: unknown[] = [];
    for (let index = 0; index < length; index++) {
      const descriptorEntry = Object.getOwnPropertyDescriptor(
        descriptors,
        String(index),
      );
      const descriptor = descriptorEntry?.value as
        | PropertyDescriptor
        | undefined;
      if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
        errors.push(
          `llm/decl-invalid: ${label}[${index}] must be a data element`,
        );
        values.push(undefined);
      } else {
        values.push(descriptor.value);
      }
    }
    for (const key of Reflect.ownKeys(descriptors)) {
      if (key === "length") continue;
      if (
        typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) ||
        Number(key) >= length
      ) {
        errors.push(`llm/decl-invalid: ${label} cannot contain extra keys`);
      }
    }
    return Object.freeze(values);
  };

  const snapshotCall = (value: unknown, index: number): LLMCallDecl => {
    const label = `llmCalls[${index}]`;
    const call = snapshotRecord(value, label) ?? Object.create(null);
    if (call.guardrail !== undefined) {
      const guardrail = snapshotRecord(call.guardrail, `${label}.guardrail`);
      if (guardrail !== undefined && guardrail.checks !== undefined) {
        guardrail.checks = snapshotArray(
          guardrail.checks,
          `${label}.guardrail.checks`,
        );
      }
      call.guardrail = guardrail === undefined
        ? null
        : Object.freeze(guardrail);
    }
    return Object.freeze(call) as LLMCallDecl;
  };

  let roster: readonly unknown[] | undefined;
  if (input === undefined) {
    roster = [];
  } else {
    roster = snapshotArray(input, "llmCalls");
  }
  for (const [index, source] of (roster ?? []).entries()) {
    const snapshot = snapshotCall(source, index);
    calls.push(snapshot);
    if (source !== null && typeof source === "object") {
      aliases.set(source, snapshot);
    }
    aliases.set(snapshot, snapshot);
  }
  const frozenCalls = Object.freeze(calls);
  const registry: LLMCallRegistry = Object.freeze({
    calls: frozenCalls,
    errors: Object.freeze(errors),
    resolve(declaration: unknown): LLMCallDecl | undefined {
      if (declaration === null || typeof declaration !== "object") {
        return undefined;
      }
      return aliases.get(declaration);
    },
  });
  llmCallRegistries.add(registry);
  return registry;
}

/** A registry passed to the runtime must originate from the snapshotter, not a structural lookalike. */
export function isLLMCallRegistry(value: unknown): value is LLMCallRegistry {
  return value !== null && typeof value === "object" &&
    llmCallRegistries.has(value);
}

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
  // Value validation runs first at app boot. Keep this function defensive as well because it is exported and
  // a cast/JSON configuration can call it directly with something that is not an object.
  if (decl === null || typeof decl !== "object") return errs;
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

const llmDeclName = (decl: Record<string, unknown>) =>
  typeof decl.name === "string" ? decl.name : "<unnamed>";

/** Validate values at the JavaScript configuration boundary. `defineLLMCall` is typed, but deployment config
 * can arrive through a cast or JSON adapter; key-only validation let a numeric model and malformed guardrail
 * reach the provider and stamp invalid model provenance. */
export function checkLLMCallValues(decl: unknown): string[] {
  if (decl === null || typeof decl !== "object" || Array.isArray(decl)) {
    return ["llm/decl-invalid: an llm call declaration must be an object"];
  }
  const d = decl as Record<string, unknown>;
  const name = llmDeclName(d);
  const errs: string[] = [];
  if (typeof d.name !== "string") {
    errs.push("llm/decl-invalid: an llm call name must be a string");
  }
  for (const schema of ["input", "output"] as const) {
    let value: unknown;
    try {
      value = d[schema];
    } catch {
      errs.push(
        `llm/decl-invalid: llm call '${name}' ${schema} could not be read`,
      );
      continue;
    }
    let hasAsyncParser = false;
    try {
      hasAsyncParser = value !== null && typeof value === "object" &&
        typeof (value as { safeParseAsync?: unknown }).safeParseAsync ===
          "function";
    } catch {
      // An accessor-backed parser is not a trustworthy schema at boot.
    }
    if (!hasAsyncParser) {
      errs.push(
        `llm/decl-invalid: llm call '${name}' ${schema} must be a Zod schema with safeParseAsync`,
      );
    }
  }
  if (typeof d.prompt !== "function") {
    errs.push(
      `llm/decl-invalid: llm call '${name}' prompt must be a function`,
    );
  }
  if (d.model !== undefined && typeof d.model !== "string") {
    errs.push(
      `llm/decl-invalid: llm call '${name}' model must be a string`,
    );
  }
  if (
    d.deadlineMs !== undefined &&
    !(typeof d.deadlineMs === "number" &&
      (d.deadlineMs === 0 ||
        (Number.isFinite(d.deadlineMs) && d.deadlineMs >= 1 &&
          d.deadlineMs <= 2_147_483_647)))
  ) {
    errs.push(
      `llm/decl-invalid: llm call '${name}' deadlineMs must be 0 (off) or a number of milliseconds between 1 and 2147483647`,
    );
  }
  if (d.guardrail === undefined) return errs;
  if (
    d.guardrail === null || typeof d.guardrail !== "object" ||
    Array.isArray(d.guardrail)
  ) {
    errs.push(
      `llm/decl-invalid: llm call '${name}' guardrail must be an object`,
    );
    return errs;
  }
  const g = d.guardrail as Record<string, unknown>;
  if (
    !Array.isArray(g.checks) ||
    g.checks.some((check) => typeof check !== "function")
  ) {
    errs.push(
      `llm/decl-invalid: llm call '${name}' guardrail.checks must be an array of functions`,
    );
  }
  for (const key of ["safetyClass", "judge"] as const) {
    if (g[key] !== undefined && typeof g[key] !== "boolean") {
      errs.push(
        `llm/decl-invalid: llm call '${name}' guardrail.${key} must be a boolean`,
      );
    }
  }
  if (g.judgeRubric !== undefined && typeof g.judgeRubric !== "string") {
    errs.push(
      `llm/decl-invalid: llm call '${name}' guardrail.judgeRubric must be a string`,
    );
  }
  if (
    g.judgeDeadlineMs !== undefined &&
    !(typeof g.judgeDeadlineMs === "number" &&
      Number.isFinite(g.judgeDeadlineMs) &&
      g.judgeDeadlineMs >= 1 && g.judgeDeadlineMs <= 2_147_483_647)
  ) {
    errs.push(
      `llm/decl-invalid: llm call '${name}' guardrail.judgeDeadlineMs must be a finite number of milliseconds between 1 and 2147483647 — a shorter bound abstains before any judge can answer`,
    );
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
    // self-identify as the fixture so provenance never launders the echoed prompt into the audit trail under
    // the real declared model name. With no requested id, the fixture reports its own configured default.
    model: `fixture:${req.model ?? "client-default"}`,
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
