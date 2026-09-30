# Hazelnut

Agent-first Deno backend: MCP is a first-class interface, but exposure is explicit. Model each entity
once with `defineResource`; custom handlers are separate operations. Choose which operations to expose
as MCP tools, HTTP routes, or both; opening one door never opens the other. Both enter the same operation
pipeline, which enforces each door's declared policy. `http.external: true` skips policy only for HTTP
traffic authorized upstream; it never grants direct MCP access. `hazelnut new --example` demonstrates a curated anonymous,
row-protected list and actor-owned writes that stay hidden until auth grants them. Added resources stay
off-wire until exposed. Nothing is generated to disk or maintained as a parallel API.

This repository is a Deno workspace of the packages below.

## Packages

| Directory | Package | Role |
| --- | --- | --- |
| [`core/`](./core/) | `@hazelnut/core` | Derivation engine, runtime, structural `verify`, operator CLI |
| [`ai/`](./ai/) | `@hazelnut/ai` | Model connector ([handbook](./ai/docs/modules/ai/ai.md): `defineLLMCall`, `ctx.llm`) |

Start with [`core/docs/QUICKSTART.md`](./core/docs/QUICKSTART.md). The handbook index is
[`core/docs/README.md`](./core/docs/README.md).

## Acquire

```sh
deno run --allow-read --allow-write=. --allow-env --allow-run=deno,deno.exe,git --allow-net jsr:@hazelnut/core/cli new my-app
```

Named grants only — never `-A`. After scaffold, `deno task start` / `dev` use the least privileges
the app needs.

## Issues

Bug reports and questions: https://github.com/Hazelnut-17/hazelnut/issues

Please open an issue before a pull request. See [`core/CONTRIBUTING.md`](./core/CONTRIBUTING.md).
Security reports: this repository's **Security** tab → **Report a vulnerability**.

## License

Apache-2.0 — each package directory carries the full text in `LICENSE`.
