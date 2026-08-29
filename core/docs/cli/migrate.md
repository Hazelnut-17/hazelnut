# `hazelnut migrate`

> **Reference** — for whoever changes the schema. Every subcommand, what it
> refuses, and what it does to your database.

`hazelnut migrate` is a **thin safety shell over drizzle-kit**, not an engine of
its own. drizzle-kit does the diffing and writes the DDL. The shell makes it act
on your declarations and stay safe to run unattended.

## Interface

```
hazelnut migrate <app> generate   # diff declarations → emit SQL; flag dangerous changes; stub a data migration if needed
hazelnut migrate <app> preview    # dry run: the pending schema changes, additive and irreversible listed apart
hazelnut migrate <app> apply      # run the pending migrations
hazelnut migrate <app> status     # applied vs pending, plus fork and dev-drift orientation
hazelnut migrate <app> check      # read-only drift gate for CI: exit 0 clean, exit 1 on drift
hazelnut migrate <app> drift      # offline gate: is the committed migration stale? exit 0 clean, exit 1 stale
hazelnut migrate <app> rebase     # detect a forked history and print the fix
hazelnut migrate <app> reset      # re-sync a development database to the declarations
```

`generate`, `drift` and `rebase` are **offline** — they read the committed
migration history and your declarations, never the database. Everything else
needs `DATABASE_URL`, as does `rebase --execute`.

| Exit | Meaning                                                                                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | success, or `check`/`drift` finding nothing                                                                                                             |
| 1    | drift (`check`, `drift`); an unsafe-DDL block (`--allow-unsafe-ddl` authors it); an ambiguous rename (a `.data.ts` shell is scaffolded); a failed apply |
| 2    | a destructive block (`--allow-destructive` authors it); drizzle-kit could not run or answer its own prompt; the prod-env guard                          |

A CI step that branches on exit code must treat both `1` and `2` as "did not
proceed" — the split is which flag, if any, would have let it through.

## What the shell adds

|               | drizzle-kit alone             | with the shell                         |
| ------------- | ----------------------------- | -------------------------------------- |
| Schema source | you hand-write drizzle tables | derived from your Zod declarations     |
| A rename      | an interactive prompt         | classified, or blocked — never guessed |
| Column values | DDL only                      | a `.data.ts` transform                 |
| Applying      | immediate                     | env guard + preview + confirmation     |

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

## Dangerous-change detection {#safety}

The shell replaces drizzle-kit's interactive rename prompt and its silent
add-plus-drop with a classification that needs no human at the keyboard:

| Diff shape                                                | Verdict       | What happens                                                |
| --------------------------------------------------------- | ------------- | ----------------------------------------------------------- |
| add a nullable or defaulted column, a new table, an index | safe          | applied automatically                                       |
| a column disappears **and** one appears; a type changes   | **ambiguous** | blocked — the tool will not guess whether that was a rename |
| a column or table disappears; a type narrows              | destructive   | blocked until you confirm with `--allow-destructive`        |

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
  re-run with --allow-destructive to author it, or restore the declaration you removed.
```

Leaving the file on disk would be the bypass: the next bare `generate` would
diff against the new snapshot, report no schema changes, and exit 0 over the
same drop. So the confirm is the only way past it, and `migrate <app> drift`
stays red until you either give it or put the declaration back.

### Safe DDL {#safe-ddl}

Classification is not enough. The SQL drizzle-kit emits also passes a
Postgres-safe-DDL lint, because drizzle-kit is an engine and will happily write
SQL that is correct and still takes your service down: a bare `DROP` or
`RENAME`, a blocking `SET NOT NULL`, an index built without `CONCURRENTLY`, a
missing `lock_timeout`.

**Blocked:** a table-rewriting `ADD COLUMN … DEFAULT <volatile>`, a blocking
`SET NOT NULL` or narrowing type change, a non-`CONCURRENTLY` index, an
unvalidated constraint, a missing `lock_timeout`.

**Offered instead:** add-nullable then backfill then validate; `NOT VALID`
followed by `VALIDATE`; `CREATE INDEX CONCURRENTLY`.

This is deploy-target independent. A lock held during a table rewrite stalls
live traffic under every deployment strategy, so the lint runs on every
`generate` — it is the pattern set above, not a general Postgres-safety
analysis.

A blocked script is **unwritten**, for the same reason a destructive one is:
left on disk, the next bare `generate` diffs against the advanced snapshot,
reports no schema changes, exits 0, and `drift` then calls the tree current —
with the unsafe SQL still committed. Re-running the same command repeats the
refusal.

When the lock is one you have decided to take — a maintenance window, a table
you know is small — `--allow-unsafe-ddl` authors the script as-is and succeeds:

```text
✓ migrate generate: derived 1 resource(s) across 1 schema(s) — UNSAFE change
  authored (--allow-unsafe-ddl)
  - ADD COLUMN … NOT NULL with no DEFAULT fails or rewrites a populated table
  apply it in a window where a stalled write is acceptable.
```

The index case does not reach this: an index the framework itself derives on a
table that already exists is written as `CREATE INDEX CONCURRENTLY`, so the
script the emitter authors is one the lint accepts.

## Data migrations

A `.data.ts` file carries the value transform DDL cannot express:

<!-- @conformance:skip reason=comment placeholders as object values (invalid syntax) + non-facade date() -->

```ts
// migrations/<dir>/member_birthdate.data.ts
export default dataMigration({
  reads:  /* intermediate-state type: old + new coexisting */,   // framework-supplied
  writes: /* the new column */,
  forward: (row) => ({ birthDate: date(row.birthYear, row.birthMonth ?? 1, 1) }),
  reversible: false,
});
```

You write `forward` and you declare whether it is `reversible`. The framework
supplies the intermediate-state `reads` type — old and new columns coexisting —
so a transform written against a half-migrated schema is still compiler-checked.

**Expand-contract ordering is not automated.** A transform is detected, an
unsafe one-shot is refused, a stub is emitted, and you sequence the expand, the
data step and the contract by hand.

**What a rebase does not re-check.** After a rebase re-homes a `.data.ts`, its
_semantic_ correctness is not re-verified — only that it still type-checks and
that its applied state is intact. If a neighbouring column changed type, the
intermediate-state type no longer matches and `deno check` goes red, loudly. If
a column kept its type and changed its _meaning_, nothing here catches it.

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

Because `--execute` mutates committed history based on a live read of applied
state, the whole read-decide-drop-re-derive sequence holds the migrate advisory
lock. A concurrent `apply` fails loudly on contention rather than flipping a
migration from unapplied to applied inside that window.

Re-deriving is not a safety bypass: the new migration runs the danger
classification and the safe-DDL lint again, from scratch.

### `hazelnut migrate status`

Beyond applied and pending, two orientation signals:

- **Fork** —
  `local chain forked from origin/main — run hazelnut migrate rebase`.
- **Development-database drift** — `status` introspects the live database shape
  and compares it with what your declarations derive. Drift prints the specific
  difference and a fix, such as
  `column <x> is in the DB, not in the declarations — run hazelnut migrate <app>
  reset`.
  On a non-default `--env` the fix reads
  `generate a forward migration (reset is dev-only)` instead.

The drift check is a whole-schema introspect-and-diff and is slow, so it lives
in `status` and in a CI run that connects to a database — never in an inner-loop
check. Offline, it **skips with a note** rather than passing quietly: a
files-only green can coexist with real database drift, and your CI is free to
promote that skip to a failure.

### `hazelnut migrate drift` {#drift}

`status` and `check` ask whether your **database** matches your declarations.
`drift` asks whether the **committed migration** does — the artifact you deploy
from, which nothing else looks at.

```sh
hazelnut migrate ./app.ts drift
```

It re-derives the schema from your declarations and diffs it against the newest
`drizzle/<TS>_<name>/snapshot.json`. No database, no drizzle-kit, no network, so
it belongs in your default lane — `deno task ci` runs it for you.

You will see one of three things:

- `✓ migrate drift: drizzle/<dir> vs the declarations … — the committed
  migration matches`
  — exit 0.
- `✗ … the committed migration is STALE`, then a line per difference —
  `declared, absent from the migration: public.invoice.currency` — and exit 1.
  Run `hazelnut migrate <app> generate` and commit the new
  `drizzle/<TS>_<name>/` directory.
- `✗ … the app declares N resource(s) and drizzle/ holds no committed migration`
  — exit 1. Production reads its schema from `drizzle/` alone, so that state
  deploys an empty database, and the dev substrate hides it: `main.ts` derives
  the schema at boot for the embedded PGlite. `hazelnut new` authors the first
  migration for you, so a fresh project is not born failing — you reach this
  only by deleting `drizzle/` or by declaring a resource in a tree that never
  had one. An app declaring no resource at all still exits 0.

Add a field to a resource whose table is already in the committed migration,
skip `generate`, and every other gate stays green: your tests run against a
schema derived at boot, and the migration that builds production never learns
about the column. This is the gate that catches that.

**Read the third line as the warning it is.** It is what you get from the first
resource you add onward, until you run `generate` once — the declarations say
one thing, `drizzle/` says nothing at all, and `drift` compares against nothing
and passes. Nothing else fills the gap: the structural check never reads
`drizzle/`, `doctor` has no migration check, and dev runs on a schema applied
straight from the declarations, so the first place the absence shows up is the
deploy. Run `generate` and commit the chain as soon as you declare your first
resource, and this line stops appearing.

## What `preview` prints {#preview}

`preview` is the plan you read before you type `apply`. It reads the live
database and changes nothing.

```
migrate preview (dry-run, non-mutating): 1 resource(s) across 1 schema(s)
  · 1 ADDITIVE pending change(s) — the next apply adds these column(s):
    + post.body
  · 1 DESTRUCTIVE pending change(s) — IRREVERSIBLE: the next apply drops these column(s) and the data in them:
    - post.legacy
  · this plan is schema (DDL) only — row counts and data-volume estimates are not reported
```

The two lists are one diff split in two, so the irreversible half is never
folded into the additive count. **A column under the DESTRUCTIVE heading loses
its data, and no later migration brings it back** — that is the line to read
before you sign off. If you did not mean to drop it, put the field back in your
declarations rather than applying.

Two more lists appear when they apply: declared tables, projection columns and
constraints the live database does not have yet, and columns a live API version
still keeps alive. A sunset date does not release that hold — remove the
version's declaration once its clients have migrated off, then contract.

Finding a destructive change does not change the exit code — `preview` is
orientation, not a gate. The refusal lives in `generate`, which blocks a
dangerous change before any SQL is committed, and the CI gates are `check` and
`drift`.

## Applying to production {#prod-guard}

```sh
hazelnut migrate ./app.ts apply                       # loads .env
hazelnut migrate ./app.ts apply --env production      # loads .env.production
```

The `--env` file supplies the `DATABASE_URL`. Migration files are
environment-independent.

**The framework does not detect production and mints no sign-off token.**
"Production" is you naming `--env production` and holding the matching file.

| Layer            | What it is                                                                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The boundary** | `.env.production` is gitignored and held by operators or CI secrets. A machine without it cannot reach production — unreachable, not policy-blocked. |
| A seatbelt       | a non-default `--env` prompts `Target: production — apply? [y/N]` (`--yes` in CI)                                                                    |
| In CI            | a protected job supplies the connection; approval is your CI platform's                                                                              |

**`reset` is refused outright** on any non-default `--env`. Production recovery
is roll-forward only.

`drizzle push` stays disallowed everywhere — it bypasses the safe-DDL lint, the
preview, and the audit trail.

**RLS is not production protection.** It governs row visibility for DML only:
`DROP` is governed by ownership and `TRUNCATE` bypasses RLS entirely.

## Concurrency

| Mechanism                                                                 | Strength                                                                                                                           |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| A unique constraint on the migration's content hash, inside a transaction | **The guarantee.** Two agents applying the same migration fail atomically at the database, lock or no lock.                        |
| A Postgres advisory lock + a heartbeating lock file                       | Coordination. Reclaiming a stale lock needs proof the holder is dead **and** an expired heartbeat; it refuses when it cannot tell. |

`generate` touches no database, so it takes no advisory lock — and it is the
real history corruptor, since it writes the committed chain offline. The fork
gate is what protects it.

A best-effort lock is detection with latency, not prevention. What holds:
corruption within one tree is tamper-evident and caught before any gated apply.

## Schema per module

`generate` lays this out automatically from your module structure. A schema is
created per module, each table lands in the right one, foreign keys inside a
module are real, and cross-module references are always by identifier — so there
are no cross-schema foreign keys. A resource outside any module stays in
`public`. You never specify any of it by hand.

## The framework's own tables {#framework-tables}

The runtime needs nine internal `_`-prefixed tables. `migrate` creates and
maintains them; you neither write them nor touch them by hand.

| Table           | What it holds                                                                     |
| --------------- | --------------------------------------------------------------------------------- |
| `_outbox`       | the transactional outbox — events and enqueued work                               |
| `_outbox_dead`  | the dead-letter queue, after repeated delivery failure                            |
| `_processed`    | consumer de-duplication, so delivery is effectively-once                          |
| `_outbox_retry` | per-consumer retry counts, so one flaky subscriber cannot burn a sibling's budget |
| `_rate_limit`   | the per-actor rate-limit counter, shared across instances                         |
| `_idempotency`  | an operation's idempotency key mapped to its result, with a TTL                   |
| `_audit`        | the audit trail — who, which operation, what changed                              |
| `_seq_counters` | the gap-free allocation counter behind `sequence`                                 |
| `_ops_control`  | the operator levers you pull without a deploy — see `hazelnut ops`                |

Exactly those nine are framework tables. The translation sidecar and the tree
closure table are **per-resource**: they carry cascading deletes, they evolve
with the resource declaration, and they travel the ordinary
application-migration path.

### How they evolve {#framework-table-evolution}

The eight are not a function of your declarations, but they **are** a function
of your declared feature set combined with the framework version you pinned —
and the framework knows both the deployed shape and the target shape at once. It
ships table definitions rather than SQL, so nothing extra is committed.

`generate` diffs the target framework-table shape against the committed baseline
and emits **one** migration, into the same stream as your application
migrations, tagged as framework-owned and ordered **before** the application's
pending work, because the tables have to exist first. A second, separate chain
is rejected: there is one migration history, and de-duplication is by content
hash.

It reuses the existing gates for free — the fork check, the baseline-freshness
check, and `rebase` all apply unchanged.

**The framework is held to its own rule.** A framework-emitted DDL that touches
`_audit` or any append-only table must be additive. A destructive one is an
absolute build error with no override — a framework bug is never treated more
leniently than deliberate tampering.

**Reading data written by an older version.** A cached `_idempotency` result
whose shape predates the current revision reads as a **miss**, so the operation
re-executes rather than replaying something stale; the cache is rebuildable and
TTL-bounded, so that is safe. `_audit` is the exception — its rows are read
exactly as written and never reshaped. In-flight `_outbox` rows evolve
additively. Rows carry a revision stamp, and a read walks the registered upgrade
chain to the pinned revision; a gap routes that row to its own backoff, where it
is observable — never read as if it were current, and never aborting the drain.

## `hazelnut migrate reset` {#reset}

`reset` re-syncs a **development** database to your declarations after an
abandoned session. Git rewinds your declarations; it does not rewind Postgres.
That gap is the whole reason this verb exists.

It re-derives from the _current_ declarations. It does not replay migration
history, and it owns no seeding step — seeding is your application's business.

1. **Target guard.** A non-default `--env` is a flat refusal, with no override,
   and it prints:
   `prod recovery is a forward migration (hazelnut migrate apply), never reset`.
2. **Lock.** Take the migrate advisory lock, non-blocking. Already held means a
   loud failure; a stale lock is refused rather than reclaimed optimistically.
3. **Derive** the whole schema from the current declarations — your module
   schemas, the framework tables, and the per-resource sidecars. If the model
   does not assemble, fail loudly. It materializes a coherent schema or does
   nothing; there is no half-push.
4. **Drop**, partitioned, preserving the audit trail. Each module schema goes,
   cascading, and so does every non-audit framework table — including the
   feature-gated ones, dropped unconditionally so a re-sync never orphans a
   stale feature's state — along with the migration ledger. **`_audit` is
   preserved.** Destructive DDL against `_audit` is an absolute build error the
   framework does not exempt itself from, so `reset` does not drop it either.
   Clearing a genuinely corrupt development audit trail is a named, loud
   opt-out: `hazelnut migrate <app> reset --include-audit`, through the same
   production refusal, never the default.
5. **Push** the re-derived schema. No replay, no seed. You get an empty, freshly
   pushed database by design.
6. **Sweep** the regenerable working directory, then release the lock.

Every drop is conditional and cascading, the derive is pure, and the push is
convergent — so `reset` is idempotent and safe to re-enter after a crash midway.

**Getting back to a known-good state is two steps.** First `git checkout` or
`git revert` the tracked files — that is git's job, not a framework verb. Then
`hazelnut migrate <app> reset` to re-sync the one surface git cannot touch.
There is deliberately no revert verb and no down-migration: development data is
throwaway, and a down-migration would duplicate git while adding a way to be
wrong.

## Development vs production

|                 | Mechanism                                        | Blast radius                                    |
| --------------- | ------------------------------------------------ | ----------------------------------------------- |
| **Development** | direct push, plus `reset` for recovery           | that database only — a named `--env` is refused |
| **Production**  | `generate` → `preview` → your sign-off → `apply` | the full with-data protection                   |

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

`apply` runs the drizzle-kit **CLI**, not the programmatic migrator, which
silently does nothing against this layout.

