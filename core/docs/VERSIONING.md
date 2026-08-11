# Versioning and support

> **Reference** — for anyone pinning Hazelnut in a project. What a version
> number promises, how long a line is supported, and what an upgrade costs.

Maintained by one person. No support contract, no maintenance branches.

## Version numbers

|       |                                      |
| ----- | ------------------------------------ |
| MAJOR | your app must change                 |
| MINOR | additive, in the precise sense below |
| PATCH | fixes only                           |

A Breaking change — including a removed call shape, a renamed declaration key,
or a boot refusal that used to accept — is a MAJOR (or, while the line is still
`0.x`, a MINOR). A PATCH does not ask you to edit your app.

**No deprecation dual-path.** Removals take effect in the version that ships
them; the old form is a hard error that names its replacement, never a second
working path kept alongside.

**Your protection.** Pin exactly and commit `deno.lock`. The scaffold does both,
so an upgrade happens on a day you chose. Read the release's Breaking section
and its own diff before you take a bump.

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
