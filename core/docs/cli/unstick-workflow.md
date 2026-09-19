# `hazelnut unstick-workflow`

> **Reference** — for the operator who knows a workflow runner is dead and does
> not want to wait for its step lease to lapse.

A crashed step's claim frees itself once its lease expires. This verb expires it
now, so the next run takes the step over immediately. Run it bare for the plan;
nothing changes until you add `--execute`. Forcing a claim that is still live
lets a non-idempotent step run twice, and the plan says so every time it would.

## Usage

```sh
hazelnut unstick-workflow ./app.ts --workflow wf_123 --step charge            # the plan
hazelnut unstick-workflow ./app.ts --workflow wf_123 --step charge --execute
```

It connects to the database named by `DATABASE_URL`.

## Flags

| Flag              | Meaning                                               |
| ----------------- | ----------------------------------------------------- |
| `--workflow <id>` | the workflow instance holding the claim; required     |
| `--step <stepId>` | the step whose claim to expire; required              |
| `--execute`       | expire the claim; without it the verb prints the plan |

## Exit codes

| Result                                                                             | Exit |
| ---------------------------------------------------------------------------------- | ---- |
| the plan printed, the claim expired, or no in-flight claim matched (a clean no-op) | 0    |
| a usage error or an unreadable database                                            | 2    |

There is no `unstick` for webhooks, queues or cron: those consumers claim inside
one database transaction, so a crash leaves no claim behind. A webhook stuck in
retry is dead-letter recovery, which is [`hazelnut redrive`](./redrive.md).
