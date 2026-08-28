# `hazelnut new`

> **Reference** — for scaffolding a fresh app. Every flag, what lands on disk,
> and how the framework gets pinned.

`hazelnut new <name>` writes a complete, runnable project. It is
non-interactive, so an agent can run it in one line; it never touches a
database; and it needs no network except to warm the dependency cache.

## Interface {#--steer}

```
hazelnut new <name> [--example] [--rules=<profile>] [--steer=full|index] [--core]
                    [--no-git] [--local <repo> | --vendor <repo> | --pin <spec>]
```

| Flag              | Meaning                                                                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `<name>`          | Required. Becomes the directory name and the package name.                                                                                     |
| `--example`       | Scaffold one example resource. Default is an empty app.                                                                                        |
| `--rules`         | Principle profile (default `recommended`). See the verify-module note below.                                                                   |
| `--steer`         | How the agent steer file renders (default `full`). See the verify-module note below.                                                           |
| `--core`          | Emit a **core-module** app: the core barrel, the core CLI, and none of the verification envelope. See _Which capability module you get_ below. |
| `--no-git`        | Skip `git init`.                                                                                                                               |
| `--local <repo>`  | Pin the framework at an explicit checkout — the repository root holding `src/`. See _How the framework gets pinned_ below.                     |
| `--vendor <repo>` | Copy the framework source **into** the app and pin it relatively, so the app is self-contained and portable.                                   |
| `--pin <spec>`    | Pin `imports.hazelnut` at a published specifier — the ordinary registry shape, and the default when you ran the CLI from the registry.         |

`--local`, `--vendor` and `--pin` are mutually exclusive: they are three answers
to the same question.

## Which capability module you get {#module}

The scaffolder emits an app for exactly one capability module — `core` or the
full build — and which one is a property of the CLI you ran:

- **You ran the core CLI** — `src/cli/hazelnut-core.ts` in a checkout, or the
  `@hazelnut/core` package's `cli` export — and you get a core app. Every form
  of the command does, including `--local` and `--vendor` pointed at a full
  checkout: the CLI emits what it can serve, not what the path on disk happens
  to contain.
- **You ran a full build's CLI** — the entry beside the core one — and you get a
  full app, unless you pass `--core`.

A core app pins the core barrel and the core CLI, and drops everything it could
not honour: the `verify` task and its `ci` step, the projected `AGENTS.md`, and
(under `--example`) the row-policy specification sibling. It still gets a lint
plugin — the 9-rule safety floor shipped in the public artifact, narrower than
the full build's plugin (the floor plus the verify module's discipline rules).
The result references none of the verification envelope, so onboarding is
self-consistent: nothing in the app points at a command your CLI refuses.

## How the framework gets pinned {#acquisition}

Every scaffolded app names the framework as exactly one pin value, and
`deno.json` is where it lives: the `hazelnut` entry, the concern subpaths beside
it, every CLI task line and (on a verify build) the lint-plugin path all carry
that same value. There are three shapes, and which one is available to you
follows from how you acquired the framework.

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
the app at `.hazelnut/modules/` and pinned relatively. The app is then
self-contained and runs from any unpack location — the shape to use for a
hand-over that must survive without the original checkout. A compiled binary has
no source tree on disk to copy, so it refuses `--vendor` rather than emitting a
broken pin.

`.hazelnut/` is git-ignored, so the copied tree travels with the **directory**,
not with the repository. Hand the app over as an archive or a container image
and it runs as-is. A git clone does not carry it — run
`hazelnut install --from <framework-checkout>` in the clone to put it back. That
copies from a directory already on the machine; it fetches nothing.

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
├─ .gitattributes       # merge driver for the surface locks — not in a core app
├─ hazelnut.config.ts   # defineConfig — the keystone `add` registers into
├─ Dockerfile           # host-agnostic production container
├─ .dockerignore        # keeps .env / .git / .hazelnut out of the image
├─ ARCHITECTURE.md      # projected module/resource/surface map — verify module only, never hand-edit
├─ AGENTS.md            # projected agent steer — verify module only, never hand-edit
├─ .gitignore
├─ .env.example         # copy to .env (gitignored) and fill DATABASE_URL
├─ README.md
├─ app.ts               # createApp(config) — the PURE model the CLI verbs read (no db)
├─ app.test.ts          # a boot smoke test, so a fresh scaffold's `deno task test` is green
├─ main.ts              # the SERVED boot: db seam → createApp(config, { db, relay, scheduler }) → Deno.serve
├─ widget.resource.ts   # --example only — the seed declaration
├─ widget.rowpolicy.spec.ts  # --example, verify module only — the row policy's independent spec
├─ src/modules/         # grown by `hazelnut add module <name>`, not pre-created
├─ drizzle/             # migration DDL and snapshots, written on first `migrate generate`
├─ migrations/          # data-transform files, created on first transform
└─ .hazelnut/           # generated, gitignored
```

## What the run does {#run-steps}

```
1. Parse `hazelnut new <name> [flags]`.
2. Validate the name, and refuse if the directory already exists.
3. Create the directory and write the templates.
4. Warm the cache (`deno cache`) so `deno.lock` exists, then `git init` and commit,
   so the lock is IN the initial commit. `--no-git` skips the git half only —
   the cache still runs, so the app always has a lock.
5. Print the next step: `cd <name> && hazelnut add module <name>`.
```

Step 4 is the only one that reaches the network, and it is best-effort. If it
fails — no network, a registry hiccup — the run prints the exact make-up command
(`deno cache main.ts && git add deno.lock && git commit`) and still initialises
git. You are never left with a half-scaffolded directory.

## Decisions worth knowing

- **Non-interactive.** There are no prompts, ever, so the verb is scriptable and
  agent-runnable.
- **Empty by default.** `--example` is opt-in, because an example you did not
  ask for is code you have to delete.
- **No multi-tenancy flag.** Multi-tenancy is a configuration recipe over the
  generic `scope` primitive, not a scaffold-time fork.
- **`deno.lock` is committed; `.hazelnut/` is not.** The lock pins your supply
  chain and belongs in review; the working directory does not.
- **The projected files are never hand-edited.** `ARCHITECTURE.md` and
  `AGENTS.md` are derived from the same model the app boots from. Edit the
  declarations, not the projection. Both are verify-module projections: a core
  app has neither, and every file it does get is yours to edit.

### The Dockerfile and the deployment stance

The framework **containerizes** — that is the paved road — but stays
**host-agnostic**: the container is a generic deployable bound to no platform.
The `Dockerfile` is generate-once-then-yours.

Migration runs as a gated release step, never on application boot. `createApp`
does not migrate, by construction. That is a correctness property rather than a
preference: the migration tool holds no advisory lock, so several replicas
running a boot-time migration would corrupt the schema. Multi-replica boot is
otherwise safe — the relay claims work without double-delivery, and cron is
leaderless.

## Template contents {#templates}

The exact bytes are **emitted by the scaffolder**, which is the single source of
truth. This page keeps no verbatim second copy, because a hand-maintained
duplicate drifts on exactly the keys that matter. Run
`hazelnut new <name> [--example]` to see the current output; for the
illustrative `deno.json` shape read [Rundown §1](../rundown.md).

Two substitutions happen: the app name, and the principle profile.

| File                                                                                         | What it is                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deno.json`                                                                                  | tasks, imports, `nodeModulesDir: "auto"` — and, on a checkout or registry pin, a lint plugin (9-rule floor on core; floor plus verify-module discipline on the full build). A bare PATH-binary pin (`--pin hazelnut`) leaves `lint.plugins` off: there is no resolvable `./lint` URL. |
| `hazelnut.config.ts`                                                                         | the keystone `defineConfig` that `hazelnut add` registers into                                                                                                                                                                                                                        |
| `app.ts`                                                                                     | `createApp(config)` — the pure model the CLI verbs read: no database, no `fetch`                                                                                                                                                                                                      |
| `main.ts`                                                                                    | the served boot: the database seam, then `createApp(config, { db, relay, scheduler })`, then `Deno.serve` with a graceful drain                                                                                                                                                       |
| `ARCHITECTURE.md`                                                                            | the committed module/resource/surface projection, born at scaffold from the seed model — verify module only                                                                                                                                                                           |
| `AGENTS.md`                                                                                  | the projected agent steer — verify module only                                                                                                                                                                                                                                        |
| `.env.example` · `.gitignore` · `.dockerignore` · `Dockerfile` · `README.md` · `app.test.ts` | generate-once-then-yours. The `app.test.ts` boot smoke keeps a fresh `deno task test` green by construction.                                                                                                                                                                          |
| `.gitattributes`                                                                             | generate-once-then-yours, and only in an app whose build can write a surface lock — a core app receives none.                                                                                                                                                                         |
| `widget.resource.ts` · `widget.rowpolicy.spec.ts`                                            | `--example` only — the seed declaration, and (verify module) its independent visibility specification                                                                                                                                                                                 |
