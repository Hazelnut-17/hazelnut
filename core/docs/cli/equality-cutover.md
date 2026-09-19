# `hazelnut equality-cutover`

> **Reference** — for the operator making one key version canonical for
> encrypted equality lookups on unique fields.

It canonicalizes the equality tokens of every resource with a unique encrypted
equality field. Run it bare for the plan, which counts rows and reads no key
material; nothing is written until you add `--execute`. Section 13 of the
[rundown](../rundown.md) explains the unique-equality boundary this closes.

## Usage

```sh
hazelnut equality-cutover ./app.ts --to v2                 # the plan
hazelnut equality-cutover ./app.ts --to v2 \
  --key-env v2=ENCRYPTION_KEY --key-env v1=ENCRYPTION_KEY_PREVIOUS --execute
```

It connects to the database named by `DATABASE_URL`.

## Flags

| Flag                        | Meaning                                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `--to <version>`            | the canonical key version; required                                                                         |
| `--key-env <version>=<ENV>` | repeat once per key version: the canonical key and every historical envelope key; required with `--execute` |
| `--execute`                 | perform the cutover; without it the verb prints the plan                                                    |

## What `--execute` does

For each resource it takes the same write lock as normal equality writes,
decrypts and re-stamps the whole corpus in one transaction, checks full,
composite and partial uniqueness, then records a completed marker. A bad
envelope, a changed row, a missing key or a duplicate rolls that resource back
and leaves no marker. It does not re-wrap envelopes and does not authorize
deleting any key; run `hazelnut rotate-key` for the envelopes.

Resources are cut over one at a time. When one fails, the run exits 2 and names
the resources already cut over; each keeps its completed marker. Fix the cause
and re-run.

## Exit codes

| Result                                                                          | Exit |
| ------------------------------------------------------------------------------- | ---- |
| the plan printed, or the cutover completed                                      | 0    |
| a usage error, a missing key, a rolled-back resource, or an unreadable database | 2    |
