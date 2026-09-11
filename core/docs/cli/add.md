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
post.rowpolicy.test.ts  # the spec's teeth on a core build
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

`hazelnut add module content` writes `src/modules/content/content.module.ts`,
carrying both the `defineModule` call and its `ContentCtx` alias export — the
type an operation handler's signature names.

## What it registers {#auto-wiring}

Emitting is only half the verb. It also wires what it emitted:

- `post` is added to the `resources` array in `content.module.ts` — import and
  push.
- `hazelnut add module <name>` registers the module in the `modules` array in
  `hazelnut.config.ts`.

That is why the output is born structurally complete: every resource the app
declares is registered somewhere that reaches `createApp`. When there is nowhere
to register it — `add resource billing/invoice` before `add module billing`, or
a module file with no `import` / `resources: [` line to splice into — the
command refuses and writes nothing. A missing module names the module verb to
run first. A missing splice names the line it needed. Either way you do not get
an unregistered file every later gate would pass over. An unregistered
declaration would compile, lint and test clean while reaching `createApp` from
nothing — and `verify` would ship-block it via `wiring/declaration-registered` —
so it is never emitted.

## The operation test stub fails on purpose {#verify-green-is-not-test-green}

`--ops X` emits **three limbs per operation, atomically**:

- the resource `operations` entry (import + name),
- a `logic/<r>/X.ts` handler (`defineOp({})`),
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
    owner_id: z.string(), // who the row belongs to — the column the row rule narrows on
  }),
  features: { timestamps: true, versioning: false },
  // WHICH ROWS, per caller — the ownership shorthand: `<column> = <the caller's id>`, and the ANONYMOUS
  // caller (who arrives as a NON-NULL actor holding no claim) is denied outright, by construction. Swap
  // `owner_id` for the column that carries ownership; anything beyond ownership takes the fragment form
  // (`none`/`owned`/`shared` from "hazelnut/query"), where that denial must be written with `isAnonymous`.
  rowPolicy: "owner_id",
  // Nothing is on the wire yet. UNCOMMENT to expose — the rowPolicy above and post.rowpolicy.spec.ts are
  // already written, so the guarded form costs this one line. `"public"` lifts the permission gate;
  // a declared rowPolicy still narrows. Serving every row means `"public"` AND deleting the row rule.
  // http: { list: { policy: "policy", columns: ["id", "title", "owner_id"] }, find: { policy: "policy", columns: ["id", "title", "owner_id"] }, create: "policy" },
  // transitions / owns / relates / references / policy — add as needed.
  // operations: re-run `add resource` with `--ops <name>` — it writes the typed handler,
  // annotated with this module's `Ctx`, so a resource-name typo is a compile error.
});
```

Formalize a field only once it is used. The full declaration vocabulary — every
`features` key, every top-level option — is in the
[Rundown feature tour](../rundown.md). `--features` pre-fills the keys the verb
knows: `timestamps`, `softDelete`, `audit`, `scope`, `versioning`, `sequence`.
`sequence` writes `{ field: "seq", strategy: "locked-row" }`, never `true`.
`--features audit` writes `sensitive: []` (the boot-required "no PII" answer).
`--features scope` refuses unless `hazelnut.config.ts` already declares
`scope: { key, resolve }` — the resource flag alone cannot boot. A top-level key
(`encrypted`, `i18n`, `vector`) you write by hand after the skeleton lands.
`tree` is a `features:{}` flag the verb does not pre-fill — write
`features: { tree: true }` by hand; `--features tree` is unknown. `--ops` takes
operation names you choose, not feature keys.
