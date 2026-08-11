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

<!-- @conformance:skip reason=illustrative fragment, the surrounding decl is above -->

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

Register it with `llmCalls: [summarise]` on your config and call it from an
operation:

<!-- @conformance:skip reason=illustrative fragment, ctx and summarise come from the surrounding op -->

```ts
const r = await ctx.llm.call(summarise, { body: article });
if (!r.ok) return r; // { kind: "validation" | "forbidden" | … }
const summary = r.value; // typed from the output schema
```

The call speaks `Result`, like every other fallible surface in this framework —
a model that returns something the output schema rejects is a `validation`
error, not an exception and not a half-parsed object.

Four things ride along that a hand-rolled `fetch` cannot have:

| Rider                   | What it gets you                                                                                                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **the contract**        | input validated before the prompt renders, output validated before you see it, both inferred from the same Zod schemas as everything else.                                                          |
| **provenance**          | every call stamps a model-origin record into `ctx.log`, so a value that came from a model stays distinguishable from one a human wrote — after the fact, with no instrumentation at the call sites. |
| **a budget**            | `ctx.llmBudget` accumulates the operation's token spend, keyed by the principal the call is attributed to.                                                                                          |
| **the egress boundary** | the call is the declared way out of the process, which is what lets the purity rules permit it at all.                                                                                              |

The budget is charged with what the client actually reported. A client that
surfaced no usage charges zero rather than an estimate — an honest gap beats a
fabricated number.

## The client is yours, and its absence is loud

<!-- @conformance:skip reason=illustrative config fragment, not a whole declaration -->

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
      body: JSON.stringify({ prompt: req.prompt, model: req.model }),
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
    // deterministic, cheap, and run first — a failure short-circuits before any model is asked
    checks: [(out) => ({ ok: out.length <= 300, reason: "too long" })],
    safetyClass: true,
  },
});
```

The order is fixed and worth knowing: input validation → prompt → the client →
provenance and budget → output validation → the guardrail. A guardrail therefore
only ever sees output that already matched your schema.

`safetyClass` decides what a failure does:

| `safetyClass` | A failing check                                                            |
| ------------- | -------------------------------------------------------------------------- |
| `true`        | **blocks** the output — the call returns a `forbidden` error and no value. |
| absent/false  | flags an advisory into `ctx.log`, and the output is still returned.        |

Add `judge: true` for a language-model residual after the deterministic checks —
for the part of "is this answer acceptable" no predicate expresses. It needs a
second client, `llm: { judgeClient }`, and declaring one without the other
**refuses to boot** (`llm/judge-client-required`): a guardrail that cannot
decide would allow the output, while the same guardrail with a working judge
would refuse it, and a check whose verdict depends on its own availability is
not a check. `judgeRubric` supplies the question and `judgeDeadlineMs` bounds
the wait.

An abstaining judge follows the same rule as everything else here: on a
`safetyClass` guardrail it is a **block** (deny on uncertainty), and on an
advisory one it is a clean skip. The output is handed to the judge as data
inside a tainted-content envelope, never as instructions, so a crafted answer
cannot steer its own review.

`judgeProvider("gemini", { apiKey })` builds a shipped API adapter with that
provider's own rules already applied; anything else goes through the raw
provider seam and implements `JudgeProvider`. Every judge reachable from a
served process talks HTTP — nothing here spawns a program, so a deployment's run
permissions do not have to widen.

## Capping the spend

<!-- @conformance:skip reason=illustrative config fragment, not a whole declaration -->

```ts
llm: { cap: { maxCalls: 4, maxTokens: 20_000 } },
```

The per-operation, per-principal ceiling. It is read **before** the model is
reached, because a charge after the fact records spend and cannot prevent it.

**You have this ceiling whether or not you write it.** Declare nothing and every
operation runs under **20 calls and 200,000 tokens** per principal — enough for
any handler that is doing work, and immediate for the loop that is not. Declare
one ceiling and the other still takes its default, so
`cap: { maxTokens: 5_000 }` is a token limit _and_ the standing call limit, and
`cap: {}` is both defaults rather than none. Raise either one the moment your
workload needs it; that is a line in your config and a decision you made.

To run with no ceiling at all, write `cap: false`. Nothing else means unlimited
— an omitted key never does, because absent-means-unbounded on the one knob that
spends money is a bill, not a default.

`maxTokens` refuses once the principal's accumulated spend has _reached_ the
ceiling: the pending call's own token count is unknowable until the model
answers, so that is the last honest refusal point. The first call of an
operation therefore always reaches the model, however large its context. A
ceiling that is not a finite number at or above zero is refused at boot rather
than silently enforcing nothing.

You will see the refusal as a `403` whose message names the ceiling it hit and
the key that raises it. If you see one you did not expect, the operation made
more model calls than you thought it did — read it before you raise the number.

Both ceilings are per principal, and the principal is the identity the call is
attributed to — an actor, or whoever an operation is acting on behalf of. That
is deliberate: one runaway caller should not consume another's allowance.
