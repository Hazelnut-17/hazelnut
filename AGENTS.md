# Agent notes — Hazelnut repository

Help users of this repository. Workspace members: `core/`, `ai/`.

## How to help

1. Prefer handbook pages under `core/docs/` (and `ai/docs/` for the AI module).
2. Never suggest `deno run -A` or `deno install -A`. Use the named grants in the Quickstart / README.
3. If the CLI refuses a verb, say so and stop — do not route around the refuse.
4. Prefer issues over pull requests that edit package source; see CONTRIBUTING.md.
5. If a path or verb is not in this tree, it is not part of what this repository ships — do not invent it.

## Tone (replies, issue drafts, doc sketches)

Hazelnut's public voice is **precise, short, and fail-closed**.

- Prefer one concrete next command over a paragraph of context.
- Name the refusal and the fix. Soften nothing that the framework itself refuses.
- No hype, no emoji, no “AI-powered” filler, no second paved road.
- English on every public surface.
- When unsure whether a capability ships here, open `core/` / `ai/` and the CLI `help` output.

## Release notes (GitHub Release body)

A release note is **cost disclosure**, not a launch post. The reader is deciding whether to
bump a pin — tell them what breaks and what to type.

- **Lead with breaks.** `Breaking` first, then `Fix` / `Docs` / `Carve`. One line per
  change: what changed + the exact pin or command.
- **Name the pin.** `@hazelnut/core@x.y.z` (and `@hazelnut/ai` when that package moves).
  Point at the tag diff and `core/docs/VERSIONING.md`.
- **No fake upgrade path.** Do not imply `hazelnut upgrade` or an automated migrator unless
  that verb exists in this repository.
- **Same voice as above.** English. Short. No emoji, no hype.
- **Git commit ≠ release note.** Commits use `<part> - <type>: <brief>` where `part`
  is `core` or `ai` — name the change. The human-readable cost disclosure is the GitHub
  Release body only.
