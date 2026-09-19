# `hazelnut rotate-key`

> **Reference** — for the operator moving encrypted data keys onto a new master
> key version.

It re-wraps each encrypted field's data key under the new master key. The
ciphertext is not re-encrypted. Run it bare for the plan, which counts rows and
reads no key material; nothing is written until you add `--execute`. Section 13
of the [rundown](../rundown.md) covers what a finished rotation does and does
not let you delete, and the unique-equality boundary.

## Usage

```sh
hazelnut rotate-key ./app.ts --from v1                     # the plan: rows still on v1
hazelnut rotate-key ./app.ts --from v1 --to v2 \
  --new-key-env ENCRYPTION_KEY --old-key-env ENCRYPTION_KEY_PREVIOUS --execute
```

It connects to the database named by `DATABASE_URL`. Each `--…-key-env` flag
names the environment variable holding a base64 32-byte master key, never the
key itself.

## Flags

| Flag                  | Meaning                                                            |
| --------------------- | ------------------------------------------------------------------ |
| `--from <version>`    | the key version to move rows off; required                         |
| `--to <version>`      | the new key version; `v2` when omitted                             |
| `--new-key-env <VAR>` | the variable holding the new master key; required with `--execute` |
| `--old-key-env <VAR>` | the variable holding the old master key; required with `--execute` |
| `--execute`           | perform the re-wrap; without it the verb prints the plan           |

## Exit codes

| Result                                                                                     | Exit |
| ------------------------------------------------------------------------------------------ | ---- |
| the plan printed, or every envelope is off `--from`                                        | 0    |
| an envelope still names `--from`, or a row could not be rotated and needs manual repair    | 1    |
| a usage error, a wrong or missing key, `--to` equal to `--from`, or an unreadable database | 2    |

Treat exit 1 as "not finished": re-run until it exits 0 before any key-retention
step. A row that a concurrent write changed mid-pass is reported and left as
that writer committed it; the next run picks it up if it is still on `--from`.
Exit 0 proves only that envelopes no longer name the old version — an equality
blind index or a tamper-evident chain can still need that key.
