# The ai module

> **Reference** — declaring a model call and reaching a model from business
> logic.

> **AI module.** Everything on this page comes from `@hazelnut/ai`. It is not in
> `@hazelnut/core`: without it there is no `llmCalls` config key and no
> `ctx.llm`. It runs **inside your serving process**, so it is a dependency your
> deploy target resolves — a choice you make rather than one you inherit.

A model call here is a **declaration**, not a `fetch`. You state the contract
once and the framework owns the round trip: validate the input, render the
prompt, invoke a client you supplied, validate what came back.

## Start from the AI entry {#ai-entry}

An app that declares `llmCalls` must take its app builders from the AI package;
the core entry deliberately has no AI config keys:

<!-- @conformance:ts imports=createApp,defineConfig,defineLLMCall -->

```ts
import { createApp, defineConfig } from "jsr:@hazelnut/ai@0.56.0";
import { defineLLMCall } from "jsr:@hazelnut/ai@0.56.0/ai/llm.ts";
```

Use those `createApp` and `defineConfig` bindings for the registration shown
below. They keep every core config key and add `llmCalls` plus `llm`; importing
the same names from `@hazelnut/core` makes those keys a type error. Keep the AI
pin certified against your core pin; the release notes name the matching pair.

## Declaring a call

<!-- @conformance:ts imports=defineLLMCall -->

```ts
export const summarise = defineLLMCall({
  name: "summarise",
  input: z.object({ body: z.string() }),
  output: z.string(), // validated against the model's RAW TEXT — see below
  prompt: (input) => `Summarise this in one sentence:\n\n${input.body}`,
  model: "the-model-id", // optional; absent ⇒ whatever the client defaults to
});
```

**`output` validates the raw text the client returned**, not a parsed object.
The client hands back a string, and that string is what your schema sees — so a
bare `z.object({ … })` can never match one and every call would come back a
`validation` error. For structured answers, parse inside the schema:

<!-- @conformance:skip reason=fragment form=object-member shape=llm-call -->

```ts
output: z.string().transform((text, ctx) => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    ctx.addIssue({ code: "custom", message: "the model did not return JSON" });
    return z.NEVER;
  }
}).pipe(z.object({ summary: z.string() })),
```

`z.NEVER` after `addIssue` is what keeps a malformed answer a `validation`
result instead of a thrown parse error.

Call sites supply the schema's raw input type, before defaults and transforms;
the prompt renderer receives the parsed output type. Eval golden items also
store the raw value supplied to the call. Validation errors use stable generic
messages: Zod issue paths and messages are not returned because application
callbacks may interpolate submitted input or rejected model text into them.

TypeScript is not the only declaration boundary. If a call reaches config
through a cast, JavaScript adapter, or JSON-derived value, boot re-validates its
`input` and `output` Zod schemas with callable `safeParseAsync`, `prompt`, model
and guardrail card before any provider call or model provenance can exist. A
malformed value refuses as `llm/decl-invalid`, rather than becoming a silent
default. `deadlineMs` is either `0` (no framework wait) or a finite positive
millisecond value no larger than `2147483647`; the judge deadline is always
finite and positive. Boot also rejects malformed shapes and unknown keys on the
framework-owned `llm` and `llm.cap` cards, requires callable `complete` /
`judge` port methods when clients are provided, and rejects a non-callable
optional `judgeRaw` or a non-string optional judge-client `name`.
Provider-specific client options remain opaque to Hazelnut.

Register it with `llmCalls: [summarise]` on your config and call it from an
operation:

`ctx.llm.call` accepts only the same declaration object you registered in
`llmCalls`; creating a call declaration inside a handler or passing a
same-shaped copy returns `forbidden` before the provider is invoked. Keep the
declaration at module scope and use that value in both places. The framework
freezes the validated declaration snapshot at app composition, so changing a
guardrail afterward cannot weaken the boot-checked settings. Accessor-backed
declaration fields are refused as `llm/decl-invalid`.

<!-- @conformance:skip reason=fragment form=function-body context=article,ctx,summarise -->

```ts
const r = await ctx.llm.call(summarise, { body: article });
if (!r.ok) return r; // { kind: "validation" | "forbidden" | … }
const summary = r.value; // typed from the output schema
```

The call speaks `Result`, like every other fallible surface in this framework —
a model that returns something the output schema rejects is a `validation`
error, not an exception and not a half-parsed object.

Both schemas use Zod's async parser, so async refinements and transforms are
awaited as well. If app-authored schema code throws, the call returns a generic
`internal` error without forwarding that exception. Input validation completes
before provider egress; output validation follows the call and its provenance /
budget record. `deadlineMs` bounds the injected client's `complete()` wait, not
arbitrary asynchronous schema code.

The declared call adds these pieces around the injected client:

For production `hazelnut launch`, declare every provider destination in the
app's `egressHosts` as an exact `host:port` (a DNS name or IP literal plus an
explicit port; no scheme, path, or wildcard). The launcher cannot inspect an
injected client to infer its endpoint; a destination missing from the list is
denied by Deno with `NotCapable`. If `judgeClient` uses another host, declare
that destination too. Run `hazelnut launch ./app.ts --explain` to see the exact
derived grants before starting (replace `./app.ts` with your app entry module).

| Rider                 | What it gets you                                                                                                                                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **the contract**      | input validated before the prompt renders, output validated before you see it, both inferred from the same Zod schemas as everything else; asynchronous refinements/transforms are awaited.                                                        |
| **provenance**        | `ctx.log` records the model call and its `valueProvenance` stamp; this is call-level only. It does not tag a returned value or stored row, and it does not change `_audit.origin`. If you need durable field-level lineage, record it in app data. |
| **a budget**          | `ctx.llmBudget` accumulates the operation's token spend (before, handler, and after share one ceiling), keyed by the principal the call is attributed to.                                                                                          |
| **the provider seam** | `ctx.llm.call` invokes the app-supplied `LLMClient`; your client chooses its provider transport and host. This seam does not restrict other I/O in handlers.                                                                                       |
| **a deadline**        | every `complete` is raced against a wait. Absent `deadlineMs` that wait is 120 seconds; `deadlineMs: 0` opts out. A hung client is `timeout`. Honour `req.signal` to cancel the provider request.                                                  |

Thrown provider errors stay generic on the response wire. A client may add a
synchronous `classifyFailure(error)` callback that maps known failures to one of
`authentication`, `authorization`, `rate_limit`, `invalid_request`,
`unavailable`, `network`, `configuration`, or `provider`. Hazelnut records only
that closed category under `attrs.llmFailureCategory`; unknown categories,
classifier errors, and raw messages remain generic and are never serialized.

`ctx.llm.call` returns `forbidden` before invoking the client while the
operation holds a database transaction. This includes write operations and read
operations backed by a real read-only transaction (such as a pooled adapter or
an explicit operation deadline); transaction-free reads remain allowed. Move
model work to an operation that does not hold a database transaction, then
persist its result in a separate write operation. Workflow and step contexts do
not expose `ctx.llm`, and steps run transactionally, so neither is an escape
from this refusal.

The budget is charged with what the client actually reported. A client that
surfaced no usage charges zero rather than an estimate — an honest gap beats a
fabricated number.

## The client is yours, and its absence is loud

<!-- @conformance:skip reason=fragment form=object-member context=myClient shape=ai-config -->

```ts
llm: { client: myClient },
```

Any object with a `complete` method satisfies the port, so a provider SDK or an
internal gateway wraps in a few lines and never reaches your logic:

<!-- @conformance:ts imports=LLMClient -->

```ts
const myClient: LLMClient = {
  complete: async (req) => {
    const res = await fetch("https://models.example.com/v1/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: req.prompt,
        ...(req.model !== undefined ? { model: req.model } : {}),
      }),
      signal: req.signal,
    });
    const body = await res.json() as { text: string; tokens?: number };
    return { text: body.text, tokens: body.tokens };
  },
};
```

An app that declares a call and configures no client **refuses to boot**
(`llm/client-required`). That refusal is the point: with no client every call
would hand back the rendered prompt and stamp it as model output, and a database
full of prompts labelled as answers is worse than an outage, because nothing
reports it.

When `model` is absent from the call declaration, the request omits a model
override and leaves selection to the client. `ValueProvenance.model` is present
when the declaration names a model or the client reports its resolved model;
otherwise the model identity remains unknown instead of being guessed.

## Refusal index {#refusals}

| Id                          | What to change                                                                                                                                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `llm/config-invalid`        | Use valid `llm` / `llm.cap` shapes; `client.complete` and `judgeClient.judge` must be callable, optional `judgeRaw` callable, and optional `name` a string.                                                           |
| `llm/decl-invalid`          | Correct the call declaration: its schemas, prompt, model, deadline, or guardrail card is invalid.                                                                                                                     |
| `llm/client-required`       | Supply `defineConfig({ llm: { client } })` before a declared call can run.                                                                                                                                            |
| `llm/judge-client-required` | Supply `judgeClient` when a served call declares `guardrail: { judge: true }`.                                                                                                                                        |
| `llm/cap-invalid`           | Set each configured cap ceiling to a finite number greater than or equal to zero.                                                                                                                                     |
| `llm/transaction-open`      | Run `ctx.llm.call()` from an operation that does not hold a database transaction, then persist its result in a separate write operation. Workflow and step contexts do not expose `ctx.llm`; steps are transactional. |
| `llm/call-unregistered`     | Pass the exact declaration object registered in `llmCalls`; a handler-local declaration or same-shaped copy is not that registered call.                                                                              |
| `llm/unknown-key`           | Correct the typo on `llm` or `llm.cap`; only framework-owned keys are checked.                                                                                                                                        |

## Guardrails

A guardrail is a per-request check on one validated output. It is not an
evaluation — it never aggregates a set or compares a baseline.

<!-- @conformance:ts imports=defineLLMCall -->

```ts
export const reply = defineLLMCall({
  name: "reply",
  input: z.object({ question: z.string() }),
  output: z.string(),
  prompt: (input) => input.question,
  guardrail: {
    // deterministic, cheap, and run first — a failure short-circuits before any judge
    checks: [(out) => ({ ok: out.length <= 300, reason: "too long" })],
    safetyClass: true,
  },
});
```

The order is fixed and worth knowing: input validation → cap → prompt rendering
and string check → reserve → the client → provenance and budget charge → output
validation → the guardrail. A `cap` breach returns `forbidden` and never renders
the prompt. If your prompt renderer throws or returns anything other than a
primitive string, the call returns an `internal` error before any client request
or budget slot is taken. A guardrail therefore only ever sees output that
already matched your schema.

`safetyClass` decides what a failure does:

| `safetyClass` | A failing check                                                            |
| ------------- | -------------------------------------------------------------------------- |
| `true`        | **blocks** the output — the call returns a `forbidden` error and no value. |
| absent/false  | flags an advisory into `ctx.log`, and the output is still returned.        |

A safety-class refusal returns a stable, generic reason. Check exceptions and
judge findings can contain model output or application data, so their detail is
not copied into the served error response.

Each deterministic check must return `{ ok: boolean, reason?: string }` at
runtime. A malformed result is treated as a failure rather than tested by
JavaScript truthiness: safety-class calls block, while advisory calls are
flagged and still return the validated output.

Add `judge: true` for a language-model residual after the deterministic checks —
for the part of "is this answer acceptable" no predicate expresses. It needs a
second client, `llm: { judgeClient }`. A served `judge: true` with no
`judgeClient` **refuses to boot** (`llm/judge-client-required`): a guardrail
that cannot decide would allow the output, while the same guardrail with a
working judge would refuse it, and a check whose verdict depends on its own
availability is not a check. A `judgeClient` with no live `judge: true` is
silent. `judgeRubric` supplies the question and `judgeDeadlineMs` bounds the
wait. When that deadline expires, Hazelnut aborts the judge request signal
before blocking a safety-class result or skipping an advisory residual. Judge
clients should honor the signal to stop provider work; a client that ignores it
may continue after Hazelnut has returned. Configured API-judge abstain retries
also stop on cancellation and do not launch a later attempt.

When a judge-backed guardrail inspects a non-string output, Hazelnut sends its
JSON representation; strings are sent as text. If the validated value cannot be
serialized (for example, a Zod transform returns a `bigint`), serialization is a
guardrail failure, not an escaped exception: a safety-class guardrail blocks the
result, while an advisory guardrail flags it and still returns the validated
value.

An abstaining judge follows the same rule as everything else here: on a
`safetyClass` guardrail it is a **block** (deny on uncertainty), and on an
advisory one it is a clean skip. The output is handed to the judge as data
inside a tainted-content envelope, never as instructions, so a crafted answer
cannot steer its own review.

The AI module validates a frozen copy of the judge's data before using it. A
judge cannot change its verdict or findings between validation and the safety
decision; malformed or accessor-backed results abstain.

`judgeProvider("gemini", { apiKey })` builds a shipped API adapter with that
provider's own rules already applied. For an API the registry does not ship,
import `apiJudgeProvider` (and its `ApiTransport` seam) from
`@hazelnut/ai/ai/judge-api.ts`; it keeps the same fenced prompt, strict verdict
parsing, abstention, and retry behavior while the app owns API auth and wire
formatting. `retries` is a finite non-negative integer: each value adds that
many abstain retries to the first attempt, so invalid configuration fails at
construction instead of creating an unbounded verifier wait. An API adapter's
judge talks HTTP only — it never widens a deployment's run permissions.

## Capping the spend

<!-- @conformance:skip reason=fragment form=object-member shape=ai-config -->

```ts
llm: { cap: { maxCalls: 4, maxTokens: 20_000 } },
```

The per-operation, per-principal ceiling. It is read **before** the model is
reached, because a charge after the fact records spend and cannot prevent it.
Before, handler, and after of one operation share that ceiling.

**You have this ceiling whether or not you write it.** Declare nothing and every
operation runs under **20 calls and 200,000 tokens** per principal — enough for
any handler that is doing work, and immediate for the loop that is not. Declare
one ceiling and the other still takes its default, so
`cap: { maxTokens: 5_000 }` is a token limit _and_ the standing call limit, and
`cap: {}` is both defaults rather than none. Raise either one the moment your
workload needs it; that is a line in your config and a decision you made.

To run with no ceiling at all, write `cap: false`. Nothing else means unlimited
— an omitted key never does, because absent-means-unbounded on the one knob that
spends money is a bill, not a default. A ceiling that is not a finite number at
or above zero stops the boot (`llm/cap-invalid`): every comparison against such
a value is false, so the cap would be configured and enforce nothing.

`maxTokens` refuses once the principal's accumulated spend has _reached_ the
ceiling: the pending call's own token count is unknowable until the model
answers, so that is the last honest refusal point. The first call of an
operation therefore always reaches the model, however large its context. A
ceiling that is not a finite number at or above zero is refused at boot rather
than silently enforcing nothing.

You will see the refusal as `err("forbidden")`. HTTP maps that to 403; MCP maps
`forbidden` to `-32002`. The message names the ceiling it hit and the key that
raises it. If you see one you did not expect, the operation made more model
calls than you thought it did — read it before you raise the number.

The budget is per operation invocation: before, handler, and after share one
budget, and each new operation gets a fresh one. It is not a cumulative
per-principal quota across requests or jobs. The principal key records which
actor — or on whose behalf — spent within that operation.
