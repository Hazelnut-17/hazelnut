# `hazelnut run-workflow`

> **Reference** — for the operator starting or resuming a declared workflow from
> the command line.

It runs a `defineWorkflow` by name against your database. Run it bare for the
plan — which steps would resume from the journal and which would fire for real;
nothing runs until you add `--execute`. Steps that already committed stay in the
journal, so a re-run resumes rather than repeating them.

## Usage

```sh
hazelnut run-workflow onboard ./app.ts                     # the plan
hazelnut run-workflow onboard ./app.ts --execute
```

The workflow name comes before the app. It connects to the database named by
`DATABASE_URL`.

On first run, Hazelnut binds each `workflowId` to one workflow name and scope.
After upgrading from a version that predates this identity record, execution of
an existing journal without a binding stops with `workflow/identity-unbound`;
verify the original workflow and scope before adding that binding, or retire the
old persisted run. The framework will not guess. Drain old app processes before
starting the new version's workflow traffic.

If a persisted step id contains `:`, change the workflow declaration to a
colon-free id and migrate its completed journal key before the new process can
resume it. Otherwise the new id will not match the stored result and the step
body can run again. After the schema migration creates `_workflow_identity`,
stop old workers, inspect the old run and its side effects, then bind and rename
the verified rows in one database transaction. For example:

```sql
BEGIN;
INSERT INTO "_workflow_identity" (workflow_id, workflow_name, scope)
VALUES ('onboard:user-7', 'onboard', 'tenant-7');
UPDATE "_workflow_journal" SET step_id = 'charge-vendor'
WHERE workflow_id = 'onboard:user-7' AND step_id = 'charge:vendor' AND status = 'done';
UPDATE "_workflow_progress" SET step_id = 'charge-vendor'
WHERE workflow_id = 'onboard:user-7' AND step_id = 'charge:vendor';
COMMIT;
```

Use the exact workflow name and execution scope. Run the updates only when the
destination step id has no row; a primary-key conflict rolls the transaction
back. Do not rename `running` or otherwise ambiguous steps until their external
effects have been reconciled. If you cannot prove the original identity or
effect state, retire the run instead of guessing.

## Flags

| Flag        | Meaning                                               |
| ----------- | ----------------------------------------------------- |
| `--execute` | run the workflow; without it the verb prints the plan |

## Exit codes

| Result                                                                                   | Exit |
| ---------------------------------------------------------------------------------------- | ---- |
| the plan printed, or the workflow ran to the end                                         | 0    |
| a usage error, no workflow with that name, a step that failed, or an unreadable database | 2    |

When a step fails, the steps before it stand in the journal and the message says
so; fix the cause and re-run the same command to resume.
