# `hazelnut add`

> **Reference** — for a developer growing an existing app. What `add` emits,
> what it registers for you, and what it deliberately leaves failing.

`hazelnut add` declares a module or a resource and wires it in. The framing is
_declare_, not _generate_: you receive an already-registered declaration ready
to fill in, not a pile of code you must connect yourself.

## Interface

```
hazelnut add module <name>                     # create a module
hazelnut add resource <module>/<name>          # create a resource inside a module
  [--features softDelete,audit,timestamps]     # pre-fill features
  [--ops publish,archive]                      # pre-stub these operations, with logic files
```

## What it emits

`hazelnut add resource content/post` writes:

```
post.rowpolicy.spec.ts  # "who SHOULD see a post row", stated independently
src/modules/content/
├─ post.resource.ts     # a defineResource skeleton
└─ logic/post/          # home for operation handlers (only with --ops)
```

The skeleton is born guarded and off the wire: it declares an `owner_id` column
and a `rowPolicy` narrowing to it, and its `http` line is commented out. Put it
on the wire by uncommenting that one line — the row rule and its spec are
already written, so the guarded form is the cheapest thing you can do. Serving
rows to every caller means rewriting `"policy"` to `"public"` AND deleting the
row rule, which is four edits and shows up in a diff as exactly what it is.

`hazelnut add module content` writes `content.module.ts`, carrying both the
`defineModule` call and its `ContentCtx` alias export — the type an operation
handler's signature names.

## What it registers {#auto-wiring}

Emitting is only half the verb. It also wires what it emitted:

- `post` is added to the `resources` array in `content.module.ts` — import and
  push.
- `hazelnut add module <name>` registers the module in the `modules` array in
  `hazelnut.config.ts`.

That is why the output is born structurally complete: every resource the app
declares is registered somewhere that reaches `createApp`. When there is nowhere
to register it — `add resource billing/invoice` before `add module billing` —
the command refuses and writes nothing, naming the module verb to run first. An
unregistered declaration would compile, lint and test clean while reaching
`createApp` from nothing — and `verify` would ship-block it via
`wiring/declaration-registered` — so it is never emitted.

## The operation test stub fails on purpose {#verify-green-is-not-test-green}

`--ops X` emits **three limbs per operation, atomically**:

- the `defineOp({})` entry,
- a `logic/<r>/X.ts` handler,
- a `logic/<r>/X.test.ts` test stub that fails until you fill it in.

The stub throws `"hazelnut: unimplemented op-test"`. The asymmetry is
deliberate:

| Channel     | State on a fresh emit | Why                       |
| ----------- | --------------------- | ------------------------- |
| `deno lint` | green                 | the stub is well-formed   |
| `deno test` | **red**               | the behaviour is unproven |

A _handler_ stub is green on emit, because a missing handler is a boot-fatal
wiring error the framework already refuses. A missing or unfilled **test**
crashes nothing, so it must fail loudly rather than pass silently. The
scaffolded `deno task ci` runs `deno test` as an independent step, so a cold
start is a red `deno test` and a tracked obligation — an honest red, not a
silent pass.

CRUD operations have no `logic/` directory, get no stub, and are exempt.

`hazelnut verify` is green on a fresh emit — structure and completeness pass —
because verifying is not testing. `deno test` is the gate that fails on the
unwritten test.

## The generated skeleton

Minimal by design, and grown on demand:

<!-- @conformance:skip reason=self-imports hazelnut + zod (duplicates injected header) -->

```ts
// content.module.ts
import { type Ctx, defineModule } from "hazelnut";
export const content = defineModule({
  name: "content",
  resources: [],
  exposes: [],
  deps: [],
});
// the module-typed op ctx: an op does `import type { ContentCtx }` from here,
// and every `ctx.data.<r>.*` in its handler is face-checked against this
// module's declarations.
export type ContentCtx = Ctx<typeof content>;

// post.resource.ts
import { defineResource } from "hazelnut";
import { z } from "zod";
export const post = defineResource({
  name: "post",
  schema: z.object({
    title: z.string(),
    status: z.enum(["draft", "published"]).default("draft"),
  }),
  features: { timestamps: true },
  // transitions / owns / relates / references / operations / policy — add as needed
});
```

Formalize a field only once it is used. The full declaration vocabulary — every
`features` key, every top-level option — is in [Rundown §8](../rundown.md), and
`--features` and `--ops` accept exactly those names.
