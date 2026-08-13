# Contributing

Thanks for helping improve @hazelnut/core.

## Issues

Bug reports, questions, and requests: https://github.com/Hazelnut-17/hazelnut/issues

Include these and a report is usually answered in one round instead of three:

- the version you are on — the `jsr:` specifier you ran, or the pin in your app's `deno.json`
- `deno --version`
- the smallest `defineResource` declaration that reproduces it
- what you expected, and what happened instead

## Pull requests

Please open an issue first. Package source (`src/**` and the package files listed below) is
updated in maintainer releases — pull requests that edit those paths are not merged.

Covered paths include `src/**`, plus `deno.json` · `LICENSE` · `README.md` · `CONTRIBUTING.md` · `llms.txt` · `README.md` · `AGENTS.md` · `.gitattributes` · `.gitignore` · `.github/workflows/publish.yml` · `.github/workflows/ci.yml`.

## Tone

When you write an issue or discuss a fix, match the product's public voice: precise, short,
fail-closed. Prefer a concrete command or a concrete refusal over a long explanation. Never ask
anyone to run with `-A`. Agents answering in this repository follow `AGENTS.md` at the
workspace root.

## Security

Do not open a public issue for a vulnerability. Use this repository's **Security** tab →
**Report a vulnerability**, which opens a channel visible only to the maintainers.

## License

Apache-2.0 — the full text, with the copyright statement, is in LICENSE.
