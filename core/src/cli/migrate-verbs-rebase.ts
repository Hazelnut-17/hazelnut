// `hazelnut migrate` rebase verb + the file-pure safe-ddl gate (cli/migrate.md).
import {
  baselineFresh,
  classifyDangerousChange,
  destructiveStatements,
  fieldLiveContractViolations,
  frameworkTableAdditive,
  historyLinear,
  immutableProtected,
  SAFE_DDL,
  safeDdl,
} from "../data/migrate-safety.ts";
import { expandProceduralScript } from "../data/migrate-safety-ast.ts";
import { readMigrationHistory } from "../data/migrate.ts";
import type { CliResult } from "./cli.ts";
import { forkPointsInHistory } from "./migrate-verbs-shared.ts";

/**
 * `hazelnut migrate rebase` (cli/migrate.md §history-linearization · §rebase): detects a forked history via
 * the committed `prevIds[]` DAG and/or the dir-ordinal `historyLinear` shape check, and prints the dissolve
 * recipe (return to the parent tip, drop the unapplied migration, re-derive one migration). This offline verb
 * only detects; `--execute` (`autoDissolveRebase`) auto-dissolves under the migrate advisory lock. Exit 1 on
 * a detected fork, exit 0 on a linear chain (no-op).
 */
export async function cliMigrateRebase(
  dirs: ReadonlyArray<string>,
  opts: { drizzleDir?: string } = {},
): Promise<CliResult> {
  const history = opts.drizzleDir !== undefined
    ? await readMigrationHistory(opts.drizzleDir)
    : [];
  const dagForks = forkPointsInHistory(history);
  const fork = historyLinear([...dirs]);
  const totalMigrations = history.length || dirs.length;
  if (dagForks.length === 0 && fork.length === 0) {
    return {
      code: 0,
      stdout:
        `✓ migrate rebase: chain is already linear (${totalMigrations} migration(s)) — nothing to rebase`,
    };
  }
  const findings = [
    ...dagForks.map((id) =>
      `migration node ${id} has ≥2 children (a forked prevIds[] DAG — the canonical fork signal drizzle-kit check misses)`
    ),
    ...fork.map((f) => f.message),
  ];
  const body = [
    `✗ migrate rebase: forked / non-linear history detected (${findings.length} finding(s))`,
    ...findings.map((f) => `  - ${f}`),
    "  dissolve-by-re-derive: the snapshot chain is a pure function of the",
    "  declarations — never text-merge it. Return to the parent tip, drop the local UNAPPLIED migration, merge the",
    "  declarations, and re-derive ONE migration against the merged declarations (hazelnut migrate generate).",
    "  ▶ OR run it automatically: hazelnut migrate rebase --execute (needs DATABASE_URL) reads __drizzle_migrations",
    "  under the migrate lock to dissolve the UNAPPLIED divergent migrations + re-derive, and refuses-and-routes any",
    "  APPLIED fork to a new forward migration (never rewrites applied history).",
  ];
  return { code: 1, stdout: body.join("\n") };
}

/**
 * `hazelnut migrate` safe-ddl gate (cli/migrate.md §safe-ddl): the offline, file-pure half of the migrate
 * shell, distinct from `cliMigrate`'s DB apply/check. Runs over the given SQL (plus, when supplied, dir
 * names and a baseline re-diff): migrate/safe-ddl, migrate/immutable-protected, migrate/framework-table-additive
 * always; migrate/history-linear when dirs are given; migrate/baseline-fresh when `rediff` is given. Any
 * build-error-level finding exits non-zero.
 */
export function cliMigrateSafe(
  sql: string,
  opts: {
    dirs?: ReadonlyArray<string>;
    resource?: string;
    immutable?: ReadonlyArray<string>;
    rediff?: boolean | { pending: number };
    /** `--allow-destructive`: the caller has already confirmed this migration may discard data, so the
     *  destructive reading below is their answer rather than a finding. `generate` owns that confirm; the
     *  standalone lint has no such flag, and reports every destructive statement it reads. */
    allowDestructive?: boolean;
    // newTableAware (cli/migrate.md §safe-ddl new-table exemption): an index/constraint on a table THIS
    // script creates is exempt; an incremental ALTER against a live table is not. Defaults to TRUE because
    // the exemption keys on the script's own content, so it is the right reading for every whole-script
    // door — and a seat that simply forgot to pass it refused what a generated migration accepted.
    newTableAware?: boolean;
    // `resource.column` (and bare `column`) names a live API version keeps alive via `fields` (multi-version.md §9):
    // a `DROP COLUMN` of one is a `version/field-live` contract violation — refused in the same safe-ddl channel.
    fieldLiveLocked?: ReadonlyArray<string>;
  } = {},
): CliResult & { readonly ids: readonly string[] } {
  const resource = opts.resource ?? "migration";
  // Parser-backed statement model (migrate-safety-ast.ts): flattens a classifiable DO body once so every
  // sql-pure gate sees what the body would run (a DO-wrapped DROP TABLE "_audit" cannot hide behind the wrapper).
  const effectiveSql = expandProceduralScript(sql) ?? sql;
  const ddl = safeDdl(sql, resource, {
    newTableAware: opts.newTableAware ?? true,
  });
  const fieldLive = fieldLiveContractViolations(
    effectiveSql,
    new Set(opts.fieldLiveLocked ?? []),
  );
  // immutable-protected and framework-table-additive are pure over the SQL — they always run (no DB, no
  // dir list needed). immutableProtected's immutable set is `_audit` plus any caller-marked table.
  const immutable = immutableProtected(effectiveSql, {
    immutable: opts.immutable,
    resource,
  });
  const framework = frameworkTableAdditive(effectiveSql, resource);
  // history-linear only runs when migration-dir names are supplied — an empty/absent dir list is trivially
  // linear (the gate itself returns [] for []), so a SQL-only invocation reports only the SQL-pure verdicts.
  const history = opts.dirs && opts.dirs.length > 0
    ? historyLinear([...opts.dirs])
    : [];
  // baseline-fresh models a latency-heavy whole-schema re-diff; the entrypoint runs that and passes the
  // result here. Absent a `rediff` result there is nothing to check (the SQL-only invocation skips it).
  const baseline = opts.rediff !== undefined
    ? baselineFresh(opts.rediff, resource)
    : [];
  // The DESTRUCTIVE verdict, which `generate` and `audit` both run over the same kind of SQL and this mode
  // did not. Without it a hand-written `DROP TABLE users` read as clean here while `generate` refused it —
  // and `cli/migrate.md §safe-ddl-mode` promises this mode meets "the same bar as a generated migration".
  // `immutableProtected` above only ever answered for `_audit` and caller-marked tables.
  const destructive = classifyDangerousChange(effectiveSql, resource);
  // A DROP against ANY table, not only a protected one. `immutableProtected` above answers for `_audit` and
  // caller-marked tables; `generate` refuses the rest unless `--allow-destructive`, and this mode reported
  // them clean. Reported, not refused-with-an-override: a lint names what it found and the operator decides.
  const destroys =
    (opts.allowDestructive ? [] : destructiveStatements(effectiveSql)).map((
      stmt,
    ) => ({
      id: SAFE_DDL,
      resource,
      message: `destructive DDL: ${
        stmt.trim().replace(/\s+/g, " ")
      } — this discards data. \`migrate generate\` refuses it without --allow-destructive; a hand-written script gets the same reading here`,
    }));
  const findings = [
    ...ddl,
    ...destructive,
    ...destroys,
    ...fieldLive,
    ...immutable,
    ...framework,
    ...history,
    ...baseline,
  ];
  if (findings.length === 0) {
    // The verdict names the gates that RAN — every one of them. `historyLinear` answers only when dir names
    // are supplied, `baselineFresh` only when the entrypoint hands in a re-diff, and `fieldLive` only when
    // locked fields are, so a SQL-only invocation claiming "no history corruption" claimed a check it had
    // skipped; naming three of the six always-run gates under-claimed the other direction.
    const alsoRan = [
      ...((opts.fieldLiveLocked?.length ?? 0) > 0
        ? ["live-field contract"]
        : []),
      ...(history.length > 0 || (opts.dirs?.length ?? 0) > 0
        ? ["history linearity"]
        : []),
      ...(opts.rediff !== undefined ? ["baseline freshness"] : []),
    ];
    return {
      code: 0,
      ids: [] as readonly string[],
      stdout:
        `✓ migrate: SAFE-DDL gate clean — no unsafe DDL, destructive change, immutable-table violation, or framework-table violation${
          alsoRan.length > 0 ? `, and no ${alsoRan.join(" or ")} problem` : ""
        } (${resource})`,
    };
  }
  // Group by id so a script tripping several gates shows each roster id with its own findings (and its count).
  const ids = [...new Set(findings.map((f) => f.id))];
  const body = ids.flatMap((id) => {
    const items = findings.filter((f) => f.id === id);
    return [
      `✗ ${id} (${items.length})`,
      ...items.map((f) => `  - ${f.message}`),
    ];
  });
  // The ids travel with the verdict: an exit code cannot say WHICH gate refused, so a caller holding an
  // override had no way to honour a class that has no accept path. `--allow-unsafe-ddl` waived every
  // finding, WORM included, while the WORM message said it had no `--accept`.
  return {
    code: 1,
    ids: ids as readonly string[],
    stdout: [
      `✗ migrate: ${findings.length} build-error-level migration violation(s)`,
      ...body,
    ].join("\n"),
  };
}
