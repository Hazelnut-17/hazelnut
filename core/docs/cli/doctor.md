# `hazelnut doctor`

> **Reference** — for anyone whose app will not start, migrate, or serve. Checks
> the machine and the project's plumbing, and tells you the fix.

Run it as `deno task doctor` inside a scaffolded app, or `hazelnut doctor` from
an app root. It checks the **environment**: the Deno line, the lock file, the
project config, the framework pin, and the database. Whether your app's own code
is correct is a different question and not this verb's job.

## Checks

| Check                   | ok                                                           | warn                                                                                       | fail                                                           |
| ----------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `deno/version`          | the tested Deno line                                         | another 2.x line — runs, but unverified                                                    | 1.x, below the boot floor                                      |
| `env/path-shape`        | the running deno's directory is on PATH                      | it is not (an MSYS shell's converted PATH drops it) — `launch` refuses its own child spawn | —                                                              |
| `supply-chain/lock`     | `deno.lock` present, committed, and unchanged since          | missing; untracked; gitignored; or changed since the commit                                | —                                                              |
| `config/deno-json`      | —                                                            | —                                                                                          | absent (wrong directory), or not valid JSONC                   |
| `tasks/least-privilege` | no task that runs your code carries a blanket grant          | `start`, or any `deno run`/`deno test` task, grants `-A`                                   | —                                                              |
| `tasks/unstable-cron`   | the serve tasks carry the flag                               | a serve task lacks it — TTL sweeps and cron jobs no-op                                     | —                                                              |
| `config/node-modules`   | `nodeModulesDir` is `"auto"`                                 | anything else — drizzle-kit cannot resolve, migrate breaks                                 | —                                                              |
| `pin/resolves`          | every framework pin that names a path is on disk             | —                                                                                          | a pin naming a path points at nothing                          |
| `pin/portable`          | the pin travels with the app, or names a published module    | the pin is a host-absolute path — this machine only                                        | —                                                              |
| `pin/certified`         | every published module pin is certified against the core pin | —                                                                                          | a module pin is unknown, or certified against a different core |
| `pin/dependencies`      | shared dependency pins match the ones this build resolves    | one differs — the package would load twice, at two versions                                | —                                                              |
| `db/postgres`           | no `DATABASE_URL` (the PGlite dev shape), or PostgreSQL 16+  | —                                                                                          | the URL is unreachable, or the server is older than 16         |
| `db/pgvector`           | the extension is available                                   | unavailable — `vector()` fields would fail at runtime                                      | —                                                              |

An app with no `start` task passes `tasks/least-privilege`: nothing is claiming
to be the production serve command. Every OTHER task that runs your own code —
`dev`, `test`, anything spelled `deno run` or `deno test` — is checked the same
way, because the inner loop runs the code you just wrote and a blanket grant
there hands it your whole machine. A scaffolded app is born with those tasks
named (`--allow-net --allow-env --allow-read --allow-write=. --unstable-cron`);
widen one only when you know which capability you are adding and why. The tasks
that run the kit's own tooling rather than your code are build tools and are not
checked. Routing `start` through [`hazelnut launch`](./launch.md) is the fix
there, because the grant set is then derived on every start rather than written
once and left to rot.

## The static-rung check

`lint/static-rung` is reported only when your tasks run the framework CLI from a
pinned source checkout — the one setup where `doctor` can probe the plugin file
on disk. A published-module pin still wires the package's `./lint` export in
`deno.json` (so `deno lint` and `verify` see the floor); `doctor` stays silent
on that check rather than asking you to confirm a path it cannot resolve.

| Check              | ok                                                                | warn                                                                              | fail |
| ------------------ | ----------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---- |
| `lint/static-rung` | `lint.plugins` names the plugin, and nothing narrows what it sees | it is not named, or `lint.exclude` / `lint.rules.exclude` switches part of it off | —    |

The plugin's rules run only inside `deno lint`. No verb spawns it for you, so an
app whose `lint.plugins` omits the plugin runs none of them: `deno lint` stays
green on the builtin rules alone and reports nothing missing. Add the plugin to
`lint.plugins` in `deno.json`, or accept the gap knowingly.

Naming the plugin is not the whole answer, because two other keys narrow it
after the fact:

- `lint.exclude` drops whole paths from the scan. Your tests are usually where a
  fabricated actor or a raw SQL string hides most quietly, so excluding them
  hides exactly the code worth checking.
- `lint.rules.exclude` switches a **named rule off across the entire app**.

Both are yours to set. `doctor` names what each one takes away so the choice
stays visible in the report rather than only in the file. If you see this
warning and did not mean to narrow anything, drop the key.

One thing `doctor` cannot see: a `// deno-lint-ignore-file` comment at the top
of a source file switches rules off for that file, and a bare one with no rule
named switches off **all** of them. `deno lint` cannot report a suppression —
the report is what it suppresses. Name the rules you are suppressing, one per
reason, so a reader can weigh each; a bare directive leaves nothing to weigh.

## Output and exit codes

Every non-`ok` line carries a `fix:` action. The last line summarises, and the
exit code follows the failures only:

| Result          | Exit |
| --------------- | ---- |
| any `✗` (fail)  | 1    |
| warnings only   | 0    |
| everything `ok` | 0    |

Warnings do not block. They name something that will bite later — a silently
no-op cron sweep, a `vector()` field that cannot work — and leave the decision
to you.
