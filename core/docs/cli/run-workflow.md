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
