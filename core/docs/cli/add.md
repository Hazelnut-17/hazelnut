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
src/modules/content/
├─ post.resource.ts     # a defineResource skeleton
├─ post.rowpolicy.spec.ts  # "who SHOULD see a post row", stated independently
├─ post.rowpolicy.test.ts  # checks this module's resource against its spec
└─ logic/post/          # home for operation handlers (only with --ops)
```

The skeleton is born guarded and off the wire: it declares an `owner_id` column
and a `rowPolicy` narrowing to it, but exposes neither an HTTP route nor an MCP
tool. Choose the `http:` face you need; to expose an agent tool, add an `mcp:`
card with a useful `describe` as a separate explicit choice. Opening an HTTP
route never publishes an MCP tool. The row rule and its independent spec are
already written. For caller-owned writes, use a narrow custom operation that
stamps ownership from `ctx.actor.id`: `rowPolicy` narrows reads, but does not
rewrite built-in CRUD create input. Serving rows to every caller means rewriting
`"policy"` to `"public"` AND deleting the row rule.

An `mcp:` entry curates the tool description and projection; it has no `policy`
key. Keep authorization in the existing resource row rule and operation policy.
Declare `mcp.gate` separately in the app configuration to decide who may enter
the agent door; a tool description never opens that gate.

Each module keeps its own spec/test pair beside the resource. The generated test
selects the composed model by module and resource, so `shop/post` and
`billing/post` cannot share an oracle. Standalone app resources keep their pair
at the app root. When upgrading an older app, move each module's root-level pair
into its module directory, change the test's config import to
`../../../hazelnut.config.ts`, and qualify its model lookup by module and
resource (including the module's `pgSchema`). Review each independently stated
spec before moving it; do not copy one shared root oracle onto distinct
policies.

Pass `--ops` when first creating a resource if it needs typed operations.
Re-running the same `add` command can resume an interrupted emit, but `add` does
not merge new operations into or overwrite an existing resource file.

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
declaration can compile, lint and test clean while reaching `createApp` from
nothing. `add` prevents that at the emit boundary; it does not discover
arbitrary declarations you wrote by hand.

## The operation test stub fails on purpose {#verify-green-is-not-test-green}

`--ops X` emits **three limbs per operation, crash-safely**: a kill mid-emit
never leaves a truncated limb, and re-running the same command completes
whatever limb is still missing without re-touching (or refusing on) one that
already landed:

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
scaffolded `deno task test` runs the offline `migrate drift` gate first and then
`deno test`; `ci` reaches both through that task. Once the migration is current,
the unfilled test stub still makes `deno test` red and remains a tracked
obligation — an honest red, not a silent pass.

Fill the generated `testCtx`/`t.runOp` recipe with assertions over returned
values, persisted business state, and denied/error cases. For database
semantics, use the existing live-Postgres recipe and assert the relevant
interleaving, duplicate write, or explicit-null behavior. The plain and real-PG
stubs use only these executable recipes: neither sends a core CLI user to
`explain` or a rule catalogue their build does not carry. Filling the stub does
not prove behavior unless its assertions actually exercise the operation.

Always dispose the test harness in `finally`. For the live-Postgres recipe, also
close the injected client with `sql.end()` in an outer `finally`, including when
harness setup fails: `t.dispose()` does not close a caller-owned database
connection.

CRUD operations have no `logic/` directory, get no stub, and are exempt.

`hazelnut verify` is green on a fresh emit — structure and completeness pass —
because verifying is not testing. `deno test` is the gate that fails on the
unwritten test.

## The generated skeleton

Minimal by design, and grown on demand:

<!-- @conformance:ts imports= -->

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
  // Nothing is on the wire yet: this resource creates no HTTP route and no MCP tool. Declare an `http:` face
  // deliberately; if agents should see an operation, add an `mcp:` card with a useful `describe` too — an HTTP
  // route never publishes an MCP tool. The rowPolicy above and post.rowpolicy.spec.ts are already written.
  // For caller-owned writes, use a narrow custom op and stamp the owner from `ctx.actor.id`; rowPolicy only
  // narrows rows, it does not rewrite built-in CRUD input. `"public"` lifts the permission gate but not rowPolicy.
  // mcp: { list: { describe: "List posts" } },
  // http: { list: { policy: "policy", columns: ["id", "title", "owner_id"] }, find: { policy: "policy", columns: ["id", "title", "owner_id"] }, create: "policy" },
  // transitions / owns / relates / references / policy — add as needed.
  // To add typed operations, pass `--ops <name>` when creating this resource;
  // `add` does not rewrite an existing resource declaration. Each generated handler is
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
