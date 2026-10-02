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
to a database, nothing is written to your schema, and the pass is offline.

## What it checks {#structural-rung}

The **structural rung**: every rule that can be decided from the model your
declarations compose to. That is the whole of what one `defineResource`,
`defineModule` and `defineView` set materialises — the derived columns, the
routes, the MCP tools, the reference graph, the module dependency graph, the
view projections.

Both builds also independently run the safety floor over your app's source,
using the framework's plugin and config. Changing `tasks.ci`, lint selectors or
rule exclusions cannot silence that run. Editor lint remains in your app; it
does not decide what this floor checks. A temporary source mirror beneath your
app root preserves relative paths and is removed afterward. Every visited file
must equal the full source corpus; an empty corpus, incomplete run or failed
mirror cleanup is ship-blocking `lint/floor-unavailable`, not a clean verdict. A
cleanup failure names the leftover mirror so you can remove it after restoring
filesystem access. This adds a lint subprocess to each `verify` invocation and
needs the existing tooling read/write/run grants. It runs offline with the
pinned plugin cached. Tests reached by app source do not get a floor exemption
just because their filename ends in `.test.ts`.

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

The **structural** report ends with this list every core run, clean or not,
because a checker that reports clean without saying what it covered is worse
than one that says nothing:

- **Source checks beyond the safety floor.** Types (`deno check`), other lint
  rules and business behavior remain separate checks. The report does not claim
  those ran merely because a CI task names them.
- **Files sitting beside your declarations** that a richer build regenerates and
  compares — a discovered `*.prompt.ts`, a generated project brief.
- **Your HTTP / MCP / event surface against a committed baseline.** Whether this
  release broke a consumer is a question about two versions, not one.
- **Your rowPolicy implementations against a written specification.**
- **Your migration history against the schema your declarations now derive to.**
  `deno task migrate drift` is the verb that checks that. Bare
  `deno task migrate` applies pending SQL and needs `DATABASE_URL`.
- **Anything that needs a language model to judge.**

And the standing one, which no rung closes: **a green verify is not a tested
app.** It says your declarations are coherent. Whether they say the right thing
is what your own tests are for.

## Which silencings are yours

The safety floor is not an app-owned switch: both builds execute it
independently. Its source corpus does not shrink with your CI task, lint
selectors or rule exclusions. The editor-wiring shield still refuses a missing
floor plugin, a floor exclusion or a narrowed file set; fixing that wiring does
not replace the independent run.

A named floor-rule waiver remains valid only in an unreachable test fixture.
Quoted basename references from non-test source, including chains through test
files, withhold that exemption. A blanket directive refuses everywhere. This
conservative reach check is not a full TypeScript module resolver; ambiguous
references withhold the exemption too.

## Reading the report

The first two lines are the verdict:

```
verify (structural rung) — 101 checks over the model your declarations compose to
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

| Result                            | Exit |
| --------------------------------- | ---- |
| any ship-blocking finding         | 1    |
| warnings / advisories             | 0    |
| nothing found                     | 0    |
| a flag it cannot read (see below) | 2    |

Exit 2 is a REFUSAL, not a verdict: the command never ran, so nothing was
checked. Every verb answers this way for a misspelled flag, an unknown flag, or
a value flag given no value — `--json=true` is exit 2 here, because `--json`
takes no value. Read it as "fix the command line", never as "the app is clean".

So `deno task ci` fails on a ship-blocking finding and on nothing else — a warn
you decided to live with does not stop a build. That lane is offline, so you can
run it as often as you like. The release lane is the one to run before you ship;
the rundown's own section on the lanes says which it is and why.

## Fixing a finding

Every finding names a **declaration**, not a line of your logic. That is the
point of the rung: the fix is almost always one field in a
`defineResource`/`defineView` call, and the `fix:` line tells you which one. If
a finding seems to be about code you did not write, it is about code the
framework derived from a declaration you did write — follow the `at:` pointer to
that declaration.
