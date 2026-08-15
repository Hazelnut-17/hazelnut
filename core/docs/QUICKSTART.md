# Quickstart

> **Tutorial** — for a developer who has never used Hazelnut. Follow it in
> order; every step is verifiable before you move on. Roughly fifteen minutes.

You will end with a backend that serves HTTP, answers an agent over MCP, and
keeps its schema in a real database — derived from one declaration you write
yourself.

Nothing here needs a database installed, an account, or an API key.

## Before you start

You need [Deno](https://deno.com) 2.x. Check it:

```sh
deno --version
```

Hazelnut pins exact versions and commits `deno.lock`: a bump is always a
deliberate act. Read the release's Breaking section before you take one — a
MINOR or MAJOR may ask you to edit your app; a PATCH does not.

## 1. Create the app

Acquire Hazelnut from the registry. Those flags are what `new` needs — write
under the current directory, warm the lock, optionally `git init`. They are not
the serve path: after this step, `deno task dev` / `deno task start` never use
`-A`.

```sh
deno run --allow-read --allow-write=. --allow-env --allow-run=deno,git --allow-net jsr:@hazelnut/core@0.3.2/cli new my-app
cd my-app
```

If you already have the framework tree on disk, run the CLI from that tree
instead:

```sh
deno run --allow-read --allow-write=. --allow-env --allow-run=deno,git --allow-net src/cli/hazelnut-core.ts new my-app
```

The CLI pins the published version or the tree it was run from, so the app you
get is bound to the exact framework it was generated against — the pin is
written into `deno.json`, and `deno.lock` is committed beside it. It writes a
complete, runnable project: `hazelnut.config.ts`, `app.ts`, `main.ts`,
`deno.json` with every dependency pinned, `app.test.ts`, `.env.example`, a
`Dockerfile`, and the repository hygiene files. You write none of that.

## 2. Declare a resource

A resource is one `defineResource` call. From it Hazelnut derives the TypeScript
types, the HTTP routes, the Postgres table, and the MCP tools — at boot, by
composition. No code is generated to disk, and there is no watcher.

Create `note.resource.ts`:

<!-- @conformance:resource -->

```ts
import { defineResource } from "hazelnut";
import { z } from "zod";

export const note = defineResource({
  name: "note",
  schema: z.object({
    title: z.string(),
    body: z.string(),
    owner_id: z.string(), // who this note belongs to — the column the row rule narrows on
  }),
  features: { timestamps: true, versioning: false }, // timestamps maintained for you;
  // `versioning: false` STATES that last-write-wins is right for a note. There is no default — boot refuses
  // a resource that says nothing, because the framework cannot tell a counter from a draft.
  // WHICH ROWS, per caller. Two callers holding the same grant must not see each other's notes, so the
  // rule narrows on the row's own owner — and that is safe for an unauthenticated request by construction:
  // it arrives as an ANONYMOUS actor, which owns nothing, so the same conjunct matches no row. A bare
  // column name IS the ownership rule; the column is checked against the schema above.
  rowPolicy: "owner_id",
  http: {
    list: { policy: "policy", columns: ["id", "title", "owner_id"] },
    find: { policy: "policy", columns: ["id", "title", "owner_id"] },
    create: "policy",
  }, // every route deny-by-default; reads name the wire
  mcp: { list: { describe: "List notes.", shape: ["id", "title"] } }, // the agent surface
});
```

This is the posture `hazelnut new --example` writes for you: every route closed,
every read narrowed to the caller's own rows, from the first line.

**A row rule answers "which rows", not "may they in".** The permission already
decided whether the caller reaches the route; the row rule decides what they see
once there. A rule shaped `can(actor, "note:list") ? all() : none()` answers the
first question twice and the second one never — every grantee reads every other
grantee's notes — so boot refuses it and names the two answers: narrow on the
row (above), or return `shared()` when the rows really are the same for everyone
who gets this far (`shared(<condition>)` when that is a fixed subset rather than
the whole table). `features: { scope: true }` is not a third answer: it
partitions tenants, so two callers inside one tenant get the identical scope
conjunct and it separates them by nothing.

Four fields carry the whole declaration:

- **`schema`** — your Zod object. The types and the database columns both derive
  from it, so they cannot disagree.
- **`rowPolicy`** — which ROWS a guarded read returns. The rule above is "you
  see the notes you own, and no others": it narrows on the row's own `owner_id`,
  so two callers holding the same grant never meet. A read route carries no
  permission gate of its own, so this IS the gate. Write the function form
  instead once the rule is more than ownership — and when you do, remember that
  what narrows is the conjunct, not a test for a signed-in caller: put a bare
  `all()` behind `actor ?` and it narrows nobody, because an unauthenticated
  request arrives carrying an anonymous actor, not nothing.
- **`http`** — which routes mount, and how each is guarded. `"policy"` is
  deny-by-default: a write needs the permission (`note:create`), and a read
  returns only the rows `rowPolicy` admits. A verb you omit does not mount at
  all.
- **`mcp`** — what an agent may see. Only what you list here becomes a tool; the
  surface is curated, never automatic.

There is one other setting, `"public"`: an open route, served to every caller,
agent, and crawler, with no `rowPolicy` applied. Declare it only for data you
deliberately publish — section 2 of the [rundown](./rundown.md) works that case
through as its one counter-example.

**A read returns exactly the columns you name — nothing else.** A short-form
`"policy"` / `"public"` on `list`/`find` boot-refuses: every wire-serializing
read must declare a positive projection. `timestamps: true` put `created_at` and
`updated_at` in the table, and neither is on the wire until you list it. That is
the rule, not an oversight: switching a feature on moves storage, never your
public shape, so nothing you turn on later can widen what a client already
parses. Name the whole response in `columns` on each read verb:

<!-- @conformance:skip reason=the http fragment of the declaration above, not a standalone module -->

```ts
http: {
  list: { policy: "policy", columns: ["id", "title", "created_at"] },
  find: { policy: "policy", columns: ["id", "title"] },
  create: "policy",
},
```

Now `GET /notes` returns exactly those three keys while `find` returns two — the
two read verbs project independently. The list is positive: it names everything
served, so a column you forget is a column no client sees. The same list governs
the `mcp` agent tool for that verb, so the agent surface can never be wider than
the route it mirrors. Boot refuses a name that is not a column of the table, and
refuses one you also marked `sensitive` — that field is dropped from every
response, so promising it would be a lie.

Register it in `hazelnut.config.ts`: import `note` from `./note.resource.ts`,
then add it to `resources: [...]`.

(`deno task add resource` scaffolds into a **module** —
`add resource <module>/<name>` — so it comes in later, once you have one.
Section 4 of the [rundown](./rundown.md) covers modules.)

**Three declaration verbs are all you need today.** `defineResource`, plus
`defineConfig` and `createApp` — and the scaffold already wrote the last two.
(`all` and `none` are not declaration verbs; they are the two nullary answers of
the condition algebra `rowPolicy` returns, and `can` is the permission question
it asks.) Every other `define*` waits until you have a reason for it.

## 3. Serve it

```sh
deno task dev
```

The development server uses an in-memory Postgres (PGlite) and syncs the schema
at boot, so there is nothing to install or migrate yet. `deno task dev` asks for
that database explicitly, by setting `HAZELNUT_DEV=1`. Run `main.ts` yourself
with neither `HAZELNUT_DEV=1` nor a `DATABASE_URL` and it refuses to start —
that is deliberate, and it is what stops a deployment that lost its database url
from quietly serving an empty in-memory one.

```sh
curl localhost:8000/health    # {"status":"ok"}
curl localhost:8000/notes     # []
```

That second `[]` is the `rowPolicy` answering, not an empty table: the curl
carries no credentials, so it is the anonymous caller, and the anonymous caller
sees no rows. Wire auth and the same route starts returning them.

All of this derived from the declaration you wrote:

| Route         | What it is                          |
| ------------- | ----------------------------------- |
| `GET /notes`  | typed list, narrowed by `rowPolicy` |
| `POST /notes` | create, gated by `note:create`      |
| `GET /health` | liveness probe                      |
| `POST /mcp`   | the agent surface                   |

The OpenAPI document is a declaration too, and this scaffold does not make it:
`GET /openapi.json` answers **404** until you write `openapi: { … }` in
`hazelnut.config.ts`. `hazelnut new --example` writes the GATED form
(`openapi: { gate: "widget:list" }`) so the document is there and closed. The
open form exists — `openapi: { public: true }` — and `hazelnut launch`, the
command that serves your app in production, refuses to start while a document is
ungated, so publishing one is always a deliberate act.

## 4. What comes next

Reach for more only when a real need appears:

- **[Rundown](./rundown.md)** — the practical guide: custom operations, authz,
  modules, events and background work, the seams you wire yourself.
- **[Deploying](./DEPLOY.md)** — the one documented path to production.
- **[CLI reference](./cli/new.md)** — every verb, its flags, and what it
  refuses.
- **[`hazelnut verify`](./cli/verify.md)** — check your declarations against an
  invariant roster: a missing policy, a feature switched on whose column was
  never derived, a module reaching outside the dependencies it declares. Every
  build serves it, and every report ends with what it did not look at.
