# `hazelnut relay`

> **Reference** — for anyone running the outbox drain as its own process. It
> drains the outbox and routes runtime alarms into your alarm sink.

A single-process deployment drains inside the served app and does not need this
verb. Run it when the served app leaves draining to a separate worker. The
operating guide — seams for a separate process, backpressure, and `/ready` — is
section 13 of the [rundown](../rundown.md).

## Usage

```sh
hazelnut relay ./app.ts                                   # one drain pass, then exit
hazelnut relay ./app.ts --loop                            # drain until SIGINT
hazelnut relay ./app.ts --loop --interval 500 --health-port 9090
```

It connects to the database named by `DATABASE_URL`.

## Flags

| Flag                | Meaning                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| `--loop`            | keep draining; SIGINT lets the in-flight pass finish, then exits                                      |
| `--interval <ms>`   | the wait between passes in `--loop` mode, 1 to 2147483647 milliseconds; 1000 when omitted             |
| `--health-port <n>` | in `--loop` mode, serve the worker's own `GET /healthz` on this port (1–65535), the headless `/ready` |

Without `--loop`, `--interval` and `--health-port` have no effect, but a
malformed value is still refused.

## Exit codes

| Result                                                                                                           | Exit |
| ---------------------------------------------------------------------------------------------------------------- | ---- |
| the drain finished: `✓ relay: drained — processed=… failed=… dead=…`                                             | 0    |
| a usage error, a module without an `app` export, a malformed flag value, `DATABASE_URL` unset, or a missing seam | 2    |

A pass that dead-letters messages still exits 0; the `dead` count and your alarm
sink report them, and [`hazelnut redrive`](./redrive.md) recovers them.
