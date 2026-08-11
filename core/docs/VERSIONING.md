# Versioning and support

> **Reference** — for anyone pinning Hazelnut in a project. What a version
> number promises, how long a line is supported, and what an upgrade costs.

Maintained by one person. No support contract, no maintenance branches.

## Pre-1.0 (now)

|                        |                                                                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Backward compatibility | **None guaranteed.** A minor bump may require edits, and nothing announces them for you — read the release's own diff before you take it. |
| Deprecation period     | **None.** Removals take effect immediately — no second path is kept alive alongside a replacement.                                        |
| Your protection        | Pin exactly, commit `deno.lock`. The scaffold does both, so an upgrade happens on a day you chose.                                        |

## From 1.0

|       |                                      |
| ----- | ------------------------------------ |
| MAJOR | your app must change                 |
| MINOR | additive, in the precise sense below |
| PATCH | fixes only                           |

**Upgrade one step at a time.** Multi-version jumps are out of scope — there is
no test behind a cumulative path.

**Support covers the latest major line.** A security fix gets a tagged release
promptly. Whether your app must change is a question you answer against the
release itself, not against a summary written about it.

## What "additive" means {#lane-contract}

Not a judgement call. Three public surfaces each carry a committed lock, and a
change is checked against it:

| Surface   | MINOR may                                                          | MAJOR is required for                                                                                                    |
| --------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| **HTTP**  | add a route; add an optional query parameter or field              | remove or rename a route; change a status code; change the response envelope; switch pagination style                    |
| **MCP**   | add a tool or prompt; add an optional argument; widen a read shape | remove one; retype an argument; add a required argument; narrow a shape; reword a description; change an annotation hint |
| **Event** | add a topic; add an optional payload field                         | remove a topic; retype a payload field; make one required                                                                |

Two rows surprise people:

- **A reworded MCP description is breaking.** To an agent a description is
  executable instruction — changing it changes behaviour, whatever the diff
  looks like.
- **The lock is the unit, not the source.** A refactor that leaves every
  projected shape identical is not a version event, however much code moved.

## Releases

- **A release is a tag**, published by a workflow rather than from a
  maintainer's machine, so what is published traces to a commit.
- **A published version is never replaced.** If a release is wrong, the answer
  is a new version; a withdrawn one stays downloadable for whatever already
  depends on it. Treat every version number as permanent.
- **Dependencies are pinned exactly**, never to a range, with the hashes in
  `deno.lock`.

## Reporting a security issue

Do not open a public issue. Use GitHub's private vulnerability reporting on the
[repository](https://github.com/Hazelnut-17/hazelnut) (Security → Report a
vulnerability).

A security fix ships as its own tagged release, named as such — never folded
quietly into an unrelated bump.
