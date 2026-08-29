// `hazelnut migrate` generate/preview/status verbs (cli/migrate.md) — drizzle-kit orchestration, dry-run
// drift preview, and history/drift status reporting.
import type { App } from "../core/app.ts";
import { explainError } from "./hazelnut-io.ts";
import type { Db } from "../data/db.ts";
import {
  ambiguousRenamePairs,
  classifyDangerousChange,
  historyLinear,
  immutableProtected,
  safeDdl,
  statements,
} from "../data/migrate-safety.ts";
import {
  checkBaseline,
  checkCommittedSnapshot,
  deriveSchemaSql,
  fieldLiveBlocked,
  isMigrationFresh,
  pendingChanges,
  readMigrationHistory,
  runDrizzleKitGenerate,
  structuralBaselineDrift,
} from "../data/migrate.ts";
import type { CliResult } from "./cli.ts";
import { cliMigrateSafe } from "./migrate-verbs-rebase.ts";
import {
  forkPointsInHistory,
  type MigrateGenerateResult,
  scaffoldDataMigration,
} from "./migrate-verbs-shared.ts";

/**
 * The emitted statements that DESTROY data, as the safety roster's OWN classifier decides: every identifier
 * the statement names is handed to `immutableProtected` as off-limits, so the answer comes from the one
 * destructive-DDL model the immutable and framework-table gates already share — never a second regex here.
 */
function destructiveStatements(sql: string): string[] {
  return statements(sql).filter((stmt) =>
    immutableProtected(stmt, {
      immutable: [...stmt.matchAll(/"([^"]*)"|([A-Za-z_][\w$]*)/g)].map((m) =>
        m[1] ?? m[2]!
      ),
    }).length > 0
  );
}

/**
 * Unwrite the migration drizzle-kit just wrote, when a refusal has to erase it (left on disk, a bare re-run
 * diffs against the advanced snapshot, reports no changes, and launders the block into exit 0). Returns the
 * clause to append to the "blocked" line: `""` when nothing was written, a "was removed" clause on success,
 * or a LOUD "COULD NOT remove" clause when the delete fails (Windows EBUSY / a read-only parent) — the
 * refused script is still there and the operator has to know. `remove` is injectable for the failure test.
 */
async function unwriteRefusedMigration(
  dir: string | null,
  remove: (path: string) => Promise<void>,
): Promise<string> {
  if (dir === null) return "";
  try {
    await remove(dir);
    return "; the migration drizzle-kit wrote was removed";
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      return "; the migration drizzle-kit wrote was removed";
    }
    return `; COULD NOT remove ${dir} — delete it by hand before re-running, or a bare re-run diffs against the new snapshot and launders the block into exit 0`;
  }
}

const defaultRemove = (path: string): Promise<void> =>
  Deno.remove(path, { recursive: true });

/**
 * `hazelnut migrate generate` (cli/migrate.md §who-writes-what): spawns the pinned drizzle-kit to diff the
 * declaration-derived schema and write the real migration.sql + snapshot.json; this orchestrator never writes
 * SQL itself. Runs the safe-ddl gate over the emitted bytes and blocks (exit 2) on a dangerous change, an
 * ambiguous rename, or an unconfirmed DESTRUCTIVE change — an ambiguous drop+add additionally scaffolds a
 * `.data.ts` transform shell.
 */
export async function cliMigrateGenerate(
  app: App,
  opts: {
    dirs?: ReadonlyArray<string>;
    immutable?: ReadonlyArray<string>;
    out?: string;
    offline?: boolean;
    drizzleKitPin?: string;
    /** `--allow-destructive`: the operator's explicit confirm that this migration may discard data. Absent,
     *  a destructive emit is refused AND unwritten — the confirm can only widen what generate will author. */
    allowDestructive?: boolean;
    /** `--allow-unsafe-ddl`: the operator's explicit confirm that this migration may stall traffic. Absent,
     *  an unsafe emit is refused AND unwritten — left on disk, a bare re-run diffs against the new snapshot,
     *  reports "no schema changes", and launders the block into a clean exit 0. */
    allowUnsafeDdl?: boolean;
    /** The unwrite used when a refusal erases the migration drizzle-kit wrote (default `Deno.remove`).
     *  Injectable so a test can drive the failure branch (Windows EBUSY / a read-only parent). */
    removeImpl?: (path: string) => Promise<void>;
  } = {},
): Promise<MigrateGenerateResult> {
  // Spawns the pinned drizzle-kit to author the real migration (when an `out` dir is given — the entrypoint
  // always supplies one); it diffs the declaration-derived schema and writes migration.sql + snapshot.
  let gen: Awaited<ReturnType<typeof runDrizzleKitGenerate>> | null = null;
  if (opts.out !== undefined) {
    try {
      gen = await runDrizzleKitGenerate(app, {
        out: opts.out,
        name: "generate",
        offline: opts.offline,
        drizzleKitPin: opts.drizzleKitPin,
      });
    } catch (e) {
      // a real subprocess failure is loud (never a silent partial) — the pinned engine could not run or errored.
      return {
        code: 2,
        stdout: `✗ migrate generate: drizzle-kit subprocess failed — ${
          explainError(e)
        }`,
      };
    }
    // A column rename makes drizzle-kit ask a TTY-only prompt it cannot answer non-interactively; surfaced loudly
    // (exit 2) rather than silently treated as "no schema changes" (which would drop the rename).
    if (gen && !gen.created && gen.renameBlocked) {
      return { code: 2, stdout: `✗ migrate generate: ${gen.reason}` };
    }
  }
  // The SQL the safe-ddl gate lints: the bytes drizzle-kit wrote when it created a migration, else the
  // declaration-derived bytes (the no-op / no-out case, same content drizzle-kit diffs against an empty baseline).
  const emittedSql = gen?.created
    ? gen.sql
    : deriveSchemaSql(app).join(";\n") + ";\n";
  // `newTableAware` is passed unconditionally, which is safe only because its exemptions key on the script's
  // own content: an index or constraint is exempt on a table THIS script creates, and the lock_timeout waiver
  // additionally needs every FK parent created here too — a script whose FK names a live parent forfeits it,
  // and `prependLockTimeout` is what the emitter writes to satisfy the gate rather than argue with it.
  // version/field-live (multi-version.md §9): fed to the safe-ddl gate so an emitted DROP of a column a
  // declared version still keeps alive is refused; the lock follows declaration, not the sunset calendar.
  const fieldLiveLocked = (app.versions ?? []).flatMap((ver) =>
    (ver.fields ?? []).map((f) => `${ver.resource}.${f}`)
  );
  const safe = cliMigrateSafe(emittedSql, {
    dirs: opts.dirs,
    immutable: opts.immutable,
    resource: "generate",
    newTableAware: true,
    fieldLiveLocked,
  });
  const artifact = gen?.created
    ? ` → drizzle-kit wrote drizzle/${gen.dir}/migration.sql + snapshot.json (snapshot version ${gen.snapshot.version}, prevIds ${
      JSON.stringify(gen.snapshot.prevIds)
    })`
    : gen && !gen.created
    ? ` → drizzle-kit reported no schema changes (${gen.reason})`
    : " (offline derive — no --out: pass the drizzle/ dir to spawn drizzle-kit)";
  const header =
    `migrate generate: derived ${app.model.length} resource(s) across ${app.schemas.length} schema(s)${artifact}`;
  // Ambiguous rename → scaffolds a `.data.ts` shell at the same ordinal dir as the DDL (cli/migrate.md
  // §data-migration): the framework never guesses rename-vs-drop+add; the shell's `forward` body is hand-written.
  const pairs = ambiguousRenamePairs(emittedSql);
  if (pairs.length > 0) {
    const dir = gen?.created
      ? gen.dir
      : (opts.dirs && opts.dirs.length > 0
        ? [...opts.dirs].sort().at(-1)!
        : "0000_data");
    const emit: Record<string, string> = {};
    for (const { table, dropped } of pairs) {
      Object.assign(
        emit,
        scaffoldDataMigration({ dir, table, columns: dropped }),
      );
    }
    const cols = pairs.flatMap((p) => p.dropped.map((c) => `${p.table}.${c}`))
      .sort();
    return {
      code: 1,
      emit,
      stdout: [
        `✗ ${header} — AMBIGUOUS rename blocked; scaffolded ${
          Object.keys(emit).length
        } .data.ts transform shell(s)`,
        ...classifyDangerousChange(emittedSql, "generate").map((vio) =>
          `  - ${vio.message}`
        ),
        `  scaffolded shell(s) for ${
          cols.join(", ")
        } under migrations/${dir}/ — hand-write each \`forward\` (born RED until you do)`,
      ].join("\n"),
    };
  }
  // The DESTRUCTIVE partition (cli/migrate.md §safety): a pure DROP is unambiguous — no rename to guess —
  // so the safe-ddl clauses, which lint HOW a change is applied, all pass it and printed a ✓ over an
  // irreversible one. The refusal UNWRITES what drizzle-kit just wrote: left on disk, a bare re-run diffs
  // against the new snapshot, reports "no schema changes", and launders the block into a clean exit 0.
  const destroys = destructiveStatements(emittedSql);
  const writtenDir = gen !== null && gen.created && opts.out !== undefined
    ? `${opts.out}/${gen.dir}`
    : null;
  if (destroys.length > 0 && !opts.allowDestructive) {
    const unwrote = await unwriteRefusedMigration(
      writtenDir,
      opts.removeImpl ?? defaultRemove,
    );
    return {
      code: 2,
      stdout: [
        `✗ migrate generate: derived ${app.model.length} resource(s) across ${app.schemas.length} schema(s)` +
        ` — DESTRUCTIVE change blocked${unwrote}`,
        ...destroys.map((s) => `  - ${s.trim().replace(/\s+/g, " ")}`),
        "  this discards the data in those column(s)/table(s) and cannot be undone by re-adding them.",
        "  re-run with --allow-destructive to author it, or restore the declaration you removed.",
      ].join("\n"),
    };
  }
  if (safe.code === 0) {
    return { code: 0, stdout: `✓ ${header} — safe-DDL gate clean` };
  }
  // A confirmed operator gets a SUCCESS: `--allow-destructive` widens what generate authors and exits 0,
  // and an explicit confirm that reports failure is the same contradiction this branch exists to remove.
  if (opts.allowUnsafeDdl) {
    return {
      code: 0,
      stdout: [
        `✓ ${header} — UNSAFE change authored (--allow-unsafe-ddl)`,
        safe.stdout,
        "  apply it in a window where a stalled write is acceptable.",
      ].join("\n"),
    };
  }
  // Otherwise block, and UNWRITE for the same reason the destructive partition does: left on disk, a bare
  // re-run diffs against the advanced snapshot, reports "no schema changes", and the refusal becomes a clean
  // exit 0 with the unsafe SQL still committed. Measured — the second run of the SAME command exited 0 and
  // `drift` then called the tree current.
  const unwroteUnsafe = await unwriteRefusedMigration(
    writtenDir,
    opts.removeImpl ?? defaultRemove,
  );
  return {
    code: safe.code,
    stdout: [
      `✗ ${header} — DANGEROUS change blocked${unwroteUnsafe}`,
      safe.stdout,
      "  apply the safe pattern above to your declaration, or re-run with --allow-unsafe-ddl to author it as-is.",
    ].join("\n"),
  };
}

/**
 * `hazelnut migrate drift` (cli/migrate.md §drift) — the committed-migration staleness gate: diffs the
 * declaration-derived schema against the newest committed `drizzle/<ts>/snapshot.json`. Offline and
 * database-free, so it belongs in an app's default `ci` lane; a field added to a `defineResource` without a
 * regenerated migration is exit 1. No committed migration yet is exit 0 — nothing on disk to be stale.
 */
export async function cliMigrateDrift(
  app: App,
  opts: { drizzleDir: string },
): Promise<CliResult> {
  const r = await checkCommittedSnapshot(app, opts.drizzleDir);
  if (r.state === "none") {
    // A gate whose subject is "your migrations do not match your declarations" cannot PASS when there are
    // no migrations to match. This verb rides the emitted `ci` chain, so exiting 0 here left the staleness
    // gate silent in the one state where the mismatch is total — and the dev substrate hides it, because
    // `main.ts` calls `applySchema` for the embedded PGlite while production takes its schema only from
    // `drizzle/`. Green `ci`, empty production database. An app that derives NO table still passes: there
    // is genuinely nothing to generate.
    // The DECLARED resources, not the fingerprint: every app derives the framework's own `_*` tables, so a
    // fingerprint count is never zero and would refuse an app that declares nothing.
    if (app.model.length === 0) {
      return {
        code: 0,
        stdout:
          `migrate drift: no committed migration in ${opts.drizzleDir}/, and the app declares no resource — nothing to generate yet`,
      };
    }
    return {
      code: 1,
      stdout: [
        `✗ migrate drift: the app declares ${app.model.length} resource(s) and ${opts.drizzleDir}/ holds no committed migration — production takes its schema from ${opts.drizzleDir}/ alone, so this deploys an EMPTY database. (The dev substrate hides it: main.ts calls applySchema for the embedded PGlite.)`,
        "  run hazelnut migrate <app> generate and commit the new drizzle/<ts>/ dir",
      ].join("\n"),
    };
  }
  if (r.state === "unreadable") {
    return {
      code: 2,
      stdout:
        `✗ migrate drift: ${opts.drizzleDir}/${r.dir}/snapshot.json is not readable JSON — ${r.why}`,
    };
  }
  const header =
    `migrate drift: ${opts.drizzleDir}/${r.dir} vs the declarations (${app.model.length} resource(s) across ${app.schemas.length} schema(s))`;
  if (isMigrationFresh(r.drift, r.sqlInvented)) {
    return {
      code: 0,
      stdout: `✓ ${header} — the committed migration matches`,
    };
  }
  const lines = [`✗ ${header} — the committed migration is STALE`];
  for (const k of r.drift.missing) {
    lines.push(`  - declared, absent from the migration: ${k}`);
  }
  for (const k of r.drift.extra) {
    lines.push(`  - in the migration, no longer declared: ${k}`);
  }
  for (const k of r.drift.retyped) {
    lines.push(`  - type differs (committed → declared): ${k}`);
  }
  for (const k of r.sqlInvented) {
    lines.push(
      `  - migration.sql invents column absent from snapshot: ${k} (hand-edit or regenerate)`,
    );
  }
  lines.push(
    "  run hazelnut migrate <app> generate and commit the new drizzle/<ts>/ dir",
  );
  return { code: 1, stdout: lines.join("\n") };
}

/**
 * A read that could not RUN is a refusal (exit 2), never a verdict. Exit 1 is the drift code, so a driver
 * throw escaping as 1 — or as an uncaught rejection — routes a wrapper into "regenerate the migration" for
 * what is a database outage, and hands the operator a framework stack trace for an unreachable port.
 */
function migrateReadRefusal(verb: string, e: unknown): CliResult {
  return {
    code: 2,
    stdout: `migrate ${verb}: cannot read the database — ${explainError(e)}\n` +
      `  the connection comes from DATABASE_URL (\`.env\`, or \`.env.<name>\` with \`--env <name>\`) — start the ` +
      `database, or point --env at the file holding the right URL`,
  };
}

/** `hazelnut migrate preview` (cli/migrate.md) — a non-mutating dry run: the pending column plan the next
 * apply would run, PARTITIONED on `destructive`, so the irreversible half can never be omitted from a plan
 * the reader signs off on. Row-count estimates for data migrations are the expand-contract seam. Reads only,
 * never gated: exit 0 informational, 2 when the read failed. /
 */
export async function cliMigratePreview(db: Db, app: App): Promise<CliResult> {
  // ONE diff, rendered as a partition: the additive and the irreversible halves are the same read, so a
  // preview cannot report one class of change and stay silent about the other.
  let pending: Awaited<ReturnType<typeof pendingChanges>>;
  let structural: ReadonlyArray<string>;
  try {
    pending = await pendingChanges(db, app);
    // the non-column half of the plan (sidecar/junction tables, a projection column, a constraint), shared
    // with the post-apply re-verify so both read one enumeration of what a declaration requires.
    structural = await structuralBaselineDrift(db, app);
  } catch (e) {
    return migrateReadRefusal("preview", e);
  }
  const additive = pending.filter((c) => !c.destructive);
  const destructive = pending.filter((c) => c.destructive);
  const lines = [
    `migrate preview (dry-run, non-mutating): ${app.model.length} resource(s) across ${app.schemas.length} schema(s)`,
  ];
  if (pending.length === 0 && structural.length === 0) {
    lines.push(
      "  · no pending schema changes — the live DB matches the declarations",
    );
  }
  if (additive.length > 0) {
    lines.push(
      `  · ${additive.length} ADDITIVE pending change(s) — the next apply adds these column(s):`,
    );
    for (const c of additive) lines.push(`    + ${c.resource}.${c.column}`);
  }
  if (destructive.length > 0) {
    lines.push(
      `  · ${destructive.length} DESTRUCTIVE pending change(s) — IRREVERSIBLE: the next apply drops these column(s) and the data in them:`,
    );
    for (const c of destructive) lines.push(`    - ${c.resource}.${c.column}`);
  }
  if (structural.length > 0) {
    lines.push(
      `  · ${structural.length} declared structure(s) absent from the live DB:`,
    );
    for (const s of structural) lines.push(`    ! ${s}`);
  }
  // version/field-live (multi-version.md §9): names which of those drops a live API version keeps alive;
  // visibility only — the hard refuse rides the deferred expand-contract seam.
  const blocked = fieldLiveBlocked(pending);
  if (blocked.length > 0) {
    lines.push(
      `  · ${blocked.length} column(s) RETAINED by a live API version (version/field-live — a sunset DATE does not release the lock; remove that version's defineVersion first):`,
    );
    for (const b of blocked) {
      lines.push(
        `    - ${b.resource}.${b.column} — kept alive by version '${b.blockedBy}'`,
      );
    }
  }
  lines.push(
    "  · this plan is schema (DDL) only — row counts and data-volume estimates are not reported",
  );
  return { code: 0, stdout: lines.join("\n") };
}

/**
 * `hazelnut migrate status` (cli/migrate.md §status): applied/pending orientation — reuses `checkBaseline`
 * for dev-DB-shape drift, and reads fork orientation from the committed drizzle history (`prevIds[]` DAG)
 * and/or the dir-ordinal `historyLinear` shape check. Reads only, never gated: exit 0 orientation, 2 when
 * the read failed. The drift fix-hint is env-keyed: default-env `reset`, non-default-env a forward migration.
 */
export async function cliMigrateStatus(
  db: Db,
  app: App,
  opts: {
    dirs?: ReadonlyArray<string>;
    nonDefaultEnv?: boolean;
    drizzleDir?: string;
  } = {},
): Promise<CliResult> {
  let drift: ReadonlyArray<string>;
  let history: Awaited<ReturnType<typeof readMigrationHistory>>;
  try {
    drift = await checkBaseline(db, app);
    // Reads the real committed drizzle history (the artifact `generate` authored) when a drizzle/ dir is given —
    // the prevIds[] DAG is the canonical fork signal; historyLinear is the complementary dir-ordinal shape check.
    history = opts.drizzleDir !== undefined
      ? await readMigrationHistory(opts.drizzleDir)
      : [];
  } catch (e) {
    return migrateReadRefusal("status", e);
  }
  const dagForks = forkPointsInHistory(history);
  const fork = opts.dirs && opts.dirs.length > 0
    ? historyLinear([...opts.dirs])
    : [];
  const lines = [
    `migrate status: ${app.model.length} resource(s) across ${app.schemas.length} schema(s)`,
  ];
  if (history.length > 0) {
    lines.push(
      `  · committed migration history: ${history.length} migration(s) (drizzle-kit-authored)`,
    );
  }
  // Fork orientation: a forked / non-linear committed chain (the prevIds[] DAG has a ≥2-child node, or the
  // dir-ordinal shape check found ≥2 leaves / a gap).
  if (dagForks.length > 0 || fork.length > 0) {
    lines.push(
      "  ⚠ local chain forked from origin/main — run hazelnut migrate rebase",
    );
    for (const id of dagForks) {
      lines.push(
        `    - migration node ${id} has ≥2 children (a forked prevIds[] DAG)`,
      );
    }
    for (const f of fork) lines.push(`    - ${f.message}`);
  } else if ((opts.dirs && opts.dirs.length > 0) || history.length > 0) {
    lines.push("  · migration chain is linear (no fork)");
  }
  // dev-db-shape drift orientation — the §status drift line, keyed-hint on the target class
  if (drift.length === 0) {
    lines.push("  · dev DB shape matches the declarations (no drift)");
  } else {
    const hint = opts.nonDefaultEnv
      ? "generate a forward migration (reset is dev-only)"
      : "run hazelnut migrate <app> reset";
    lines.push(`  ⚠ dev DB shape drifts from the declarations — ${hint}`);
    for (const d of drift) lines.push(`    - ${d}`);
  }
  return { code: 0, stdout: lines.join("\n") };
}

/**
 * `hazelnut migrate audit` (cli/migrate.md §history-audit) — points the safe-DDL reader at the COMMITTED
 * history. `generate` guards what it AUTHORS; nothing looked at what is already on disk, so a tree that
 * reached green before a clause existed (or through the bare-re-run launder 0.6.4 closed) still carries the
 * script and `drift` calls it current, because it matches the declarations.
 *
 * ADVISORY by default (exit 0), `--strict` makes a finding exit 1. That default is the honest one: these
 * statements have already run wherever they were applied, so refusing them retroactively reports a risk
 * that is spent. What is NOT spent is the replay — `drizzle/` is what a fresh environment, a restore, or a
 * new developer's database executes, so an unsafe committed script is a lock waiting to be taken again.
 * That is the finding's subject, and it is why the verb exists rather than the clause simply being loosened.
 *
 * Offline: reads `drizzleDir` off disk, spawns nothing, needs no DATABASE_URL — so an app may chain it.
 */
export async function cliMigrateAudit(
  opts: {
    drizzleDir: string;
    strict?: boolean;
    immutable?: ReadonlyArray<string>;
  },
): Promise<MigrateGenerateResult> {
  const history = await readMigrationHistory(opts.drizzleDir);
  if (history.length === 0) {
    return {
      code: 0,
      stdout:
        `migrate audit: no committed migration in ${opts.drizzleDir}/ — nothing to audit`,
    };
  }
  // newTableAware, exactly as the authoring gate runs it: an index or constraint on a table the SAME script
  // creates is scanning zero rows. Without it every initial-create migration reports findings it never
  // deserved at authoring time, and an advisory nobody believes is one nobody reads.
  const flagged = history
    .map((m) => ({
      dir: m.dir,
      findings: [
        ...safeDdl(m.sql, m.dir, { newTableAware: true }),
        ...classifyDangerousChange(m.sql, m.dir),
        ...immutableProtected(m.sql, {
          immutable: opts.immutable,
          resource: m.dir,
        }),
      ],
    }))
    .filter((r) => r.findings.length > 0);

  const scanned =
    `${history.length} committed migration(s) in ${opts.drizzleDir}/`;
  if (flagged.length === 0) {
    return { code: 0, stdout: `✓ migrate audit: ${scanned} — no findings` };
  }
  const total = flagged.reduce((n, r) => n + r.findings.length, 0);
  const lines = [
    `${
      opts.strict ? "✗" : "⚠"
    } migrate audit: ${scanned} — ${total} finding(s) across ${flagged.length} migration(s)`,
  ];
  for (const { dir, findings } of flagged) {
    lines.push(`  ${dir}`);
    for (const f of findings) lines.push(`    - ${f.message}`);
  }
  lines.push(
    opts.strict
      ? "  --strict: a committed finding is an error. These statements already ran where they were applied; what re-runs them is a fresh environment or a restore."
      : "  advisory (exit 0). These statements already ran where they were applied — the finding is about the REPLAY: a fresh environment or a restore executes drizzle/ again. Pass --strict to make this an error.",
  );
  return { code: opts.strict ? 1 : 0, stdout: lines.join("\n") };
}
