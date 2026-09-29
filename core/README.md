# @hazelnut/core

Agent-first Deno backend. Model each entity once with `defineResource`; custom handlers are separate
operations. Explicitly choose which operations to expose as MCP tools or HTTP routes — opening
one door never opens the other, and both enforce the same policies through the same operation pipeline.
The starter proves the agent path with an anonymous, row-protected list; writes stay hidden until auth
grants them. Added resources stay off-wire until exposed. No generated files or parallel API.

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
