// hazelnut migrate --safe-ddl — the one migrate subcommand that does not load an app.
// Schema migrate verbs live in `hazelnut-schema-cmd.ts`. Upgrade / range-diff live in
// `hazelnut-app-cmd.ts` (withheld from the core artifact — every verb they own is refused
// before dispatch on a core build).
import { CORE_VERBS } from "./build-module.ts";
import { MIGRATE_SUBCOMMANDS, positionalTokens } from "./flag-roster.ts";
import { cliMigrateSafe } from "./cli.ts";

/** TTY stdin hangs `for await (Deno.stdin.readable)` forever. Refuse, never block. */
export function migrateStdinRefusal(
  hasFile: boolean,
  isTty: boolean,
): string | null {
  if (!hasFile && isTty) {
    return "migrate --safe-ddl: stdin is a TTY — pass a .sql file, or pipe SQL on stdin";
  }
  return null;
}

export async function dispatchMigrate(
  cmd: string,
  modPath: string,
  rest: string[],
  /** The verbs the CALLING entry serves — the usage line derives from it rather than restating a roster
   *  this dispatcher cannot see. Defaults to the core build's; the full entry passes its own. */
  served: readonly string[] = CORE_VERBS,
): Promise<void> {
  if (cmd === "migrate" && modPath === "--safe-ddl") {
    // POSITIONAL, so a value flag's value is never mistaken for the script: `--safe-ddl --dir foo x.sql`
    // read `foo`. `-` stays out — it is the stdin convention, not a path.
    const sqlArg = positionalTokens(rest).find((a) => a !== "-");
    const tty = migrateStdinRefusal(Boolean(sqlArg), Deno.stdin.isTerminal());
    if (tty) {
      console.error(tty);
      Deno.exit(2);
    }
    let sql: string;
    if (sqlArg) sql = await Deno.readTextFile(sqlArg);
    else { // read from stdin (the `-` form, or no path at all)
      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const c of Deno.stdin.readable) {
        chunks.push(c);
        total += c.length;
      }
      const merged = new Uint8Array(total);
      let at = 0;
      for (const c of chunks) {
        merged.set(c, at);
        at += c.length;
      }
      sql = new TextDecoder().decode(merged);
    }
    // `--dir a --dir b` collects the migration-dir names for the history-linear gate (optional).
    const dirs = rest.flatMap((
      a,
      i,
    ) => (a === "--dir" && rest[i + 1] && !rest[i + 1]!.startsWith("--")
      ? [rest[i + 1]!]
      : [])
    );
    // `--immutable t1 --immutable t2` marks caller-owned immutable tables (in addition to `_audit`).
    const immutable = rest.flatMap((
      a,
      i,
    ) => (a === "--immutable" && rest[i + 1] && !rest[i + 1]!.startsWith("--")
      ? [rest[i + 1]!]
      : [])
    );
    const r = cliMigrateSafe(sql, { dirs, immutable });
    console.log(r.stdout);
    Deno.exit(r.code);
  }

  if (cmd !== "migrate") return;

  // Bare `migrate` without a path — schema-cmd owns the app-taking forms; name the shape here so a
  // mistyped `--safe-ddl` still gets a useful refusal rather than falling through silently.
  if (!modPath) {
    console.error(
      `usage: hazelnut <verb> <app> — this build serves: ${
        served.join(" · ")
      }\n` +
        `  migrate <app> [${MIGRATE_SUBCOMMANDS.join("|")}] [--dir <name>]…\n` +
        `  migrate --safe-ddl [<sql-file>|-] [--dir <name>]… [--immutable <table>]…`,
    );
    Deno.exit(2);
  }
}
