# Deploying a Hazelnut app

> **How-to** — for whoever puts the app in production. One path, end to end:
> database, gated migration, container, probes, shutdown, observability.

The one documented path from a scaffolded app to a running production service.
Everything here derives from what the framework already owns — the scaffold's
`Dockerfile`, the migrate verbs, the probes, and the multi-replica semantics —
so the guide is short: there is little left for you to invent.

## The shape

A Hazelnut deployment is three moving parts, in this order:

1. **A Postgres 16+** you provision (managed or self-hosted). The app never
   creates or migrates it on boot — `main.ts` serves, only.
2. **A gated migrate step** run per release, before the new code takes traffic:
   `hazelnut migrate <app> preview` in CI (review the DDL), then
   `hazelnut migrate <app>` (apply) against the production `DATABASE_URL`.
   `migrate <app> check` in CI catches drift between the declared model and the
   live schema; `status` shows what is pending.
3. **N replicas of the container** built from the scaffold's `Dockerfile`.
   Multi-replica boot is safe by construction: the outbox relay drains with
   `FOR UPDATE SKIP LOCKED` (no double-delivery), cron is leaderless (one firing
   via advisory lock), and migrations never race because step 2 is the only
   writer of DDL. The container's `CMD` is `hazelnut launch`, which derives the
   served process's Deno permissions from the app's own declarations rather than
   granting `-A` (`cli/launch.md §derivation`).

**Step 3 has a prerequisite, and it is worth checking before you write a
pipeline.** A Docker build only sees its build context, so the framework has to
sit inside the app directory or be fetched by name. An app scaffolded against a
local checkout pins `imports.hazelnut` at an absolute path on the machine that
scaffolded it — `deno cache main.ts` cannot resolve that inside the image, and
nothing else can resolve it on any other machine either. Two ways to be
deployable:

- **Self-contained** — scaffold with
  `hazelnut new <app> --vendor <framework-repo>`, which copies the framework
  into the app and pins it relatively.
  `hazelnut install --from <framework-repo>` does the same to an app that
  already exists.
- **Published** — pin `imports.hazelnut` at a published specifier, which the
  build fetches like any other dependency.

`deno task doctor` reports which one you are on: `pin/portable` warns while the
pin is a host-absolute path and names the fix. It is a warning rather than a
blocker because the local-checkout shape is a perfectly good development posture
— it is only step 3 it cannot survive.

## Environment

| Var                           | Required                                                           | Meaning                                                                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                | prod: yes                                                          | Postgres connection string. Unset, the process refuses to start unless `HAZELNUT_DEV=1`.                                                                                                       |
| `HAZELNUT_DEV`                | dev only, when `DATABASE_URL` is unset                             | `1` asks for the embedded PGlite (fresh each run, every write lost on exit). `deno task dev` sets it.                                                                                          |
| `PORT`                        | no (8000)                                                          | listen port for `Deno.serve`. `launch` refuses an empty or `0` value.                                                                                                                          |
| `FILES_DIR`                   | if any resource declares a `file()` field and stores bytes locally | the `localDriver` root — also the one directory the derived write grant covers.                                                                                                                |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no                                                                 | OTLP collector endpoint. `launch` derives its host into `--allow-net`.                                                                                                                         |
| `APP_URL`                     | only for an MCP gateway entry                                      | the app's internal base url that entry forwards to. `launch` derives its host into `--allow-net`, and refuses an unreachable one.                                                              |
| `PATH`                        | no                                                                 | read by `doctor` only: when the running deno's own directory is not on it (an MSYS shell's converted PATH drops it), bare-name run grants cannot resolve and `launch` refuses its child spawn. |

**A production deployment never sets `HAZELNUT_DEV`.** The dev database is
something a developer asks for, not something an empty variable grants — copy
the dev Dockerfile, drop `DATABASE_URL`, and the container exits non-zero naming
both variables instead of serving an in-memory database that loses every write
on restart.

That table is every name a served process, `launch`, or `doctor` reads, and the
split matters when you provision them: `launch` reads every row above to derive
a served process's grants, the served process reads `DATABASE_URL`,
`HAZELNUT_DEV` and `PORT`, `HAZELNUT_MCP_TOKEN` is read by the MCP **stdio**
entry — a separate process, deployed only if you emit one. Both MCP names are on
the MCP page too, where the entries that need them are. `CI` is not in the
table: a set, non-empty value ignores `mute` on the ship gate, and a served
process never reads it. **Every other secret is named by your project, not by
the framework** — including the `encrypted` master key: it arrives through
`defineConfig({ encryptionKey })`, which your config site sources from whatever
env name you choose. There is no branded framework env var for it, and no env
fallback: a missing key with encrypted fields is a loud boot refuse, never a
silent downgrade.

Generate that key with `openssl rand -base64 32` and nothing else. A 32-byte
string you typed is refused at boot — printable text, or too few distinct bytes,
is a placeholder however long it is, and the framework will not seal columns
under one. You cannot re-key afterwards by editing the value: a different master
key does not unwrap the data keys already written.

Secrets ride your platform's secret store; the config seam
(`hazelnut.config.ts`) reads env at boot and fails closed on what it needs.
Those literal reads are also what `hazelnut launch` scans to derive
`--allow-env` (`cli/launch.md §derivation`), so a project-named secret needs no
separate registration.

## Probes

Wire both — they are already served, in front of rate limiting:

- **Liveness** `GET /health` → `{"status":"ok"}` — the process is up.
- **Readiness** `GET /ready` — checks the DB round-trip and (when a relay is
  wired) the drain loop's health; a dead drain or over-budget backlog fails
  readiness and takes the instance out of rotation while it recovers.

## Shutdown

Send SIGTERM/SIGINT and let the drain finish: in-flight requests complete, the
relay finishes its current pass, then the process exits. Give the platform a
grace period ≥ your slowest op's `deadlineMs` (statement timeout default 30s).

## Operator levers — changing behaviour without a deploy {#operator-levers}

Two things you can change on a running deployment with no code change, no
restart and no redeploy. Each is a row in the framework table `_ops_control`, so
it survives a restart, every replica reads the same one, and pulling the same
lever twice is one lever.

Read what is set — this writes nothing:

```
hazelnut ops ./app.ts
```

You will see each live lever, the `_outbox` backlog waiting to drain, and
whether the relay is holding. With no lever set you will see
`(no lever set — the app runs on its declared defaults)`.

### Hold the relay

To quiesce your workers — a database failover, a bad deploy of a downstream
service, a poisoned stream you are about to redrive:

```
hazelnut ops ./app.ts pause-relay --reason "db failover"     # prints the plan
hazelnut ops ./app.ts pause-relay --reason "db failover" --execute
```

Within one poll interval (`hazelnut relay <app> --interval`, default 1s) every
replica stops CLAIMING new messages. A worker already inside a delivery finishes
it — the hold drains, it never kills work mid-transaction, so nothing is left
half-done. The backlog grows while the hold stands; nothing is lost.

Readiness reports `relay-paused` and stays GREEN, so your orchestrator will not
restart the workers you just quiesced. A worker that has genuinely stopped is
still reported unready, hold or no hold.

Two things the hold does NOT cover, so size them before you rely on it:
framework maintenance sweeps (file GC, re-embedding, read-model maintenance)
keep running, and serving traffic is unaffected — this lever is about message
delivery, not about the HTTP surface.

A hold can last as long as you need it to. The head-of-line breaker that
dead-letters a stuck message only counts messages that have actually failed a
delivery, so a backlog that merely sat through a long hold is delivered on
resume, not dead-lettered.

Release it:

```
hazelnut ops ./app.ts resume-relay --execute
```

### Cap a rate-limit budget

When one caller is hammering you and you would otherwise ship a hotfix:

```
hazelnut ops ./app.ts cap agent:noisy-bot 10 --execute
```

That key gets 10 requests per window on every replica, taking effect on the next
request — including one already waiting on the budget row. Use `''` (two quotes)
as the key to cap every key that has no cap of its own:

```
hazelnut ops ./app.ts cap '' 60 --execute
```

**A cap only ever tightens.** The limiter takes the lower of your cap and the
budget the app declared, so a number above the declared budget changes nothing —
you cannot hand out more traffic than the app asked for. If you need to widen
under load, that is an app change.

The cap reaches the shared Postgres-backed limiter, which is what a deployment
with more than one replica runs. An app that opted down to the in-memory
single-instance limiter has no shared row to read, so capping it needs a deploy.

Remove a cap and the declared budget applies again:

```
hazelnut ops ./app.ts uncap agent:noisy-bot --execute
```

Without `--execute`, every one of these prints exactly what it would do —
including how many messages a hold would strand — and changes nothing.

## Least-privilege

The process runs with the exact capability set its declarations imply, not `-A`.
`deno task start` and the container `CMD` both route through `hazelnut launch`,
which reads the model at start-up and grants one `--allow-net` per declared
egress host, one `--allow-env` per literal env read, and a write grant only when
a `file()` field forces one — see `cli/launch.md §derivation` for the full table
and for what it refuses rather than widening. `hazelnut doctor` warns
(`tasks/least-privilege`) if `start` — or any other task that runs your own
code, `dev` and `test` included — is edited back to a blanket grant. The inner
loop is born with its grants named too: a scaffolded `dev` holds net, env, read
and write-to-the-project, and no capability to spawn a process or load native
code.

An app declaring no `file()` field and no webhook serves production with net
(listen + Postgres), env (its own keys), and read (its own tree) — no write
grant at all.

Least privilege applies at the OS layer too. The scaffold's `Dockerfile` chowns
the app tree and switches to the image's unprivileged `deno` user before the
`CMD`, so the served process is not uid 0. The base image does not do this for
you — a container built `FROM denoland/deno` with no `USER` line runs as root,
no matter how narrow its Deno grants are.

`launch` also refuses to start an app whose OpenAPI document is served ungated —
see `cli/launch.md §openapi-gated`. Development is unaffected.

## What the framework already bounds

No config needed for the production floor you would otherwise hand-assemble: 1
MiB body cap (413) · statement timeout 30s · bounded deadlock retry ·
distributed rate limiting (`_rate_limit`) · deny-by-default authz (build-red
before it ever deploys) · outbox retry → `_outbox_dead` → `hazelnut redrive`
(prints a plan; `--execute` lands it) · outbound webhooks/`safeFetch` behind the
SSRF floor · a relay hold and a rate cap you pull without a deploy (the section
on operator levers above).

That last one has a residual you should size before you treat it as a network
boundary: the DNS pre-flight resolves, then `fetch` resolves again, so an
attacker controlling the answer for a hostname you POST to can rebind between
the two. Deno offers no IP-pinned socket, so this cannot be closed from inside
the process — close it upstream with an egress proxy or firewall rule, or by
addressing the receiver by a literal you control. The section on the outbound
SSRF floor in `rundown.md` has the full shape.

## Observability {#observability}

Traces and metrics leave through OTLP/HTTP in one line — no SDK to assemble, no
instrumentation to write:

<!-- @conformance:ts imports=installOtlp -->

```ts
// main.ts, after createApp
const otel = Deno.env.get("OTEL_EXPORTER_OTLP_ENDPOINT");
const obs = otel
  ? installOtlp({
    endpoint: otel,
    serviceName: "my-app",
    serviceVersion: "1.0.0",
  })
  : undefined;
// in the SIGTERM path, before Deno.exit — otherwise the last export window dies with the process
await obs?.shutdown();
```

What you get without writing an instrumentation call: **one span per op** (the
op-pipeline's own wrap point, with the error status set from the `Result`) and
the **RED trio** — `hazelnut.op` (rate + errors, by module/resource/op/origin/
outcome/kind) and `hazelnut.op.duration_ms`. Metric attributes are
declaration-derived only; actor and scope are deliberately excluded, since a
tenant key as a dimension is how a metrics bill becomes unbounded.

Unwired, the seams stay no-ops and cost nothing. Wired, the exporter is
fire-and-forget: an unreachable or rejecting collector increments
`obs.stats().failures` and never surfaces as an app error, and a queue that
outruns the collector drops (counted in `.dropped`) rather than growing into an
OOM of the app it observes.

The **collector, storage, and dashboard are yours** — the framework ships the
wire, not the stack. That boundary is why counts export as a delta Sum and
observations as a **Gauge**: percentiles over `hazelnut.op.duration_ms` are the
collector's to compute — or a real OTel SDK's, composed through the
`MetricsCollector` Port — not the exporter's to accumulate client-side. A
minimal local topology, addable to the reference compose file below:

```yaml
otel-collector:
  image: otel/opentelemetry-collector-contrib:latest
  command: ["--config=/etc/otel.yaml"]
  volumes: ["./otel.yaml:/etc/otel.yaml"]
  ports: ["4318:4318"] # OTLP/HTTP — the endpoint the app posts to
jaeger:
  image: jaegertracing/all-in-one:latest
  ports: ["16686:16686"] # trace UI
prometheus:
  image: prom/prometheus:latest
  ports: ["9090:9090"] # metric UI
```

with `otel.yaml` receiving OTLP/HTTP and exporting to those two backends. Point
the app at it with `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318`.

A collector on the internal network is the normal case, so this seam defaults
its SSRF-floor opt-outs on (`allowPrivateNetwork`, `allowInsecureHttp`); set
either to `false` to hold a public collector to the https + public-address
floor.

This is the framework's **one** default-relaxed security floor, so it does not
stay quiet about it: when the endpoint does not look internal — not a
private/loopback literal, not `localhost`, not a bare service name —
`installOtlp` warns once at wiring, naming the endpoint and the two flags that
re-arm the floor. An in-cluster collector triggers nothing; a public one tells
you the guard that would have caught a mistyped or attacker-supplied endpoint is
off.

`hazelnut launch` reads `OTEL_EXPORTER_OTLP_ENDPOINT` itself at launch and
derives the collector host into `--allow-net` — it does not depend on any app
file reading the name (`cli/launch.md §derivation`).

## Reference topology (compose form)

```yaml
services:
  db:
    image: pgvector/pgvector:pg16 # pgvector included — `vector()` columns need the extension
    environment:
      POSTGRES_PASSWORD: ${PG_PASSWORD}
    volumes: ["pgdata:/var/lib/postgresql/data"]
  app:
    build: .
    environment:
      DATABASE_URL: postgres://postgres:${PG_PASSWORD}@db:5432/postgres
      # your hazelnut.config.ts reads this; the framework reads no key env of its own
      ENCRYPTION_KEY: ${ENCRYPTION_KEY}
    depends_on: [db]
    ports: ["8000:8000"]
volumes:
  pgdata:
```

Release loop: build image → `hazelnut migrate <app> preview` (review) →
`hazelnut migrate <app>` → roll replicas → watch `/ready`. Rollback is the same
loop with the previous image, so keep the schema additive within a release line.

## Non-goals

No bundled PaaS, no provisioning DSL, no zero-downtime orchestrator — bring your
platform (compose, Kamal, Fly, K8s all fit the shape above). The framework's
promise ends at: a container that serves, probes that tell the truth, migrations
that never run themselves, and replicas that cannot double-fire.
