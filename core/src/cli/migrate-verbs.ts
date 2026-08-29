import { migrateEnvGuard, type TargetClass } from "../authz/trust.ts";
import { explainError } from "./hazelnut-io.ts";
import type { App } from "../core/app.ts";
import type { Db } from "../data/db.ts";
import {
  applyMigrations,
  type ApplyMigrationsResult,
  applySchema,
  checkBaseline,
  resetSchema,
  withMigrateLock,
} from "../data/migrate.ts";
import type { CliResult } from "./cli.ts";

/** CLI migrate verbs: `migrate` (check/reset/push), `generate`, `preview`, `status`, `rebase`, `safe` — the
 *  schema-diff, safe-ddl gate, and drizzle-history CLI over `data/migrate.ts` (re-exported from sibling modules). */
/**
 * `hazelnut migrate apply|check|reset` — the live migrate entrypoint; the prod env-guard (14-trust-gradient.md
 * §6 · cli/migrate.md §prod-guard) is wired here, the single DB-mutation site. `target` comes from the explicit
 * `--env` name, NEVER host-detection. `check` reads only, never gated. `apply` on `prod` needs `opts.confirmed`
 * or `--yes` (confirm-required); `reset` on `prod` is a categorical flat-refuse (prod recovery is roll-forward
 * only, via `apply`). `target` defaults to `"dev"`. Exit 0 ok / 1 drift / 2 error|refused.
 */
export async function cliMigrate(
  db: Db,
  app: App,
  mode: "apply" | "check" | "reset" = "apply",
  opts: {
    target?: TargetClass;
    confirmed?: boolean;
    includeAudit?: boolean;
    drizzleDir?: string;
    lock?: boolean;
  } = {},
): Promise<CliResult> {
  const target = opts.target ?? "dev";
  // The guard keys on target (the explicit --env name → prod|dev); only the mutating verbs (apply/reset)
  // route through it. A confirmed answer lifts only confirm-required, NEVER flat-refuse.
  if (mode === "apply" || mode === "reset") {
    const verdict = migrateEnvGuard(mode, target);
    if (verdict === "flat-refuse") {
      return {
        code: 2,
        stdout:
          `✗ migrate reset: CATEGORICAL refuse — reset against a non-default --env is never permitted (no --yes lifts it). prod recovery is a forward migration (hazelnut migrate apply), never reset.`,
      };
    }
    if (verdict === "confirm-required" && !opts.confirmed) {
      return {
        code: 2,
        stdout:
          `✗ migrate apply: target is a non-default --env — confirm with --yes (or answer the interactive prompt). The real gate is capability separation: prod credentials live only in .env.production. Refusing rather than applying.`,
      };
    }
  }
  try {
    if (mode === "apply") {
      // The mutating apply runs holding the cooperative advisory lock (cli/migrate.md §concurrency-safety),
      // acquired non-blocking, so two concurrent migrators loud-fail rather than interleave.
      const runApply = async (): Promise<CliResult> => {
        // Forward path: when a committed drizzle/ history exists, replays the authored migration files in
        // order, each exactly once; `applySchema` is the dev-push fallback when nothing is authored yet.
        let migrated: ApplyMigrationsResult | null = null;
        if (opts.drizzleDir !== undefined) {
          migrated = await applyMigrations(db, opts.drizzleDir);
        }
        if (!migrated || migrated.total === 0) {
          await applySchema(db, app); // no authored history → the dev convergent push
        }
        // Post-apply re-verify (cli/migrate.md §who-writes-what — apply ends green or loud): the live schema
        // must now match the declarations; residual drift after apply is a build-error exit 1.
        const drift = await checkBaseline(db, app);
        if (drift.length > 0) {
          return {
            code: 1,
            stdout: [
              "✗ migrate apply: post-apply re-verify found drift — the applied schema does not match the declarations",
              ...drift.map((d) => `  - ${d}`),
            ].join("\n"),
          };
        }
        const note = migrated && migrated.total > 0
          ? ` — applied ${migrated.applied.length} migration(s) (${migrated.skipped.length} already applied) from the committed history, post-apply re-verify clean`
          : ` for ${app.model.length} resource(s) across ${app.schemas.length} schema(s), post-apply re-verify clean`;
        // A CONCURRENTLY / VACUUM file runs OUTSIDE the per-migration tx — a mid-file failure may have
        // half-applied it, so the operator has to be told which dirs those were, not left to infer it.
        const nonAtomic = migrated?.nonAtomic?.length
          ? `\n  ⚠ ran OUTSIDE a transaction (${
            migrated.nonAtomic.join(", ")
          }) — a mid-file failure there half-applies; check those dirs before proceeding`
          : "";
        return {
          code: 0,
          stdout: `✓ migrate: applied schema${note}${nonAtomic}`,
        };
      };
      return opts.lock ? await withMigrateLock(db, runApply) : await runApply();
    }
    if (mode === "reset") {
      // Dev reset (cli/migrate.md §reset): a partitioned `_audit`-preserving DROP + re-derive + push, via
      // `resetSchema`. `_audit` is WORM-preserved by default, dropped only under the loud `--include-audit` opt-out.
      const { dropped } = await resetSchema(db, app, {
        includeAudit: opts.includeAudit,
      });
      // The truthy branch REPORTS what the operator passed; the falsey one states the posture and stops.
      // Advertising the destructive opt-out on a success line teaches dropping the WORM table as routine.
      const auditNote = opts.includeAudit
        ? " — _audit DROPPED (--include-audit)"
        : " — _audit preserved (WORM)";
      return {
        code: 0,
        stdout:
          `✓ migrate reset: re-synced dev DB to the declarations — dropped ${dropped} object(s), re-derived + pushed ${app.model.length} resource(s) across ${app.schemas.length} schema(s)${auditNote}`,
      };
    }
    const drift = await checkBaseline(db, app);
    if (drift.length === 0) {
      return { code: 0, stdout: "✓ migrate check: no drift" };
    }
    return {
      code: 1,
      stdout: [
        "✗ migrate check: drift detected",
        ...drift.map((d) => `  - ${d}`),
      ].join("\n"),
    };
  } catch (e) {
    return { code: 2, stdout: `migrate: ${explainError(e)}` };
  }
}

// roster/engine extracted into cohesive submodules, re-exported so importers stay stable.
export * from "./migrate-verbs-shared.ts";
export * from "./migrate-verbs-gen.ts";
export * from "./migrate-verbs-rebase.ts";
