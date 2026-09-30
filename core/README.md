# @hazelnut/core

Agent-first Deno backend: MCP is a first-class interface, but exposure is explicit. Model each entity
once with `defineResource`; custom handlers are separate operations. Choose which operations to expose
as MCP tools, HTTP routes, or both; opening one door never opens the other. Both enter the same operation
pipeline, which enforces each door's declared policy. `http.external: true` skips policy only for HTTP
traffic authorized upstream; it never grants direct MCP access. `hazelnut new --example` demonstrates a curated anonymous,
row-protected list and actor-owned writes that stay hidden until auth grants them. Added resources stay
off-wire until exposed. Nothing is generated to disk or maintained as a parallel API.

```ts
import { createApp, defineResource } from "@hazelnut/core";
```

## What this module includes

The derivation engine and its runtime: resources, modules, ops, authz (`scope` / `rowPolicy` /
perms), the feature set (`encrypted`, `transitions`, `sequence`, `searchable`, `vector`, …), the
transactional outbox, the MCP surface, and the app-facing test harness at `@hazelnut/core/test.ts`.

## The CLI

```sh
deno run --allow-read --allow-write=. --allow-env --allow-run=deno,deno.exe,git --allow-net jsr:@hazelnut/core/cli new my-app
# or install once (same grants), then call it by name:
deno install --allow-read --allow-write=. --allow-env --allow-run=deno,deno.exe,git --allow-net -n hazelnut jsr:@hazelnut/core/cli
```

Verbs: `help` · `new` · `add` · `install` · `doctor` · `verify` · `migrate` · `launch` · `mcp` · `relay` · `ops` · `redrive` · `rotate-key` · `equality-cutover` · `run-workflow` · `unstick-workflow`

## The handbook

Ships in this package, under `docs/`. Start at `docs/README.md` — it is the index.

- `docs/QUICKSTART.md` — an empty directory to a serving app, one linear path
- `docs/rundown.md` — the task recipes
- `docs/cli/` — reference pages for the verbs that have one: what the verb does, its flags, its exit codes
- `docs/DEPLOY.md` · `docs/VERSIONING.md` · `docs/GLOSSARY.md`

## Issues and contributions

Issues: https://github.com/Hazelnut-17/hazelnut/issues — bug reports and requests are welcome.

Please open an issue before sending a pull request. Changes to package source land in
maintainer releases — see CONTRIBUTING.md.

## License

Apache-2.0 — the full text, with the copyright statement, is in LICENSE.
