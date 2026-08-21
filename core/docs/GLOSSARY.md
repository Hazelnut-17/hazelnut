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

- **op-pipeline** — the single path every operation takes: policy → row policy →
  hooks → transaction → outbox. There is no second path, and nothing bypasses
  it.
- **scope** — the generic row-ownership primitive: a column plus a resolver.
  Multi-tenancy is a recipe written over it, not a concept the framework owns.
- **row policy** — the rule that narrows what a given actor may read or write,
  applied inside the pipeline rather than remembered at each call site.
- **outbox / relay** — events are captured in the same transaction as the write
  that caused them (the outbox), and delivered afterwards by the relay. A
  delivery that keeps failing lands in a dead-letter queue you `redrive`.
- **seam** — a boundary where you plug your own implementation in: the database,
  a datasource, a key store, an LLM client. A seam is always explicit and typed.
- **fail-closed** — the failure posture: when a security-relevant check cannot
  decide, it refuses. Failures are loud — thrown, refused, or logged — never
  silently degraded.

## Evolution

- **surface lock** — a committed record of your public HTTP, MCP, and event
  shapes. A change that is not additive against it is a breaking change, and
  saying so is the lock's job rather than a reviewer's memory.
- **additive** — a change that only adds: a new route, a new optional field, a
  new tool. Removing, renaming, retyping, or making something required is not
  additive. See [Versioning](./VERSIONING.md) for what each lane permits.

## Capability modules

The framework ships as separable capability modules. This is a different sense
of _module_ from the one above: a **capability module** is a piece of the
framework, an ordinary **module** is a group of resources in your app. A
capability module is framework-level — your app declares nothing to enable one,
and its absence changes what your **build** serves, never what you may declare.

- **core** — the derivation engine and its runtime: resources, faces, routes,
  schema, the op-pipeline, authz, async, MCP, the CLI's operating verbs.
  Published as `@hazelnut/core`.
- **ai** — the model connector: the client port, the provider adapters, and the
  declared call path business logic reaches a model through, with its token
  budget and its provenance stamp. It knows how to _call_ a model and has no
  opinion about what the answer is for. Runs inside your serving process, so it
  is a dependency your deploy target must resolve. Delivered separately as
  `@hazelnut/ai`.

A capability module is named by what it contains, never by what it costs, and
this list is not a price ladder — a module is separate because it is separable.
The CLI names the verbs its own build serves and refuses the rest, so a verb
your build does not have says so instead of failing obscurely. Every handbook
passage that needs one opens with that module's marker.
