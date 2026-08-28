/**
 * `hazelnut migrate <app> [generate|preview|apply|status|rebase|check|reset|drift]` — the schema-migration verb.
 *
 * It lives in its own CORE file rather than beside `verify`/`diff`/`upgrade`. Sharing a dispatcher with three
 * withheld verbs is what made it a silent no-op on the core CLI: the shared verb filter listed only
 * the module verbs, and this body sat below it, unreachable. A dispatcher that mixes tiers puts a core verb
 * one edit away from disappearing, and the mixing buys nothing — the app-loading preamble is four lines.
 */
import { classifyMigrateTarget, type TargetClass } from "../authz/trust.ts";
import type { CliResult } from "./cli.ts";
import type { App } from "../core/app.ts";
import { postgresDb } from "../data/db.ts";
import { autoDissolveRebase } from "../data/migrate-rebase-engine.ts";
import {
  cliMigrate,
  cliMigrateDrift,
  cliMigrateGenerate,
  cliMigratePreview,
  cliMigrateRebase,
  cliMigrateStatus,
} from "./cli.ts";
import { MIGRATE_SUBCOMMANDS } from "./flag-roster.ts";
import { importAppModule, moduleSpec, parseEnvFile } from "./hazelnut-io.ts";

/** The subcommand vocabulary — also what a missing app path is mistaken for. Single-sourced with the flag
 *  roster that scopes each subcommand's flags, so the two cannot name different verb sets. */
const SUBCOMMANDS: readonly string[] = MIGRATE_SUBCOMMANDS;

export async function dispatchSchema(
  cmd: string,
  modPath: string,
  rest: string[],
): Promise<void> {
  if (cmd !== "migrate") return;
  const USAGE =
    "usage: hazelnut migrate <app> [generate|preview|apply|status|rebase|check|reset|drift] [--dir <name>]…";
  // A subcommand in the app slot means the path was omitted. Without this it reaches `importAppModule`
  // and dies on an uncaught "Module not found" — a stack trace where every other verb prints usage.
  if (!modPath || SUBCOMMANDS.includes(modPath)) {
    console.error(
      modPath
        ? `${USAGE}\n  the app path comes FIRST: hazelnut migrate <app> ${modPath}`
        : USAGE,
    );
    Deno.exit(2);
  }
  const mod = await importAppModule(moduleSpec(modPath)) as {
    app?: App;
    default?: App;
  };
  const app = mod.app ?? mod.default;
  if (!app) {
    console.error(`module '${modPath}' does not export 'app'`);
    Deno.exit(2);
  }
  // `--dir a --dir b` collects the committed migration-dir names (the history-linear / fork-detection input,
  // shared by `generate` / `status` / `rebase`); `--immutable t1 --immutable t2` marks caller-owned tables.
  const migrateDirs = rest.flatMap((
    a,
    i,
  ) => (a === "--dir" && rest[i + 1] && !rest[i + 1]!.startsWith("--")
    ? [rest[i + 1]!]
    : [])
  );
  const migrateImmutable = rest.flatMap((
    a,
    i,
  ) => (a === "--immutable" && rest[i + 1] && !rest[i + 1]!.startsWith("--")
    ? [rest[i + 1]!]
    : [])
  );

  // The committed drizzle/ migration dir (cli/migrate.md §who-writes-what) — drizzle-kit authors the real
  // migration.sql + snapshot.json here; `status`/`rebase` read the chain off it. Override with `--out <dir>`.
  const drizzleDir = (() => {
    const at = rest.indexOf("--out");
    return at !== -1 && rest[at + 1] && !rest[at + 1]!.startsWith("--")
      ? rest[at + 1]!
      : "drizzle";
  })();

  // `--online` opts into a network drizzle-kit fetch; default is `--cached-only` (the pinned drizzle-kit lives
  // in Deno's npm cache after the first run / `deno cache`, so generate is offline-by-default).
  const offlineGen = !rest.includes("--online");

  // A non-flag token that is not a recognized migrate verb (e.g. typo'd `previw`) must not silently fall
  // through to mutating `apply` — reject it loudly. A flag's value (after `--dir`/`--immutable`/etc.) is excluded.
  if (cmd === "migrate") {
    const valueFlags = new Set(["--dir", "--immutable", "--out", "--env"]);
    const knownVerbs = new Set(SUBCOMMANDS);
    const unknownVerb = rest.find((a, i) =>
      !a.startsWith("--") && !(i > 0 && valueFlags.has(rest[i - 1]!)) &&
      !knownVerbs.has(a)
    );
    if (unknownVerb !== undefined) {
      console.error(
        `migrate: unknown verb '${unknownVerb}' — expected one of: ${
          SUBCOMMANDS.join(", ")
        }`,
      );
      Deno.exit(2);
    }
  }

  // Offline migrate verbs (`drift`, `generate`, `rebase`'s fork-detection) need the composed app but no
  // DATABASE_URL, so they run before the connect. `drift` additionally spawns nothing at all — it reads the
  // committed snapshot off disk — which is what lets an app chain it into its default `ci` lane.
  if (rest.includes("drift")) {
    const r = await cliMigrateDrift(app, { drizzleDir });
    console.log(r.stdout);
    Deno.exit(r.code);
  }
  // `generate` spawns the pinned drizzle-kit to author the migration on disk.
  if (rest.includes("generate")) {
    const r = await cliMigrateGenerate(app, {
      dirs: migrateDirs,
      immutable: migrateImmutable,
      out: drizzleDir,
      offline: offlineGen,
      allowDestructive: rest.includes("--allow-destructive"),
      allowUnsafeDdl: rest.includes("--allow-unsafe-ddl"),
    });
    // Writes the `.data.ts` transform shells the pure core returned (emit is data, disk I/O is the shell).
    // An ambiguous rename scaffolds a born-RED shell; never clobbers an existing hand-written `forward` body.
    if (r.emit) {
      for (const [file, content] of Object.entries(r.emit)) {
        try {
          await Deno.stat(file); // path exists → keep the hand-written body, do not overwrite
        } catch {
          await Deno.mkdir(file.slice(0, file.lastIndexOf("/")), {
            recursive: true,
          });
          await Deno.writeTextFile(file, content);
        }
      }
    }
    console.log(r.stdout);
    Deno.exit(r.code);
  }
  // `hazelnut migrate rebase` (offline default) is fork detection over the committed `prevIds[]` DAG + dir names.
  // `--execute` runs the connected auto-dissolve engine instead (needs DATABASE_URL) — falls through to the connect below.
  if (rest.includes("rebase") && !rest.includes("--execute")) {
    const r = await cliMigrateRebase(migrateDirs, { drizzleDir });
    console.log(r.stdout);
    Deno.exit(r.code);
  }

  // Resolves DATABASE_URL from the env file (cli/migrate.md §prod-guard): bare `migrate` loads `.env`,
  // `--env <name>` loads `.env.<name>`. Prod credentials live only in `.env.production` — unreachable otherwise.
  const envAt = rest.indexOf("--env");
  const envName =
    envAt !== -1 && rest[envAt + 1] && !rest[envAt + 1]!.startsWith("--")
      ? rest[envAt + 1]!
      : undefined;
  const envFile = envName !== undefined ? `.env.${envName}` : ".env";
  let fileEnv: Record<string, string> = {};
  try {
    fileEnv = parseEnvFile(await Deno.readTextFile(envFile));
  } catch {
    // a missing default `.env` is fine (ambient / CI supplies DATABASE_URL); a named `--env` pointing at a
    // non-existent file is a loud operator error (they typed a name expecting that file to hold the connection).
    if (envName !== undefined) {
      console.error(
        `migrate: --env ${envName} names ${envFile}, but that file is not present`,
      );
      Deno.exit(2);
    }
  }
  const fileUrl = fileEnv.DATABASE_URL;
  const url = fileUrl ?? Deno.env.get("DATABASE_URL");
  if (!url) {
    console.error(
      `migrate: DATABASE_URL is not set (looked in ${envFile} and the ambient environment)`,
    );
    Deno.exit(2);
  }
  // The env-guard keys on the connection target, not the `--env` label (cli/migrate.md §prod-guard): only a
  // file-supplied DATABASE_URL under the default `.env` is `dev`; anything else is `prod` and fails closed.
  const target: TargetClass = classifyMigrateTarget({
    envName,
    fileSuppliedUrl: fileUrl !== undefined,
  });
  const nonDefaultEnv = target === "prod";
  // an honest operator-facing label for the confirm prompts: the named env, else the ambient-connection source.
  const targetLabel = envName ?? "an ambient DATABASE_URL";
  const postgres = (await import("postgres")).default;
  const sql = postgres(url, { onnotice: () => {} });
  // Migrate never calls `.transaction` — it takes a cooperative advisory lock and replays the committed
  // migration history via `.exec`/`.query`. `postgresDb` only adds `.transaction`; the shape is unchanged.
  const db = postgresDb(sql);

  // A failed connect names the CAUSE (`explainError` unwraps the driver's AggregateError); this names the
  // SOURCE, which is the half the author acts on. `.env` WINS over the ambient environment, so an exported
  // DATABASE_URL and a placeholder left in `.env` fail against the placeholder — silently, without this line.
  const withUrlOrigin = (r: CliResult): CliResult =>
    /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|password authentication|does not exist/i
        .test(r.stdout)
      ? {
        ...r,
        stdout: `${r.stdout}\n  the connection came from ${
          fileUrl !== undefined
            ? `DATABASE_URL in ${envFile} (a file value WINS over the ambient environment)`
            : "DATABASE_URL in the ambient environment"
        }`,
      }
      : r;

  // DB-touching read-only orientation verbs (cli/migrate.md): `preview` (dry-run, non-mutating) + `status`
  // (applied/pending + fork + dev-DB drift). Both read only, so neither routes through the prod-sign guard.
  if (rest.includes("preview")) {
    const r = withUrlOrigin(await cliMigratePreview(db, app));
    await sql.end();
    console.log(r.stdout);
    Deno.exit(r.code);
  }
  if (rest.includes("status")) {
    const r = await cliMigrateStatus(db, app, {
      dirs: migrateDirs,
      nonDefaultEnv,
      drizzleDir,
    });
    await sql.end();
    console.log(r.stdout);
    Deno.exit(r.code);
  }

  // `hazelnut migrate rebase --execute` (cli/migrate.md §rebase): under the advisory lock, dissolves an
  // unapplied forked migration or refuses-and-routes an applied one — never rewrites applied history.
  if (rest.includes("rebase")) {
    if (
      nonDefaultEnv && !rest.includes("--yes") &&
      !(Deno.stdin.isTerminal() &&
        prompt(
            `Target: ${targetLabel} — rebase --execute mutates committed migration history. Proceed? [y/N]`,
          )?.trim().toLowerCase() === "y")
    ) {
      await sql.end();
      console.error(
        `✗ migrate rebase --execute: target is prod-equivalent (a non-default --env or an ambient DATABASE_URL) — confirm with --yes (or answer the prompt). Applied history is never rewritten regardless (an applied fork routes to a forward migration).`,
      );
      Deno.exit(2);
    }
    const r = await autoDissolveRebase(db, app, { drizzleDir });
    await sql.end();
    console.log(r.stdout);
    Deno.exit(r.code);
  }

  // verbs: `check` (read-only drift), `reset` (dev re-sync; non-default --env → flat-refuse; `--include-audit`
  // clears a corrupt dev _audit — the named loud opt-out, still through the env-guard), default `apply`.
  const verb: "apply" | "check" | "reset" = rest.includes("check")
    ? "check"
    : rest.includes("reset")
    ? "reset"
    : "apply";
  const includeAudit = rest.includes("--include-audit");
  // A destructive `apply` against a non-default `--env` prompts (TTY only) unless `--yes` is set; without
  // confirmation `cliMigrate` refuses rather than apply silently. `reset` on non-default env is always refused.
  const confirmed = rest.includes("--yes") ||
    (verb === "apply" && nonDefaultEnv && Deno.stdin.isTerminal() &&
      prompt(`Target: ${targetLabel} — apply? [y/N]`)?.trim().toLowerCase() ===
        "y");
  // The live apply takes the advisory lock (cli/migrate.md §concurrency-safety), replays the committed
  // `drizzle/` migration history, then re-verifies. `lock:true` only at the entrypoint — unit callers stay lock-free.
  const r = await cliMigrate(db, app, verb, {
    target,
    confirmed,
    includeAudit,
    drizzleDir,
    lock: verb === "apply",
  });
  // `.hazelnut/` class-4 sweep (cli/migrate.md §reset step 5) — after a successful dev reset, drop the
  // re-derivable verify cache (the next `hazelnut verify` regenerates it). Best-effort: a missing dir is fine.
  if (verb === "reset" && r.code === 0) {
    for (const entry of ["metadata.json", "verify-cache.json"]) {
      try {
        await Deno.remove(`.hazelnut/${entry}`);
      } catch { /* not present — already swept / never generated */ }
    }
    try {
      for await (const e of Deno.readDir(".hazelnut")) {
        if (e.isDirectory && e.name.startsWith("run-")) {
          await Deno.remove(`.hazelnut/${e.name}`, { recursive: true });
        }
      }
    } catch { /* no .hazelnut dir — nothing to sweep */ }
  }
  await sql.end();
  console.log(withUrlOrigin(r).stdout);
  Deno.exit(r.code);
}
