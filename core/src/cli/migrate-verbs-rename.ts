/**
 * `hazelnut migrate <app> rename` — the operator declares a column rename that a diff cannot infer.
 *
 * A rename and a drop+create produce the IDENTICAL declaration diff: the declaration describes the END
 * state, and which path reached it is a fact no declaration carries. drizzle-kit therefore refuses
 * (`missing_hints`) rather than guess, because guessing drop+create discards the column's data. That left
 * a real gap — no door expressed "this is a rename", so a column could not be renamed at all.
 *
 * This verb supplies the missing bit as drizzle-kit's own `--hints` resolution, so the migration and its
 * snapshot are authored by the same engine every other migration goes through — no hand-forged snapshot,
 * and the `prevIds[]` DAG chains normally.
 *
 * WHAT IT IS NOT: expand-contract. One `ALTER TABLE … RENAME COLUMN` is atomic and preserves data, but the
 * old name stops existing the moment it applies, so code still reading it breaks. That is a COMPATIBILITY
 * class, not the data-loss class `--allow-destructive` gates or the lock-stall class `--allow-unsafe-ddl`
 * gates — reusing either would blur a gate that already means something precise. It has its own consent.
 */
import type { App } from "../core/app.ts";
import { runDrizzleKitGenerate } from "../data/migrate-drizzle-schema.ts";
import { segmentErr } from "../core/app-define.ts";

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
}

/** The rolling-safe alternative, named wherever this verb refuses or warns — one spelling, so the refusal
 *  and the success banner cannot describe it differently. */
const EXPAND_CONTRACT_RECIPE =
  "add the new column nullable and generate, backfill it, then drop the old column in a LATER migration once nothing reads it";

/** `--table` accepts `schema.table`; a bare name is `public`, the schema a non-modular app derives to. */
export function splitQualifiedTable(
  table: string,
): { schema: string; table: string } {
  const at = table.indexOf(".");
  return at === -1
    ? { schema: "public", table }
    : { schema: table.slice(0, at), table: table.slice(at + 1) };
}

export async function cliMigrateRename(
  app: App,
  opts: {
    table?: string;
    from?: string;
    to?: string;
    out?: string;
    offline?: boolean;
    drizzleKitPin?: string;
    /** `--allow-incompatible`: the operator's confirm that readers of the OLD name may break. Absent, the
     *  rename is refused and nothing is written — the same "refuse AND unwrite" shape the other two
     *  consents use, so a blocked rename cannot be laundered into a clean exit by a bare re-run. */
    allowIncompatible?: boolean;
  } = {},
): Promise<CliResult> {
  const missing = (["table", "from", "to"] as const).filter((k) =>
    opts[k] === undefined || opts[k] === ""
  );
  if (missing.length > 0) {
    return {
      code: 2,
      stdout: `✗ migrate rename: ${
        missing.map((m) => `--${m}`).join(", ")
      } required — ` +
        `usage: hazelnut migrate <app> rename --table <[schema.]table> --from <column> --to <column>`,
    };
  }
  const { schema, table } = splitQualifiedTable(opts.table!);
  // The three identifiers reach drizzle-kit's hint and, through it, emitted DDL. They are bound to the same
  // charset every declared name obeys rather than quoted-and-hoped: an identifier this framework would not
  // let you DECLARE is not one it should let you rename to.
  for (
    const [what, value] of [
      ["schema", schema],
      ["table", table],
      ["--from column", opts.from!],
      ["--to column", opts.to!],
    ] as const
  ) {
    const e = segmentErr(value, what);
    if (e) return { code: 2, stdout: `✗ migrate rename: ${e}` };
  }
  if (opts.from === opts.to) {
    return {
      code: 2,
      stdout:
        `✗ migrate rename: --from and --to are both '${opts.from}' — nothing to rename`,
    };
  }
  if (opts.allowIncompatible !== true) {
    return {
      code: 2,
      stdout: [
        `✗ migrate rename: renaming ${schema}.${table}.${opts.from} → ${opts.to} is atomic and keeps the data,`,
        `  but the OLD name stops existing the moment it applies, so anything still reading it breaks.`,
        ``,
        `  For a rolling deploy, do NOT rename — ${EXPAND_CONTRACT_RECIPE}.`,
        `  Each of those steps is an ordinary \`migrate generate\`.`,
        ``,
        `  For a maintenance window or a single-replica deploy, re-run with --allow-incompatible.`,
      ].join("\n"),
    };
  }
  if (opts.out === undefined) {
    return {
      code: 2,
      stdout: "✗ migrate rename: no migration directory to write to",
    };
  }
  const gen = await runDrizzleKitGenerate(app, {
    out: opts.out,
    name: `rename_${opts.from}_to_${opts.to}`,
    offline: opts.offline,
    drizzleKitPin: opts.drizzleKitPin,
    hints: [{
      type: "rename",
      kind: "column",
      from: [schema, table, opts.from!],
      to: [schema, table, opts.to!],
    }],
  });
  if (!gen.created) {
    // A hint that resolved nothing means the declaration does not describe this rename — the operator
    // renamed in the CLI without renaming in the declaration, or named a column that is not moving.
    return {
      code: 2,
      stdout: `✗ migrate rename: ${gen.reason}\n` +
        `  The declaration is the source: rename the field in defineResource first, then run this verb to say WHICH old column it was.`,
    };
  }
  return {
    code: 0,
    stdout: [
      `✓ migrate rename — ${gen.dir}`,
      `  ${schema}.${table}.${opts.from} → ${opts.to} (data preserved, old name gone)`,
      `  Readers of the old name break at apply time; for a rolling deploy the path is instead to ${EXPAND_CONTRACT_RECIPE}.`,
    ].join("\n"),
  };
}
