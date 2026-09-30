# The Hazelnut Handbook

**Agent-first Deno backend: MCP is first-class, but exposure is explicit.**

Declare each entity once with **`defineResource`**; its types and Postgres
schema derive at boot. Custom handlers are separate operations. Choose which
operations to expose as MCP tools, HTTP routes, or both; opening one door never
opens the other. Both enter the same operation pipeline, which enforces each
door's declared policy. `http.external: true` skips policy only for HTTP traffic
authorized upstream; it never grants direct MCP access. `hazelnut new --example`
demonstrates the agent path with a curated, anonymous row-protected list and
actor-owned writes that stay hidden until auth grants them. Added resources stay
off-wire until you explicitly expose them. Nothing is generated to disk or
maintained as a parallel API.

Agent-first is a priority, not automatic exposure. The agent door is the surface
this handbook teaches first: tools are curated, row access is declared, and
destructive actions carry a confirmation hint for the host. Human clients can
use explicitly mounted HTTP routes into the same operation pipeline; the
HTTP-only upstream-authority exception above does not authorize direct MCP.

## How this handbook is organised

Four kinds of page, following [Diátaxis](https://diataxis.fr). Each page says at
the top which kind it is and who it is for, so you can tell in one line whether
you are in the right place.

| Kind          | Read it when                              | Pages                                                                                                         |
| ------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Tutorial**  | you have never used Hazelnut              | [Quickstart](./QUICKSTART.md)                                                                                 |
| **How-to**    | you know the shape and have a task        | [The agent door](./agent-door.md) · [Rundown](./rundown.md) · [Deploying](./DEPLOY.md)                        |
| **Reference** | you need the exact behaviour of one thing | [CLI pages](#the-cli) · [Refusals](./refusals.md) · [Glossary](./GLOSSARY.md) · [Versioning](./VERSIONING.md) |

Start with the [Quickstart](./QUICKSTART.md). It is about fifteen minutes and
ends with a serving backend; the [Rundown](./rundown.md) assumes you have done
it.

## The CLI

| Verb                                            | What it does                                       |
| ----------------------------------------------- | -------------------------------------------------- |
| [`new`](./cli/new.md)                           | scaffold a runnable app                            |
| [`add`](./cli/add.md)                           | add a module or resource, and register it          |
| [`doctor`](./cli/doctor.md)                     | check the environment, and name the fix            |
| [`verify`](./cli/verify.md)                     | check your declarations against the roster         |
| [`migrate`](./cli/migrate.md)                   | change the database schema, safely                 |
| [`launch`](./cli/launch.md)                     | serve under derived least-privilege                |
| [`mcp`](./cli/mcp.md)                           | expose the MCP surface over another transport      |
| [`relay`](./cli/relay.md)                       | drain the outbox as its own process                |
| [`redrive`](./cli/redrive.md)                   | move dead-lettered messages back for the relay     |
| [`rotate-key`](./cli/rotate-key.md)             | re-wrap encrypted data under a new master key      |
| [`equality-cutover`](./cli/equality-cutover.md) | make one key version canonical for unique equality |
| [`run-workflow`](./cli/run-workflow.md)         | run or resume a declared workflow                  |
| [`unstick-workflow`](./cli/unstick-workflow.md) | free a dead runner's step claim now                |
| [`install`](./cli/install.md)                   | restore the vendored framework tree                |
| [`ops`](./cli/ops.md)                           | pull a production lever without a deploy           |

## Core, and capability modules

`@hazelnut/core` is the derivation engine and its runtime — resources, routes,
schema, the operation pipeline, authz, async, MCP. Capability modules are
delivered as separate artifacts; your CLI lists the verbs this build serves and
refuses the rest.

| Module | What it adds                                             | When it runs                |
| ------ | -------------------------------------------------------- | --------------------------- |
| **ai** | the model connector business logic calls a model through | inside your serving process |

The `ai` module is a separate artifact, so its book is not a page of this one
and a link from here would point at something this package does not carry. That
book ships inside `@hazelnut/ai`; install the module and it arrives with it, or
browse the published copy from the
[repository](https://github.com/Hazelnut-17/hazelnut).

Every passage that needs a capability module opens with a blockquote naming that
module, so one line tells you whether it applies to the build you have.

You will never be told to run something your CLI will refuse, or to import
something your build does not carry, without being told first. See the
[Glossary](./GLOSSARY.md) for what each module contains.

## What this framework does not do

It brings no platform, no provisioning language, no hosting. It picks Postgres,
Deno, Hono, Zod and Drizzle for you, and those choices are not configurable —
the guarantees depend on them. See [Deploying](./DEPLOY.md) for where the
framework's promise ends and yours begins.

Three more, because agent-first invites the wrong guesses:

- **It does not turn HTTP routes into agent tools.** Nothing is exposed to an
  agent by existing. The agent surface is curated one operation at a time, so a
  route you open stays a route.
- **It does not demote HTTP.** Humans keep every route, on the same
  declarations. Agent-first is which surface is taught first and guarded
  hardest, never which callers are served.
- **It does not run agents.** There is no planner, no orchestration, no tool
  marketplace. Hazelnut serves the door; what happens on the other side of it
  belongs to the host.
