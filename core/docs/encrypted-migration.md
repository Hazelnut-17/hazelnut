# Move existing plaintext into encrypted fields

> **How-to** — for the operator adding encryption to a populated resource.

Add a new nullable encrypted field, seal existing values through the normal
write path, switch readers and writers, then remove the old plaintext in a later
migration. `migrate generate` and `migrate apply` refuse an in-place type change
or a column rename into a declared encrypted field with
`encrypted/seal-forward-required`, including a file carrying `allow-unsafe-ddl`
consent. Casting text to `bytea` produces plaintext bytes; it does not produce
an encrypted envelope.

## 1. Expand without changing the stored plaintext

Keep the original field and add a nullable encrypted field under its permanent
name. Mark the old field `sensitive` while it remains present so normal
responses and audit snapshots withhold it. Configure a durable KMS or
`defineConfig({ encryptionKey })`, retain the key, and use the same key on the
backfill worker and every serving replica.

This example uses `secret_sealed` as the final stored field. The helper is the
body of an authorized write operation, invoked repeatedly in small batches. Keep
its statement text in `queries/` as shown; expose no public backfill door.

<!-- @conformance:ts imports=defineResource,z -->

```ts
// resources/vault.resource.ts
import { defineResource } from "hazelnut";
import { z } from "zod";

export const vault = defineResource({
  name: "vault",
  schema: z.object({
    label: z.string(),
    secret: z.string(),
    secret_sealed: z.string().nullable(),
  }),
  features: { versioning: false },
  sensitive: ["secret"],
  encrypted: { fields: ["secret_sealed"], equality: ["secret_sealed"] },
});
```

Keep the batch statement in the query seam:

<!-- @conformance:ts imports= -->

```ts
// queries/sealVaultBatch.ts
export const SEAL_VAULT_BATCH =
  "SELECT id, secret FROM vault WHERE secret_sealed IS NULL ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED";
```

Import the resource type and batch statement in the operation's logic. Call this
helper only inside an authorized write transaction.

<!-- @conformance:ts imports=Ctx,err,ok fixture=seal-forward -->

```ts
// logic/vault/sealBatch.ts
import { type Ctx, err, ok } from "hazelnut";
import type { vault } from "../../resources/vault.resource.ts";
import { SEAL_VAULT_BATCH } from "../../queries/sealVaultBatch.ts";

export async function sealBatch(ctx: Ctx<typeof vault>) {
  const { rows } = await ctx.query<{ id: string; secret: string }>(
    SEAL_VAULT_BATCH,
  );
  for (const row of rows) {
    const written = await ctx.data.vault.update(row.id, {
      secret_sealed: row.secret,
    });
    if (!written.ok) return written;
    const checked = await ctx.data.vault.find(row.id);
    if (!checked.ok) return checked;
    if (checked.value?.secret_sealed !== row.secret) {
      return err("internal", "sealed value failed verification");
    }
  }
  return ok({ sealed: rows.length }); // return counts, never plaintext
}
```

Generate and apply the additive migration before deploying code that writes the
new field. Do not edit the generated `bytea` column into a cast of the old
column. A `.data.ts` transform shell is not an automatically executed backfill:
run your authorized operation or a separately reviewed maintenance runner.

The example uses a flat, unscoped, mutable resource without versioning or
lifecycle features. For a scoped resource, put the scope predicate in the raw
statement and run each batch under that same scope. Keep the resource's
`rowPolicy` and the maintenance actor aligned. For a versioned resource, select
and pass the current version to `update`. Do not turn off versioning on an
existing resource to copy this example.

## 2. Keep new writes consistent and backfill in batches

Deploy code that writes both fields in the same write operation while old
readers still need plaintext. Drain every old replica, relay, scheduled job, and
external writer that can write only the old field before starting the backfill.
A legacy writer can otherwise change plaintext after its row was sealed, leaving
a valid but stale encrypted value.

Call the batch operation repeatedly, committing each batch. The row locks hold
through sealing and verification; ordinary dual writers serialize with the copy.
An error rolls back that batch. Re-running it selects only rows whose encrypted
field remains null. An empty batch can mean another worker holds the remaining
rows, so finish with a full-corpus check after workers have drained.

`ctx.data` seals the value using the configured KMS and stamps the equality
blind index when declared. Raw `UPDATE`, `secret::bytea`, and copying another
cell's envelope bypass that work. If you need uniqueness on encrypted equality,
declare it on the encrypted field before copying; a duplicate must be resolved
before the batch can commit. Never put plaintext in progress logs, operation
results, queue payloads, or a workflow journal.

## 3. Verify every retained row and switch readers

Verify decryption and plaintext equality for every retained source row, then
verify zero missing encrypted values after all batches and writers have settled.
Include non-public scopes and lifecycle-hidden rows. The ordinary `ctx.data`
write/read stack hides soft-deleted, expired, or superseded rows; the example
refuses if one cannot be updated or verified. Such rows need a reviewed
maintenance plan that preserves their lifecycle and audit rules, or an explicit
retention decision to delete them before the old column goes. Immutable
resources require their supported correction/append workflow. Do not silently
skip these rows and call the migration complete.

Use a separate completion marker for a nullable plaintext source: a null source
legitimately produces a null encrypted value, so `IS NULL` alone cannot
distinguish unfinished rows. Keep that marker and the encrypted write in the
same transaction. Test equality lookups and declared uniqueness as well as
decryption if the new field uses `equality`.

Switch all readers to the encrypted field only after the checks pass. Keep dual
writes during the rollback window. Existing plaintext readers can then be
restored without losing newer writes. Once plaintext writes stop, rollback
requires a deliberate decrypt-and-copy process; restoring the old binary alone
is insufficient.

## 4. Contract after the rollback window

Remove the plaintext field from every writer and reader, then remove it from the
declaration. Generate a separate destructive migration with
`--allow-destructive`, review it, and apply it after your retention and backup
requirements permit deletion. Tighten the encrypted field to non-null only after
the full corpus satisfies that constraint; follow the staged validation pattern
in [migrate](./cli/migrate.md).

An envelope is authenticated against its schema, table, field, and row id. Keep
`secret_sealed` under that name. Renaming it to `secret`, moving it to another
table, or copying it to another row makes authentication fail. If the final
field must be named `secret`, fence writers for a coordinated deployment, rename
the **plaintext** field to `secret_legacy` first, and add a fresh nullable
encrypted `secret` at its final location. Seal through `ctx.data` into that
field, verify, and later drop `secret_legacy` using the same steps. Renaming
plaintext is safe; renaming sealed bytes is not.

[`rotate-key`](./cli/rotate-key.md) and
[`equality-cutover`](./cli/equality-cutover.md) operate on existing envelopes.
Use them for key rotation after sealing, rather than for plaintext conversion.
