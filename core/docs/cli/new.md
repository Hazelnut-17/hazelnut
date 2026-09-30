# `hazelnut new`

> **Reference** — for scaffolding a fresh app. Every flag, what lands on disk,
> and how the framework gets pinned.

`hazelnut new <name>` writes a complete, runnable project. It is
non-interactive, so an agent can run it in one line; it never touches a
database; and it needs no network except to warm the dependency cache.

## Interface {#--steer}

```
hazelnut new <name> [--example] [--core]
                    [--no-git] [--local <repo> | --vendor <repo> | --pin <spec>]
```

| Flag              | Meaning                                                                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<name>`          | Required. Becomes the directory name. The scaffold does not write a package `name`.                                                                  |
| `--example`       | Scaffold one example resource. Default is an empty app.                                                                                              |
| `--core`          | Emit a **core-module** app: the core barrel and the core CLI. The structural `verify` task still ships; see _Which capability module you get_ below. |
| `--no-git`        | Skip `git init`.                                                                                                                                     |
| `--local <repo>`  | Pin the framework at an explicit checkout — the repository root holding `src/`. See _How the framework gets pinned_ below.                           |
| `--vendor <repo>` | Copy the framework source **into** the app (omitting `tests/`) and pin it relatively, so the app is self-contained and portable.                     |
| `--pin <spec>`    | Pin `imports.hazelnut` at a published specifier — the ordinary registry shape, and the default when you ran the CLI from the registry.               |

`--local`, `--vendor` and `--pin` are mutually exclusive: they are three answers
to the same question.

The expanded full-build CLI is not currently distributed as a package. The
published `@hazelnut/core` command is the core CLI above and refuses these
flags; a consumer cannot obtain the expanded synopsis from the published
packages today.

## Which capability module you get {#module}

The published `@hazelnut/core` CLI emits a core app. The command you run
determines what it emits, not the framework path you point it at:

- **You ran the core CLI** — `src/cli/hazelnut-core.ts` in a checkout, or the
  `@hazelnut/core` package's `cli` export — and you get a core app. This remains
  true when `--local` or `--vendor` points at a fuller source checkout: the CLI
  emits what it can serve, not what the path on disk happens to contain.

A core app pins the core barrel and the core CLI. It still ships the `verify`
task and chains it in `ci` — that verb is the structural fold every build
serves. The published core CLI writes a hand-written `AGENTS.md` with the app's
shape and agent-door posture. It does not write `ARCHITECTURE.md`,
`.gitattributes`, or a row-policy specification sibling for `--example`. Its
lint plugin checks the published safety floor. Onboarding stays self-consistent:
nothing in the app points at a command your CLI refuses.

## How the framework gets pinned {#acquisition}

Every scaffolded app names the framework as exactly one pin value, and
`deno.json` is where it lives: the `hazelnut` entry, the concern subpaths beside
it, every CLI task line, and — on a checkout or a registry pin — the lint-plugin
path all carry that same value. A bare PATH-binary pin has no resolvable plugin
URL and omits that path. There are three shapes, and which one is available to
you follows from how you acquired the framework.

**A published specifier (`--pin <spec>`).** This is the ordinary path. Run the
CLI from the registry and the app is pinned to the same published version you
just ran; `--pin` sets that specifier explicitly, which is also what you want
when you host a published tree of your own. The exact version is written into
the app, so the app is bound to a release you can name. Name no version in the
specifier and Deno resolves the newest release older than 24 hours — its install
policy refuses anything fresher, so an exact pin to a just-published version
fails until that window clears. To take a fresher one anyway, put
`{ "minimumDependencyAge": 0 }` in a `deno.json` and pass `-c deno.json` on the
command: the setting must reach Deno before it resolves the specifier, which is
earlier than any config the new app will have. The value is the number `0`;
`"0s"` is refused.

Pass the package root (for example, `jsr:@hazelnut/core`), not an export subpath
such as `/cli`; the scaffold derives its app imports from the root and adds the
`./cli` export to task commands. JSR and NPM package subpaths are refused before
any scaffold files are written.

```sh
deno run --allow-read --allow-write=. --allow-env --allow-run=deno,deno.exe,git --allow-net jsr:@hazelnut/core/cli new my-app
```

On Windows — including git-bash — a named `--allow-run=deno` often cannot
resolve. Use a bare `--allow-run`:

```sh
deno run --allow-read --allow-write=. --allow-env --allow-run --allow-net jsr:@hazelnut/core/cli new my-app
```

**A checkout.** When you hold the framework as a tree on disk, run its CLI from
there:

```sh
deno run --allow-read --allow-write=. --allow-env --allow-run=deno,deno.exe,git --allow-net src/cli/hazelnut-core.ts new my-app
```

```sh
deno run --allow-read --allow-write=. --allow-env --allow-run --allow-net src/cli/hazelnut-core.ts new my-app
```

No flag is needed: a CLI running from a checkout derives that checkout and pins
the app's imports, CLI tasks and lint plugin at `file://…/src/…`.
`--local <repo>` is the same pin stated explicitly, for when you run the CLI
from somewhere else and want to name a different tree. The path is validated: it
must actually be a framework checkout, and it must be able to serve the
capability module you asked for. This pin is machine-absolute, so the app is
**not portable** — moving either tree breaks it. For a portable hand-over use
`--vendor` below.

**A vendored copy (`--vendor <repo>`).** The framework's `src/` is copied into
the app at `.hazelnut/modules/` (any `tests/` directory is omitted) and pinned
relatively. The app is then self-contained and runs from any unpack location —
the shape to use for a hand-over that must survive without the original
checkout. An unflagged `hazelnut new` from a compiled binary does not copy a
source tree; pass `--local <repo>`, `--vendor <repo>`, or `--pin <spec>`.

`.hazelnut/` is git-ignored, so the copied tree travels with the **directory**,
not with the repository. Hand the app over as an archive or a container image
and it runs as-is. A git clone does not carry it — run
`hazelnut install --from <framework-checkout>` in the clone to put it back. That
copies from a directory already on the machine; it fetches nothing.

Each `install --from` or `--vendor` replaces `.hazelnut/modules/` with that
checkout's `src/` (omitting `tests/` directories) — the tree the pin names, not
a union with files an older checkout left behind. If the copy fails before the
swap, the tree that was already there stays. If the swap itself fails, the
previous tree is put back in the same run.

### Running a verb by hand {#by-hand}

Inside a scaffolded app, use its own tasks — `deno task add`, `doctor`,
`migrate`, `start`. They already carry everything below.

Invoking the CLI directly needs one flag:

```sh
deno run --allow-read --allow-write=. --allow-env --allow-run=deno,deno.exe --allow-net -c deno.json <framework-checkout>/src/cli/hazelnut-core.ts migrate ./app.ts
```

`-c deno.json` names **the app's** config. Without it, Deno resolves the config
from the CLI entry's own location rather than your app's, so the `hazelnut`
specifier your modules import is not in scope and the load fails with
`Import "hazelnut" not a dependency`. The CLI detects that exact case and prints
the fix, so a first run costs you one message rather than an investigation.
`new` itself needs no flag, because it imports no app.

## What lands on disk

```
{{name}}/
├─ deno.json            # tasks + imports (+ lint plugin on checkout/registry pins; bare PATH-binary pins omit it — no resolvable ./lint URL)
├─ deno.lock            # supply-chain lock — committed
├─ .gitattributes       # not written by the published core CLI
├─ hazelnut.config.ts   # defineConfig — the keystone `add` registers into
├─ Dockerfile           # host-agnostic production container
├─ .dockerignore        # keeps .env / .git / .hazelnut (except modules/) / node_modules out of the image
├─ ARCHITECTURE.md      # not written by the published core CLI
├─ AGENTS.md            # hand-written agent steer — yours to edit
├─ .gitignore
├─ .env.example         # copy to .env (gitignored) and fill DATABASE_URL
├─ README.md
├─ app.ts               # createApp(config) — the PURE model the CLI verbs read (no db)
├─ app.test.ts          # a boot smoke test, so a fresh scaffold's `deno task test` is green
├─ main.ts              # the SERVED boot: db seam → createApp(config, { db, relay, scheduler }) → Deno.serve
├─ widget.resource.ts   # --example only — the seed declaration
├─ widget.rowpolicy.spec.ts  # not written by the published core CLI
├─ src/modules/         # grown by `hazelnut add module <name>`, not pre-created
├─ drizzle/             # first migration — this run authors it (`migrate generate`)
└─ .hazelnut/           # `--vendor` / `install --from` only — gitignored
```

## What the run does {#run-steps}

```
1. Parse `hazelnut new <name> [flags]`.
2. Validate the name, and require the target path not to exist. Even an empty
   directory is refused so the complete scaffold can be staged before it lands.
3. Create the directory and write the templates.
4. Format the tree (`deno fmt`). Best-effort.
5. Warm the cache (`deno cache`) so `deno.lock` exists. Best-effort; a miss is
   born-red. The temporary `minimumDependencyAge: 0` bootstrap override is
   atomically removed after a successful warm, before the consumer receives
   the app.
6. Author the first migration (`deno task migrate generate`) into `drizzle/`.
   Best-effort; a miss is born-red — `deno task ci` runs `migrate drift` and
   refuses an app that declares resources with nothing committed.
7. `git init` and commit, so the lock and the first migration are IN the initial
   commit. `--no-git` skips the git half only — format, cache, and generate still
   run.
8. Print the next step: `cd <name> && cp .env.example .env`, then
   `deno task add module <name>` and `deno task add resource <module>/<name>`.
```

Step 5 is the only one that reaches the network, and it is best-effort. If the
cache or the first migration fails, the run prints that step's make-up command
and still initialises git when it can. If cache warming failed, the zero-age
override remains for that retry; remove it after the lock is successfully
warmed. You are never left with a half-scaffolded directory.

## Decisions worth knowing {#design-decisions}

- **Non-interactive.** There are no prompts, ever, so the verb is scriptable and
  agent-runnable.
- **Empty by default.** `--example` is opt-in, because an example you did not
  ask for is code you have to delete.
- **No multi-tenancy flag.** Multi-tenancy is a configuration recipe over the
  generic `scope` primitive, not a scaffold-time fork.
- **`deno.lock` is committed; `.hazelnut/` is not.** The lock pins your supply
  chain and belongs in review; the working directory does not.
- **The published core CLI writes a hand-written `AGENTS.md`.** It does not
  write `ARCHITECTURE.md` or regenerate the agent steer; the `AGENTS.md` it
  emits is yours to edit.

### The Dockerfile and the deployment stance

The framework **containerizes** — that is the paved road — but stays
**host-agnostic**: the container is a generic deployable bound to no platform.
The `Dockerfile` is generate-once-then-yours.

Migration runs as a gated release step, never on application boot. `createApp`
does not migrate, by construction. That is a correctness property rather than a
preference: N replicas applying DDL from `CMD` would race. `hazelnut migrate`
takes an advisory lock for the gated step; that lock is not a reason to run
migrate on boot. Multi-replica boot is otherwise safe — the relay fences each
consumer so two replicas do not run the same delivery concurrently; external
effects stay at-least-once, and cron is leaderless.

## Template contents {#templates}

The exact bytes are **emitted by the published core CLI**, which is the single
source of truth. This page keeps no verbatim second copy, because a
hand-maintained duplicate drifts on exactly the keys that matter. Run
`hazelnut new <name> [--example]` to see the current output; for the
illustrative `deno.json` shape read [Rundown §1](../rundown.md).

The app name is the only substitution in the core output.

| File                                                                                         | What it is                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deno.json`                                                                                  | core tasks, imports, `nodeModulesDir: "auto"`, and — on a checkout or registry pin — the core safety-floor lint plugin. A bare PATH-binary pin (`--pin hazelnut`) leaves `lint.plugins` off: there is no resolvable `./lint` URL. |
| `hazelnut.config.ts`                                                                         | the keystone `defineConfig` that `hazelnut add` registers into                                                                                                                                                                    |
| `app.ts`                                                                                     | `createApp(config)` — the pure model the CLI verbs read: no database, no `fetch`                                                                                                                                                  |
| `main.ts`                                                                                    | the served boot: the database seam, then `createApp(config, { db, relay, scheduler })`, then `Deno.serve` with a graceful drain                                                                                                   |
| `ARCHITECTURE.md`                                                                            | not written by the published core CLI                                                                                                                                                                                             |
| `AGENTS.md`                                                                                  | a hand-written agent steer; edit it freely                                                                                                                                                                                        |
| `.env.example` · `.gitignore` · `.dockerignore` · `Dockerfile` · `README.md` · `app.test.ts` | generate-once-then-yours. The `app.test.ts` boot smoke keeps a fresh `deno task test` green by construction.                                                                                                                      |
| `.gitattributes`                                                                             | not written by the published core CLI                                                                                                                                                                                             |
| `widget.resource.ts`                                                                         | `--example` only — the seed declaration                                                                                                                                                                                           |
| `widget.rowpolicy.spec.ts`                                                                   | not written by the published core CLI                                                                                                                                                                                             |
