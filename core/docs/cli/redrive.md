# `hazelnut redrive`

> **Reference** — for the operator recovering dead-lettered outbox messages
> after fixing what made them fail.

It moves dead-lettered corpses from `_outbox_dead` back onto `_outbox` for the
standing relay to re-process. It sends nothing itself. Run it bare for the plan;
nothing is written until you add `--execute`. The rundown's section 13 explains
what a re-drive re-sends and why a redriven message gets a fresh `id` — read it
before the first `--execute`.

## Usage

```sh
hazelnut redrive ./app.ts                                  # the plan: what would move, by topic
hazelnut redrive ./app.ts --topic order.paid --execute     # move one stream
hazelnut redrive ./app.ts --limit 500 --execute            # move in chunks
```

It connects to the database named by `DATABASE_URL`.

## Flags

| Flag          | Meaning                                               |
| ------------- | ----------------------------------------------------- |
| `--topic <t>` | redrive only corpses of this topic                    |
| `--limit <n>` | move at most this many corpses; a positive integer    |
| `--execute`   | perform the move; without it the verb prints the plan |

## Exit codes

| Result                                                               | Exit |
| -------------------------------------------------------------------- | ---- |
| the plan printed, or the move landed                                 | 0    |
| a usage error, a malformed `--limit`, or the database cannot be read | 2    |

A corpse whose event fanned out to several subscribers is deferred while a
sibling subscriber is still unresolved. It stays in `_outbox_dead`, both the
plan and `--execute` name it, and the run still exits 0. Re-run once the sibling
resolves.
