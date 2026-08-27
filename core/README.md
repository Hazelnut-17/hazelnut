# @hazelnut/core

Hazelnut — a Deno backend framework where one `defineResource` is the single
source for the type faces, HTTP routes, Postgres schema, MCP tools, and the op-pipeline. Everything
derives at boot by composition; nothing is generated to disk.

```ts
import { createApp, defineResource } from "@hazelnut/core";
```

## What this module includes

The derivation engine and its runtime: resources, modules, ops, authz (`scope` / `rowPolicy` /
perms), the feature set (`encrypted`, `transitions`, `sequence`, `searchable`, `vector`, …), the
transactional outbox, the MCP surface, and the app-facing test harness at `@hazelnut/core/test`.

## The CLI

```sh
deno run --allow-read --allow-write=. --allow-env --allow-run=deno,deno.exe,git --allow-net jsr:@hazelnut/core/cli new my-app
# or install once (same grants), then call it by name:
deno install --allow-read --allow-write=. --allow-env --allow-run=deno,deno.exe,git --allow-net -n hazelnut jsr:@hazelnut/core/cli
```

Verbs: `help` · `new` · `add` · `install` · `doctor` · `verify` · `migrate` · `launch` · `mcp` · `relay` · `ops` · `redrive` · `rotate-key` · `run-workflow` · `unstick-workflow`

## The handbook

Ships in this package, under `docs/`. Start at `docs/README.md` — it is the index.

- `docs/QUICKSTART.md` — an empty directory to a serving app, one linear path
- `docs/rundown.md` — the task recipes
- `docs/cli/` — one reference page per verb: what it does, its flags, its exit codes
- `docs/DEPLOY.md` · `docs/VERSIONING.md` · `docs/GLOSSARY.md`

## Issues and contributions

Issues: https://github.com/Hazelnut-17/hazelnut/issues — bug reports and requests are welcome.

Please open an issue before sending a pull request. Changes to package source land in
maintainer releases — see CONTRIBUTING.md.

## License

Apache-2.0 — the full text, with the copyright statement, is in LICENSE.
