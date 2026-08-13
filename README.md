# Hazelnut

One `defineResource` is the single source. Types, HTTP routes, Postgres schema, MCP tools, and the
op-pipeline derive at boot by composition. Nothing is generated to disk to keep in sync.

This repository is a Deno workspace of the packages below.

## Packages

| Directory | Package | Role |
| --- | --- | --- |
| [`core/`](./core/) | `@hazelnut/core` | Derivation engine, runtime, structural `verify`, operator CLI |
| [`ai/`](./ai/) | `@hazelnut/ai` | Model connector (`defineLLMCall`, `ctx.llm`) |

Start with [`core/docs/QUICKSTART.md`](./core/docs/QUICKSTART.md). The handbook index is
[`core/docs/README.md`](./core/docs/README.md).

## Acquire

```sh
deno run --allow-read --allow-write=. --allow-env --allow-run=deno,git --allow-net jsr:@hazelnut/core/cli new my-app
```

Named grants only — never `-A`. After scaffold, `deno task start` / `dev` use the least privileges
the app needs.

## Issues

Bug reports and questions: https://github.com/Hazelnut-17/hazelnut/issues

Please open an issue before a pull request. See [`core/CONTRIBUTING.md`](./core/CONTRIBUTING.md).
Security reports: this repository's **Security** tab → **Report a vulnerability**.

## License

Apache-2.0 — each package directory carries the full text in `LICENSE`.
