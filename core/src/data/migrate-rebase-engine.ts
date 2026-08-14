// The connected half of migrate rebase (cli/migrate.md §rebase; migrate-verbs-rebase.ts detects the fork
// offline). Reads the live `__drizzle_migrations` ledger to decide, per forked migration, dissolve
// (unapplied → drop + re-derive) vs refuse-and-route (applied → never rewrite applied history), running
// the whole decide+drop+re-derive holding `withMigrateLock`. Pin:.
import type { App } from "../core/app.ts";
import type { Db } from "./db.ts";
import { readMigrationHistory } from "./migrate-drizzle-schema.ts";
import type { MigrationEntry } from "./migrate-drizzle-schema.ts";
import { migrationHash, withMigrateLock } from "./migrate-lock.ts";
import { runDrizzleKitGenerate } from "./migrate-drizzle-schema.ts";

/** Applied-migration hashes from `__drizzle_migrations`; a hash absent is unapplied (safe to dissolve).
 *  Probed via `to_regclass`, not a catch-all — a real read error refuses rather than reading as empty.
 *  Resolves via `search_path`; a `search_path` shadowed between apply and this run is operator-owned,
 *  outside this guard. */
export async function readAppliedMigrationHashes(db: Db): Promise<Set<string>> {
  const probe = await db.query<{ reg: string | null }>(
    `SELECT to_regclass('__drizzle_migrations') AS reg`,
  );
  if (!probe.rows[0]?.reg) return new Set(); // absent via search_path ⇒ greenfield
  const r = await db.query<{ hash: string }>(
    `SELECT hash FROM "__drizzle_migrations"`,
  );
  return new Set(r.rows.map((row) => row.hash));
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
  readonly _afterAppliedRead?: () => Promise<void>;
}

/** The connected auto-dissolve (cli/migrate.md §rebase), run holding `withMigrateLock`: read the applied-hash
 *  ledger, decide, and on dissolve drop the unapplied divergent dirs, re-home their `.data.ts` forward
 *  bodies, and re-derive one migration against the merged declarations. A route decision drops nothing. */
export async function autoDissolveRebase(
  db: Db,
  app: App,
  opts: AutoDissolveOpts,
): Promise<RebaseResult> {
  return await withMigrateLock(db, async () => {
    // decide+drop+re-derive is guarded: a ledger read failure or a real drop failure refuses (code 2) rather
    // than dissolving unverified or re-deriving over a half-dropped tree; the lock releases on throw.
    try {
      const history = await readMigrationHistory(opts.drizzleDir);
      const appliedHashes = await readAppliedMigrationHashes(db);
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

      // dissolve: every divergent migration is unapplied. Re-home each `.data.ts` forward body, drop the
      // divergent dirs, then re-derive one migration — all inside the lock (nothing mid-drop can record a hash).
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
      // a drop that fails for a real reason (a file lock, a permission error) must not be swallowed — re-deriving
      // over a still-present dir corrupts the tree. Only an already-absent dir (NotFound) is tolerated.
      const dropDir = async (path: string) => {
        try {
          await Deno.remove(path, { recursive: true });
        } catch (e) {
          if (!(e instanceof Deno.errors.NotFound)) throw e;
        }
      };
      for (const dir of decision.drop) {
        await dropDir(`${opts.drizzleDir}/${dir}`);
        await dropDir(`${migrationsDir}/${dir}`);
      }
      const gen = await runDrizzleKitGenerate(app, {
        out: opts.drizzleDir,
        name: "rebase",
        offline: opts.offline,
      });
      const rehomed: string[] = [];
      if (gen.created && rehomedBodies.length > 0) {
        const target = `${migrationsDir}/${gen.dir}`;
        await Deno.mkdir(target, { recursive: true });
        for (const b of rehomedBodies) {
          await Deno.writeTextFile(`${target}/${b.file}`, b.content); // forward body preserved verbatim
          rehomed.push(`${target}/${b.file}`);
        }
      }
      return {
        code: 0,
        decision: "dissolve",
        dropped: decision.drop,
        rederived: gen.created ? gen.dir : undefined,
        rehomed,
        stdout: [
          `✓ migrate rebase: dissolved ${decision.drop.length} unapplied divergent migration(s) + re-derived against the merged declarations`,
          ...decision.drop.map((d) => `  - dropped ${d} (unapplied)`),
          gen.created
            ? `  + re-derived ${gen.dir} (prevIds → the surviving tip)`
            : `  · re-derive: ${gen.reason}`,
          ...rehomed.map((f) =>
            `  + re-homed ${f} (forward body preserved verbatim)`
          ),
        ].join("\n"),
      };
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
