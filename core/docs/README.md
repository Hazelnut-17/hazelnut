# The Hazelnut Handbook

Hazelnut is a Deno backend framework. You write **one `defineResource`** per
entity; the TypeScript types, the HTTP routes, the Postgres schema, the MCP
tools and the operation pipeline all derive from it at boot, by composition.
Nothing is generated to disk, so there is no watcher and nothing to keep in
sync.

## How this handbook is organised

Four kinds of page, following [Diátaxis](https://diataxis.fr). Each page says at
the top which kind it is and who it is for, so you can tell in one line whether
you are in the right place.

| Kind          | Read it when                              | Pages                                                                             |
| ------------- | ----------------------------------------- | --------------------------------------------------------------------------------- |
| **Tutorial**  | you have never used Hazelnut              | [Quickstart](./QUICKSTART.md)                                                     |
| **How-to**    | you know the shape and have a task        | [Rundown](./rundown.md) · [Deploying](./DEPLOY.md)                                |
| **Reference** | you need the exact behaviour of one thing | [CLI pages](#the-cli) · [Glossary](./GLOSSARY.md) · [Versioning](./VERSIONING.md) |

Start with the [Quickstart](./QUICKSTART.md). It is about fifteen minutes and
ends with a serving backend; the [Rundown](./rundown.md) assumes you have done
it.

## The CLI

| Verb                          | What it does                                  |
| ----------------------------- | --------------------------------------------- |
| [`new`](./cli/new.md)         | scaffold a runnable app                       |
| [`add`](./cli/add.md)         | add a module or resource, and register it     |
| [`doctor`](./cli/doctor.md)   | check the environment, and name the fix       |
| [`verify`](./cli/verify.md)   | check your declarations against the roster    |
| [`migrate`](./cli/migrate.md) | change the database schema, safely            |
| [`launch`](./cli/launch.md)   | serve under derived least-privilege           |
| [`mcp`](./cli/mcp.md)         | expose the MCP surface over another transport |

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
