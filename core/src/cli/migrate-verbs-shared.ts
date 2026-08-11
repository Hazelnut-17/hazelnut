// Shared migrate-verb leaf — the pieces `migrate-verbs.ts` (barrel), `-gen`, and `-rebase` all stand on,
// extracted so no verb file imports another through the barrel (import-cycle-gate keeps the trio acyclic).
import type { MigrationEntry } from "../data/migrate.ts";
import type { CliResult } from "./cli.ts";

/** The result of `cliMigrateGenerate` — a `CliResult` superset plus the optional `.data.ts` shell emit map.
 *  The pure core returns `{path: content}`; `hazelnut.ts` writes it (emit is data, disk I/O is the shell). */
export interface MigrateGenerateResult extends CliResult {
  readonly emit?: Readonly<Record<string, string>>;
}

/**
 * The pure `.data.ts` shell emitter (cli/migrate.md §data-migration): for each ambiguous-rename dropped
 * column, returns one `migrations/<dir>/<col>.data.ts` entry at the same ordinal `dir` as the sibling DDL.
 * The stub's `forward` is born RED (throws `TODO: hand-write this data transform`) so an unfilled transform
 * fails loudly at run. No disk side-effects — `hazelnut.ts` writes the returned map.
 */
export function scaffoldDataMigration(
  opts: { dir: string; table: string; columns: readonly string[] },
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const col of [...opts.columns].sort()) {
    const path = `migrations/${opts.dir}/${col}.data.ts`;
    out[path] = `import { dataMigration } from "hazelnut";

// Data-transform SHELL for '${opts.table}.${col}' (cli/migrate.md §data-migration). The framework emitted this
// shell at the same ordinal position as its DDL sibling; the \`forward\` body is YOURS to hand-write. drizzle-kit
// does DDL only — a column whose new value derives from the old rows needs this value transform.
export default dataMigration({
  // \`reads\` is the intermediate (old + new coexisting) row; \`writes\` is the new column. Both are inferred from
  // your declarations (z.infer / Drizzle) — fill the bodies, never code-generate the types.
  forward: (_row) => {
    throw new Error("TODO: hand-write this data transform for ${opts.table}.${col}");
  },
  reversible: false,
});
`;
  }
  return out;
}

/**
 * Walks the `prevIds[]` DAG of a read drizzle migration history (cli/migrate.md §history-linearization):
 * a node with ≥2 children is a fork drizzle-kit's own `check` does not detect.
 * @returns the fork-point ids, empty when the chain is a single leaf.
 */
export function forkPointsInHistory(
  history: ReadonlyArray<MigrationEntry>,
): string[] {
  const childCount = new Map<string, number>();
  for (const m of history) {
    for (const parent of m.prevIds) {
      childCount.set(parent, (childCount.get(parent) ?? 0) + 1);
    }
  }
  return [...childCount.entries()].filter(([, n]) => n >= 2).map(([id]) => id)
    .sort();
}
