# The Hazelnut Handbook

**Agent-first Deno backend — humans use the same resources over HTTP.**

You write **one `defineResource`** per entity; the TypeScript types, the HTTP
routes, the Postgres schema, the MCP tools and the operation pipeline all derive
from it at boot, by composition. Nothing is generated to disk, so there is no
watcher and nothing to keep in sync.

Agent-first is a priority, not an exclusion. The agent door is the surface this
handbook teaches first and guards hardest — curated tools, a declared posture,
confirmation on anything destructive. Every route a human client had is still
there, derived from the same declaration, because there is one set of
declarations and no second stack.

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
