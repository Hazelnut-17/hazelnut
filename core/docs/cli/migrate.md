# `hazelnut migrate`

> **Reference** — for whoever changes the schema. Every subcommand, what it
> refuses, and what it does to your database.

`hazelnut migrate` is a **thin safety shell over drizzle-kit** for `generate`
and `rename`: drizzle-kit diffs the derived schema and writes the DDL. `apply`
then **replays those committed SQL files itself** (hash-checked). When
`drizzle/` has no committed history, `apply` pushes the derived schema instead.
That derived push is one database transaction when the configured driver
supports transactions, so a failed framework-index replacement preserves the
prior live schema. The shell makes both act on your declarations and stay safe
to run unattended.

Before applying a committed migration, the CLI checks that history is linear and
strictly audits the **pending** files for safe DDL, destructive consent, and
field-live conflicts. Already-applied files are not newly blocked by a later
audit rule. A pending snapshot-backed directory must also contain a non-empty
executable `migration.sql`; a missing or comment-only file is refused before the
migration ledger or schema changes. `apply` has no bypass flag: author any
required consent through `generate`, then review and apply the committed file.

## Interface

```
hazelnut migrate <app> generate   # diff declarations → emit SQL; flag dangerous changes; stub a data migration if needed
hazelnut migrate <app> preview    # dry run: selected apply SQL, then live/declaration drift separately
hazelnut migrate <app> apply      # replay committed SQL, or push the derived schema when drizzle/ is empty
hazelnut migrate <app> status     # fork and live-schema drift orientation (needs DATABASE_URL)
hazelnut migrate <app> check      # live-schema twin: needs DATABASE_URL; exit 0 clean, exit 1 on drift
hazelnut migrate <app> drift      # offline gate: is the committed migration stale? exit 0 clean, exit 1 stale
hazelnut migrate <app> audit      # offline: run the safe-DDL reader over the COMMITTED history (advisory; --strict to gate)
hazelnut migrate <app> rename     # declare a column rename a diff cannot infer, and author the ALTER
hazelnut migrate <app> rebase     # detect a forked history and print the fix
hazelnut migrate <app> reset      # re-sync a development database to the declarations
```

`generate`, `rename`, and `drift` are **offline** — they read the committed
migration history and your declarations, never the database. `audit` and
`rebase` are also offline: they read the committed chain only (rebase also reads
`--dir` names), never the database and never your declarations. Everything else
needs `DATABASE_URL`, as does `rebase --execute`.

### Flags {#migrate-flags}

| Flag                       | Read by                                                                        | Effect                                                                                                                                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--dir <name>`             | `generate`, `status`, `rebase`, and the standalone `--safe-ddl` mode           | another committed migration directory to read when detecting a forked history. Repeat it per directory. Naming the `drizzle/` container here is refused — a `--dir` value is one migration directory, not the tree that holds them.                                                      |
| `--out <dir>`              | `generate`, `rename`, `drift`, `audit`, `rebase`, `status`, `preview`, `apply` | where the migration files live. Defaults to `drizzle/`. Use the same value for preview and apply. `generate` creates it if missing. `audit` and `drift` refuse a missing or non-directory `--out` (exit 2). Not the `--safe-ddl` invocation — that mode takes `--dir` and `--immutable`. |
| `--immutable <table>`      | `generate`, `audit`, `apply`, and the standalone `--safe-ddl` mode             | a table of your own to protect like `_audit` — no `DROP TABLE`, no `TRUNCATE`, no `DELETE`, no destructive `ALTER`. Apply checks it against pending files only. An index drop is matched by NAME: `DROP INDEX <table>_…` is caught, and an index named otherwise is not. Repeat it.      |
| `--safe-ddl [<file>]`      | `migrate` itself                                                               | read a standalone `.sql` file (or `-` for stdin) through the same gate, with no app and no database. See "Checking a script you wrote by hand".                                                                                                                                          |
| `--env <name>`             | `preview`, `status`, `check`, `reset`, `apply`, and `rebase` with `--execute`  | read `DATABASE_URL` from `.env.<name>` instead of `.env`. A name whose file is absent is an error; a missing default `.env` is not — the ambient environment supplies it.                                                                                                                |
| `--online`                 | `generate`                                                                     | let drizzle-kit fetch over the network. Offline by default, from Deno's cache.                                                                                                                                                                                                           |
| `--allow-destructive`      | `generate`                                                                     | author a migration that drops something. Without it, the run stops at exit 2.                                                                                                                                                                                                            |
| `--allow-unsafe-ddl`       | `generate`, `rename`                                                           | author SQL the safe-DDL reader rejects, and record the confirm in the migration. Without it, `generate` stops at exit 1 and `rename` stops at exit 2.                                                                                                                                    |
| `--table <[schema.]table>` | `rename`                                                                       | which table the renamed column lives on. A bare name means the `public` schema.                                                                                                                                                                                                          |
| `--from <column>`          | `rename`                                                                       | the column's OLD name — the bit the diff cannot carry.                                                                                                                                                                                                                                   |
| `--to <column>`            | `rename`                                                                       | the column's NEW name. It must already be what your declaration says.                                                                                                                                                                                                                    |
| `--allow-incompatible`     | `rename`                                                                       | author the rename even though readers of the old name break at apply time. Without it, the run stops at exit 2 and prints the rolling-safe alternative.                                                                                                                                  |
| `--strict`                 | `audit`                                                                        | turn an advisory finding into exit 1.                                                                                                                                                                                                                                                    |
| `--yes`                    | `apply`, and `rebase` with `--execute`                                         | skip the confirmation prompt. `reset` never prompts: on a prod-equivalent target it is refused outright, and no `--yes` lifts that.                                                                                                                                                      |
| `--include-audit`          | `reset`                                                                        | reset the `_audit` table too. It is kept by default.                                                                                                                                                                                                                                     |
| `--execute`                | `rebase`                                                                       | perform the fix rather than print it.                                                                                                                                                                                                                                                    |

Write a flag's value as the **next argument** — `--out drizzle`, not
`--out=drizzle`. Spelled with `=`, or given with no value at all, the run stops
at exit 2 and names the spelling that works.

| Exit | Meaning                                                                                                                                                                                                                                                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | success; `check`/`drift` finding nothing; `audit` finding something WITHOUT `--strict` (advisory)                                                                                                                                                                                                                                          |
| 1    | drift (`check`, `drift`); `audit --strict` finding something; an unsafe-DDL block from `generate` (`--allow-unsafe-ddl` authors it); an ambiguous rename (a `.data.ts` shell is scaffolded); a failed apply                                                                                                                                |
| 2    | a destructive block (`--allow-destructive` authors it); an unsafe-DDL block from `rename` (`--allow-unsafe-ddl` authors it); drizzle-kit could not run or answer its own prompt; the prod-env guard; an unknown verb, a flag spelled `--flag=value` or given no value at all, or an `--out` that is not a directory (`audit`/`drift` only) |

A CI step that branches on exit code must treat both `1` and `2` as "did not
proceed" — the split is which flag, if any, would have let it through. Apply
preflight refusals (forked history, unsafe or destructive pending SQL,
field-live conflict, or missing executable migration SQL) exit `2` before the
pending SQL is executed or recorded in the migration ledger.

## What the shell adds

|               | drizzle-kit alone             | with the shell                                                          |
| ------------- | ----------------------------- | ----------------------------------------------------------------------- |
| Schema source | you hand-write drizzle tables | derived from your Zod declarations                                      |
| A rename      | an interactive prompt         | classified, or blocked — never guessed                                  |
| Column values | DDL only                      | a `.data.ts` transform                                                  |
| Applying      | immediate                     | env guard + confirmation (`--yes` or TTY). `preview` is a separate verb |

`generate` never writes SQL itself: it derives the schema, calls drizzle-kit to
diff and write, classifies what came back, and stubs a data migration only when
a transform is required.

## Who writes what

| File                                | Author                                                      |
| ----------------------------------- | ----------------------------------------------------------- |
| `drizzle/<TS>_<name>/migration.sql` | **drizzle-kit**                                             |
| `drizzle/<TS>_<name>/snapshot.json` | **drizzle-kit**                                             |
| `migrations/<dir>/*.data.ts`        | Hazelnut writes the shell; **you write the `forward` body** |

The `.data.ts` shell is re-derivable. Only the `forward` body is yours, and it
is the one thing a rebase preserves verbatim.

Re-running `generate` is safe only when an existing transform shell is
**byte-identical** to the generated shell; that is treated as a completed prior
write. A different shell is never overwritten — including when another session
creates it between the existence check and the atomic create — so review the
file and the migration decision before changing or removing it, then re-run.
There is no generated-file clobber path hidden behind a retry.

## Dangerous-change detection {#safety}

The shell replaces drizzle-kit's interactive rename prompt and its silent
add-plus-drop with a classification that needs no human at the keyboard:

| Diff shape                                                                                   | Verdict       | What happens                                                                               |
| -------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------ |
| add a nullable or defaulted column, a new table, an index                                    | safe          | authored without a confirm                                                                 |
| a column disappears **and** one appears                                                      | **ambiguous** | blocked — a `.data.ts` shell is stubbed; the tool will not guess whether that was a rename |
| a column or table disappears; **an index is dropped**                                        | destructive   | blocked until you confirm with `--allow-destructive`                                       |
| rows are removed (`TRUNCATE`, a `DELETE` with no `WHERE`)                                    | destructive   | blocked until you confirm with `--allow-destructive`                                       |
| a declared object is dropped (view, function, trigger, sequence, type, domain, rule, policy) | destructive   | blocked until you confirm with `--allow-destructive`                                       |

A dropped index is on that list because in Postgres a UNIQUE constraint **is** a
unique index: `DROP INDEX` and `ALTER TABLE … DROP CONSTRAINT` remove the same
declared invariant, and asking about only one of them made the spelling decide
whether you were asked. What disappears is the guarantee, not the bytes — which
is why it is the destructive confirm rather than the lock lint below.

On an append-only table that confirm does not exist, and the reading is
deliberately conservative. Which table an index belongs to cannot be worked out
without a database, so an index whose name **begins with** a protected table's —
`_audit_email_key`, or `<your-immutable-table>_…` — is read as belonging to it
and refused with no `--accept`. Postgres names its own indexes that way, so the
rule matches the common case; the cost is that an unrelated index that happens
to share the prefix is refused too. Rename it, or drop it before marking the
table immutable.

Every resolution is something you write down rather than something you click:
annotate the rename, supply a data migration, or confirm. Silent data loss is
not constructible through this path.

The destructive refusal also **unwrites** what drizzle-kit just authored, so the
tree is exactly as it was before you ran it:

```
✗ migrate generate: derived 1 resource(s) across 1 schema(s) — DESTRUCTIVE change
  blocked; the migration drizzle-kit wrote was removed
  - ALTER TABLE "notes"."note" DROP COLUMN "body"
  this discards the data in those column(s)/table(s) and cannot be undone by re-adding them.
  restore the declaration you removed to keep the data.
  only if discarding that data is intended, re-run with --allow-destructive to record consent and author it.
```

Leaving the file on disk would be the bypass: the next bare `generate` would
diff against the new snapshot, report no schema changes, and exit 0 over the
same drop. So the confirm is the only way past it, and `migrate <app> drift`
stays red until you either give it or put the declaration back.

When you do confirm, the authored migration records it — `generate` writes
`-- hazelnut: allow-destructive` at the top of the file. `audit` reads that line
and stops reporting the drop, so a migration you authorised on purpose does not
come back as a finding every time you audit the tree. Delete the line and it is
a finding again. The line does **not** clear an append-only violation: a drop
against `_audit` or a framework table has no confirm at any door. The one
framework-authored exception is a versioned index replacement whose generated
SQL proves both replacement arbiters exist before the legacy index is removed.

`--allow-unsafe-ddl` works the same way and writes its own line,
`-- hazelnut: allow-unsafe-ddl`. The two are separate because they answer
different questions — "this may discard data" and "this may stall writes" — and
each line clears only its own class. A change that is both carries both lines.

The lines are read as a BLOCK at the very top of the file: `generate` writes
them there, and a marker anywhere below the opening comments does not authorise
anything. That is deliberate. A confirm you cannot see while reading the diff is
not a confirm, so a line hidden inside a string or a `DO $$ … $$` body is
ignored.

### Safe DDL {#safe-ddl}

`generate` prepends `SET lock_timeout = '5s'` when the emitted SQL contains no
active `SET` / `SET LOCAL lock_timeout`. An authored value is kept; the `2s`
preview example below is an authored value, not the emitter default. The prepend
is session `SET`, not `SET LOCAL`, because `CONCURRENTLY` and `VACUUM` run
outside a transaction. Review the bound before apply; an unbounded external
script is still refused.

Classification is not enough. The SQL drizzle-kit emits also passes a
Postgres-safe-DDL lint, because drizzle-kit is an engine and will happily write
SQL that is correct and still takes your service down: a bare `DROP` or
`RENAME`, a blocking `SET NOT NULL`, an index built without `CONCURRENTLY`, a
missing `lock_timeout`.

**Blocked:** a table-rewriting `ADD COLUMN … DEFAULT <volatile>` or
`… GENERATED ALWAYS AS (…) STORED`, a blocking `SET NOT NULL` or in-place
`ALTER COLUMN … TYPE`, a non-`CONCURRENTLY` index build **or drop**, an
unvalidated `CHECK`/`FOREIGN KEY`/`EXCLUDE`, a `UNIQUE`/`PRIMARY KEY` constraint
add, a missing `lock_timeout`.

**Read per clause.** An `ALTER TABLE` is read one action at a time, so a
`UNIQUE`/`PRIMARY KEY` add is caught whether it stands alone, sits beside an
`ADD COLUMN` (`ADD COLUMN email text, ADD CONSTRAINT email_uk UNIQUE (email)`),
or rides the column itself (`ADD COLUMN id uuid PRIMARY KEY`). All three build a
unique index on a live table under `ACCESS EXCLUSIVE`. One clause adopting a
finished index does not exempt a sibling that builds one.

**Offered instead:** add-nullable then backfill then validate; `NOT VALID`
followed by `VALIDATE`; `CREATE INDEX CONCURRENTLY` / `DROP INDEX CONCURRENTLY`.

`UNIQUE` and `PRIMARY KEY` get their own advice, because Postgres has no
`NOT VALID` for either: build the index out of the way with
`CREATE UNIQUE INDEX CONCURRENTLY`, then adopt it with
`ALTER TABLE … ADD CONSTRAINT … USING INDEX`, which takes the finished index
without a second full scan.

This is deploy-target independent. A lock held during a table rewrite stalls
live traffic under every deployment strategy, so the lint runs on every
`generate` — it is the pattern set above, not a general Postgres-safety
analysis.

### Checking a script you wrote by hand {#safe-ddl-mode}

A `DELETE` is targeted only when its own clause has `WHERE`: a predicate inside
a `USING` or `RETURNING` subquery does not qualify the outer delete. Comments
before a `DO`, including nested block comments, do not hide its body: the same
comment-aware procedural test controls both expansion and the
unclassifiable-script refusal.

The same lint runs on a standalone `.sql` file, with no app and no database:

```
hazelnut migrate --safe-ddl ./one-off.sql
hazelnut migrate --safe-ddl -            # read the script from stdin
```

Exit 0 means the script is clean; exit 1 names each violated rule. `generate`
reports the same findings but exits 2 on a destructive one, because there it has
a migration to refuse; here there is nothing to author, so a lint names what it
found and you decide. Add `--immutable <table>` to protect a table of your own
alongside `_audit`, and `--dir <name>` to include a migration directory in the
history-linearity check. Both repeat.

Use it for the scripts drizzle-kit never sees — a hand-written backfill, a
one-off index build — so they meet the same bar as a generated migration: this
mode, `generate` and `audit` share the same readers, with one deliberate
exception below.

The exception. `audit` honours both `-- hazelnut:` consent lines —
`allow-destructive` and `allow-unsafe-ddl` — and this mode honours neither: it
has no confirming flag of its own, and a lint's job is to name what it read and
leave the decision to you. So a committed migration you authorised on purpose
comes back clean from `audit` and still reports its finding here. That is the
intended split, not a disagreement: use `audit` to ask whether the committed
history is acceptable, and this mode to ask what a script does.

### Auditing what is already committed {#history-audit}

`generate` guards what it **authors**. It cannot help the tree that already has
the script — one written before a clause existed, or hand-edited afterwards.
`drift` will not catch it either: that asks whether the migration matches your
declarations, and an unsafe migration can match them perfectly.

```sh
hazelnut migrate ./app.ts audit            # advisory — reports, exits 0
hazelnut migrate ./app.ts audit --strict   # a finding is an error (exit 1)
```

Advisory is the default because those statements have **already run** wherever
they were applied; refusing them now reports a risk that is spent. What is not
spent is the replay: `drizzle/` is what a fresh environment, a restore, or a new
developer's database executes, so an unsafe committed script is a lock waiting
to be taken again. That is what the finding is about.

Use `--strict` when you want the history held to today's rules — worth doing
right after you fix a finding, so it cannot come back.

`apply` runs the same strict audit over pending committed migrations before it
executes any of them. A rejected pending script leaves both its SQL and the
migration ledger untouched; already-recorded migrations are not re-blocked.

`audit` is read-only: it never authors, unwrites, or records consent.

At **`generate`**, a blocked script is **unwritten**, for the same reason a
destructive one is: left on disk, the next bare `generate` diffs against the
advanced snapshot, reports no schema changes, exits 0, and `drift` then calls
the tree current — with the unsafe SQL still committed. Re-running the same
command repeats the refusal.

When the lock is one you have decided to take — a maintenance window, a table
you know is small — `--allow-unsafe-ddl` authors the script as-is and succeeds:

```text
✓ migrate generate: derived 1 resource(s) across 1 schema(s) — UNSAFE change
  authored (--allow-unsafe-ddl)
✗ migrate: 1 build-error-level migration violation(s)
✗ migrate/safe-ddl (1)
  - ADD COLUMN … NOT NULL with no DEFAULT fails or rewrites a populated table
  apply it in a window where a stalled write is acceptable.
```

The `✗` banners print on the GREEN authoring on purpose — the authorised finding
travels with the success, so you see what you consented to. A CI step that greps
for `✗` misreads this run as a failure: the exit code is the verdict, and it is
0 here.

The index case does not reach this: an index the framework itself derives on a
table that already exists is written as `CREATE INDEX CONCURRENTLY`, so the
script the emitter authors is one the lint accepts.

## Data migrations {#data-migration} {#expand-contract}

A `.data.ts` file carries the value transform DDL cannot express:

<!-- @conformance:skip reason=fragment form=local-context context=date -->

```ts
// migrations/<dir>/member_birthdate.data.ts
type MemberBirthdateIntermediate = {
  birthYear: number;
  birthMonth: number | null;
  birthDate: string | null;
};
type BirthdateWrite = { birthDate: string };

export default dataMigration({
  forward: (row: MemberBirthdateIntermediate): BirthdateWrite => ({
    birthDate: date(row.birthYear, row.birthMonth ?? 1, 1),
  }),
  reversible: false,
});
```

You write `forward`, explicitly annotate its input as the intermediate state
(old and new columns coexisting) and its result, and declare whether it is
`reversible`. These are author-supplied TypeScript annotations, not types
derived or verified by Hazelnut from migration history or the database schema.
`deno check` checks the transform against your annotations; it cannot prove the
annotations match the actual intermediate schema. There is no generated type
companion, and the callback is deliberately not contextually typed as a schema
row if its input annotation is omitted.

**Expand-contract ordering is not automated.** A transform is detected, an
unsafe one-shot is refused, a stub is emitted, and you sequence the expand, the
data step and the contract by hand.

The migration history check reads the actual per-directory file listings. A
`.data.ts` without a same-ordinal `migration.sql` or `snapshot.json` is refused
by `generate`, `rename`, `status`, `rebase`, and `apply` preflight; naming a
linear directory chain alone cannot silence that check. This guards placement,
not execution: Hazelnut does not run the transform for you.

Grant read access to the selected history directory and every child directory,
including directories without an ordinal prefix. If listing them fails,
`generate`, `rename`, `status`, `rebase`, and `rebase --execute` return exit 2
with a history-read remedy, not a stack trace or a clean verdict. If `generate`
or `rename` already wrote a new migration before this refusal, only that new
directory is removed. A failed removal is reported as `COULD NOT remove`: remove
the named new directory before retrying, or its snapshot can hide the refused
change. Existing history is left intact. Missing paths and SQL-only authored
history retain their existing behavior.

**What a rebase does not re-check.** After a rebase re-homes a `.data.ts`, its
_semantic_ correctness is not re-verified — only that it still type-checks and
that its applied state is intact. Review and update the hand-written
intermediate-state annotation against the rebased DDL and resource declaration.
`deno check` will not detect a stale annotation or a column whose type stayed
the same while its _meaning_ changed.

## Concurrent sessions and forked history {#history-linearization}

`drizzle/` is the only committed artifact that is **history** rather than a pure
function of your declarations. Two branches each run `generate`, each mint the
next migration, each rewrite the chain — and the merge goes wrong two ways:

| Merge outcome        | Why it hurts                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| a text conflict      | you must hand-edit files you must not hand-edit                                                     |
| a _clean_ auto-merge | worse — the baseline now matches neither branch, and the next `generate` emits wrong DDL against it |

**Re-derive, never text-merge:**

```sh
git checkout <parent-tip> -- drizzle/   # drop the local UNAPPLIED migration
git merge <other-branch>                # merge the DECLARATIONS first
hazelnut migrate ./app.ts generate      # re-derive ONE migration
```

Merging declarations first puts the conflict in the source of truth, where you
want it. Already-applied history cannot be re-derived — the database records
which, by content hash, never by timestamp.

Fork detection is the framework's own: it walks each snapshot's parent links and
flags any node with two children. drizzle-kit's own check passes those.

### `hazelnut migrate rebase`

Offline by default. It reads the committed chain, detects a fork, and prints the
recipe; you run it.

`--execute` does it for you, and needs `DATABASE_URL`. Per divergent migration
it decides:

- **unapplied** → dissolve: drop the directory, re-home any `.data.ts` `forward`
  body verbatim, and re-derive one migration against the merged declarations.
- **applied** → refuse and route: applied history is never rewritten. You get a
  new forward migration instead.

If a divergent migration has an authored `.data.ts` body but the staged
re-derive creates no DDL migration, `--execute` refuses before touching the live
fork. Resolve the body explicitly or make the corresponding schema change before
retrying; a body is never dropped just because the merged declarations need no
new DDL.

If divergent forks contain `.data.ts` bodies with the same basename, `--execute`
also refuses before touching the live fork: both bodies would target the same
file in the re-derived migration, so choosing either one would lose authored
code. Merge or rename the bodies explicitly, then retry.

The generated destination is checked too. If the target already contains one of
the body filenames outside the forks being dissolved, `--execute` refuses
instead of overwriting a stale or orphaned authored body. Inspect and resolve
that destination explicitly before retrying.

On every executed rebase, the `migrations/` root and each existing divergent
source directory must be real directories. A symlinked source directory is
refused before the engine reads its contents or drops the fork. Authored
`.data.ts` bodies must be regular files; links and other non-file entries with
that suffix are refused rather than followed or silently discarded. A generated
destination must also be a real directory with no colliding body path. These
checks keep rebase from reading or writing authored code through links; replace
the link with a real migration directory/file before retrying.

Because `--execute` mutates committed history based on a live read of applied
state, the whole read-decide-drop-re-derive sequence holds the migrate advisory
lock. A concurrent `apply` fails loudly on contention rather than flipping a
migration from unapplied to applied inside that window.

Applied state comes from `__drizzle_migrations`, not from guessing which SQL
produced the live schema. When the ledger records a directory, changing that
directory's SQL refuses the rebase; restore the recorded bytes before retrying.
Older ledger rows without a directory binding are matched by SQL hash only.
After manual schema changes or a failed migration outside a transaction,
reconcile the live database and migration history before executing a rebase. An
absent ledger entry does not prove that a failed migration left no effects.

Re-deriving is not a safety bypass: the new migration runs the danger
classification and the safe-DDL lint again, from scratch.

### `hazelnut migrate status`

Orientation only — committed history count, fork, and live-schema drift. It does
not list applied vs pending files (`__drizzle_migrations` is what `apply` and
`rebase --execute` read). Two orientation signals:

- **Fork** —
  `local chain forked from origin/main — run hazelnut migrate rebase`.
- **Development-database drift** — `status` introspects the live database shape
  and compares it with what your declarations derive. Drift prints the specific
  difference and a fix, such as
  `column <x> is in the DB, not in the declarations — run hazelnut migrate <app>
  reset`.
  On a prod-equivalent target (a named `--env`, or an ambient `DATABASE_URL`
  with no `.env` file) the fix reads
  `generate a forward migration (reset is dev-only)` instead.

The drift check is a whole-schema introspect-and-diff and is slow, so it lives
in `status` and in a CI run that connects to a database — never in an inner-loop
check. Offline — no `DATABASE_URL` — `status` exits 2
(`migrate: DATABASE_URL is
not set`). It does not skip-with-a-note. The
files-only staleness gate is `migrate drift`, which needs no database.

### `hazelnut migrate drift` {#drift}

`status` and `check` ask whether your **database** carries the columns,
sidecars, temporal EXCLUDE, and declared unique indexes (including a
`deleted_at IS NULL` partial when softDelete/rectifiable require it) your
declarations derive. They are not a full fingerprint of every index shape — that
is `migrate drift` against the committed migration artifact. `drift` asks
whether the **committed migration** matches the declarations — the artifact you
deploy from, which nothing else looks at.

```sh
hazelnut migrate ./app.ts drift
```

It re-derives the schema from your declarations and diffs it against the newest
`drizzle/<TS>_<name>/snapshot.json`. No database, no drizzle-kit, no network, so
it belongs in your default lane — `deno task ci` runs it for you.

The newest snapshot is the last directory name in sort order. drizzle-kit stamps
directories `YYYYMMDDHHMMSS_<name>`. Two writes in the same wall-clock second
would share that 14-digit prefix, and a later `rename` would sort before an
earlier `generate`. After drizzle-kit returns, the shell restamps the newer
directory until the prefix is unique. You will see consecutive stamps, one
second apart, even when both commands finished in the same second.

You will see one of three things:

- `✓ migrate drift: drizzle/<dir> vs the declarations … — the committed
  migration matches`
  — exit 0. The gate fingerprints columns, nullability, defaults, primary keys,
  stored generated expressions and identity generation modes, and indexes. It
  also compares declared foreign-key, CHECK, and EXCLUDE constraints — including
  a foreign key's `ON DELETE` action — against the materialized migration SQL,
  because snapshots do not reliably retain every constraint. Adding an enum
  value can still print match.
- `✗ … the committed migration is STALE`, then a line per difference —
  `declared, absent from the migration: public.invoice.currency` — and exit 1.
  An empty or truncated `migration.sql` whose `snapshot.json` still names
  columns is stale too (`snapshot column absent from migration.sql`). A
  `snapshot.json` that lists an index the SQL never `CREATE INDEX`es is stale
  the same way (`snapshot index absent from migration.sql`).
  `CREATE INDEX CONCURRENTLY` — the form `generate` writes on a table that
  already exists — is that CREATE INDEX. In a generated scaffold, run
  `deno task migrate generate`; if you installed `hazelnut` on `PATH`, you can
  instead run `hazelnut migrate <app> generate`. Commit the new
  `drizzle/<TS>_<name>/` directory.
- `✗ … the app declares N resource(s) and drizzle/ holds no committed migration`
  — exit 1. Production reads its schema from `drizzle/` alone, so that state
  deploys an empty database, and the dev substrate hides it: `main.ts` derives
  the schema at boot for the embedded PGlite. `hazelnut new` authors the first
  migration for you, so a fresh project is not born failing — you reach this
  only by deleting `drizzle/` or by declaring a resource in a tree that never
  had one. In a generated scaffold, repair it with
  `deno task migrate
  generate`; if you installed `hazelnut` on `PATH`,
  `hazelnut migrate <app>
  generate` is also available. An app declaring no
  resource at all still exits 0.

Add a field to a resource whose table is already in the committed migration,
skip `generate`, and every other gate stays green: your tests run against a
schema derived at boot, and the migration that builds production never learns
about the column. This is the gate that catches that.

**Read the third line as the fail it is.** It is exit 1, not a pass: production
reads its schema from `drizzle/` alone, so that state deploys an empty database.
Nothing else fills the gap: the structural check never reads `drizzle/`,
`doctor` has no migration check, and dev runs on a schema applied straight from
the declarations. `hazelnut new` authors the first migration so a fresh project
is not born failing — you reach this only by deleting `drizzle/` or by declaring
a resource in a tree that never had one. Run `generate` and commit the chain as
soon as you declare your first resource.

## What `preview` prints {#preview}

`preview` is the plan you read before you type `apply`. It reads the selected
migration history, its live ledger and the database catalog, and changes
nothing. Use the same app, environment and `--out` on both commands.

```
migrate preview (dry-run, non-mutating): 1 resource(s) across 1 schema(s)
  · execution source: committed history — 1 pending file(s) of 1 in drizzle/
    > 20261004020000_retire_legacy — per-file transaction
      -- hazelnut: allow-destructive
      SET lock_timeout = '2s';
      ALTER TABLE "public"."post" DROP COLUMN "legacy";
    · replay also maintains the migration ledger; staged temporal validations run after their file commits
  · 1 UNDECLARED live column(s) — drop candidates, NOT statements the next apply necessarily runs:
    - post.legacy
  · review the selected SQL above, including row-changing statements; row counts and data-volume estimates are not reported
  · preview executes no migration SQL and grants no consent; apply re-reads under its advisory lock and runs its safety preflight
```

With a committed history, the execution section shows unrecorded SQL in file
order, including statements that change rows or objects outside the declared
resources. Identical SQL bytes are replayed only once, just as apply's ledger
deduplicates them. A recorded file is not replayed; an unfinished temporal
validation is shown as a separate retry. `OUTSIDE a transaction` identifies the
non-atomic carve-outs. Review the SQL, not merely the column-drift list: a drop
or row-removal statement can irreversibly discard data.

Without authored history, apply uses its convergent development push. Preview
prints that materializer's actual statements, including framework-table
maintenance. Resource tables use `CREATE TABLE IF NOT EXISTS`: an existing
resource table does not gain missing columns or lose undeclared columns from
that statement. Generate and review a forward migration for such changes;
preview does not turn a live/declaration difference into executable SQL.

The following orientation lists partition declaration drift into absent declared
columns and undeclared live columns. They are **not** another apply plan. A
clean drift list does not mean the history has no pending SQL, and an undeclared
live column is not automatically dropped.

Two more lists appear when they apply: declared tables, projection columns and
constraints the live database does not have yet, and columns a live API version
still keeps alive. A sunset date does not release that hold — remove the
version's declaration once its clients have migrated off, then contract.

Finding a destructive statement does not change the exit code — `preview` is
orientation, not approval or a gate. An unreadable history, ledger or catalog
returns exit 2. Apply re-reads under its advisory lock; preview does not reserve
the plan or prevent intervening edits. Grant read access to the selected history
directory and its SQL/snapshot files: a permission or I/O failure is not an
empty history and refuses replay too. A missing directory still selects the
development push; a hand-authored SQL file need not have a snapshot. The
destructive-change refusal lives in `generate`, which blocks a dangerous change
before any SQL is committed, and the offline CI gate is `drift`. `check` is the
live-schema twin — it needs `DATABASE_URL`, so it belongs in a CI job that has
the database, not in `deno task ci`.

## Applying to production {#prod-guard}

```sh
hazelnut migrate ./app.ts apply                       # loads .env
hazelnut migrate ./app.ts apply --env production      # loads .env.production
```

The `--env` file supplies the `DATABASE_URL`. Migration files are
environment-independent.

**The framework does not detect production and mints no sign-off token.** A
prod-equivalent target is a named `--env`, or an ambient `DATABASE_URL` with no
`.env` file — not host detection.

| Layer            | What it is                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The boundary** | `.env.production` is gitignored and held by operators or CI secrets. A machine without it cannot reach production — unreachable, not policy-blocked.           |
| A seatbelt       | a prod-equivalent target prompts `Target: <name or "an ambient DATABASE_URL"> — apply? [y/N]` (`--yes` only in a protected CI job after credential separation) |
| In CI            | a protected job supplies the connection; approval is your CI platform's                                                                                        |

**`reset` is refused outright** on any prod-equivalent target. Production
recovery is roll-forward only.

`drizzle push` stays disallowed everywhere — it bypasses the safe-DDL lint, the
preview, and the audit trail.

**RLS is not production protection.** It governs row visibility for DML only:
`DROP` is governed by ownership and `TRUNCATE` bypasses RLS entirely.

## Concurrency {#concurrency-safety}

The migration ledger's content fingerprint is FNV-1a, 32-bit, written as eight
hexadecimal characters. Use it for replay/change checks, not as a cryptographic
signature or proof of who approved a migration. Keep migration files and their
review history in trusted version control; hash equality is not authorization.

| Mechanism                                                                      | Strength                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| One transaction per migration, ending in a ledger row keyed UNIQUE on its hash | **The guarantee.** The file's statements and its ledger row commit together or roll back together, so two agents racing one migration leave the loser with nothing half-applied, lock or no lock. A migration whose hash is already recorded is skipped, not re-run. The exception is a file Postgres refuses to run inside a transaction — `CONCURRENTLY` or `VACUUM` — plus the conservative `ALTER TYPE … ADD VALUE` carve-out. PostgreSQL 16 permits enum addition in a transaction, but the new value cannot be used until commit; Hazelnut keeps a hand-written file that adds and immediately uses it compatible by running that file outside the transaction. Any such file can half-apply, and `apply` names the directories it ran that way. |
| A session-scoped Postgres advisory lock                                        | Coordination, between the migrators that take it. `apply`, `reset`, and `rebase --execute` try for it without blocking and fail loudly when another migrator holds it. The migrator keeps the lock-owning connection for its whole run, including when it opens a transaction, so a one-connection Postgres pool still supports atomic migrations. Nothing has to reclaim the lock: it dies with the connection that took it.                                                                                                                                                                                                                                                                                                                          |

The programmatic `applyMigrations` entry also requires an explicit transaction
capability before it creates the ledger or executes a pending ordinary
migration. Passing a plain `Db` is supported only when every pending file is a
declared non-transactional carve-out; those files are reported as `nonAtomic`.
It never assumes that a driver's multi-statement `exec` happens to be atomic.

If a migration outside a transaction fails, `apply` names the directory and
preserves the database error. It does not automatically undo or resume
individual statements: retrying starts that unrecorded file from its first
statement. Inspect every statement's effects before retrying. A failed
concurrent index build can leave an invalid index; check its definition and
`pg_index.indisvalid` before choosing a repair. Do not add `IF NOT EXISTS` just
to hide the error: an existing invalid index is not a successful build. `apply`
checks every `CREATE INDEX CONCURRENTLY` result before it records the migration,
so a retry that finds an invalid same-named index remains refused. Reconcile
partial effects with the intended migration before retrying, and keep
successfully applied migration files unchanged. The same inspection applies when
a file containing `VACUUM` fails after other statements have already committed.

`generate` touches no database, so it takes no advisory lock — and it is the
real history corruptor, since it writes the committed chain offline. The fork
gate is what protects it.

A cooperative lock binds only the migrators that take it, so it is coordination
rather than prevention. What holds: corruption within one tree is tamper-evident
and caught before any gated apply.

## Schema per module

`generate` lays this out automatically from your module structure. A schema is
created per module, each table lands in the right one, foreign keys inside a
module are real, and cross-module references are always by identifier — so there
are no cross-schema foreign keys. A resource outside any module stays in
`public`. You never specify any of it by hand.

## The framework's own tables {#framework-tables}

The runtime needs these internal `_`-prefixed tables. `migrate` creates and
maintains them; you do not author their DDL by hand.

| Table            | What it holds                                                                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_outbox`        | the transactional outbox — events and enqueued work; a retrying row keeps `last_error` / `last_error_kind` so you can diagnose before it reaches `_outbox_dead` |
| `_outbox_dead`   | the dead-letter queue, after repeated delivery failure                                                                                                          |
| `_processed`     | per-consumer de-duplication fence (no concurrent double-run); external effects stay at-least-once                                                               |
| `_outbox_retry`  | per-consumer retry counts and latest failure details, so one subscriber's error cannot overwrite its sibling's diagnostic                                       |
| `_push_revision` | the latest change token per topic and scope — topic invalidation over SSE                                                                                       |
| `_rate_limit`    | the per-actor rate-limit counter, shared across instances                                                                                                       |
| `_idempotency`   | an operation's idempotency key mapped to its result, with a TTL                                                                                                 |
| `_audit`         | the audit trail — who, which operation, what changed                                                                                                            |
| `_seq_counters`  | the gap-free allocation counter behind `sequence`                                                                                                               |
| `_ops_control`   | the operator levers you pull without a deploy — see `hazelnut ops`                                                                                              |

These are the always-on framework tables. Declaring `tasks`, `workflows`,
`password()`, or a scheduler also mints `_tasks` / `_task_progress`,
`_workflow_identity` / `_workflow_journal`, `_password_refresh`,
`_schedule_quota` (and siblings) when that feature is on.

For the jobs, feature gates and deletion ages, read **Background retention** in
[`hazelnut launch`](./launch.md). Framework tables do not share one TTL; live
outbox work and referenced de-duplication fences are protected.

The translation sidecar and the tree closure table are **per-resource**: they
carry cascading deletes, they evolve with the resource declaration, and they
travel the ordinary application-migration path.

### How they evolve {#framework-table-evolution}

They are not a function of your declarations, but they **are** a function of
your declared feature set combined with the framework version you pinned — and
the framework knows both the deployed shape and the target shape at once. It
ships table definitions rather than SQL, so nothing extra is committed.

`generate` diffs the whole derived schema — your tables and the framework's
`_`-prefixed tables — against the committed baseline and emits **one** migration
into the same stream. drizzle-kit does not tag those tables or order their DDL
before yours. A second, separate chain is rejected: there is one migration
history, and de-duplication is by content hash.

It reuses the existing gates for free — the fork check, the baseline-freshness
check, and `rebase` all apply unchanged.

**The framework is held to its own rule.** A framework-emitted DDL that touches
`_audit` or any framework table must be additive. A destructive one is an
absolute build error with no override. A versioned framework index replacement
is accepted only when its exact generated transition builds every replacement
arbiter concurrently before it drops the named legacy index; a partial, renamed,
or broader drop remains a build error. This is a proof-bearing transition, not
an operator override.

**Reading data written by an older version.** A cached `_idempotency` result
replays as stored — a vN blob into vN+1 code. The table is TTL-bounded (a
nightly sweep of claims created more than seven days ago, only after a result is
stored or the last heartbeat is more than one day old), not reshape-on-read. An
active in-flight claim is not reaped for creation age alone. `_audit` is the
exception — its rows are read exactly as written and never reshaped. In-flight
`_outbox` rows evolve additively. Rows carry a revision stamp, and a read walks
the registered upgrade chain to the pinned revision; a gap routes that row to
its own backoff, where it is observable — never read as if it were current, and
never aborting the drain.

## `hazelnut migrate reset` {#reset}

`reset` re-syncs a **development** database to your declarations after an
abandoned session. Git rewinds your declarations; it does not rewind Postgres.
That gap is the whole reason this verb exists.

It re-derives from the _current_ declarations. It does not replay migration
history, and it owns no seeding step — seeding is your application's business.

1. **Target guard.** A prod-equivalent target (a named `--env`, or an ambient
   `DATABASE_URL` with no `.env` file) is a flat refusal, with no override, and
   it prints:
   `prod recovery is a forward migration (hazelnut migrate apply), never reset`.
2. **Derive** the whole schema from the current declarations — your module
   schemas, the framework tables, and the per-resource sidecars. If the model
   does not assemble, fail loudly. It materializes a coherent schema or does
   nothing; there is no half-push.
3. **Drop**, partitioned, preserving the audit trail. Current module schemas are
   treated as Hazelnut-owned and dropped CASCADE; do not place manual or
   unrelated objects in them. The current app's declared public resources and
   each non-audit framework table are dropped — including the feature-gated
   ones, dropped unconditionally so a re-sync never orphans a stale feature's
   state — along with the migration ledger. **`_audit` is preserved.**
   Destructive DDL against `_audit` is an absolute build error the framework
   does not exempt itself from, so `reset` does not drop it either. Clearing a
   genuinely corrupt development audit trail is a named, loud opt-out:
   `hazelnut migrate <app> reset --include-audit`, through the same production
   refusal, never the default.
4. **Push** the re-derived schema. No replay, no seed. `reset` is a
   current-declaration recovery tool, not a database wipe: it does not promise
   an empty database. Removed public resources and module schemas no longer
   present in the current app are not discoverable from today's declarations;
   unrelated public objects are retained. `migrate check` does not treat these
   extra objects as drift. Inspect and perform manual cleanup only after
   confirming ownership; do not assume reset removed stale or unmodeled data.
5. **Sweep** the selected app's regenerable `.hazelnut/` working directory
   (metadata, verify cache, and per-run scratch; never an unrelated caller-cwd
   directory). `reset`, `apply`, and `rebase --execute` take the same migrate
   advisory lock: reset replaces the schema and migration ledger that apply
   mutates, so either one refuses while the other is running.

Every listed drop is conditional, the derive is pure, and the push is convergent
— so `reset` is idempotent and safe to re-enter after a crash midway.

**Getting back to a known-good state is two steps.** First `git checkout` or
`git revert` the tracked files — that is git's job, not a framework verb. Then
`hazelnut migrate <app> reset` to re-sync the one surface git cannot touch.
There is deliberately no revert verb and no down-migration: development data is
throwaway, and a down-migration would duplicate git while adding a way to be
wrong.

## Development vs production

|                 | Mechanism                                        | Blast radius                                             |
| --------------- | ------------------------------------------------ | -------------------------------------------------------- |
| **Development** | direct push, plus `reset` for recovery           | that database only — a prod-equivalent target is refused |
| **Production**  | `generate` → `preview` → your sign-off → `apply` | the full with-data protection                            |

A dangerous migration with data in the table is always something you did on
purpose. It is never triggered by saving a file, and it cannot be run silently.

## The drizzle-kit pin

drizzle-kit is pinned to an **exact version**, never a range. Two things depend
on that: the parent-link structure the fork detection reads, and
reproducibility.

The pin is held down by a snapshot-format assertion that trips if the format
moves under you, and by the fact that the framework's own guards do not delegate
to upstream behaviour. Two upstream defects are closed here rather than waited
on: an index-numbering bug that the pinned layout makes structurally impossible,
and an apply-watermark bug that silently skipped pending migrations — closed by
checking each migration by hash and enforcing that at the database with a unique
constraint.

`apply` replays each committed `drizzle/*/migration.sql` through
`applyMigrations` (hash ledger in `__drizzle_migrations`). When `drizzle/` is
missing or holds no committed migration, it pushes the derived schema instead —
that is not `drizzle push`; the env guard and post-apply live-schema match still
run. drizzle-kit's programmatic migrator silently does nothing against this
layout, which is why apply does not call it to replay SQL.

Temporal validity-window checks on existing tables use a lock-conscious,
resumable two-step: `ADD CONSTRAINT ... NOT VALID` commits with that migration's
ledger entry, then `VALIDATE CONSTRAINT` runs in a separate transaction before
the next migration. If old rows fail validation, the check remains enforced for
new writes but unvalidated; repair those rows and rerun `apply`. It retries the
recorded check before advancing, including after a process stops between commit
and validation. A pending migration that stages this check requires a
transaction-capable database adapter and refuses before running its SQL without
one.

