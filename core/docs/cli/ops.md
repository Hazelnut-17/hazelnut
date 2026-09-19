# `hazelnut ops`

> **Reference** — for the operator pulling a production lever without a deploy.

Each lever is a row every replica reads on the cycle that needs it, so it takes
effect across replicas and survives a restart. Run an action bare for the plan;
nothing changes until you add `--execute`. The walk-through — when to hold the
relay, what `/ready` reports while it is held, and how the caps behave — is in
[Deploying](../DEPLOY.md).

## Usage

```sh
hazelnut ops ./app.ts                                      # status: live levers, backlog, relay hold
hazelnut ops ./app.ts --json                               # the same, as JSON
hazelnut ops ./app.ts pause-relay --reason "db failover" --execute
hazelnut ops ./app.ts resume-relay --execute
hazelnut ops ./app.ts cap agent:noisy-bot 10 --execute     # tighten one caller's rate limit
hazelnut ops ./app.ts uncap agent:noisy-bot --execute
```

It connects to the database named by `DATABASE_URL`. The actions are `status`
(the default), `pause-relay`, `resume-relay`, `cap <key> <limit>` and
`uncap <key>`. `cap` limits a key to that many requests per window on every
replica; `''` as the key caps every key without a cap of its own. A cap only
tightens: the limiter takes the lower of the cap and the budget the app
declared.

## Flags

| Flag              | Meaning                                                                    |
| ----------------- | -------------------------------------------------------------------------- |
| `--reason <text>` | the reason recorded with a `pause-relay` hold                              |
| `--execute`       | pull the lever; without it the verb prints the plan                        |
| `--json`          | print only the JSON document, for a script or an agent reading an incident |

## Exit codes

| Result                                                                         | Exit |
| ------------------------------------------------------------------------------ | ---- |
| the status or plan printed, or the lever landed                                | 0    |
| a usage error, an unknown action, a malformed `cap`, or an unreadable database | 2    |
