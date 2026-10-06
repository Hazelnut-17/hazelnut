# `hazelnut install`

> **Reference** — for anyone restoring the vendored framework tree into an app
> that was cloned without it.

A vendored app pins the framework at `./.hazelnut/modules/`, and that directory
is git-ignored, so a `git clone` arrives without it. `install` copies it back
from a framework checkout already on your machine — the same copy
`hazelnut new --vendor` performs. It fetches nothing: there is no default
source, registry lookup or network path.

## Usage

```sh
hazelnut install --from ../hazelnut
```

Run it from the app root, the directory holding the app's `deno.json` or
`deno.jsonc`. It copies the checkout's `src/` into `./.hazelnut/modules/` and
omits `tests/` directories.

## Pin repair and retries

A checkout pin is rewritten in the Deno config and Dockerfile; a registry pin
stays in place. If the config is already vendored but Dockerfile still names the
checkout, repeat the same command. It repairs complete absolute or `file://`
paths to both full and core framework CLIs in quoted or unquoted cache and
launch commands. Remote, relative and unrelated paths are not guessed or
rewritten by that recovery scan.

The output says `Dockerfile checkout pins repaired` when recovery changes that
file, or `no config or Dockerfile pin changes were needed` when the pins already
converged. The source tree is still copied on each run. Inspect both files
before building the image; this command does not run a Docker build.

## Flags

| Flag                          | Meaning                                                              |
| ----------------------------- | -------------------------------------------------------------------- |
| `--from <framework-checkout>` | the framework repository root to copy from, not its `src/`; required |

## Exit codes

| Result                                                                                             | Exit |
| -------------------------------------------------------------------------------------------------- | ---- |
| the tree was copied: `✓ install: copied … framework files into ./.hazelnut/modules/`               | 0    |
| a usage error, no `deno.json` here, `--from` not a directory, or `--from` not a framework checkout | 2    |
