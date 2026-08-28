// Barrel re-exports keep import sites stable.
import { resolve } from "node:path";
import type { App } from "../core/app.ts";
import { deriveDrizzleSchemaModule } from "./migrate-drizzle.ts";
import { concurrentIndexes, prependLockTimeout } from "./migrate-sql-text.ts";

import { temporalExcludeConstraintSql } from "./schema-ddl.ts";

/** One on-disk migration drizzle-kit `generate` authored — the timestamped dir, the `migration.sql` bytes,
 *  and the parsed `snapshot.json` head. `status`/`rebase` read the chain (`prevIds[]` DAG) from these. */
export interface MigrationEntry {
  readonly dir: string; // the dir name (e.g. "20260101120000_init") — its timestamp prefix orders the chain
  readonly sql: string;
  readonly id: string | null; // the snapshot id (a uuid) — the `prevIds[]` DAG node identity
  readonly prevIds: readonly string[]; // the parent node ids (the v1 DAG; `["000…0"]` is the sentinel root)
  readonly version: string | null; // the snapshot format version (the v1 RC pins "8" — a drift tripwire)
}

/**
 * `readMigrationHistory(drizzleDir)` — read the committed drizzle migration history off disk (cli/migrate.md
 * §history-linearization), ordered by dir name (the timestamp prefix is the chain position). A missing dir
 * → `[]`; a dir without a readable snapshot is skipped (not a complete migration).
 */
export async function readMigrationHistory(
  drizzleDir: string,
): Promise<MigrationEntry[]> {
  let names: string[];
  try {
    names = [];
    for await (const e of Deno.readDir(drizzleDir)) {
      if (e.isDirectory && /^\d/.test(e.name)) names.push(e.name);
    }
  } catch {
    return []; // no drizzle/ dir yet — an empty history
  }
  names.sort(); // the timestamp prefix orders the chain (lexicographic = chronological for `YYYYMMDDHHmmss`)
  const out: MigrationEntry[] = [];
  for (const dir of names) {
    let sql = "";
    try {
      sql = await Deno.readTextFile(`${drizzleDir}/${dir}/migration.sql`);
    } catch {
      /* a dir without migration.sql is not a complete migration — skip below if no snapshot either */
    }
    let id: string | null = null;
    let prevIds: readonly string[] = [];
    let version: string | null = null;
    try {
      const snap = JSON.parse(
        await Deno.readTextFile(`${drizzleDir}/${dir}/snapshot.json`),
      ) as {
        id?: string;
        prevIds?: string[];
        version?: string | number;
      };
      id = snap.id ?? null;
      prevIds = snap.prevIds ?? [];
      version = snap.version !== undefined ? String(snap.version) : null;
    } catch {
      if (sql === "") {
        continue; // neither sql nor snapshot readable — not a migration dir
      }
    }
    out.push({ dir, sql, id, prevIds, version });
  }
  return out;
}

/** The result of a real `drizzle-kit generate` spawn: the migration dir it wrote, the `migration.sql`
 *  bytes, and the parsed snapshot head. `created:false` covers the no-op ("No schema changes") and
 *  `renameBlocked:true` — drizzle-kit v1 RC's deterministic `missing_hints` refusal on a column rename
 *  (not a hang); the caller then routes the rename through the framework's expand-contract DDL path. */
export type DrizzleGenerateResult =
  | {
    readonly created: true;
    readonly dir: string;
    readonly sql: string;
    readonly snapshot: {
      readonly version: string | null;
      readonly id: string | null;
      readonly prevIds: readonly string[];
    };
  }
  | {
    readonly created: false;
    readonly reason: string;
    readonly renameBlocked?: boolean;
  };

/** The drizzle-kit v1 RC non-interactive rename-refusal signature: a rename diff with no `--hints` prints
 *  `missing_hints: <N> unresolved decisions` + the `--hints` resolution JSON and exits non-zero. Matched in
 *  stdout/stderr so a rename returns a typed `renameBlocked` result, never an opaque throw. */
const RENAME_UNRESOLVED_SIGNATURE = "missing_hints";

/** The exact drizzle-kit pin the spawn targets — an exact v1.0.0 RC pin, not a range (the `prevIds[]` DAG +
 *  snapshot version 8 are native to v1). The scaffold + `deno.json` import map carry the same string;
 *  A drift tooth binds them to this const — bump here forces the same bump there, or goes RED. */
export const DRIZZLE_KIT_PIN = "npm:drizzle-kit@1.0.0-rc.4";

/**
 * `runDrizzleKitGenerate(app, opts)` — spawns the pinned drizzle-kit to diff the declaration-derived schema
 * against the committed history and writes a real `drizzle/<TS>_<name>/migration.sql` + `snapshot.json`
 * (cli/migrate.md "the engine IS drizzle-kit"). `out` is the real committed dir; the staging schema/config is
 * a transient input, never the committed output — runtime types stay z.infer/Drizzle-inferred, no codegen.
 * `offline` adds `--cached-only` (the test path, no network). A non-zero exit throws loud with the captured stderr.
 */
export async function runDrizzleKitGenerate(
  app: App,
  opts: {
    out: string;
    name: string;
    offline?: boolean;
    drizzleKitPin?: string;
  },
): Promise<DrizzleGenerateResult> {
  const pin = opts.drizzleKitPin ?? DRIZZLE_KIT_PIN;
  // `out` resolves against the PARENT's cwd before the spawn: drizzle-kit runs with `cwd: staging`, so a
  // relative `out` — the CLI's own default — would land inside the throwaway dir and vanish with it.
  const out = resolve(opts.out);
  const schemaModule = deriveDrizzleSchemaModule(app);
  // stage the transient drizzle-kit input (schema + a deno.json that resolves the bare drizzle-orm import for
  // the spawned Node loader). The staging dir is throwaway; the `out` dir is the real committed migration home.
  //
  // It lives INSIDE the app, not in the OS temp dir. The grant a scaffolded `migrate` task carries is
  // `--allow-write=.`, so staging outside it failed a fresh app's FIRST `migrate generate` with a Deno
  // permission error the consumer never wrote — the framework's own migration test spawns with `-A`, so
  // the emitted grant was never the one exercised. `.hazelnut/` is already gitignored by the scaffold.
  const stagingRoot = `${Deno.cwd()}/.hazelnut`;
  await Deno.mkdir(stagingRoot, { recursive: true });
  // Sweep a previous run's staging. The `finally` below removes this run's, but a killed generate leaves
  // one behind — and since 0.5.3 that residue lives in the app tree rather than the OS temp dir, where
  // nothing ever cleans it up. Best-effort: a concurrent generate's dir is in use and simply refuses.
  for await (const e of Deno.readDir(stagingRoot)) {
    if (e.isDirectory && e.name.startsWith("drizzle-gen-")) {
      await Deno.remove(`${stagingRoot}/${e.name}`, { recursive: true }).catch(
        () => {},
      );
    }
  }
  const staging = await Deno.makeTempDir({
    dir: stagingRoot,
    prefix: "drizzle-gen-",
  });
  const schemaPath = `${staging}/schema.ts`;
  try {
    await Deno.writeTextFile(schemaPath, schemaModule);
    // nodeModulesDir:"auto" + the drizzle-orm map let drizzle-kit's own loader resolve `drizzle-orm/pg-core`.
    // The drizzle-orm pin tracks the drizzle-kit pin (the matched RC pair — drizzle-kit v1 needs drizzle-orm v1).
    const ormPin = pin.replace("drizzle-kit", "drizzle-orm"); // npm:drizzle-orm@<version>
    const ormVersioned = ormPin.replace("npm:drizzle-orm@", ""); // <version>
    await Deno.writeTextFile(
      `${staging}/deno.json`,
      JSON.stringify({
        nodeModulesDir: "auto",
        imports: {
          "drizzle-orm": ormPin,
          "drizzle-orm/": `npm:/drizzle-orm@${ormVersioned}/`,
        },
      }),
    );
    await Deno.mkdir(out, { recursive: true });
    const before = new Set(
      (await readMigrationHistory(out)).map((m) => m.dir),
    );
    // drizzle-kit globs its --schema/--out args, and its glob rejects backslashed Windows paths — hand it
    // forward slashes (a no-op on POSIX; Windows fs APIs accept either separator, so only the args normalize).
    const args = [
      "run",
      "-A",
      ...(opts.offline ? ["--cached-only"] : []),
      pin,
      "generate",
      "--dialect",
      "postgresql",
      "--schema",
      schemaPath.replaceAll("\\", "/"),
      "--out",
      out.replaceAll("\\", "/"),
      "--name",
      opts.name,
    ];
    const spawn = () =>
      new Deno.Command(Deno.execPath(), {
        args,
        cwd: staging,
        stdout: "piped",
        stderr: "piped",
      }).output();
    let { code, stdout, stderr } = await spawn();
    // drizzle-kit names the directory `<YYYYMMDDHHMMSS>_<name>` and this caller always passes the SAME
    // `name`, so the wall-clock second is the only thing separating two generates. Two inside one second
    // collide on mkdir, and the consumer sees a raw `EEXIST` from a subprocess they never spawned. The
    // collision is a clock artifact whose one cure is a different second, so cross the boundary and retry
    // ONCE — a second attempt that still collides is a real failure and falls through to the throw.
    const collided = (): boolean => {
      const t = new TextDecoder().decode(stdout) +
        new TextDecoder().decode(stderr);
      return t.includes("EEXIST") && t.includes(`_${opts.name}`);
    };
    if (code !== 0 && collided()) {
      for (const sec = Math.floor(Date.now() / 1000);;) {
        if (Math.floor(Date.now() / 1000) !== sec) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      ({ code, stdout, stderr } = await spawn());
    }
    if (code !== 0) {
      const stdoutText = new TextDecoder().decode(stdout);
      const stderrText = new TextDecoder().decode(stderr);
      // a column rename makes drizzle-kit v1 RC unable to decide rename-vs-drop+create non-interactively; it
      // refuses with `missing_hints` + non-zero exit. Surfaced as a typed `renameBlocked` result, not a throw.
      if (
        stdoutText.includes(RENAME_UNRESOLVED_SIGNATURE) ||
        stderrText.includes(RENAME_UNRESOLVED_SIGNATURE)
      ) {
        return {
          created: false,
          renameBlocked: true,
          reason:
            "drizzle-kit cannot disambiguate a column rename (rename vs drop+create) without `--hints`; route the rename through the framework's expand-contract DDL path instead of drizzle-kit's diff",
        };
      }
      throw new Error(
        `drizzle-kit generate exited ${code}: ${
          stderrText.trim() || stdoutText.trim()
        }`,
      );
    }
    // read back the dir drizzle-kit just wrote (the one not present before). No new dir → a no-op ("No schema
    // changes" — drizzle-kit printed it and wrote nothing), which is a clean baseline-fresh result, not a fail.
    const after = await readMigrationHistory(out);
    const fresh = after.find((m) => !before.has(m.dir));
    if (!fresh) {
      return {
        created: false,
        reason:
          "drizzle-kit reported no schema changes — the history is already current",
      };
    }
    const appended = appendTemporalExcludes(app, fresh.sql) ?? fresh.sql;
    // Before the lock-timeout prepend: both are the emitter satisfying the gate, and the index rewrite
    // reads statements, so it runs on the script's own bytes rather than on a prepended SET line.
    const concurrent = concurrentIndexes(appended) ?? appended;
    const sql = prependLockTimeout(concurrent) ?? concurrent;
    if (sql !== fresh.sql) {
      await Deno.writeTextFile(`${out}/${fresh.dir}/migration.sql`, sql);
    }
    return {
      created: true,
      dir: fresh.dir,
      sql,
      snapshot: {
        version: fresh.version,
        id: fresh.id,
        prevIds: fresh.prevIds,
      },
    };
  } finally {
    await Deno.remove(staging, { recursive: true }).catch(() => {}); // sweep the transient input (best-effort)
  }
}

/**
 * Temporal no-overlap append (04-features.md §temporal migrate): drizzle-orm cannot express an EXCLUDE
 * constraint, so this appends the framework-owned DDL to the migration drizzle-kit wrote, only for tables the
 * migration creates (enabling `noOverlap` on an already-populated table demands a hand migration, loudly, via
 * `checkBaseline`). Pure over (app, sql); `null` means nothing to append.
 */
export function appendTemporalExcludes(app: App, sql: string): string | null {
  const appends: string[] = [];
  const extensions: string[] = [];
  for (const m of app.model) {
    const constraint = temporalExcludeConstraintSql(m.name, m.features);
    if (!constraint) continue;
    const createsIt = new RegExp(
      `CREATE TABLE (?:IF NOT EXISTS )?(?:"${m.pgSchema}"\\.)?"${m.name}"`,
    ).test(sql);
    if (createsIt) {
      appends.push(
        `ALTER TABLE "${m.pgSchema}"."${m.name}" ADD ${constraint};`,
      );
    }
  }
  if (appends.length > 0) {
    extensions.push(`CREATE EXTENSION IF NOT EXISTS btree_gist;`);
  }
  // the dev/apply path has always created the extension itself (app-boot); the GENERATED artifact
  // must carry it too, or a fresh production database dies on `type "vector" does not exist`
  if (app.model.some((m) => m.vector)) {
    extensions.push(`CREATE EXTENSION IF NOT EXISTS vector;`);
  }
  if (extensions.length === 0) return null;
  return `${sql.trimEnd()}\n--> statement-breakpoint\n${
    [...extensions, ...appends].join("\n--> statement-breakpoint\n")
  }\n`;
}
