# `hazelnut run-workflow`

> **Reference** — for the operator starting or resuming a declared workflow from
> the command line.

It runs a `defineWorkflow` by name against your database. Run it bare for the
plan — recorded run IDs in the selected scope, or the journal for an explicit
run ID; nothing runs until you add `--execute`. Steps that already committed
stay in the journal, so a re-run resumes rather than repeating them.

## Usage

```sh
hazelnut run-workflow onboard ./app.ts                     # the plan
hazelnut run-workflow onboard ./app.ts --workflow-id onboard-7 --input '{"userId":"7"}' --scope tenant-7 --execute
```

The workflow name comes before the app. It connects to the database named by
`DATABASE_URL`. Execution requires `--workflow-id` and `--input` JSON. Reuse the
exact original input and scope to resume; a new explicit ID starts a new logical
run. The framework does not persist or reconstruct input. A plan only knows
steps the body has reached, so it cannot promise that later external effects
will be skipped.

For custom ports, export `workflowSeams: () => ({ kms, storage, datasources })`
from the app module (`relaySeams` is also accepted). `datasources` is the built
registry returned by `buildDatasources`. Execution inherits these ports in its
body and every step. Supply the app-key adapter through that KMS port when your
application uses a configured master key. An unavailable datasource/storage/KMS
fails through its ordinary capability door. Keep the same key custody and
storage configuration as the served application.

On first run, Hazelnut binds each `workflowId` to one workflow name and scope.
After upgrading from a version that predates this identity record, execution of
an existing journal without a binding stops with `workflow/identity-unbound`;
verify the original workflow, scope and submitting actor before adding that
binding, or retire the old persisted run. The framework will not guess. Drain
old app processes before starting the new version's workflow traffic.

If a persisted step id contains `:`, change the workflow declaration to a
colon-free id and migrate its completed journal key before the new process can
resume it. Otherwise the new id will not match the stored result and the step
body can run again. After the schema migration creates `_workflow_identity`,
stop old workers, inspect the old run and its side effects, then bind and rename
the verified rows in one database transaction. The example below assumes the
original submitting actor was `user` / `alice`; use it only after reviewing
records that establish that owner, declaration, scope and effect state:

```sql
BEGIN;
INSERT INTO "_workflow_identity" (workflow_id, workflow_name, scope, submitter)
VALUES ('onboard:user-7', 'onboard', 'tenant-7', '["user","alice"]');
UPDATE "_workflow_journal" SET step_id = 'charge-vendor'
WHERE workflow_id = 'onboard:user-7' AND step_id = 'charge:vendor' AND status = 'done';
UPDATE "_workflow_progress" SET step_id = 'charge-vendor'
WHERE workflow_id = 'onboard:user-7' AND step_id = 'charge:vendor';
COMMIT;
```

Use the exact workflow name, execution scope and original submitter. For an
authenticated actor, `submitter` is compact JSON text `[actorType,actorId]`,
with the exact actor type and id: `user` / `alice` is `'["user","alice"]'`. The
operator CLI uses `'["system","system"]'`; its command reason is not part of
this key. Use that value only for a run originally owned by the CLI system
actor, not to transfer a user's run so the CLI can resume it. A user-bound run
must resume through that user's current authenticated context. The journal does
not restore old claims. Do not infer an owner from the scope or workflow id, or
use pretty-printed JSON with different whitespace for this text key.

Omitting `submitter` leaves its compatibility default `''`. That is ownerless:
any submitter in the same declaration and scope can resume it, while app
inspection and cancellation hide it until a nonempty matching owner is set. It
does not bind the operator or the first caller that resumes. If an earlier
repair already left `submitter = ''`, stop workers and set only that row's
reviewed owner in the recovery transaction, for example:

```sql
UPDATE "_workflow_identity" SET submitter = '["user","alice"]'
WHERE workflow_id = 'onboard:user-7' AND workflow_name = 'onboard'
  AND scope = 'tenant-7' AND submitter = '';
```

Do not overwrite a nonempty owner or guess one. Run the journal-key updates only
when the destination step id has no row; a primary-key conflict rolls the
transaction back. Do not rename `running` or otherwise ambiguous steps until
their external effects have been reconciled. If you cannot prove the original
identity or effect state, retire the run instead of guessing.

## Flags

| Flag                 | Meaning                                                                  |
| -------------------- | ------------------------------------------------------------------------ |
| `--workflow-id <id>` | select a concrete run; required for execution                            |
| `--input <json>`     | original input, or input for an explicit new run; required for execution |
| `--scope <scope>`    | original scope; defaults to the empty scope                              |
| `--execute`          | run the workflow; without it the verb prints the plan                    |

## Exit codes

| Result                                                                                   | Exit |
| ---------------------------------------------------------------------------------------- | ---- |
| the plan printed, or the workflow ran to the end                                         | 0    |
| a usage error, no workflow with that name, a step that failed, or an unreadable database | 2    |

When a step fails, the steps before it stand in the journal and the message says
so; fix the cause and re-run the same command to resume.
