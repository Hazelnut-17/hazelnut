# `hazelnut verify`

> **Reference** — for anyone gating a build. What the verb checks, what it does
> not, and how to read one finding.

Run it as `deno task verify` inside a scaffolded app, or
`hazelnut verify ./app.ts` from an app root. It is already the third step of the
scaffolded `ci` task, after `deno lint` and `deno check`.

It checks **discipline** — how your declarations are written — against a fixed
invariant roster. It is not a test run and it does not know whether your
business rules are right: _generate with principles, verify with rules._

```sh
deno task verify
hazelnut verify ./app.ts --json    # the same findings as a machine document
```

It reads `app.ts` — the pure model composition — not `main.ts`. Nothing connects
to a database, nothing is written to your schema, and the pass is offline. This
build writes no files at all.

## What it checks {#structural-rung}

The **structural rung**: every rule that can be decided from the model your
declarations compose to. That is the whole of what one `defineResource`,
`defineModule` and `defineView` set materialises — the derived columns, the
routes, the MCP tools, the reference graph, the module dependency graph, the
view projections.

A sample of the kinds of fault it catches:

| Kind                        | Example finding                                                                |
| --------------------------- | ------------------------------------------------------------------------------ |
| A declaration mints nothing | a feature is switched on but its column was never derived                      |
| Two declarations conflict   | a field is both `immutable` and on a write route                               |
| A boundary is crossed       | a module references a resource in a module it does not declare as a dependency |
| A surface is unguarded      | an exposed route or a view with no policy at all                               |
| Something is unreachable    | a declared transition state no edge ever enters, or an op with no handler      |
| A graph is malformed        | two modules that each declare the other as a dependency                        |

## What it does NOT check {#unchecked}

The report ends with this list every run, clean or not, because a checker that
reports clean without saying what it covered is worse than one that says
nothing:

- **The source of your handlers, queries and tests.** `deno check` and
  `deno lint` in `deno task ci` cover the compiler's half of it; the rest is
  yours.
- **Files sitting beside your declarations** that a richer build regenerates and
  compares — a discovered `*.prompt.ts`, a generated project brief.
- **Your HTTP / MCP / event surface against a committed baseline.** Whether this
  release broke a consumer is a question about two versions, not one.
- **Your rowPolicy implementations against a written specification.**
- **Your migration history against the schema your declarations now derive to.**
  `deno task migrate` is the verb that checks that.
- **Anything that needs a language model to judge.**

And the standing one, which no rung closes: **a green verify is not a tested
app.** It says your declarations are coherent. Whether they say the right thing
is what your own tests are for.

## Reading the report

The first two lines are the verdict:

```
verify (structural rung) — 98 checks over the model your declarations compose to
✓ 0 ship-blocking (0 warn · 3 advisory)
```

Findings are grouped by how hard they bite, hardest first. Each one carries its
id, the sentence that says what is wrong, a `fix:` line pointing at the
declaration that owns it, and an `at:` line naming the module and resource.

| Group           | Meaning                                                     |
| --------------- | ----------------------------------------------------------- |
| `SHIP-BLOCKING` | a guarantee the framework cannot make with this declaration |
| `WARN`          | a liability you may accept knowingly                        |
| `ADVISORY`      | a nudge; never gates                                        |

## Exit codes

| Result                    | Exit |
| ------------------------- | ---- |
| any ship-blocking finding | 1    |
| warnings / advisories     | 0    |
| nothing found             | 0    |

So `deno task ci` fails on a ship-blocking finding and on nothing else — a warn
you decided to live with does not stop a build. That lane is offline, so you can
run it as often as you like. The release lane is the one to run before you ship;
the rundown's own section on the lanes says which it is and why.

`deno task ci` sets `CI=1` on the verify steps. Under that posture,
`defineConfig({ mute })` is ignored: muted advisories still appear in the
report. Local `deno task verify` (no `CI`) still honours mute for iteration
noise. Ship-blocking findings were never mute-able.

## Fixing a finding

Every finding names a **declaration**, not a line of your logic. That is the
point of the rung: the fix is almost always one field in a
`defineResource`/`defineView` call, and the `fix:` line tells you which one. If
a finding seems to be about code you did not write, it is about code the
framework derived from a declaration you did write — follow the `at:` pointer to
that declaration.

