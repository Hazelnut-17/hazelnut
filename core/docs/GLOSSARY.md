# Glossary

> **Reference** — for anyone reading Hazelnut's documentation or its error
> messages. One concept, one name: these terms are used bare elsewhere, and this
> is where they are defined.

## Declaring an application

- **resource** — one `defineResource` call, and the single source for everything
  derived from it: the types, the routes, the table, the tools.
- **face** — a TypeScript view derived from a declaration: `Row`, `Insertable`,
  `Updatable`, `Where`, and the typed client. Faces are _inferred_, never
  generated to a file.
- **module** — a group of resources that owns its own database schema and
  declares which other modules it may depend on. (The framework's own pieces are
  _capability modules_ — see the last section.)
- **curation** — the agent surface is opt-in per operation: only what a resource
  lists under `mcp:` becomes a tool, and each listed op owes a `describe`.
  Opening an HTTP route publishes nothing to an agent.
- **barrel** — a module you import the framework from. Nothing is public by
  accident: what a barrel exports is the supported surface, and everything else
  is internal.
- **root barrel** — `hazelnut` itself. It carries the authoring verbs, the
  `Result` seam and the authz vocabulary — everything you need to declare an app
  and put a guarded operation on the wire, minus the row-policy fragments, which
  are a concern barrel's.
- **concern barrel** — a named subpath (`hazelnut/query`, `hazelnut/schema`,
  `hazelnut/async`, `hazelnut/crypto`, `hazelnut/faces`), each covering one
  concern. A symbol belongs to exactly one, so there is never a choice about
  where to import it from. A concern name is never a directory name: a specifier
  with a file on the end (`hazelnut/data/repo.ts`) is a raw module, not part of
  the curated surface.

## Running an application

- **op-pipeline** — the path a custom operation (`defineOp`) takes: validate →
  policy → transaction → handler → `Result`. CRUD writes are not that path; they
  still take policy, row policy, and the write transaction. See the Rundown on
  custom operations.
- **scope** — the generic row-ownership primitive: a column plus a resolver.
  Multi-tenancy is a recipe written over it, not a concept the framework owns.
- **row policy** — the rule that narrows what a given actor may read or write,
  applied inside the pipeline rather than remembered at each call site.
- **outbox / relay** — events are captured in the same transaction as the write
  that caused them (the outbox), and delivered afterwards by the relay. A
  delivery that keeps failing lands in a dead-letter queue you `redrive` (plan;
  `--execute` lands it).
- **seam** — a boundary where you plug your own implementation in: the database,
  a datasource, a key store, an LLM client. A seam is always explicit and typed.
- **fail-closed** — the failure posture: when a security-relevant check cannot
  decide, it refuses. Failures are loud — thrown, refused, or logged — never
  silently degraded.
- **`NO_CAS`** — the framework-only, named exception to a `versioning` write's
  caller precondition. It is never an HTTP, MCP, or application-facing option:
  only a cascade delete, `set-null` integrity sweep, expiry reaper, or a
  non-versioning singleton replace may use it. See the Rundown for why each is
  safe to write without a caller-held version.
- **agent door** — `POST /mcp`, the MCP surface a served app already mounts. The
  same declarations serve it and HTTP; `hazelnut mcp` emits an entry when a host
  needs a different transport.
- **gate** — the permission a caller must hold to reach a door at all, checked
  before the request body is read. `mcp.gate` therefore answers for the whole
  agent door, handshake included. `null` is the open door, declared on purpose;
  absence is what refuses at boot.
- **Origin allowlist** — `mcp.allowedOrigins`: which browser page may reach the
  door. It stops a page, never a client, so it never substitutes for a gate.
- **capability filter** — the per-identity narrowing of `tools/list`: a caller
  is offered only the tools their own policy admits. It runs whether or not a
  gate does, and the two answer different questions.
- **confirm** — `confirm: true` on a destructive agent tool, which surfaces the
  host's human-in-the-loop prompt before the call runs. It is not a permission:
  the policy still decides whether that caller may act at all.
- **listChanged** — the notification that a caller's visible tool set has moved.
  A transport advertises it only when it can actually deliver it.

## Evolution

- **invariant** — a machine-checked structural rule with a stable identifier
  such as `scope/key-minted`. The structural roster lives in `@hazelnut/core`;
  `hazelnut verify` is a core verb.
- **additive** — a change that only adds: a new route, a new field, a new tool.
  Removing, renaming, or retyping is not additive. HTTP and MCP also treat a
  newly required field or argument as breaking; an event payload has no
  requiredness in the lock. See [Versioning](./VERSIONING.md) for what each lane
  permits.

## Capability modules

The framework ships as separable capability modules. This is a different sense
of _module_ from the one above: a **capability module** is a piece of the
framework, an ordinary **module** is a group of resources in your app. A
capability module is framework-level — your app declares nothing to enable one.
Its absence changes what your **build** serves: which verbs exist, and which
declaration keys exist.

- **core** — the derivation engine and its runtime: resources, faces, routes,
  schema, the op-pipeline, authz, async, MCP, the CLI's operating verbs.
  Published as `@hazelnut/core`.
- **ai** — the model connector: the client port, the provider adapters, and the
  declared call path business logic reaches a model through, with its token
  budget and its provenance stamp. The `llm` / `llmCalls` keys exist only in a
  build that carries this module. It knows how to _call_ a model and has no
  opinion about what the answer is for. Runs inside your serving process, so it
  is a dependency your deploy target must resolve. Delivered separately as
  `@hazelnut/ai`.

A capability module is named by what it contains, never by what it costs, and
this list is not a price ladder — a module is separate because it is separable.
The CLI names the verbs its own build serves and refuses the rest, so a verb
your build does not have says so instead of failing obscurely. Every handbook
passage that needs one opens with that module's marker.
