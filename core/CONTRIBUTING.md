# Contributing

@hazelnut/core is developed in a private tree and assembled into this repository one way. What you
are reading is the published form of the framework, not the place it is written.

## Pull requests cannot be merged

Every file here is emitted or assembled by that process — `src/**`, plus `deno.json` · `LICENSE` · `README.md` · `CONTRIBUTING.md` · `llms.txt` · `README.md` · `AGENTS.md` · `.gitattributes` · `.gitignore` · `.github/workflows/publish.yml`.
The next release overwrites them, whatever a pull request changed in between. This is not a policy
about contributions; it is what this repository is.

## What does reach the framework

**Issues.** Bug reports, questions, and requests are read. A fix lands in the private tree and
arrives here in the next release.

https://github.com/Hazelnut-17/hazelnut/issues

Include these and a report is usually answered in one round instead of three:

- the version you are on — the `jsr:` specifier you ran, or the pin in your app's `deno.json`
- `deno --version`
- the smallest `defineResource` declaration that reproduces it
- what you expected, and what happened instead

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
