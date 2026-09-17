// The connected half of migrate rebase (cli/migrate.md §rebase; migrate-verbs-rebase.ts detects the fork
// offline). Reads the live `__drizzle_migrations` ledger to decide, per forked migration, dissolve
// (unapplied → drop + re-derive) vs refuse-and-route (applied → never rewrite applied history), running
// the whole decide+drop+re-derive holding `withMigrateLock`.
import type { Db } from "./db.ts";
import { readMigrationHistory } from "./migrate-drizzle-schema.ts";
import type { MigrationEntry } from "./migrate-drizzle-schema.ts";
import { migrationHash, withMigrateLock } from "./migrate-lock.ts";

/** Applied-migration hashes from `__drizzle_migrations`; a hash absent is unapplied (safe to dissolve).
 *  Probed via `to_regclass`, not a catch-all — a real read error refuses rather than reading as empty.
 *  Resolves via `search_path`; a `search_path` shadowed between apply and this run is operator-owned,
 *  outside this guard. */
export async function readAppliedMigrationHashes(db: Db): Promise<Set<string>> {
  return new Set((await readAppliedMigrationRows(db)).map((row) => row.hash));
}

async function readAppliedMigrationRows(
  db: Db,
): Promise<{ hash: string; folder: string | null }[]> {
  const probe = await db.query<{ reg: string | null }>(
    `SELECT to_regclass('__drizzle_migrations') AS reg`,
  );
  if (!probe.rows[0]?.reg) return []; // absent via search_path ⇒ greenfield
  // JSON projection also reads legacy ledgers that have no folder column. Do not
  // mutate the ledger just to inspect history, or swallow a genuine read failure.
  const r = await db.query<{ hash: string; folder: string | null }>(
    `SELECT hash, to_jsonb(m)->>'folder' AS folder FROM "__drizzle_migrations" AS m`,
  );
  return r.rows;
}

/** Migration artifacts are ordinary files/directories. Keep staging copy explicit rather than shelling out or
 * relying on a runtime-specific recursive copy primitive; a symlink is refused because promotion must not
 * unexpectedly write outside the committed migration tree. */
async function copyMigrationTree(
  source: string,
  target: string,
): Promise<void> {
  await Deno.mkdir(target, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    const from = `${source}/${entry.name}`;
    const to = `${target}/${entry.name}`;
    if (entry.isDirectory) await copyMigrationTree(from, to);
    else if (entry.isFile) await Deno.copyFile(from, to);
    else {
      throw new Error(
        `migrate rebase: refusing to stage non-file artifact '${from}'`,
      );
    }
  }
}

/** Migrations descending from a fork point (a `prevIds[]` node with >=2 children — the signal
 *  `drizzle-kit check` misses). [] for a linear chain. */
export function divergentMigrations(
  history: readonly MigrationEntry[],
): MigrationEntry[] {
  const byId = new Map<string, MigrationEntry>();
  const childCount = new Map<string, number>();
  const childrenOf = new Map<string, MigrationEntry[]>();
  for (const m of history) {
    if (m.id) byId.set(m.id, m);
    for (const parent of m.prevIds) {
      childCount.set(parent, (childCount.get(parent) ?? 0) + 1);
      (childrenOf.get(parent) ?? childrenOf.set(parent, []).get(parent)!).push(
        m,
      );
    }
  }
  const forkPoints = [...childCount.entries()].filter(([, n]) => n >= 2).map((
    [id],
  ) => id);
  const divergent = new Map<string, MigrationEntry>();
  const queue: MigrationEntry[] = forkPoints.flatMap((f) =>
    childrenOf.get(f) ?? []
  );
  while (queue.length > 0) {
    const m = queue.shift()!;
    if (m.id && divergent.has(m.id)) continue;
    if (m.id) divergent.set(m.id, m);
    for (const c of childrenOf.get(m.id ?? "") ?? []) queue.push(c);
  }
  return [...divergent.values()];
}

/** The rebase decision the connected engine takes over a forked history. */
export type RebaseDecision =
  | { readonly kind: "linear" } // no fork — nothing to rebase
  | { readonly kind: "dissolve"; readonly drop: readonly string[] } // all unapplied → drop + re-derive
  | { readonly kind: "route"; readonly appliedDivergent: readonly string[] }; // an applied one → refuse

/** Decide dissolve vs refuse-and-route over a read history + applied-hash set (cli/migrate.md §rebase). All
 *  divergent migrations unapplied → dissolve (drop + re-derive one migration); any applied → refuse and
 *  route to a new forward migration. Pure — the applied read is the caller's, taken under the lock. */
export function decideRebase(
  history: readonly MigrationEntry[],
  appliedHashes: ReadonlySet<string>,
): RebaseDecision {
  const divergent = divergentMigrations(history);
  if (divergent.length === 0) return { kind: "linear" };
  const appliedDivergent = divergent.filter((m) =>
    appliedHashes.has(migrationHash(m.sql))
  );
  if (appliedDivergent.length > 0) {
    return {
      kind: "route",
      appliedDivergent: appliedDivergent.map((m) => m.dir),
    };
  }
  return { kind: "dissolve", drop: divergent.map((m) => m.dir) };
}

/** The outcome of an `autoDissolveRebase` run. */
export interface RebaseResult {
  readonly code: number; // 0 = resolved/already-linear; 1 = refused (applied fork); 2 = engine error
  readonly decision: RebaseDecision["kind"] | "error"; // "error" ⇒ refused before deciding
  readonly dropped: readonly string[]; // divergent dirs dissolved this run
  readonly rederived?: string; // the new migration dir drizzle-kit authored against the merged declarations
  readonly rehomed: readonly string[]; // `.data.ts` forward bodies re-homed to the new position
  readonly stdout: string;
}

/** Test seam: a hook run between the applied-hash read and the drop, inside the lock — the concurrency
 *  tooth injects a concurrent apply here to prove the lock closes the window (born-RED without it). */
export interface AutoDissolveOpts {
  readonly drizzleDir: string;
  readonly migrationsDir?: string; // where `.data.ts` shells live (default "migrations")
  readonly offline?: boolean; // --cached-only for the re-derive spawn (the test path)
  /** The CLI-owned rederive door. It must run the generated bytes through the same destructive and safe-DDL
   * gate as `migrate generate`; the data engine deliberately has no raw drizzle-kit fallback. */
  readonly rederive: (opts: {
    readonly out: string;
    readonly offline?: boolean;
  }) => Promise<{ readonly code: number; readonly stdout: string }>;
  readonly _afterAppliedRead?: () => Promise<void>;
}

/** The connected auto-dissolve (cli/migrate.md §rebase), run holding `withMigrateLock`: read the applied-hash
 *  ledger, decide, and on dissolve drop the unapplied divergent dirs, re-home their `.data.ts` forward
 *  bodies, and re-derive one migration against the merged declarations. A route decision drops nothing. */
export async function autoDissolveRebase(
  db: Db,
  opts: AutoDissolveOpts,
): Promise<RebaseResult> {
  return await withMigrateLock(db, async () => {
    // decide+drop+re-derive is guarded: a ledger read failure or a real drop failure refuses (code 2) rather
    // than dissolving unverified or re-deriving over a half-dropped tree; the lock releases on throw.
    try {
      const history = await readMigrationHistory(opts.drizzleDir);
      const appliedRows = await readAppliedMigrationRows(db);
      const hashByFolder = new Map(
        appliedRows.filter((row) => row.folder).map((
          row,
        ) => [row.folder, row.hash]),
      );
      for (const m of history) {
        const recorded = hashByFolder.get(m.dir);
        if (recorded !== undefined && recorded !== migrationHash(m.sql)) {
          throw new Error(
            `migrate/hash-stable: applied migration '${m.dir}' changed hash (${recorded} → ${
              migrationHash(m.sql)
            }) — restore the file before rebasing`,
          );
        }
      }
      const appliedHashes = new Set(appliedRows.map((row) => row.hash));
      // test seam: a concurrent apply injected here (inside the lock) must loud-fail on lock contention — it
      // runs after the applied read, before the drop, exactly the window the lock closes.
      if (opts._afterAppliedRead) await opts._afterAppliedRead();
      const decision = decideRebase(history, appliedHashes);

      if (decision.kind === "linear") {
        return {
          code: 0,
          decision: "linear",
          dropped: [],
          rehomed: [],
          stdout:
            `✓ migrate rebase: chain is already linear (${history.length} migration(s)) — nothing to dissolve`,
        };
      }
      if (decision.kind === "route") {
        return {
          code: 1,
          decision: "route",
          dropped: [],
          rehomed: [],
          stdout: [
            `✗ migrate rebase: an APPLIED migration is on the forked branch — refusing to rewrite applied history`,
            ...decision.appliedDivergent.map((d) =>
              `  - ${d} is recorded in __drizzle_migrations (applied)`
            ),
            `  route to a NEW forward migration instead: merge the declarations, then hazelnut migrate generate (never dissolve applied history).`,
          ].join("\n"),
        };
      }

      // Dissolve into a throwaway copy first. The rederive port is the CLI's safe-DDL/destructive-consent door;
      // a refusal must leave the live fork byte-for-byte intact rather than advancing drizzle's snapshot then
      // laundering a blocked DROP into a later clean run.
      const migrationsDir = opts.migrationsDir ?? "migrations";
      const rehomedBodies: {
        readonly file: string;
        readonly content: string;
      }[] = [];
      for (const dir of decision.drop) {
        const dataDir = `${migrationsDir}/${dir}`;
        try {
          for await (const e of Deno.readDir(dataDir)) {
            if (e.isFile && e.name.endsWith(".data.ts")) {
              rehomedBodies.push({
                file: e.name,
                content: await Deno.readTextFile(`${dataDir}/${e.name}`),
              });
            }
          }
        } catch (e) {
          // mirrors `dropDir`: only an absent dir (no `.data.ts` shell, the pure-DDL case) is tolerated — a
          // real read error propagates to the engine's code-2 refuse rather than silently dropping a forward body.
          if (!(e instanceof Deno.errors.NotFound)) throw e;
        }
      }
      const dropDir = async (path: string) => {
        try {
          await Deno.remove(path, { recursive: true });
        } catch (e) {
          if (!(e instanceof Deno.errors.NotFound)) throw e;
        }
      };
      const stage = await Deno.makeTempDir({
        prefix: "hazelnut-rebase-stage-",
      });
      const stagedDrizzle = `${stage}/drizzle`;
      try {
        await copyMigrationTree(opts.drizzleDir, stagedDrizzle);
        for (const dir of decision.drop) {
          await dropDir(`${stagedDrizzle}/${dir}`);
        }
        const before = new Set(
          (await readMigrationHistory(stagedDrizzle)).map((m) => m.dir),
        );
        const generated = await opts.rederive({
          out: stagedDrizzle,
          offline: opts.offline,
        });
        if (generated.code !== 0) {
          return {
            code: generated.code,
            decision: "error",
            dropped: [],
            rehomed: [],
            stdout:
              `✗ migrate rebase: re-derive refused; live fork is unchanged\n${generated.stdout}`,
          };
        }
        const created = (await readMigrationHistory(stagedDrizzle)).filter((
          m,
        ) => !before.has(m.dir));
        if (created.length > 1) {
          throw new Error(
            "migrate rebase: staged re-derive authored more than one migration",
          );
        }
        // Only a successful, consented staging result reaches the live tree. A real live drop/copy error remains
        // loud rather than pretending a half-promoted history is resolved.
        for (const dir of decision.drop) {
          await dropDir(`${opts.drizzleDir}/${dir}`);
          await dropDir(`${migrationsDir}/${dir}`);
        }
        const gen = created[0];
        if (gen) {
          await copyMigrationTree(
            `${stagedDrizzle}/${gen.dir}`,
            `${opts.drizzleDir}/${gen.dir}`,
          );
        }
        const rehomed: string[] = [];
        if (gen && rehomedBodies.length > 0) {
          const target = `${migrationsDir}/${gen.dir}`;
          await Deno.mkdir(target, { recursive: true });
          for (const b of rehomedBodies) {
            await Deno.writeTextFile(`${target}/${b.file}`, b.content);
            rehomed.push(`${target}/${b.file}`);
          }
        }
        return {
          code: 0,
          decision: "dissolve",
          dropped: decision.drop,
          rederived: gen?.dir,
          rehomed,
          stdout: [
            `✓ migrate rebase: dissolved ${decision.drop.length} unapplied divergent migration(s) + re-derived against the merged declarations`,
            ...decision.drop.map((d) => `  - dropped ${d} (unapplied)`),
            gen
              ? `  + re-derived ${gen.dir} (prevIds → the surviving tip)`
              : "  · re-derive: no schema changes",
            ...rehomed.map((f) =>
              `  + re-homed ${f} (forward body preserved verbatim)`
            ),
          ].join("\n"),
        };
      } finally {
        await Deno.remove(stage, { recursive: true }).catch(() => {});
      }
    } catch (e) {
      // any failure before a clean dissolve — an unverifiable ledger, a real drop failure — refuses (code 2);
      // applied history is never rewritten on an engine error.
      const msg = e instanceof Error ? e.message : String(e);
      return {
        code: 2,
        decision: "error",
        dropped: [],
        rehomed: [],
        stdout:
          `✗ migrate rebase: engine error — refusing to dissolve (applied-history state unverified): ${msg}`,
      };
    }
  });
}
