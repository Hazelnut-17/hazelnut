# `hazelnut launch`

> **Reference** — for whoever owns the production serve command. What each
> permission grant is derived from, what the verb refuses, and why it refuses
> instead of widening.

`deno task start` (scaffolded) or `hazelnut launch ./app.ts` from an app root.
Starts the served app under the Deno permission set **derived from its own
declarations**, instead of the blanket `-A` a hand-maintained serve command
settles into.

The verb exists because a permission allowlist is the one piece of hardening
that reliably rots. An author writes the flags once, the app grows a webhook,
production breaks on a denied connect, and the fix under time pressure is always
to widen back to `-A`. Deriving the set at every launch removes the maintenance
step that fails.

## Derivation {#derivation}

Each grant traces to a declaration. Nothing is granted that no declaration asks
for.

| grant                        | derived from                                                                                                                                    | absent when                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `--allow-net=0.0.0.0:<port>` | `PORT` — the socket `Deno.serve` binds                                                                                                          | never — an unusable `PORT` refuses instead            |
| `--allow-net=<host:port>`    | `DATABASE_URL`                                                                                                                                  | unset — the embedded-PGlite dev shape opens no socket |
| `--allow-env=PG*`            | `DATABASE_URL` — the postgres.js driver reads its options (`PGMAX`, `PGSSL`, `PGCONNECT_TIMEOUT`, …) from that namespace at client construction | unset — the dev shape opens no client                 |
| `--allow-net=<host:port>`    | `OTEL_EXPORTER_OTLP_ENDPOINT` — so `installOtlp` works without widening ([Deploying](../DEPLOY.md))                                             | unset — telemetry is off                              |
| `--allow-net=<host:port>`    | `APP_URL` — the internal door an MCP gateway entry forwards to ([`hazelnut mcp`](./mcp.md))                                                     | the entry is not a gateway                            |
| `--allow-net=<host:port>`    | each `defineWebhook` url                                                                                                                        | no webhook declared                                   |
| `--allow-net=<host:port>`    | each `datasources` entry's `url`                                                                                                                | no datasource declared                                |
| `--allow-env=<keys>`         | every literal `Deno.env.get("KEY")` read in the served entry's **module graph** (§graph-scan below)                                             | nothing the entry reaches reads env                   |
| `--allow-read=.`             | the app tree — module graph, `node_modules`, `deno.json`/lock                                                                                   | never                                                 |
| `--allow-write=<dir>`        | `FILES_DIR`, when any resource declares a `file()` field                                                                                        | **no `file()` field — the common case**               |
| `--unstable-cron`            | the feature TTL sweeps + expiry purge ride `Deno.cron`                                                                                          | never                                                 |
| `--unstable-no-legacy-abort` | the per-request `ctx.signal` means the client disconnected, not that the response finished                                                      | never                                                 |

A scheme's default port fills in when the url omits one (`https`→443,
`postgres`→5432). An unrecognized scheme yields a host-only grant rather than a
guessed — and therefore wrong — port.

## The env scan walks the module graph {#graph-scan}

The scan starts at the served entry (`--entry`, default `main.ts`) and follows
every **relative** import it finds, transitively. That set — not a fixed list of
entry filenames — is what gets scanned, because a `Deno.env.get` in a
`*.module.ts` is as real to the running process as one in `main.ts`. Two
consequences worth knowing:

- **Dependencies are not walked.** A bare specifier (`hono`, `hazelnut`, an
  `npm:`/`jsr:` url) is a dependency, and its env needs are the framework's or
  the driver's business — granted explicitly where they are known (the `PG*`
  namespace is exactly that), never harvested by reading into `node_modules`.
- **The app root is the boundary.** A specifier resolving outside the tree is
  not walked, because `--allow-read=.` would not let the served process read it
  either. The scan's reach and the read grant's reach are the same boundary.

`--explain` prints the file set it walked. A grant list is only as trustworthy
as its coverage: an empty `--allow-env` means "this graph reads no env" only if
you can see which files were read.

## Refusals — never a fallback to `-A`

What cannot be derived is **refused**, and the launch stops. This is the design
decision the verb turns on: a launcher that quietly re-grants everything when
derivation falls short is worse than no launcher, because it reads as
least-privilege while being `-A`.

| refusal                                     | why it is not derivable                                                                    | fix                                                            |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| a `file()` field with no `FILES_DIR`        | the write root is a deploy fact, not a declaration                                         | set `FILES_DIR`, or use an off-box `StorageDriver`             |
| `Deno.env.get(<computed>)`                  | a static scan cannot resolve a non-literal key                                             | use a literal key, or pass `--allow-env` yourself              |
| `import(<computed>)` in an app file         | the walk cannot see past it, so the graph — and the env reads in it — stops being knowable | use a literal specifier, or pass `--allow-env` for that branch |
| a `datasources` entry with no `url`         | the decl's `url` is documentary; the live connection rides `boot`                          | add the documentary `url` to the decl                          |
| a `DATABASE_URL` naming no user             | the driver falls back to the OS account, costing `--allow-sys` plus three more env keys    | put the user in the url (`postgres://USER:PASS@host/db`)       |
| an unparseable `DATABASE_URL` / webhook url | there is no host to grant                                                                  | fix the url                                                    |
| a `PORT` that names no fixed port           | the served entry binds `Number(PORT)`, so an empty or `0` binds an OS-assigned socket      | unset it for the default, or name a port in 1-65535            |
| a gateway entry with no reachable `APP_URL` | no declaration names the address it forwards to                                            | set `APP_URL` to the app's internal base url                   |

Exit 2 on any refusal, with each one naming its fix.

## An ungated API document is refused {#openapi-gated}

One refusal is not about a grant. If your app declares
`openapi: { public: true }`, `launch` will not start it:

```
REFUSED — launch will not start this app (a grant is never widened to -A):
  ✗ GET /openapi.json is served to ANYONE (`openapi: { public: true }`) — the document names every route, field and filter
    fix: gate it — `openapi: { gate: <perm> }` — or delete the `openapi` line; `deno task dev` is unaffected either way
```

The document lists every route, every field, every filter and every validation
rule your app has. Nothing hands you the open form: `hazelnut new --example`
writes `openapi: { gate: "widget:list" }`, and a plain `hazelnut new` writes no
`openapi` key at all, so the route does not mount. `public: true` is therefore
always something you typed. `deno task dev` serves whatever you declared without
asking; `launch` is the production door, so it is the place that asks.

Two ways forward. Gate it — `openapi: { gate: "ticket:submit" }` in
`hazelnut.config.ts` — and reading the document costs that permission, exactly
as an `http` route would. Or delete the `openapi` line, and the route does not
mount at all.

## An MCP door with no posture is refused {#mcp-posture}

An app that puts a tool on `POST /mcp` says two things about that door before
`launch` will start it. Neither is a grant, and both are one line:

```
REFUSED — launch will not start this app (a grant is never widened to -A):
  ✗ the MCP door at POST /mcp is served with no Origin posture (`mcp.allowedOrigins` is absent) — a browser page can reach it, and anonymous callers see every ungated tool
    fix: name who may reach it — `mcp: { allowedOrigins: ["https://your-host"] }` — or `mcp: { allowedOrigins: null }` to say the door is open on purpose
  ✗ the MCP door at POST /mcp is served with no reader posture (`mcp.gate` is absent) — every call reaches it, and `tools/list` hands back each curated tool with its full input schema, the shape `/openapi.json` is never served ungated
    fix: name who may reach it — `mcp: { gate: "<perm>" }`, which gates the WHOLE door including `initialize` — or `mcp: { gate: null }` to keep it open, which is what an app already serving anonymous agents wants
```

They answer different questions. `allowedOrigins` is WHICH BROWSER may reach the
door: an empty list closes it to every page, and headless agents send no
`Origin` at all, so they are untouched. `gate` is WHO MAY REACH IT AT ALL — the
permission is checked before the JSON-RPC body is read, so a caller without it
is refused `initialize` too, not only `tools/list`. What makes the catalogue
worth gating is that `tools/list` hands back every tool with its full input
schema, the shape the section above refuses to serve ungated as `/openapi.json`.

**If your app already serves anonymous agents, `gate: null` is the declaration
that keeps it working.** Naming a permission there closes the door on every
caller who does not hold it, starting at the handshake.

**Absence is what refuses; presence is the test.** `null` passes both, and it is
how you say the door is open on purpose. That distinction is the whole design: a
posture you chose out loud reads differently from a posture nobody wrote, and
only the second one is a mistake.

Both are asked at the entry that serves your app's own tools over a socket. A
stdio entry binds no socket, and a gateway entry forwards to an app that answers
these itself — so neither is asked twice. `deno task dev` serves whatever you
declared without asking; `launch` is the production door, so it is the place
that asks. `hazelnut new --example` writes both postures for you.

## A boot that names no drain and no scheduler is refused {#drain-declared}

The other refusal that is not about a grant. Your boot bundle must say who runs
the background work:

```
REFUSED — launch will not start this app (a grant is never widened to -A):
  ✗ who runs the feature scheduler (the served entry declares no `scheduler`)
    fix: add `scheduler: "in-process"` to the boot bundle (this process rides Deno.cron), or `scheduler: "external"` if a separate process runs `startFeatureScheduler` — undeclared, the born-on TTL sweeps over _idempotency/_outbox/_processed/_rate_limit never run and those tables grow without bound
```

Every served app needs the scheduler, whatever it declares: `_idempotency` and
`_rate_limit` take a row on ordinary traffic, and the sweeps that reap them are
the only thing that bounds those tables. The `relay` refusal is narrower — it
fires only when the app has something to drain, and names what: subscribers,
workers, read-models, vector re-embeds, `file()` byte reclaim.

Both keys take the same two answers, and each is a real answer:

| value          | meaning                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| `"in-process"` | this process does it — the drain on a poll timer, the sweeps on `Deno.cron`                          |
| `"external"`   | a separate process does — `hazelnut relay ./app.ts --loop` for the drain, your own scheduler process |

`"external"` is taken at its word. Which process owns the sweeps is a fact about
your deployment, not about your code, so nothing here verifies it — and that is
exactly why the question is asked by `launch` rather than refused at boot: a
correct multi-process deployment must not be blocked for not having said so.
What is refused is saying **nothing**, because the app then serves with the
tables growing and no subscriber ever firing, and every other check stays green.

`hazelnut new` writes both keys, so a scaffolded app clears this on day one.
`deno task dev` is untouched.

## Flags

| flag             | effect                                                                      |
| ---------------- | --------------------------------------------------------------------------- |
| _(none)_         | derive, then run the app as a child process                                 |
| `--explain`      | print every grant with the declaration that forced it, then exit            |
| `--print`        | print the `deno run …` command for a platform process definition, then exit |
| `--entry <file>` | the served entry (default `main.ts`)                                        |

`--entry` is also how you start an MCP transport entry:
`hazelnut launch
./app.ts --entry gateway.ts`. The derivation follows the entry,
so each gets its own set — the stdio entry binds no socket and is granted none,
and the gateway holds no database, no keys and no declared egress. See
[`hazelnut mcp`](./mcp.md).

## The supervisor

`launch` runs the app as a child, so two processes exist. Both are bounded:

- **the launcher** holds `--allow-read --allow-env --allow-run=deno,deno.exe`
  (Windows scaffolds: a bare `--allow-run`, because a named grant cannot resolve
  when the Deno process PATH dropped `.deno\bin`) — the three grants it needs to
  read the app tree, import the model, and spawn. Never `-A`: a supervisor
  holding everything for the child's lifetime would hand back exactly what the
  verb takes away.
- **the app** holds the derived set, and nothing else.

`SIGTERM`/`SIGINT` are **forwarded** to the child. The graceful drain hangs off
the app's own signal handler (`main.ts`), so a supervisor that swallowed the
signal would turn every rolling restart into a hard kill mid-drain — a worse
failure than the blanket grant this verb deletes.

## Why derivation happens at launch, not at scaffold

Baking a flag string into `deno.json` on day 1 would be static, and static is
what rots: the string cannot see the webhook added in month 3, and it cannot see
`DATABASE_URL`, which is a runtime fact, not a build-time one. The launcher
reads both at the moment it starts the process.

`--print` exists for platforms that require a literal command. It has the same
staleness exposure as any hand-written allowlist — re-run it when declarations
change.

## Related

- [`doctor`](./doctor.md) — its `tasks/least-privilege` check warns when a
  `start` task carries `-A`. The `dev` task is exempt; the inner loop wants the
  blanket grant.
- [Deploying](../DEPLOY.md) — where launch sits in the release loop.
