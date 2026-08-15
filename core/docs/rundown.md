# Rundown

> **How-to** — for a developer building on Hazelnut. Task-oriented: find the
> concern, use the one supported way. If you have never booted the framework,
> follow the [Quickstart](./QUICKSTART.md) first — it is fifteen minutes and
> this page assumes it.

Every snippet below is real API, compiled against the shipped surface before
this page is published.

## What you get

You write **one `defineResource`** per entity. From that single declaration
Hazelnut derives, at boot, **by composition — nothing is generated to disk**:

- the **four TypeScript faces** — `Insertable`, `Updatable`, `Row`, and the
  read-shape (all inferred, never written to a file);
- the **HTTP routes** (list / find / create / update / delete, plus any custom
  operation);
- the **Postgres schema** (columns, indexes, the framework's own tables);
- the **operation pipeline** (validate → policy → transaction → handler →
  `Result`) that every write flows through.

Because it all derives, there is no watcher and no generated code to keep in
sync. Change the declaration and everything re-derives at the next boot.

## One way per concern {#sole-ways}

Hazelnut holds a **single supported path per concern** — no legacy facade, no
"modern vs classic" pair, no dual init. Scan this table before reaching for a
pattern: if what you are about to write is not in the middle column, you are
about to hand-roll something the framework already owns.

| Concern                        | The one way                                   | Where                       |
| ------------------------------ | --------------------------------------------- | --------------------------- |
| Declare an entity              | `defineResource`                              | §2                          |
| Link two entities              | `references` / `owns` / `relates`             | §2                          |
| A maintained aggregate         | `rollups` + `count` / `sum` / `avg`           | §8                          |
| Group entities                 | `defineModule`                                | §5                          |
| Boot the app                   | `createApp`                                   | §3                          |
| Project config / secrets       | `defineConfig` (env read at YOUR config site) | §3                          |
| Non-CRUD behaviour             | `defineOp` on the resource's `operations`     | §6                          |
| Who may call                   | `http: "policy"` + perms                      | §7                          |
| Which rows they may touch      | `rowPolicy` (AND-ed into read **and** write)  | §7                          |
| Tenant/row partitioning        | `scope`                                       | §7                          |
| Identity                       | `defineAuth`                                  | §7                          |
| Email + password login         | `passwordLogin` + `passwordAuthResolver`      | §7                          |
| A permission vocabulary        | `derivePerms`                                 | §7                          |
| A perm key no resource seeds   | `definePerms`                                 | §7                          |
| Legal state changes            | `transitions` + `ctx.transition`              | §8                          |
| Field-level secrecy            | `encrypted`                                   | §8                          |
| A narrowed / cross-module read | `defineView`                                  | §5                          |
| A maintained read projection   | `defineReadModel`                             | §5                          |
| Tell other modules             | `emits` + `ctx.emit` (transactional outbox)   | §9                          |
| React to an event              | `defineSubscriber`                            | §9                          |
| Work on a schedule             | `defineJob` (leaderless exactly-once tick)    | §9                          |
| A durable work queue           | `defineWorker` (pull, retry, dead-letter)     | §9                          |
| Long work a caller polls       | `defineTask` (submit, then poll a result)     | §9                          |
| Multi-step durable process     | `defineWorkflow`                              | §9                          |
| Call OUT to a third party      | `defineWebhook` (SSRF floor + HMAC)           | §9                          |
| Raw SQL the repo can't express | a `queries/` file + `ctx.query(sql, params)`  | §4                          |
| Another SQL database           | `datasources` + `ctx.datasource(name)`        | §10                         |
| Agent-callable surface         | `mcp` curation on the resource                | §2                          |
| A reusable prompt over MCP     | `definePrompt`                                | §2                          |
| Read an older stored event     | `defineUpcaster`                              | §9                          |
| Call your API from TypeScript  | `hazelnutClient`                              | §3                          |
| Breaking API shape change      | `defineVersion`                               | §13                         |
| Test an operation              | `testCtx` (real or shallow)                   | §11                         |
| Test one module in isolation   | `moduleSlice`                                 | §11                         |
| Change the DB schema           | `hazelnut migrate` (never on boot)            | [migrate](./cli/migrate.md) |
| Serve in production            | `hazelnut launch` (derives least-privilege)   | [launch](./cli/launch.md)   |
| Check the environment          | `hazelnut doctor`                             | [doctor](./cli/doctor.md)   |

**When none of these fits**, the sanctioned escape hatches are explicit, not
improvised: raw SQL in a `queries/` file run through `ctx.query` (§4), a
project-built client inside an operation, or your own Deno lint plugin. Reaching
for one is a normal outcome; quietly re-implementing a row above it is not.

## 1. Setup

Hazelnut is a Deno library. A project's `deno.json` maps the import and the
stack. **`hazelnut new` emits this file** — it is the canonical form, and you
should not hand-write a divergent copy. One key is load-bearing:
`nodeModulesDir: "auto"`, which drizzle-kit's Node loader needs.

<!-- @conformance:scaffold file=deno.json build=core -->

```json
{
  "imports": {
    "hazelnut": "file:///path/to/hazelnut/src/mod-core.ts",
    "hazelnut/query": "file:///path/to/hazelnut/src/surface/query.ts",
    "hazelnut/async": "file:///path/to/hazelnut/src/surface/async.ts",
    "hazelnut/crypto": "file:///path/to/hazelnut/src/surface/crypto.ts",
    "hazelnut/faces": "file:///path/to/hazelnut/src/surface/faces.ts",
    "hazelnut/": "file:///path/to/hazelnut/src/",
    "@hazelnut/core": "file:///path/to/hazelnut/src/mod-core.ts",
    "@hazelnut/core/query": "file:///path/to/hazelnut/src/surface/query.ts",
    "@hazelnut/core/async": "file:///path/to/hazelnut/src/surface/async.ts",
    "@hazelnut/core/crypto": "file:///path/to/hazelnut/src/surface/crypto.ts",
    "@hazelnut/core/faces": "file:///path/to/hazelnut/src/surface/faces.ts",
    "@hazelnut/core/": "file:///path/to/hazelnut/src/",
    "zod": "npm:zod@4.4.3",
    "hono": "npm:hono@4.12.27",
    "hono/": "npm:/hono@4.12.27/",
    "drizzle-orm": "npm:drizzle-orm@1.0.0-rc.4",
    "drizzle-orm/": "npm:/drizzle-orm@1.0.0-rc.4/",
    "drizzle-kit": "npm:drizzle-kit@1.0.0-rc.4",
    "@electric-sql/pglite": "npm:@electric-sql/pglite@0.5.4",
    "@electric-sql/pglite-pgvector": "npm:@electric-sql/pglite-pgvector@0.0.5",
    "@noble/hashes/": "jsr:/@noble/hashes@2.2.0/",
    "postgres": "npm:postgres@3.4.9",
    "@std/assert": "jsr:@std/assert@1.0.19",
    "fast-check": "npm:fast-check@4.9.0",
    "pgsql-ast-parser": "npm:pgsql-ast-parser@12.0.2"
  },
  "nodeModulesDir": "auto",
  "fmt": {
    "exclude": [
      "drizzle"
    ]
  },
  "lint": {
    "plugins": [
      "file:///path/to/hazelnut/src/invariants/lint-floor.ts"
    ]
  },
  "tasks": {
    "dev": "HAZELNUT_DEV=1 deno run --allow-net --allow-env --allow-read --allow-write=. --unstable-cron --watch main.ts",
    "start": "deno run --allow-read --allow-env --allow-run=deno -c deno.json file:///path/to/hazelnut/src/cli/hazelnut-core.ts launch ./app.ts --entry main.ts",
    "test": "deno test --allow-net --allow-env --allow-read --allow-write=. --unstable-cron --allow-run=deno",
    "test:pg": "deno test --allow-net --allow-env --allow-read --allow-write=. --unstable-cron --allow-run=deno --env-file",
    "verify": "deno run --allow-read --allow-write=. --allow-env --allow-run=deno --allow-net -c deno.json file:///path/to/hazelnut/src/cli/hazelnut-core.ts verify ./app.ts",
    "add": "deno run --allow-read --allow-write=. --allow-env --allow-run=deno --allow-net -c deno.json file:///path/to/hazelnut/src/cli/hazelnut-core.ts add",
    "doctor": "deno run --allow-read --allow-write=. --allow-env --allow-run=deno --allow-net -c deno.json file:///path/to/hazelnut/src/cli/hazelnut-core.ts doctor",
    "migrate": "deno run --allow-read --allow-write=. --allow-env --allow-run=deno --allow-net -c deno.json file:///path/to/hazelnut/src/cli/hazelnut-core.ts migrate ./app.ts",
    "audit": "deno audit",
    "ci": "deno lint && deno check . && CI=1 deno task verify && deno task migrate drift && deno task test",
    "ci:full": "deno task ci && deno task audit"
  }
}
```

> **Path shown is illustrative.** `file:///path/to/hazelnut/src` stands for
> wherever your framework checkout actually lives; the scaffolder writes the
> real absolute path. Read the shape, not the location.

**The pin follows how you acquired the framework.** A checkout gives the
`file://` shape above — the pin is machine-absolute, so the app is not portable
until you vendor or re-pin it. `--vendor` copies the framework into
`.hazelnut/modules/` and pins it relatively instead, which is the portable
shape. A registry pin (`jsr:…`) collapses every framework import entry and every
task line to one published specifier — a checkout needs an exact key per concern
barrel, a published package exports them itself — and is what you get when you
ran `new` from a published package.

**The `lint.plugins` entry is the safety floor**, and `deno lint` in your `ci`
runs it. It points at the pinned tree's floor plugin — nine rules that refuse
the mistakes a type checker cannot catch: interpolating a value into SQL, a
custom read that skips its row rule, fabricating an actor, a spec that passes
its `impl ⊨ spec` check by saying nothing. Leave the entry alone, and leave the
`lint` block without an `exclude` or an `include` — narrowing either is a gap in
what your own `deno lint` checks. `hazelnut doctor` tells you if it is missing.

The CLI tasks resolve the pinned tree through `deno run` — nothing to install
first.

**Every dependency is pinned exactly**, never to a range, so a bump is an edit
rather than a float. `drizzle-orm` must match the framework's own pin or you
resolve two Drizzle builds. Three entries look optional and are not:

| Entry                           | Why it must be there                              |
| ------------------------------- | ------------------------------------------------- |
| `fast-check`                    | backs a CLI task that runs in **your** import map |
| `pgsql-ast-parser`              | same                                              |
| `@electric-sql/pglite-pgvector` | so a `vector` field works on PGlite with no edit  |
| `@noble/hashes`                 | the Argon2id a `password()` field is hashed with  |

**Commit `deno.lock` in the same change as the pin** — that is what makes CI
resolve the bytes you tested against.

**`deno task ci` is the verdict you run in the loop** — lint, type-check,
`verify`, the committed-`drizzle/` staleness gate, and your tests. Nothing in it
reaches the network, so it answers the same on a plane as it does at your desk,
and you can ask it as often as you like.

`deno task audit` reads that lock against the advisory database. It fails when
the feed is unreachable rather than passing, which is the point: a scanner that
reports clean when it could not look turns "unknown" into "clear" on every run.
That is why it is not in the offline lane above — it lives in
`deno task ci:full`, which runs that lane and then the scan. Run it before you
release, and in whatever pipeline gates a merge. When it reports a vulnerable
package, the fix is a pin bump plus `deno install` to move the lock — editing
the pin alone leaves the old resolution in place and the audit still red.

### Other pin shapes

`--vendor` copies the framework source into the app (portable hand-over);
`--local <repo>` points at a checkout. See [`new`](./cli/new.md).

### The stack {#stack}

**Deno 2.x · Hono · Zod 4 · Drizzle + drizzle-kit · PostgreSQL 16+ · `Deno.cron`
plus a Postgres transactional outbox · `Result` · OpenTelemetry · `Deno.test` +
fast-check.**

Not configurable — the guarantees depend on them. PostgreSQL 16+ is checked at
readiness, not assumed.

### Where each import comes from

There are three shapes, and the shape tells you what you are reaching for.

<!-- @conformance:skip reason=self-imports the hazelnut alias (unresolvable in the harness) -->

```ts
import { createApp, defineResource } from "hazelnut"; // 1. declare an app and boot it
import { eq, owned } from "hazelnut/query"; //           2. one concern, curated
import { testCtx } from "hazelnut/test.ts"; //           3. a direct path — plumbing
```

**1. `hazelnut` carries the authoring verbs, the `Result` seam and the authz
vocabulary.** Nine symbols get a CRUD backend running — `defineResource`,
`defineConfig`, `createApp`, `applySchema`, `pgliteDb`, `postgresDb`, `Actor`,
and `all`/`none` from `hazelnut/query`. That last pair is the honest part of the
bill: deny-by-default means a scoped resource serves no row until a `rowPolicy`
says which, so your first file already imports from two places. A resource that
is NOT `scope`-partitioned pays one symbol more — `can`, below — because its
`rowPolicy` is then the only thing standing between a read route and the whole
table, and "is there an actor" is not a rule that narrows. Twelve more put a
guarded custom operation on the wire (`defineOp`, `ok`, `err`, `Result`,
`OpDecl`, `Ctx`, `defineModule`, `defineAuth`, `derivePerms`, `requires`, `can`,
`userActor`), and those are all at the root.

**2. Every other concern is a named subpath**, and each is a curated barrel:

| import from       | reach for it when                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `hazelnut/query`  | you ask a question of a row — the Where algebra, rowPolicy fragments, the column and relation vocabulary   |
| `hazelnut/async`  | work outlives the request — queues, events, cron, sagas, webhooks, read models                             |
| `hazelnut/crypto` | secrets at rest and the identities that unlock them — KMS, the password recipe, embeddings, throttling     |
| `hazelnut/faces`  | you consume a projected face — the MCP tool surface, the OpenAPI document, the typed client, the OTLP seam |

A symbol lives in exactly one of them, so there is never a choice about where to
import it from. Your editor's completion list for `hazelnut` stays short because
of it.

**3. A specifier with a FILE on the end is a direct path** — `hazelnut/test.ts`,
`hazelnut/data/repo.ts`. Those are raw modules, deliberately off the curated
surface; reaching one is a conscious act, and this guide says so wherever it
teaches one. A concern subpath is never a directory name, so the bare word and
the file path can never be mistaken for each other.

Your imports are identical in both build shapes — the `hazelnut` alias resolves
to the same core barrel either way. What the scaffolder writes differently is
the CLI its task lines call, and which lint plugin its `lint.plugins` names —
the nine-rule floor for a core build, the full plugin for a verify one.

## 2. Your first resource

<!-- @conformance:resource -->

```ts
// product.resource.ts  (the `*.resource.ts` suffix is the declaration-file convention the lint rules enforce —
// a `defineResource` in a plain `domain.ts` is a lint error)
import { type Actor, can, defineResource } from "hazelnut";
import { none, shared } from "hazelnut/query";
import { z } from "zod";

export const product = defineResource({
  name: "product",
  // Spell a string subtype at TOP LEVEL — `z.uuid()`, `z.iso.datetime()`, `z.email()`. Chained off
  // `z.string()` it is refused at declaration (`zod/format-canonical`) and the error names the rewrite.
  schema: z.object({ name: z.string(), seats: z.number().int() }),
  // `versioning` has no default: `false` is last-write-wins, `true` CAS-guards both update and delete.
  features: { timestamps: true, versioning: false },
  rowPolicy: (actor: Actor | null) =>
    // A catalogue: every grantee sees the same products, deliberately. `shared()` lowers exactly as
    // `all()` and is the written decision — boot refuses a bare `all()` here, because it cannot tell a
    // catalogue from a leak.
    can(actor, "product:list") ? shared() : none(),
  http: {
    list: { policy: "policy", columns: ["id", "name", "seats"] }, // deny-by-default; name every wire field
    find: { policy: "policy", columns: ["id", "name", "seats", "created_at"] }, // ask for a framework column by name
    create: "policy",
  },
  mcp: { list: { describe: "List products.", shape: ["id", "name", "seats"] } },
});
```

Every route above is closed, which is the posture `hazelnut new --example` emits
too. The row rule is where the two part: `--example` seeds a resource that
narrows on the row's own owner (`rowPolicy: "owner_id"`, over
`features: { scope: true }`), while a catalogue like this one hands every
grantee the same rows, deliberately.

Ownership — the common case — has a one-word form. A bare column name IS the
rule:

<!-- @conformance:ts imports=defineResource -->

```ts
export const note = defineResource({
  name: "note",
  schema: z.object({ body: z.string(), owner_id: z.string() }),
  features: { versioning: false },
  rowPolicy: "owner_id", // this caller sees the rows they own; anonymous sees none
  http: {
    list: { policy: "policy", columns: ["id", "body", "owner_id"] },
  },
});
```

No import, and the column is checked against this resource's own schema, so a
typo is a compile error rather than a rule that quietly matches nothing. Reach
for the function form when the rule is more than ownership — a composition, a
permission test, a catalogue. Start from the narrowing rule; reach for
`shared()` only once you can name who the catalogue is for. Open a route later
still, and only once you can name who you are opening it to.

Write the row rule as a question about the ROW — which of these rows are this
caller's — never as a question the permission already answered.
`can(actor, "product:list") ? all() : none()` asks "may they in" a second time
and "which rows" never, so every grantee reads every other grantee's rows. A
null-check has the same hole from the other side: an unauthenticated request
reaches the policy carrying an anonymous actor, not nothing, so
`actor ? all() : none()` narrows nobody either — and a `"policy"` read has no
permission gate behind the rowPolicy to catch it. What boot refuses is any rule
that hands two callers holding the same claims the same rows, whichever way it
is spelled.

- **`schema`** is your Zod object — the single source the type faces and the DDL
  both derive from.
- **`features`** turn framework machinery on; §8 is the tour. Row-scoping
  (`scope: true`) additionally needs a scope resolver in your config, so it is
  deferred to §7 — declaring `scope: true` without one makes `createApp` refuse
  to boot.
- **`http`** exposes routes: `"policy"` (deny-by-default — a write needs the
  perm `product:create`, a read returns only what `rowPolicy` admits),
  `"public"` (open to everyone, no `rowPolicy` applied), or omit the verb to not
  mount it at all. A **read** (`list`/`find`) must use the object form and name
  every wire field in `columns` — a short-form `"policy"`/`"public"` alone
  boot-refuses.
- **A read route returns exactly the columns you name — nothing else.** The
  columns the framework adds for you (`created_at`, `version`, the scope key,
  the sequence number, a rollup, a parent FK) are stored, not served. To put one
  on the wire, name the WHOLE set you want in `columns: [...]`, as `find` does
  above; turning a feature on after that changes your storage, never your API.
  `columns` is required on every exposed `list` and `find` (HTTP or MCP), and
  naming a column that does not exist — or one your `sensitive`/`encrypted`
  declaration hides — stops the boot with a message naming it, rather than
  serving a field that is not there.
- **`mcp`** curates the agent surface. Only the operations and reads you list
  become tools, each with a `describe` and an optional output `shape` narrowing.
  A **prompt** is the other half of that surface:
  `definePrompt({ name, describe, arguments, render })` publishes a reusable
  prompt template through the same door, registered with `prompts: [...]` on
  your config. `arguments` is a Zod object, derived into the MCP argument schema
  by the deriver the tools already use. `render` receives the validated
  arguments and **nothing else** — no `ctx` — so a prompt is pure by
  construction and cannot smuggle an operation past the capability filter.
- **`rowPolicy`** `(actor) => Where` narrows which rows a `"policy"`-gated read
  returns. A `"policy"`-gated read, **or** an MCP read tool whose HTTP twin is
  not `"public"`, requires one: without it the read returns every row, so
  `createApp` refuses to boot. §7 is the algebra.

### The one read that needs no `rowPolicy`

<!-- @conformance:resource -->

```ts
import { defineResource } from "hazelnut";
import { z } from "zod";

// COUNTER-EXAMPLE — the only shape that may skip rowPolicy: data you deliberately serve to every
// caller, agent, and crawler. "public" states that intent; it does not narrow anything.
export const pressRelease = defineResource({
  name: "press_release",
  schema: z.object({ headline: z.string(), body: z.string() }),
  features: { versioning: false, timestamps: true },
  http: {
    list: { policy: "public", columns: ["id", "headline", "body"] },
    find: { policy: "public", columns: ["id", "headline", "body"] },
  }, // open, unauthenticated, every row — wire named
});
```

Declare `"public"` only when you can name the audience in one sentence and the
answer is "everyone". When `createApp` refuses a `"policy"` read for want of a
narrowing `rowPolicy`, rewriting that read to `"public"` does silence the
refusal — by widening the leak it was reporting. Write the policy.

### Relations between resources

Three declaration keys, one per kind of link. Each takes a helper that consumes
the **imported target declaration**, so a mistyped target is a compile error
rather than a boot failure.

| Key          | The link                                    | Helpers              |
| ------------ | ------------------------------------------- | -------------------- |
| `references` | a foreign-key column on THIS table          | `ref` · `refById`    |
| `owns`       | children whose rows exist only for this row | `hasMany` · `hasOne` |
| `relates`    | a many-to-many pair                         | `manyToMany`         |

<!-- @conformance:resource -->

```ts
// order.resource.ts
import { defineResource } from "hazelnut";
import { hasMany, manyToMany, ref, refById } from "hazelnut/query";
import { z } from "zod";

export const customer = defineResource({
  features: { versioning: false },
  name: "customer",
  schema: z.object({ email: z.string() }),
});
export const coupon = defineResource({
  features: { versioning: false },
  name: "coupon",
  schema: z.object({ code: z.string() }),
});

// an owned child is an ordinary resource: the parent names the relation, and the FK is minted on the child
export const orderLine = defineResource({
  features: { versioning: false },
  name: "order_line",
  schema: z.object({ sku: z.string(), qty: z.number().int() }),
});

export const order = defineResource({
  features: { versioning: false },
  name: "order",
  schema: z.object({
    total: z.number().int(),
    customerId: z.string(),
    placedBy: z.string(),
  }),
  references: {
    customerId: ref(customer, { onDelete: "restrict" }), // a real FK — the target must be a declared resource
    placedBy: refById("auth.user"), // a by-id target OUTSIDE the model: no FK emitted, no target check
  },
  owns: { lines: hasMany(orderLine) }, // FK on the child, ON DELETE CASCADE
  relates: { coupons: manyToMany(coupon) }, // a junction table, derived from the sorted resource pair
});
```

Reading them back, once the app is booted:

- **owned children** — `ctx.data.order_line.children(orderId)` returns the child
  rows, each filtered through the child's own read stack.
- **the other side of a `relates`** — `ctx.data.order.related("coupons", id)`
  returns the related ids; the relation key you chose is the accessor name.
- **a `references` target is not auto-joined.** Inside a module, read it with a
  second `ctx.data.<r>.find(...)`; across modules, go through
  `ctx.reads.<dep>.<view>` (§5) — never a hidden join.

Four rules that bite if you guess:

- **Ownership is parent-side only.** Declare `owns: { …: hasMany(child) }` (or
  `hasOne`) on the parent. A retired child-side `parent:` key refuses at boot
  with a rewrite steer naming `owns`.
- **`hasOne` instead of `hasMany`** makes it exactly one child, by construction:
  a UNIQUE on the child's parent FK, so a second child row is a duplicate-key
  reject rather than a rule you have to remember.
- **`hasMany(childDecl, { unique: [["sku"]] })`** makes a tuple unique **per
  parent** — the parent FK is prepended for you, so `sku` stays free to repeat
  across other parents.
- **`refById` skips the target check.** It exists for tables outside the model
  (`auth.user` in a database you share), so nothing verifies the name and no FK
  is emitted. Use `ref(decl)` whenever the target is a resource you declare.

## 3. Boot & serve

Three files, three jobs. `hazelnut.config.ts` collects the declarations,
`app.ts` boots the pure model, and `main.ts` serves it.

<!-- @conformance:skip reason=self-imports hazelnut + relative imports -->

```ts
// hazelnut.config.ts — collects the declarations
import { defineConfig } from "hazelnut";
import { product } from "./product.resource.ts";
export const config = defineConfig({ resources: [product], modules: [] });

// app.ts — the PURE model the CLI verbs read (`hazelnut migrate ./app.ts`): no db, no `fetch`.
// Loading it never constructs a database just to read the model.
import { createApp } from "hazelnut";
import { config } from "./hazelnut.config.ts";
export const app = createApp(config);

// main.ts — the SERVED boot. `db` is the one obligatory seam, constructed here by the project:
// DATABASE_URL set → real Postgres; HAZELNUT_DEV=1 → embedded PGlite; neither → refuse to serve.
import { applySchema, createApp, pgliteDb, postgresDb } from "hazelnut";
import { PGlite } from "@electric-sql/pglite";
import postgres from "postgres";
import { config } from "./hazelnut.config.ts";

const url = Deno.env.get("DATABASE_URL");
if (!url && Deno.env.get("HAZELNUT_DEV") !== "1") {
  console.error(
    "refusing to serve: DATABASE_URL is unset. Set DATABASE_URL to serve against Postgres, or set HAZELNUT_DEV=1 to boot the throwaway embedded PGlite (development only — every write is lost on exit).",
  );
  Deno.exit(1);
}
const db = url ? postgresDb(postgres(url)) : pgliteDb(new PGlite());
// `relay: "in-process"` drains the outbox from THIS serve process (subscribers / workers / read-models fire with no
// separate relay process); `scheduler: "in-process"` binds the feature TTL sweeps and `expiry` purge to Deno.cron
// (run with `--unstable-cron`). This is the single-process shape the scaffolder emits — omit `scheduler` and the
// serve boot REFUSES (expired rows would never reap); omit `relay` while async is declared and the boot REFUSES
// (the outbox never drains).
export const app = createApp(config, {
  db,
  relay: "in-process",
  scheduler: "in-process",
}); // a boot seam ⇒ `app.fetch` is present (served shape)
if (!url) await applySchema(db, app); // dev only: derive the DDL on boot. Production schema lands via `hazelnut migrate`, never on boot.
Deno.serve(app.fetch);
```

`createApp(config, boot)` returns an `App` whose `.fetch` is the HTTP handler,
so `Deno.serve(app.fetch)` is the whole server. `deno task dev` runs `main.ts`
with `--watch`, and sets `HAZELNUT_DEV=1` for you — the zero-infra loop is
unchanged. Ask for the embedded database and you get it; lose `DATABASE_URL` in
a Dockerfile and you get a refusal, not a throwaway in-memory database serving
production traffic.

**Config and secrets** land in `defineConfig`, and env is read at **your**
config site. The framework reads no branded variable of its own beyond the ones
in [Deploying](./DEPLOY.md). A missing value is a loud boot refusal.

**Middleware is fetch-wrapping.** There is no middleware hook, because
`app.fetch` is a plain function:

<!-- @conformance:skip reason=illustrative fragment, withCors is the reader's own -->

```ts
Deno.serve((req) => withCors(req, app.fetch)); // withCors is yours
```

**`createRouter` is the raw assembly path.** It is off the barrel —
`import { createRouter } from "hazelnut/runtime/serve.ts"` — and it
hand-assembles the serve config. It refuses the same model-guard ids `createApp`
does (a missing `kms` or `storage` is a boot refusal, not a first-request
surprise). `scope/resolver-required` stays on `createApp`, because that guard
needs `resolveCtx`:

<!-- @boot-guards -->

| Guard                         | Without it                                                 |
| ----------------------------- | ---------------------------------------------------------- |
| `encrypted/key-source`        | boot succeeds, writes fail later                           |
| `file/storage-required`       | same, on the first `file()` write                          |
| `vector/embed-required`       | a `vector` field can neither be written nor searched       |
| `audit/sensitive-declared`    | an audited row's PII is written to `_audit` in the clear   |
| `scope/resolver-required`     | a `scope: true` resource stops isolating                   |
| `policy/read-protected`       | a `"policy"` read with no `rowPolicy` serves every row     |
| `policy/write-protected`      | one per-resource grant lets a caller rewrite every row     |
| `op/decisions-written`        | an operation runs unauthorized, or twice on a retry        |
| `versioning/decision-written` | two callers update one row and the second erases the first |

Each name is the one `createApp` and `createRouter` print when they refuse, so a
refusal you hit searches straight back to this row.

Reach for it only to embed Hazelnut's routes inside a Hono app you assemble
yourself.

### Calling the API from TypeScript

**`hazelnutClient(config, url)`** is the fifth face: a typed fetch client
derived from the same config the server boots from. Pass the live config value
(not only `typeof config`) so a resource `path` reaches the wire the same way
the server does. No code generation, no schema download — one member per
resource, verbs filtered to the `http:`-exposed set, so calling a route you
never mounted does not compile. It and the other projected faces come from
`hazelnut/faces`:

<!-- @conformance:skip reason=the import line itself is the subject; the harness synthesizes one -->

```ts
import { deriveOpenApi, hazelnutClient } from "hazelnut/faces";
```

<!-- @conformance:ts imports=Actor,all,shared,can,createApp,defineConfig,defineResource,deriveOpenApi,hazelnutClient,none -->

```ts
const product = defineResource({
  features: { versioning: false },
  name: "product",
  schema: z.object({ name: z.string(), seats: z.number().int() }),
  rowPolicy: (actor: Actor | null) =>
    can(actor, "product:list") ? shared() : none(),
  http: {
    list: { policy: "policy", columns: ["id", "name", "seats"] },
    find: { policy: "policy", columns: ["id", "name", "seats"] },
    create: "policy",
  },
});
export const config = defineConfig({ resources: [product], modules: [] });

const api = hazelnutClient(config, "https://api.example.com", {
  headers: { authorization: "Bearer …" },
});

const listed = await api.product.list({ where: { name: "Widget" }, limit: 20 });
if (!listed.ok) {
  throw new Error(`${listed.error.kind}: ${listed.error.message}`);
}
const seats: number = listed.value[0]!.seats; // inferred from the Zod schema the server derives from

// the OpenAPI 3.2 document, off the same declarations
const doc = deriveOpenApi(createApp(config), {
  title: "Catalog API",
  version: "1.2.0",
});
await Deno.writeTextFile("openapi.json", JSON.stringify(doc, null, 2));
```

The client speaks `Result`, not exceptions: a 4xx/5xx comes back as
`{ ok: false, error: { kind, message } }` with the same `err.kind` vocabulary a
handler returns, and a transport failure collapses to `internal`. To drive a
booted app in-process with no socket, inject `fetchFn` — it carries the **global
`fetch` signature**, so wrap the handler rather than passing it bare:
`fetchFn: (input, init) => Promise.resolve(app.fetch(new Request(input, init)))`.

`deriveOpenApi` builds the document on demand. To serve it instead, opt in with
`defineConfig({ openapi: { public: true } })` — or `{ gate: "<perm>" }` to keep
the contract behind a permission. Absent, `/openapi.json` is not mounted.

## 4. The database

Hazelnut owns the schema; you never hand-write DDL. **`hazelnut migrate`**
spawns drizzle-kit to diff the derived schema against the database and land a
migration in `drizzle/`:

| Command                           | What it does                                                                  |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `hazelnut migrate <app> generate` | author the migration files offline                                            |
| `hazelnut migrate <app> check`    | read-only diff — safe, never gated                                            |
| `hazelnut migrate <app> drift`    | offline: is the committed migration stale against the declarations?           |
| `hazelnut migrate <app> preview`  | dry-run the pending set                                                       |
| `hazelnut migrate <app> status`   | show applied vs pending                                                       |
| `hazelnut migrate <app> apply`    | apply pending migrations (production-guarded — see below)                     |
| `hazelnut migrate <app> rebase`   | detect a fork in the committed migration history and print the fix            |
| `hazelnut migrate <app> reset`    | drop and rebuild; development only, refused outright on a non-default `--env` |

Applying against production is guarded: you name the target with
`--env production`, and the real gate is capability separation — you hold
`.env.production` — plus an interactive confirmation. There is no signing token.
See [migrate](./cli/migrate.md).

Destructive changes — a dropped or retyped column — are **detected, blocked, and
stubbed**; you sequence them by hand. Each module gets its own Postgres schema.

### Raw SQL — the `queries/` seam {#queries-seam}

`ctx.data` covers CRUD, filters, ordering, and scope injection. When a read
genuinely cannot be expressed through it — a window function, a recursive CTE, a
hand-tuned join — you write raw SQL, and it lives in exactly one place: a file
under `queries/` (or a top-level `queries.ts`).

A `queries/` file exports the statement **text**, with `$1`, `$2`, … where the
values go. `ctx.query(sql, params)` runs it on the operation's own transaction,
so the read sees the same uncommitted rows the handler just wrote:

<!-- @conformance:ts imports=Ctx -->

```ts
// queries/topSpenders.ts — the seam. Values are placeholders; nothing is spliced into the text.
export const TOP_SPENDERS =
  "SELECT id, rank() OVER (ORDER BY spent DESC) AS r FROM orders WHERE org_id = $1";

// logic/order/report.ts — logic/ names the statement, it never writes SQL.
declare const ctx: Ctx<undefined>;
declare const orgId: string;
const { rows } = await ctx.query<{ id: string; r: number }>(TOP_SPENDERS, [
  orgId,
]);
```

Two things the seam does **not** buy you:

- **It is not an exemption from parameterization.** Never splice a value into
  the statement text — not with `+`, not with a `${...}` template. Values go in
  the array, every time, `queries/` included.
- **It is not the scope/`rowPolicy` stack.** `ctx.data` injects the WHERE
  conjuncts for you; `ctx.query` hands your text to Postgres as written. If the
  rows are scoped, say so in your own `WHERE`.

Reaching a _second_ database is a different door — `ctx.datasource(name)`, §10 —
and its statement text lives under `queries/` too, for the same reason.

## 5. Modules

Group related resources into a **module**. Its tables live in a dedicated
Postgres schema, and it declares its cross-module contract explicitly.

<!-- @conformance:skip reason=self-imports hazelnut + undeclared vars -->

```ts
// license_system.module.ts  (the `*.module.ts` suffix, same placement convention as *.resource.ts)
import { defineModule } from "hazelnut";
export const licenseSystem = defineModule({
  name: "license_system",
  resources: [product, license, licenseEvent],
  deps: ["billing"], // modules this one may call
  exposes: ["issue"], // ops other modules may call via ctx.modules.<this>.issue
  exposesRead: ["licenseView"], // views other modules may read via ctx.reads.<this>.licenseView
});
```

A module reaches another **only** through a declared dependency's surface, or
via events — never a direct table read:

<!-- @conformance:skip reason=illustrative ctx fragment, undeclared bindings -->

```ts
await ctx.modules.billing.charge({ amount: 500 }); // a `deps` + `exposes` op
await ctx.reads.billing.invoiceView({ id }); // an `exposesRead` view
```

Cross-module reads go through a narrowing view, never the producer's raw row.

| Verb              | Read is                       | Reach for it when         |
| ----------------- | ----------------------------- | ------------------------- |
| `defineView`      | computed on demand            | the query is cheap enough |
| `defineReadModel` | stored, eventually consistent | it is not                 |

A view is MCP / `ctx.reads` by default. `http: { policy: "public" | "policy" }`
opts it into `GET /views/<name>`. `"public"` admits an anonymous caller into the
view (its `rowPolicy` still gates); `"policy"` refuses anonymous first. Leave
`http` off and there is no route.

A read model lives on the base database, never inside the operation's
transaction, and threads `ctx.scope` when scoped:
`ctx.readModels.<name>.read(q?)`.

Declare it on the module that owns the resource it projects:

<!-- @conformance:skip reason=illustrative fragment, undeclared bindings -->

```ts
export const inventory = defineModule({
  name: "inventory",
  resources: [item],
  readModels: [stockLevels],
});
```

That placement is what types the read. `ctx.readModels.stockLevels.read()` is
checked against the names this module declares, so a misspelling is a compile
error and the projection's own row shape reaches the handler. Declare it at app
level in a modular app and the boot refuses, naming the module to move it to — a
projection sitting one level above the resource it projects would work at run
time and be invisible to the type. An app with no modules keeps the app-level
slot, exactly as it keeps app-level `resources`.

A projection inherits the guards its source declares — one of them for free, one
you write. Fields marked `sensitive` or `encrypted` never reach it: `project` is
handed a row with those keys already gone, and a key you re-add under one of
those names is dropped again on the way into the table. Read the projection back
through any door — `read()`, raw SQL, drizzle — and the value is not there to
find.

Row narrowing is the half you write. A stored row is stamped once, for nobody in
particular, so a `rowPolicy` on the source resource cannot run again over it.
Give the projection its own gate — it takes the actor and answers `all()` or
`none()`:

<!-- @conformance:skip reason=illustrative fragment, undeclared bindings -->

```ts
export const stockLevels = defineReadModel({
  name: "stock_levels",
  source: "item",
  project: (row) => ({ title: row.title, qty: row.qty }),
  rowPolicy: (actor) => (can(actor, "stock:read") ? all() : none()),
});
```

Two things ask for that gate, and either one alone is enough: the source carries
a `rowPolicy`, or an operation you expose reads the projection through
`ctx.readModels`. Leave the gate out in either case and boot refuses, naming the
projection and what asked for it. A gate answering `none()` — or one that throws
— returns zero rows, never a partial read.

Write the gate so it SHUTS for an unauthenticated caller, and test that with
`isAnonymous(actor)` rather than `actor ? … : …`. An unauthenticated request
arrives holding an actor — an anonymous one — so a null-check reads as "somebody
is here" and hands the whole projection over. Boot refuses a gate it can open
that way, and the message says which caller opened it.

`can(actor, …) ? all() : none()` is the right shape HERE and the refused one on
a resource, and the difference is the row. A projected row was stamped once, for
nobody in particular — it carries no owner to narrow on, so all this gate can
decide is whether the caller reaches the projection at all. A resource row does
carry one, so the same spelling there answers "may they in" twice and "which
rows" never. Project the owning column into the read model and you are back on a
resource's terms: narrow on it.

A view's `output` says what it yields. `json()` is the default — a narrowed row
set, so column projection applies. `output: binary()` marks a view that answers
a blob (an Excel export, a PDF, a CSV) and turns that demand off, because a blob
has no columns to narrow.

## 6. Custom operations

Anything beyond CRUD is a declared operation run through the **operation
pipeline** — validate → policy → transaction → handler → `Result`. You write it
as one value with **`defineOp`**; there is no second op-authoring helper. The
input type derives from the Zod `input` schema, never a hand-written twin, and
the handler is pure logic over `ctx` that returns a `Result` and never throws.

An operation that writes must say who may run it: `policy` is a required key
unless you declare `tx: "read"`. Leave it out of a write and `deno check` fails
with "Property 'policy' is missing" — write `policy: requires("<perm>")` for the
gated case, or `policy: null` when the door really is open to everyone (a
pre-auth login). The open door is a decision you write down, never one you
forget.

<!-- @conformance:skip reason=self-imports hazelnut + zod (duplicates injected header) -->

```ts
import { defineOp, ok, type OpDecl, requires } from "hazelnut";
import { z } from "zod";

// ctx typed against THIS module → every `ctx.data.<r>.*` is face-checked. The module file exports the alias
// (`export type LicenseSystemCtx = Ctx<typeof licenseSystem>` — `hazelnut add module` scaffolds that line),
// and this import is TYPE-ONLY: erased at runtime, so there is no module cycle even though the module
// re-exports the ops.
import type { LicenseSystemCtx } from "./license_system.module.ts";

const issueInput = z.object({ key: z.string(), productId: z.string() });

export const issue: OpDecl<z.output<typeof issueInput>, { id: string }> =
  defineOp({
    input: issueInput,
    policy: requires("license:issue"), // deny-by-default; only this perm may run it
    tx: "write", // default is write (opens a transaction, rolls back on err)
    idempotent: true, // required on a write op — see "Say what a retry does", below
    handler: async (input, ctx: LicenseSystemCtx) => {
      // ctx.data.<r>.create — the framework write path (scope stamp, audit, sequence number, key management,
      // unique-violation → err("conflict")). NEVER a raw create(ctx.db, model, …), which bypasses all of that.
      const minted = await ctx.data.license.create({
        key: input.key,
        productId: input.productId,
      });
      if (!minted.ok) return minted; // a duplicate key surfaces err("conflict") — propagate; the transaction rolls back
      // ctx.emit — carries the scope and trace stamp plus the sensitive-field redaction gate, in the SAME
      // transaction (no dual-write gap). NEVER a raw emit(ctx.db, …), which publishes cross-scope and unredacted.
      await ctx.emit({
        aggregateType: "license",
        aggregateId: minted.value.id,
        topic: "license.issued",
        payload: { key: input.key },
      });
      return ok({ id: minted.value.id });
    },
  });
```

Bind it to a route with an `http` key on the resource. The same operation is
then reachable over HTTP, over MCP, and cross-module — one pipeline, one
`Result → err.kind → HTTP status` contract. An instance operation mounts at
`POST /<plural>/:id/<op>`; a collection operation, whose input carries no `id`,
at `POST /<plural>/<op>`. The `<plural>` segment is the resource's `path` when
you set one, otherwise the default `name + "s"` (so `note` → `/notes`). `name`
is the table and permission identity — set `path: "entries"` on `name: "entry"`
when you need a real English plural on the wire.

### What an operation's result may carry

Your handler chooses the value, so the framework cannot build the response the
way it builds a `list` response. It subtracts instead: a column a FEATURE minted
for you — `version`, `deleted_at`, `expires_at`, `scope_key`, the `*_by_*` pair,
a rollup counter — never leaves an operation unless a read route of that same
resource names it in `columns`. Return it under a name of your own
(`{ createdAt: row.created_at }`) when you want it on the wire.

The subtraction is by NAME and it is app-wide, so two resources can collide: if
one resource turns on `versioning` and another declares a business field it
happens to call `version`, that field is subtracted from operation results too.
Boot says so, once, naming the field, the resource that loses it and the
resource that mints it. That warning has one answer — rename the field, or drop
the feature that mints the column — because `columns:` on the losing resource
cannot put it back. Its own `list`/`find` responses still carry the field; only
operation results lose it.

### Say what a retry does

A write operation must declare `idempotent`. There is no default: leave the line
out and `deno check` refuses the declaration.

```
Property 'idempotent' is missing in type '{ input: …; tx: "write"; handler: … }'
but required in type '{ readonly tx?: "write"; readonly idempotent: boolean; }'.
```

Write `idempotent: true` and a caller may send an `Idempotency-Key` header; a
resend carrying the same key returns the first call's result instead of running
the handler again. Write `idempotent: false` and every call runs — which is what
you want when each call is a new fact (a new message on a thread), and what you
do not want when it charges a card.

A read operation (`tx: "read"`) takes no verdict at all, and declaring one there
does not compile: nothing on the read path would ever consult it.

### If `deno check` says TS7022 or TS2456

"`x` is referenced directly or indirectly in its own type annotation" on an
exported operation. Two fixes — pick either:

<!-- @conformance:skip reason=illustrative fragment pair, undeclared bindings -->

```ts
// (a) annotate the export
export const issue: OpDecl<z.output<typeof issueInput>, { id: string }> =
  defineOp({ input: issueInput, policy, idempotent: true, handler });

// (b) declare it inline on the resource — no exported const, no annotation
operations: {
  issue: defineOp({
    input: issueInput,
    policy,
    idempotent: true,
    resources: [license],
    handler,
  });
}
```

The operation's `ctx` is typed against its own module, so an inferred
`typeof issue` re-enters itself. Only a separately-exported const hits this.
Prefer (b) for a small operation.

**Do not drop the `resources:` line from (b).** An inline operation cannot name
the module it sits inside — that is the cycle above — so it names the resource
declarations it touches instead, as a value. `ctx.data` is then typed from them
and a misspelled resource or field is a compile error. Form (a) has the same
requirement met a different way — its `ctx: LicenseSystemCtx` annotation is the
anchor.

An operation that reaches `ctx.data` with neither anchor does not compile.
`deno check` reports the fix in place of the type:

```
Property 'licnese' does not exist on type '{ readonly "this op declares no
`resources:` witness and no `ctx:` annotation, so ctx.data has no typed face —
add `resources: [<the decls this op touches>]`, or annotate `ctx: Ctx<YourModule>`
": never; }'.
```

An operation that never touches `ctx.data` needs no anchor and compiles as it
is: the requirement lands on the face it protects, not on every declaration.

A `resources:` value is one of three shapes — the declarations array
(`[license, product]`), a single declaration (`license`), or a whole module
(`licenseSystem`). Anything else is rejected on the line you wrote it.

### Seeding data outside a request

"Never a raw `create`" is about **handler** code. A fixture or bootstrap script
has no request context to bind, so the raw verb is the sanctioned path — off the
barrel, so reaching for it is deliberate.

<!-- @conformance:skip reason=off-barrel import hazelnut/data/repo.ts + undeclared vars -->

```ts
import { create } from "hazelnut/data/repo.ts"; // OFF-barrel raw seed verb (development only)
// resolve the resource model from `app.model`, pass a BARE seed ctx (`{ actor, scope }`), then the positional
// `create(db, model, ctx, values)` — the framework write path still stamps scope and hashes any `password()` field.
const productM = app.model.find((m) => m.name === "product")!;
await create(db, productM, { actor: null, scope: "public" }, {
  name: "Widget Pro",
  seats: 5,
});
```

A fixture that needs a row in a **non-initial** state has the same problem —
`create` may only set the declared initial status. `transition` is the
out-of-request sibling, and it is on the barrel:
`transition(db, model, { actor, scope }, id, "active")` walks a declared edge
and refuses one you never declared, exactly as `ctx.transition` does in a
handler.

## 7. Authz & identity

**Perms derive from the resource**, so a rename cannot drift the key:

<!-- @conformance:skip reason=illustrative fragment, undeclared license/actor -->

```ts
const perms = derivePerms(license); // { issue: "license:issue", create: "license:create", … }
can(actor, perms.license.issue); // check
requires("license:issue"); // gate an op
```

`definePerms({ license: ["issue", "revoke"] })` is the escape for keys no
resource seeds. `derivePerms` also seeds a `read` alias (`license:read`) so
`requires("license:read")` resolves; HTTP `list`/`find` stay row-policy-gated
and are not denied by that key.

### Omit `policy` on a custom operation {#omit-policy}

Write `policy: requires("license:issue")` when a named permission is the gate,
or `policy: null` when the door is public (a login). A `"policy"` HTTP or MCP
route with no `policy` key on the op is not open: dispatch injects
`requires("<resource>:<op>")`. A policy you did write is the only gate — the
convention is not added beside it.

### Roles, bundles, and multi-key gates

`requires` gates on one key. Past that: **`requiresAll(...)`** demands every
key, **`requiresAny(...)`** at least one — and `requiresAny()` with no keys
denies everyone, so an empty list fails closed rather than opening the door.

A role is a **bundle**: one key that grants several. Declare the vocabulary
once, and build actors through it, so the closure resolves at authentication and
every later `can()` stays a set lookup.

<!-- @conformance:ts imports=buildExpansion,can,claimResolver,group,requiresAll,requiresAny -->

```ts
const vocab = {
  bundles: { "role:agent": group("ticket:assign", "ticket:resolve") },
  implies: { "ticket:resolve": ["ticket:reply"] }, // holding one key grants another
};

const actorFrom = claimResolver(vocab); // (id, type, grantedKeys) => Actor
const agent = actorFrom("u-1", "user", ["role:agent"]);

can(agent, "ticket:assign"); // true — the bundle grants it
can(agent, "ticket:reply"); // true — `implies` grants it transitively

const policyAll = requiresAll("ticket:assign", "ticket:resolve"); // every key
const policyAny = requiresAny("ticket:reply", "ticket:reopen"); // at least one

// the resolved graph as data — pin in a test what a role is actually allowed to do
const graph = buildExpansion(vocab); // Map<key, Set<keys it grants>>
console.log(policyAll(agent), policyAny(agent), graph.get("role:agent"));
```

Call `claimResolver` **once** at startup and reuse the returned function: it
precomputes the transitive closure, so an actor built through it carries a flat
claim set and a permission check never walks the graph.

### `rowPolicy` — which rows

`(actor) => Where`, folded into a six-conjunct stack:

```
scope ∧ softDelete ∧ expiry ∧ temporal ∧ rowPolicy ∧ caller-where
```

`{ field: value }` covers equality. Past that, the condition algebra is on the
barrel — mint a typed field proxy once and a mistyped column fails to compile:

<!-- @conformance:skip reason=undeclared Row/f binding, illustrative fragment -->

```ts
const f = fields<Row>();
rowPolicy: ((a) => or(eq(f.status, "public"), owned(f.ownerId)(a)));
```

Builders: `eq` `ne` `gt` `gte` `lt` `lte` `inArray` `like` `isNull`.
Combinators: `and` `or` `not` `all` `none`. Actor fragments: `owned` `relate`
`ramp` `sharedVia` `withinScope` `andPolicy` `orPolicy`.

### `scope` — whose rows

Generic row-scoping. There is no `tenant` or `org` in the core. A scoped
resource stamps the key on write and conjoins it on read; without a resolver it
refuses to boot.

<!-- @conformance:skip reason=illustrative config fragments, undeclared surroundings -->

```ts
// per-actor
defineConfig({
  scope: { key: "scope", resolve: ({ actor }) => actor?.id ?? "public" },
});

// multi-tenant — a recipe over the same primitive
// withTenant/tenantOf come from hazelnut/authz/auth.ts (off-barrel: tenant is yours, not the core's)
defineConfig({
  scope: {
    key: "tenantId",
    resolve: ({ actor }) => tenantOf(actor) ?? "public",
  },
});
```

**Resolve from the actor, never a header.** An `x-org` header lets a caller
cross scopes by editing a request.

### The auth seam

<!-- @conformance:skip reason=illustrative fragment, undeclared myResolver/db -->

```ts
createApp(config, { db, auth: defineAuth({ resolvers: [myResolver] }) });
```

An ordered chain; first non-null wins and becomes `ctx.actor`. A resolver that
throws fails **closed** — 503, never anonymous. Handler code cannot fabricate an
actor.

### Email and password login {#password-login}

Self-hosted human login is a shipped recipe, not code you write: a `password()`
field carries the hash, three factories mint the operations, and one resolver
turns the access token back into an actor.

<!-- @conformance:resource -->

```ts
// accounts.module.ts
import { type Actor, defineAuth, defineModule, defineResource } from "hazelnut";
import { none, password } from "hazelnut/query";
import {
  passwordAuthResolver,
  passwordLogin,
  passwordLogout,
  passwordRefresh,
} from "hazelnut/crypto";
import { z } from "zod";

// 32 characters minimum, or every factory below refuses at construction. The dev fallback is ephemeral on
// purpose: it dies on restart, so it can never quietly become a stable production key.
const SECRET = Deno.env.get("AUTH_SECRET") ??
  // The lint plugin refuses a clock or randomness read in your source — it is what makes a test freezable.
  // A site that MUST be random says so on the line, and the annotation is what a reviewer sees in the diff.
  // hazelnut-escape: a dev fallback secret must be random per boot
  crypto.randomUUID() + crypto.randomUUID();

const appUser = defineResource({
  name: "app_user",
  schema: z.object({
    email: z.string(),
    pwd: password(), // hashed on write; never read back
    roles: z.array(z.string()).default([]),
  }),
  // Every resource reachable by a second writer states its concurrency posture. `false` here says
  // last-write-wins is right for an account row; `true` mints a `version` column and makes update AND
  // delete refuse a stale write. Leave it out and boot refuses — it will not pick the racier answer for you.
  features: { versioning: false },
  operations: {
    login: passwordLogin({
      userResource: "app_user",
      schema: "accounts", // the module's Postgres schema; omit it for a flat public-schema user
      identifierField: "email",
      passwordField: "pwd",
      secret: SECRET,
      rolesField: "roles", // minted into the access token's `roles` claim
    }),
    // `rolesFrom` re-reads that column on refresh, so a grant or a revocation lands at the next refresh
    refresh: passwordRefresh({
      secret: SECRET,
      rolesFrom: {
        userResource: "app_user",
        schema: "accounts",
        field: "roles",
      },
    }),
    logout: passwordLogout(),
  },
  http: { login: "public", refresh: "public", logout: "public" },
  rowPolicy: (a: Actor | null) => (a ? { id: a.id } : none()), // a caller reads only their own row
});

export const accounts = defineModule({
  name: "accounts",
  resources: [appUser],
});

// wire at boot: createApp(config, { db, auth: bearer })
export const bearer = defineAuth({
  resolvers: [passwordAuthResolver({ secret: SECRET })],
});
```

What each piece guarantees:

- **`passwordLogin`** returns `{ accessToken, refreshToken }`. A wrong password
  and an unknown identifier return the same `forbidden` — there is no
  user-enumeration oracle — and repeated attempts on one identifier are
  throttled before the hash is ever computed. If the user resource is
  `scope:true`, the lookup ANDs `scope_key` from the request's resolved scope;
  an empty scope does not search every tenant. Declare `scopeFrom: "request"` on
  `passwordLogin`; boot refuses the combo without it.
- **The JSON body uses the schema field names.** `identifierField` and
  `passwordField` are the wire keys — here `email` and `pwd`. A body
  `{ "password": … }` is `unrecognized_keys`. There is no `username` /
  `password` alias.
- **The access token is short-lived and cannot be revoked**, so its TTL is
  capped for you. Revocation rides the refresh token, which is stored hashed and
  is **single-use**: presenting one rotates it, and presenting a consumed one is
  `forbidden`.
- **`rolesField` is the perm transport.** Omit it and the token carries no
  claims, so every `requires(...)`-gated operation denies. Which user holds
  which role stays your application's data.
- **`passwordAuthResolver`** reads `Authorization: Bearer <jwt>` and returns
  `null` for a missing, foreign-scheme, or invalid token — so the `defineAuth`
  chain falls through to the next resolver instead of failing the request.
- **`verifyRefreshToken(db, token)`** answers the subject a stored refresh token
  belongs to, or `null`. That is the door for your own session screens ("sign
  out everywhere"); the login flow needs none of it.

The signing secret must come from the environment or a secret store. A literal
in source is a lint error, and the operations carry a boot-time cross-check: the
resource, schema, and column names you passed above are matched against the
declared model, so a rename that breaks the login fails at boot, not at 3 a.m.

## 8. Feature tour

Turn machinery on with `features` (and a few top-level keys). Each one adds
storage; none of them changes what a read route returns unless you name the new
column in that route's `columns` (§2):

| Feature                  | What it adds                                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timestamps`             | `created_at` / `updated_at` — stored columns; they reach a response only if you name them in a read route's `columns` (§2)                                                                              |
| `scope`                  | row-scoping: a scope-key column, stamped on write and conjoined on read                                                                                                                                 |
| `softDelete`             | `deleted_at`; delete becomes soft, and reads exclude deleted rows                                                                                                                                       |
| `audit` (+ `onRow`)      | an audit trail per mutation, masking the `sensitive` and `encrypted` fields. Declaring it REQUIRES declaring `sensitive` — `sensitive: []` is the "no PII here" answer, and nothing else masks the diff |
| `sequence`               | a per-resource minted counter column, such as `invoiceNo`                                                                                                                                               |
| `expiry`                 | `valid_until`, read exclusion, and an asynchronous purge                                                                                                                                                |
| `temporal`               | `valid_from` / `valid_to` effective-dating plus `asOf` reads                                                                                                                                            |
| `versioning`             | an optimistic-lock `version`. `update` AND `delete` both require the version you read — `findForUpdate(id)` locks the row and hands it to you; over HTTP, send `If-Match` on the PATCH and the DELETE   |
| `immutable`              | append-only, whole-resource or field-level set-once; `{ tamperEvident: true }` adds a SHA-256 hash chain                                                                                                |
| `singleton`              | exactly one row, per scope or per app                                                                                                                                                                   |
| `tree` (+ `treeClosure`) | a self-referential hierarchy plus a closure table                                                                                                                                                       |
| `unique: [[...]]`        | unique indexes, scope-folded when the resource is scoped                                                                                                                                                |
| `i18n: [...]`            | a per-field translation sidecar (`ctx.i18n.resolve`; the field-level mark is `translatable()`)                                                                                                          |
| `encrypted: [...]`       | at-rest envelope encryption — a per-row data key under an app key or your KMS                                                                                                                           |
| `sensitive: [...]`       | egress redaction at one chokepoint: logs, audit rows and traces mask the field (`{ fields, mask: "full" \| "partial" }` picks `****` or `***-1234`)                                                     |
| `i18nFallback: [...]`    | the resolution order `ctx.i18n.resolve` walks after the requested locale — app-declared, never a framework default                                                                                      |
| `vector: {...}`          | a pgvector embedding column, an HNSW index, `semanticSearch`, and staleness shadows                                                                                                                     |
| `searchable: [...]`      | native Postgres full-text search (tsvector + GIN)                                                                                                                                                       |
| `rollups: {...}`         | maintained aggregates over child rows                                                                                                                                                                   |
| `transitions: {...}`     | a status state machine; `status` moves only along a declared transition                                                                                                                                 |
| `idempotency`            | operation-level effectively-once — a client `Idempotency-Key` de-duplicates a retried write                                                                                                             |

`file()`, `translatable()`, `money()`, `password()`, and
`dbType("numeric(p,s)")` are **field helpers** used inside `schema` — for
example `z.object({ doc: file() })` — not `features` keys. `dbType` pins the
native Postgres column type (`numeric(p,s)`, `inet`, `point`) instead of
hand-editing a migration.

### rollups — aggregates that are already there

A rollup is a **maintained column on the parent**, re-stamped inside the child's
own write transaction. It is not a query-time aggregate: reading it costs one
column, and it can never lag the children it counts.

<!-- @conformance:resource -->

```ts
// basket.resource.ts
import { defineResource } from "hazelnut";
import { avg, count, hasMany, max, min, sum } from "hazelnut/query";
import { z } from "zod";

export const basketItem = defineResource({
  features: { versioning: false },
  name: "basket_item",
  schema: z.object({ price: z.number().int() }),
});

export const basket = defineResource({
  features: { versioning: false },
  name: "basket",
  schema: z.object({ label: z.string() }),
  owns: { items: hasMany(basketItem) },
  rollups: {
    item_count: count(basketItem), // how many children
    total: sum(basketItem, "price"), // over a child column
    average: avg(basketItem, "price"),
    cheapest: min(basketItem, "price"),
    dearest: max(basketItem, "price"),
  },
});
```

You get five extra columns on `basket`, each named by the key you chose, each on
the read face — `row.total` is a `number`, no join and no second query.

Two facts decide which helper you want:

- **`count` and `sum` are `number`**, and an empty child set reads `0`.
- **`avg`, `min` and `max` are `number | null`**, and an empty child set reads
  `null`. Removing the last child resets the column rather than leaving a stale
  value or fabricating a `0` that means "no data" and "zero" at once.

`rollups` is a **top-level key**, a sibling of `schema` — not a `features`
entry. So is `unique`. Putting either inside `features: {}` is a loud boot
refusal that names the key.

## 9. Events & async

`ctx.emit` and `ctx.queue` write to a **Postgres transactional outbox** inside
the operation's transaction, so there is no dual-write gap. A **relay** drains
it to `defineSubscriber` and `defineWorker` handlers with retry and error
classification.

The relay is not wired by default. Pass `relay: "in-process"` to `createApp` for
the single-process shape, or run a separate `hazelnut relay <app> --loop`
process for multi-replica deployments and acknowledge it with
`relay: "external"`. A bare serve-only boot with async work declared refuses
(`relay/decision-written`) rather than fill an undrained outbox. A poison
message lands in a dead-letter queue — observable, never silently dropped — and
`hazelnut redrive` moves it back once you have fixed the cause.

You can also hold the relay on a running deployment without a deploy:
`hazelnut ops <app> pause-relay --execute` makes every replica stop claiming new
messages within one poll interval, while a worker already inside a delivery
finishes it. `resume-relay` releases it. The companion lever caps a rate-limit
budget key the same way — `hazelnut ops <app> cap <key> <n> --execute`, which
can only tighten what the app declared. `hazelnut ops <app>` on its own prints
what is set and writes nothing; the section on operator levers in `DEPLOY.md`
has the full shape.

### Bind a subscriber's topic to the emitter {#subscriber-from}

A `topic` is a string, and a string that matches nothing is not an error — the
subscriber simply never fires, quietly, for as long as it is deployed. Renaming
an emitted topic, or mistyping one, is exactly that.

Close it at the type level: name the emitting module in `from:`, and `topic`
narrows to the union of what that module declares it `emits`.

<!-- @conformance:ts imports=defineModule,defineResource,defineSubscriber -->

```ts
const invoice = defineResource({
  name: "invoice",
  schema: z.object({ total: z.number() }),
  features: { versioning: false },
});

export const billing = defineModule({
  name: "billing",
  resources: [invoice],
  emits: { "invoice.paid": z.object({ id: z.string() }) },
});

export const onPaid = defineSubscriber({
  from: [billing], //  ← without this, `topic` is any string and a typo is silent
  topic: "invoice.paid",
  handler: (event, ctx) => Promise.resolve(void [event, ctx]),
});
```

Mistype it now and `deno check` refuses the file:
`Type '"invoice.payd"' is not assignable to type '"invoice.paid"'`. Write
`from:` on every subscriber you author — it costs one line and it is the only
thing that makes a topic rename a compile error.

The rest of the async vocabulary, one verb per concern:

- **`defineSubscriber`** — react to an emitted event (push); name the emitting
  module in `from:` so the topic is checked (above).
- **`defineWorker`** — consume a durable queue (pull).
- **`defineTask`** — long work a caller submits and then polls for a result.
- **`defineJob`** — a cron job, riding a leaderless exactly-once tick.
- **`defineWorkflow`** — a journaled multi-step process that survives a crash.
- **`defineWebhook`** — an outbound HTTP sink, HMAC-signed and behind the SSRF
  floor, with the same retry and dead-letter path. What that floor is, and the
  one gap it does not close, is below.
- **`defineUpcaster`** — read an older stored event forward. Events outlive the
  code that wrote them, so when a topic's payload shape changes you declare
  `defineUpcaster({ from, upcast })` — one total vN→vN+1 transform — and
  register the links per topic under
  `upcasters: { <topic>: { links, currentVersion } }` on your config. The relay
  walks the chain up to the revision the handler expects before parsing. A chain
  with a missing link throws **at boot**, not at consume, because the
  alternative is a stored payload reaching a handler un-upgraded and
  dead-lettering in production.

The framework's own feature sweeps ride the same tick, wired by the sibling
`scheduler: "in-process" | "external"` boot choice.

`ctx.queue.enqueue(name, payload)` and `ctx.schedule(at, job, payload)` do not
get the `from:` treatment above — a job/topic name is a plain string with no
`defineJob`/`defineWorker` declaration to check it against, so `deno check`
accepts any spelling and a typo enqueues a topic nothing drains, silently, for
as long as the app is deployed. `ctx.tasks.<name>.submit(input)` and
`ctx.workflows.<name>.start(input)` are different: `hazelnut verify` cross-
checks the literal name you write against your declared `defineTask` /
`defineWorkflow` set and refuses the build on a typo, the same way it refuses a
dangling `can()` permission key — but only when the name is a literal in your
source, never one built from a variable.

### The outbound SSRF floor, and the gap it does not close

Every outbound call the framework makes for you — `defineWebhook` delivery, and
`safeFetch(url, init?, opts?)` when you call an external URL by hand from boot
or a seam — goes through one guard:

- **https only.** `allowInsecureHttp: true` is the loud opt-out, for a dev
  receiver you own.
- **A DNS pre-flight** resolves the host and refuses private, loopback,
  link-local, ULA, CGNAT and cloud-metadata addresses. It reads the resolved
  BYTES, so the v4-mapped, v4-compatible and NAT64 spellings of a private
  address are refused too. `allowPrivateNetwork: true` is the explicit opt-in
  for a receiver you know is internal.
- **`redirect: "error"`.** A redirect is the classic pivot around the check
  above, so a redirected outbound call fails instead of following.

**One gap remains, and you should size it before you rely on this as a network
boundary.** The pre-flight resolves the host, and then `fetch` connects — which
resolves again. An attacker who controls the DNS answer for a hostname you POST
to can return a public address to the first lookup and a private one to the
second (a TTL-0 rebind), and the connection lands somewhere the pre-flight would
have refused. Deno offers no IP-pinned socket, so the framework cannot close
this from inside the process.

Close it upstream when the receiver's address is a thing you control: give the
webhook a URL whose host is an address literal or a name you resolve yourself,
or send it through an egress proxy or firewall rule that enforces the
destination range. Treat the floor as defence in depth against a mistyped or
attacker-supplied URL — not as a substitute for a network that cannot reach your
internal services in the first place.

### Driving the relay yourself

`relay: "in-process"` and `hazelnut relay <app> --loop` cover both deployments.
When you need the drain under your own control — a test that must see a
subscriber run before it asserts, or a worker process you supervise yourself —
the same primitives are yours to call, from `hazelnut/async`:

<!-- @conformance:skip reason=the import line itself is the subject; the harness synthesizes one -->

```ts
import {
  drainOutbox,
  runLiveRelay,
  startFeatureScheduler,
} from "hazelnut/async";
```

<!-- @conformance:ts imports=App,Db,Transactor,drainOutbox,runLiveRelay,startFeatureScheduler -->

```ts
declare const app: App; // the model from createApp(config)
declare const db: Db & Transactor;

// ONE poll cycle: due messages fanned out to every declared subscriber, worker and read-model, each claimed
// in its own transaction, so one consumer failing retries only itself. Loop it and you have `relay --loop`.
const cycle = await runLiveRelay(
  db,
  app.relay!,
  { batch: 50, maxAttempts: 10 },
  app,
);
console.log(cycle.processed, cycle.failed, cycle.dead);

// the framework's own cron work — feature TTL sweeps and the `expiry` purge. Needs `--unstable-cron`;
// without the flag the jobs warn once and no-op. `scheduler: "in-process"` calls exactly this for you.
startFeatureScheduler(app, db);

// the primitive underneath: one cycle, ONE handler for every due message, fenced for effectively-once
// delivery. Reach for it only when draining somewhere the declared consumers do not cover.
await drainOutbox(db, {
  handler: async (m) => {
    console.log(m.topic, m.payload);
  },
});
```

`runLiveRelay` needs a connection that can open transactions; hand it a `Db`
that cannot and it **rejects** rather than running claims and handlers apart,
which would duplicate writes on a crash. One call is one poll cycle, and
per-aggregate ordering means each aggregate advances one message per cycle — so
a test that emits three events for one row calls it three times.

### Starting a workflow

`defineWorkflow` declares; **`runWorkflow`** starts or resumes one run.
`hazelnut run-workflow <name> <app>` is the same thing from the command line.

<!-- @conformance:ts imports=App,ConsumerCtx,Db,WorkflowConflictError,defineWorkflow,runWorkflow -->

```ts
declare const app: App;
declare const db: Db;
declare const base: ConsumerCtx; // the consumer surface a relay handler is given

const onboarding = defineWorkflow({
  name: "onboarding",
  run: async (input: { userId: string }, ctx) => {
    // every `step` is journaled by its id — on resume, a completed step short-circuits to its recorded result
    const account = await ctx.step(
      "open-account",
      () => ({ id: input.userId }),
    );
    await ctx.step("send-welcome", async () => {
      console.log(account.id);
    });
  },
});

try {
  // the SAME workflowId is a RESUME, not a second run: execution picks up at the first unfinished step
  await runWorkflow(
    db,
    onboarding,
    { userId: "u-1" },
    base,
    "onboard:u-1",
    app,
  );
} catch (e) {
  if (!(e instanceof WorkflowConflictError)) throw e;
  // a concurrent runner holds this step's claim — back off and resume later; never re-run the body
}
```

The `workflowId` defaults to the workflow's name, which means **one logical run
per name**. Pass your own stable id (`onboard:u-1`) the moment two runs can be
in flight at once, or the second caller resumes the first one's journal. A
`WorkflowConflictError` is not a failure — it is the losing side of a race
telling you the peer is still alive.

## 10. Seams you wire

The framework owns the **contract**; you wire the substrate once at boot. Each
has a zero-cost default.

| Seam                   | What it is                          | Default                     |
| ---------------------- | ----------------------------------- | --------------------------- |
| `db`                   | the Postgres connection             | none — obligatory           |
| `datasources`          | additional SQL databases            | none                        |
| `kms`                  | key custody for `encrypted`         | local app key               |
| `embed`                | the embedding provider for vectors  | none → loud and inert       |
| `storage`              | the driver for `file()` fields      | none — required if declared |
| `logSink`              | the provenance record stream        | stderr JSON                 |
| `tracer` / `alarmSink` | OpenTelemetry spans, alarm delivery | no-op                       |

Reach a second SQL database with `ctx.datasource(name)`. Its statements obey the
same rule as `ctx.query`'s: the SQL text lives in a `queries/` file (§4). This
door is a second connection, never a second seam.

### The shipped constructors

Four of those seams ship a ready driver, so wiring one is an argument rather
than an implementation.

<!-- @conformance:ts imports=Db,appKeyKms,awsKms,createApp,decodeMasterKey,defineConfig,defineResource,localDriver,openaiEmbed -->

```ts
declare const db: Db; // the connection main.ts built (§3)
const doc = defineResource({
  features: { versioning: false },
  name: "doc",
  schema: z.object({ body: z.string() }),
});
const config = defineConfig({ resources: [doc], modules: [] });

export const app = createApp(config, {
  db,
  // Key custody for `encrypted` fields. `appKeyKms(decodeMasterKey(<base64>))` is the local app-key adapter;
  // `decodeMasterKey` refuses anything that is not 32 bytes, so a truncated secret fails loudly instead of
  // silently becoming a weak key. `awsKms` moves custody out: it wraps and unwraps through AWS KMS and never
  // sees the value plaintext, so a stolen database dump is not a stolen key.
  kms: Deno.env.get("AWS_KMS_KEY_ID")
    ? awsKms({
      region: "eu-west-1",
      keyId: Deno.env.get("AWS_KMS_KEY_ID")!,
      accessKeyId: Deno.env.get("AWS_ACCESS_KEY_ID")!,
      secretAccessKey: Deno.env.get("AWS_SECRET_ACCESS_KEY")!,
    })
    : appKeyKms(decodeMasterKey(Deno.env.get("ENCRYPTION_KEY")!)),
  embed: openaiEmbed({
    model: "text-embedding-3-small",
    dims: 1536, // must equal the `vector` field's declared width
    apiKey: Deno.env.get("OPENAI_API_KEY")!,
  }),
  storage: localDriver({ dir: "./files" }), // the development floor for `file()` fields
  relay: "in-process",
  scheduler: "in-process",
});
```

There is no `rateLimitStore` line, and that is the point: leave the key out and
a `Db` that can open transactions gets `pgRateLimitStore`, the shared Postgres
store, which is multi-replica-correct. You never write the safe wiring down.

`relay` and `scheduler` are the two keys that do **not** work that way, which is
why they are written out above even though this section is about the four
drivers. Leave either out and nothing takes over: the outbox fills and no
subscriber, worker or read-model ever fires, and the TTL sweeps over
`_idempotency`, `_outbox`, `_processed` and `_rate_limit` never run, so those
tables grow for as long as the app serves. Both keys take `"in-process"` (this
process does it) or `"external"` (a separate process does — a
`hazelnut relay <app> --loop` for the drain, your own `startFeatureScheduler`
for the sweeps). Leave `scheduler` out of a boot that has a database and
`createApp` refuses to compose the served app (same floor as `hazelnut launch`).
Leave `relay` out when the app has async work and `createApp` refuses until you
name `"in-process"` or `"external"`.

- **`localDriver`** puts `file()` bytes on the local disk. That is one replica's
  disk — a second replica cannot read them, so name a shared driver before you
  run more than one.
- **`memoryRateLimitStore`** is the opt-DOWN. It counts in one process, so N
  replicas admit N times the limit. Pass it
  (`rateLimitStore:
  memoryRateLimitStore({ limit: 100, windowSec: 60 })`) only
  when you mean single instance, or when a test needs a deterministic window.

`awsKms` covers wrap and unwrap. An `encrypted: { equality: [...] }` field needs
an adapter that can also compute a blind index, which `awsKms` does not.

## 11. Testing

**`testCtx`** (from `hazelnut/test.ts`) gives you an in-memory-real context for
unit-testing handler logic over the real repository and feature hooks, with no
infrastructure. `testCtx({ app, scope })` returns `t.ctx` — the handler's world
— and `t.build.<r>(...)`, a fixture builder.

<!-- @conformance:skip reason=self-imports hazelnut/test.ts + relative config import -->

```ts
import { testCtx } from "hazelnut/test.ts";
import { config } from "../hazelnut.config.ts";

const t = await testCtx({ app: createApp(config), scope: "s1" });
const created = await t.ctx.data.product.create(
  t.build.product({ name: "Widget", seats: 5 }),
);
assert(created.ok); // the real write path stamped timestamps and scope; softDelete, transitions and the rest all fired
```

A handler takes `ctx` — pass `t.ctx`. The shallow mode `testCtx({ data })` stubs
the surface when you do not want the real repository, and `moduleSlice` boots
one module in isolation when you want its boundary honoured.

**`userActor(id, claims)`** builds the actor a resolver would have produced —
`userActor("u-1", ["license:issue"])` is the caller a policy-gated test needs,
and `userActor("u-2")` the one that must be refused. Reach for it rather than
hand-writing an `Actor` literal: it is the shape the authn seam produces, scope
and all. A handler still cannot fabricate one.

**`t.runOp(op, input, { actor, scope, idempotencyKey, now })`** drives a custom
operation through the **full** pipeline with the composed `ctx.data`,
`ctx.emit`, `ctx.tasks` and `ctx.readModels` surface wired for you. To test
against real Postgres — the concurrency, uniqueness and NULL semantics in-memory
PGlite cannot show — open your own connection and inject it:
`testCtx({ app, module, db: postgresDb(postgres(PG_URL!)) })` runs the same
schema, context and pipeline over the live connection. You own that connection:
drop stale-shape tables before the call and end the connection after, because
`t.dispose()` never closes one you injected.

### Freeze the clock

Time is the usual reason a passing test starts failing on a slow machine, and
the usual repairs — a `sleep`, a widened tolerance — make the test weaker rather
than the code better. Hand the harness a clock instead. `ctx.now()` then answers
whatever you say, both in `t.ctx` and inside every operation `t.runOp` drives:

<!-- @conformance:skip reason=self-imports hazelnut/test.ts + relative config import -->

```ts
import { testCtx } from "hazelnut/test.ts";
import { config } from "../hazelnut.config.ts";

const t = await testCtx({
  app: createApp(config),
  scope: "s1",
  now: () => new Date("2026-01-01T00:00:00Z"), // every ctx.now() in this harness
});

const first = await t.runOp(issue, { plan: "pro" });
const second = await t.runOp(issue, { plan: "pro" });
// every ctx.now() in both reads 2026-01-01, so anything DERIVED FROM THE CLOCK
// matches across the two runs. Two things still differ: the row `id` (minted
// per row — `idSeed` below is the door for that one) and the
// `created_at`/`updated_at` stamps (written by Postgres, not by ctx.now()).
```

Pass `now` per call to move time between two otherwise identical runs —
`t.runOp(renew, { id }, { now: () => new Date("2026-06-01T00:00:00Z") })` is
five months later without waiting five months, so "does this expire?" is one
assertion instead of a mocked module.

**The lint plugin is what keeps the harness honest.** It refuses a clock or a
randomness read in your own source — `new Date()`, `Date()`, `Date.now()`,
`Date["now"]()`, `crypto.randomUUID()`, `performance.now()`, `Temporal.Now`,
`globalThis.crypto.randomUUID()`, `const { random } = Math`,
`import { randomUUID } from "node:crypto"`, `import { v4 } from "uuid"` and
`import { ulid } from "@std/ulid"`. Take the clock from `ctx.now()` and let the
framework mint row ids, and the two knobs above then govern every value your
test can predict. It reads the BINDING and not the name you gave it, so a
namespace import under any local name
(`import * as anything from "node:crypto"`, then `anything.randomUUID()`), a
local alias of the object, and a version-pinned or registry-prefixed specifier
are all the same read. What it does not follow is a value handed to it from
another file — assigning `Date` to a variable there and exporting it, say. That
it cannot see, so it does not claim to. One line genuinely has to be random — a
dev fallback secret, the one place that injects the real clock — so write
`// hazelnut-escape: <why>` on it and the waiver is visible in the diff instead
of being a rule you quietly turned off.

**Two clocks exist and only one is yours.** `created_at` and `updated_at` are
stamped by PostgreSQL, not by `ctx.now()`, so the injected clock does not move
them. Assert on a column your handler writes from `ctx.now()`; treat the
`timestamps` columns as ordering, never as values you can predict.

### Freeze the ids

The other value you cannot predict is the row `id`. Add `idSeed` and you can:
the framework replays its whole minting stream — row ids, audit rows, outbox
messages — from that seed, so an operation that creates a row returns the same
id every run.

<!-- @conformance:skip reason=self-imports hazelnut/test.ts + relative config import -->

```ts
import { testCtx } from "hazelnut/test.ts";
import { config } from "../hazelnut.config.ts";

const t = await testCtx({
  app: createApp(config),
  scope: "s1",
  now: () => new Date("2026-01-01T00:00:00Z"),
  idSeed: 1, // the id stream replays from here
});

const r = await t.runOp(issue, { plan: "pro" });
// `r.value.id` is the same string on every run of this test, on every machine.
// They are still ordinary ids — sortable, unique within the run — just replayed.
```

Pass `idSeed` per call — `t.runOp(issue, input, { idSeed: 1 })` — when only one
operation needs a predictable id; the seed is put back when that call finishes.

Two bounds are worth knowing before you reach for it. The stream is
**process-wide**, so run one seeded harness at a time rather than two in
parallel. And it does not touch `created_at`/`updated_at`: those are still
Postgres's. With both doors open, everything in a returned row is reproducible
except the `timestamps` columns.

### Seed the fixtures

`t.build.<r>()` and `t.arb.<r>()` are deterministic functions, not random
generators — no seed at all still gives you the same row every run.
`t.arb.product({ seed: 7 })` is how you get a _different_ schema-valid row
without getting an unpredictable one, so a loop over seeds covers a spread of
shapes and every failure reproduces from the seed alone:

<!-- @conformance:skip reason=continues the harness snippet above (t is defined there) -->

```ts
for (const seed of [1, 2, 3, 4, 5]) {
  const r = await t.ctx.data.product.create(t.arb.product({ seed }));
  // a failure here names the seed; re-run that one seed to get the exact row back
  assert(r.ok, `seed ${seed} produced a row the write path rejected`);
}
```

**Assert only what you override.** The generated values are structurally valid
with no domain meaning, and which value a seed produces is free to change when
you upgrade — `t.build.product({ name: "Widget" })` then asserting on `name` is
stable, asserting on the generated `sku` is not. Seeding buys you reproducible
_variety_, not a fixture you can pin.

### The single-connection false green

PGlite is **one** connection, so two "concurrent" transactions serialize. A lost
update, a double mint, or a non-locking read-before-write passes green on PGlite
and ships the race. Copy this three-piece pattern:

<!-- @conformance:ts imports= -->

```ts
// concurrency.test.ts — armed by an env-gated REAL Postgres, visibly skipped otherwise.
// Gate on the SAME `DATABASE_URL` main.ts uses, so the teeth run against the real database
// whenever one is wired — no second env var to remember.
const PG_URL = Deno.env.get("DATABASE_URL");
Deno.test(
  { name: "two connections cannot double-mint", ignore: !PG_URL },
  async () => {
    // open TWO real connections (postgresDb(postgres(PG_URL!)) each) and interleave the racing halves…
  },
);
```

1. **Gate on an env var** — a default `deno test` shows it _ignored_, a visible
   skip rather than a silent green.
2. **Arm it in CI** with a Postgres service container, so it bites on every
   push.
3. **Write one for every read-then-write** — check-then-insert, a counter bump,
   a rollup re-stamp. That read needs `FOR UPDATE` or a unique index; only two
   connections prove it.

`hazelnut add resource <module>/<name> --ops <op>` emits a failing test stub per
operation, so an unwritten test fails loudly.

## 12. The verification envelope

`hazelnut verify` checks _discipline_ — how the code is written — against an
invariant roster. It is not a test run: generate with principles, verify with
rules. **Every build serves it**, and it always tells you which rungs it ran:

```sh
hazelnut verify ./app.ts
```

The rung every build runs is the **structural** one — a fold over the model your
declarations compose to. Its report ends with the subjects it did _not_ look at,
so a clean run never reads as more than it is.
[`cli/verify.md`](./cli/verify.md) is the reference.

## 13. Operating in production

[Deploying](./DEPLOY.md) is the full path. The operational surface:

- **`GET /health`** — public, shallow liveness probe, no database call.
- **`GET /ready`** — the deep readiness sibling: a database probe AND relay
  liveness. A dead drain loop or an over-budget outbox head returns 503 with a
  coarse reason slug. Point the orchestrator's readiness check here and its
  liveness check at `/health`.
- **`GET /version`** — the gated build-identity half, opt-in via
  `version: { gate: PermKey }` (`import type { PermKey } from "hazelnut"`) and
  deny-by-default.
- **Outbox backpressure** — past `defineConfig({ outbox: { maxReadyBacklog } })`
  waiting rows (50 000 by default), `ctx.emit` fails with `timeout` and the
  operation rolls back. That is the source valve behind three softer signals: a
  warning log at half the budget, a backlog alarm, and `/ready`. Retry with an
  idempotency key once the relay drains; `false` disables the valve.
- **`hazelnut relay <app>`** — drains the outbox and routes runtime alarms
  (dead-letter depth, relay liveness, the backlog watermark, model-derived
  asserts) into your alarm sink. In `--loop` mode, `--health-port <n>` serves
  the worker's own `GET /healthz`, the headless sibling of `/ready`.

  **A separate relay process needs its own seams.** `app.ts` carries none, so an
  app with `file()`, `vector` or `encrypted` fields exports a factory the CLI
  threads in:

  <!-- @conformance:skip reason=illustrative fragment, undeclared localDriver import -->

  ```ts
  // relay.ts
  export const relaySeams = () => ({
    storage: localDriver({ dir: Deno.env.get("FILES_DIR")! }),
  });
  ```

  Without it, `hazelnut relay` refuses at startup and names the missing seam. A
  single-process deployment needs none.
- **`hazelnut redrive <app> [--topic <t>] [--limit <n>]`** — dead-letter
  recovery. After fixing a poison batch, move the dead-lettered records back for
  the standing relay to re-process. `--topic` resurrects one stream; `--limit`
  re-drives in chunks.
- **`hazelnut rotate-key <app> --from <old-version> --new-key-env <VAR> --old-key-env <VAR>`**
  — re-wrap encrypted data keys under a new master key.
- **`hazelnut run-workflow <name> <app>`** — run a declared `defineWorkflow`.

  **Those three change your datastore, so none of them acts until you say
  `--execute`.** Run one bare and you get a plan: how many dead-lettered jobs
  would move and under which topics, how many rows would be re-wrapped off which
  key version, which workflow steps would resume from the journal and which
  would fire for real. Nothing is written. Re-run the same command with
  `--execute` on the end and exactly that lands.

  Read the redrive plan before you run it. A re-drive re-sends every listed
  job's external effect — mail, webhooks, provider calls — and it removes the
  dead-letter row that recorded the attempt count and the error, so after the
  move neither is answerable from your database. Scope it with `--topic` when
  you only meant to recover one stream.
- **`hazelnut unstick-workflow <app> --workflow <id> --step <stepId>`** — a
  crashed step's claim self-heals once its lease lapses; this forces that NOW,
  for the operator who already knows the prior runner is dead and does not want
  to wait. `--execute` lands it (bare: the plan). Force a claim that is
  genuinely still live and a non-idempotent step runs twice — the plan says so
  explicitly every time it would.

  There is no `unstick-webhook` or `unstick-cron` because there is nothing to
  force: a workflow step is the one substrate with a lease that outlives the
  process holding it, so a crash mid-step leaves a claim only a forced expiry
  clears. A queue/webhook consumer and a cron tick claim their row inside one
  database transaction — a crash rolls that transaction back, so the claim is
  already gone by the time anyone could look for it. A webhook stuck in retry is
  not a lease problem; it is the outbox's dead-letter path, and `redrive` above
  already covers it.
- **Metrics** — compose `recordMetricsSink(collector)` into your log-sink chain
  for the rate / errors-by-kind / duration trio per operation, and bring your
  own registry behind the `MetricsCollector` port. `memoryMetricsCollector()` is
  the development floor. These three are deliberately off the barrel — import
  them by path:

  <!-- @conformance:skip reason=illustrative import line, the symbols are off-barrel by design -->

  ```ts
  import {
    memoryMetricsCollector,
    type MetricsCollector,
    recordMetricsSink,
  } from "hazelnut/runtime/observe-derive.ts";
  ```
- **The read-path deadline is yours to set.** The framework floors only the
  **write** path — every write transaction gets a 30-second statement timeout
  unless the operation declares its own `deadlineMs`. The default read path
  carries no per-statement deadline, so a pathological query under load can hold
  pool connections. Set a pool-level `statement_timeout` on the connection you
  hand to `createApp` (for example `?options=-c statement_timeout=10s` on the
  DSN). That is the deployment's obligation, not an automatic floor.

### Changing the API shape

Two edits look similar and are not. Adding a field to a resource's `schema`
grows what its read routes return — every read names its `columns`, so a feature
you enable cannot widen the wire by itself. Turning a FEATURE on does not: the
column it adds is stored and stays off the wire until you name it in `columns`.
So a feature you enable to fix a data problem never surprises a client.

**`defineVersion`** is how a breaking wire change lands without breaking live
callers: you declare the new shape as a version rather than editing the old one
in place, and both are served while callers migrate. What counts as breaking is
not a judgement call — [Versioning](./VERSIONING.md) states it per surface.

## 14. CLI reference

Each verb has its own page under [`cli/`](./cli/new.md). Every verb takes a
closed set of flags: pass one it does not take and it exits 2 naming the flag
and listing the ones it does take, before anything runs. A typo (`--jsonn`) or a
guess (`--dry-run` where `launch` takes `--print`) refuses instead of quietly
doing something else, so a script never has to check whether a flag landed.

The map:

| Verb                                                         | Purpose                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------- |
| `hazelnut help`                                              | list the verbs this build serves (`--help`, `-h`)       |
| [`hazelnut new <name>`](./cli/new.md)                        | scaffold a runnable app                                 |
| [`hazelnut add`](./cli/add.md)                               | add a module or a resource, and register it             |
| [`hazelnut doctor`](./cli/doctor.md)                         | environment checkup                                     |
| [`hazelnut verify <app>`](./cli/verify.md)                   | run the structural rung over your composed model        |
| [`hazelnut migrate <app>`](./cli/migrate.md)                 | schema diff, apply, rebuild                             |
| [`hazelnut launch <app>`](./cli/launch.md)                   | least-privilege supervised serve                        |
| [`hazelnut mcp stdio\|gateway`](./cli/mcp.md)                | emit an MCP transport entry                             |
| `hazelnut relay <app>`                                       | drain the outbox and route alarms                       |
| `hazelnut redrive <app>`                                     | dead-letter recovery (plan; `--execute` lands it)       |
| `hazelnut rotate-key <app> --from <v> …`                     | re-wrap encrypted data keys (`--execute` lands it)      |
| `hazelnut run-workflow <name> <app>`                         | run a declared workflow (`--execute` lands it)          |
| `hazelnut unstick-workflow <app> --workflow <id> --step <s>` | force-reclaim a stuck step claim (`--execute` lands it) |

## Where to go next

- **[Deploying](./DEPLOY.md)** — the one documented path to production.
- **[Versioning](./VERSIONING.md)** — what a version number promises.
- **[Glossary](./GLOSSARY.md)** — one concept, one name.
