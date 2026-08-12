# Agent notes — public Hazelnut repository

You are reading the **published artifact**, not the workshop.

## Positioning

- **This repo** (`Hazelnut-17/hazelnut`): assembled export. Workspace members: `core/`, `ai/`.
- **Private tree**: where the framework is written. You do not have it here. Do not invent paths into
  `docs/spec/`, `verify/`, `upgrade/`, or `principles/` — if a verb or file is absent, this build
  does not serve it.

## How to help a consumer

1. Prefer handbook pages under `core/docs/` (and `ai/docs/` for the AI module).
2. Never suggest `deno run -A` or `deno install -A`. Use the named grants in the Quickstart / README.
3. If the CLI refuses a verb, say so and stop — do not route around the refuse.
4. Fixes land via issues; source edits in a PR against this repo will be overwritten on the next release.

## Tone (replies, issue drafts, doc sketches)

Hazelnut's public voice is **precise, short, and fail-closed**.

- Prefer one concrete next command over a paragraph of context.
- Name the refusal and the fix. Soften nothing that the framework itself refuses.
- No hype, no emoji, no “AI-powered” filler, no second paved road.
- English on every public surface.
- When unsure whether a capability ships in *this* checkout, open `core/` / `ai/` and the CLI
  `help` output — never assume a private module is sitting beside the artifact.

## Release notes (GitHub Release body)

A release note is **cost disclosure**, not a launch post. The reader is deciding whether to
bump a pin — tell them what breaks and what to type.

- **Lead with breaks.** `Breaking` first, then `Fix` / `Docs` / `Carve`. One line per
  change: what changed + the exact pin or command.
- **Name the pin.** `@hazelnut/core@x.y.z` (and `@hazelnut/ai` when that package moves).
  Point at the tag diff and `core/docs/VERSIONING.md`.
- **No fake upgrade path.** Do not imply `hazelnut upgrade` or an automated migrator unless
  that verb exists in the published tree.
- **Same voice as above.** English. Short. No emoji, no hype, no private-repo paths
  (`docs/spec/`, `notes/`, internal filenames).
- **Assemble commit ≠ release note.** `hazelnut - chore: sync <version> from private` stays
  on the commit; the human-readable note is the GitHub Release body only.

Edits to this file in a fork are discarded on release; change the private assembler if the voice must move.
