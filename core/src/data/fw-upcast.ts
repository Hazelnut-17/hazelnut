/**
 * Framework-table at-rest format versioning (cli/migrate.md §framework-table-evolution): the `_outbox` /
 * `_outbox_dead` / `_processed` trio carries a per-row `_fw_schema_version` (the table-shape revision,
 * distinct from `_outbox.schema_version`, the event payload contract) and upcasts to the current revision
 * on read; a missing chain link throws loud. Every table sits at revision 1 today. Pins: fw-upcast.test.ts.
 */

/** One upcast link: reshape a `<table>` row from revision `from` to `from + 1`. Pure. */
export interface FwUpcaster {
  readonly table: string;
  readonly from: number;
  upcast(row: Record<string, unknown>): Record<string, unknown>;
}

/** The at-rest pin: the current table-shape revision per table + the upcaster chain (keyed `${table}@${from}`).
 *  Immutable — the framework const is `FRAMEWORK_FW_PIN`; a test builds a synthetic one with `buildFwPin`. */
export interface FwUpcastPin {
  readonly revisions: ReadonlyMap<string, number>;
  readonly upcasters: ReadonlyMap<string, FwUpcaster>;
}

/** The framework pin at this version — every trio table sits at revision 1 today (the walk is a passthrough).
 *  Not exported: consumers reach it via the `fwUpcastRow`/`fwTableRevision` default-arg, so there is one home. */
const FRAMEWORK_FW_PIN: FwUpcastPin = {
  revisions: new Map<string, number>([["_outbox", 1], ["_outbox_dead", 1], [
    "_processed",
    1,
  ]]),
  upcasters: new Map<string, FwUpcaster>(),
};

/** Build a synthetic pin (tests prime one; the framework const is `FRAMEWORK_FW_PIN`). Pure — no
 *  process-global side effect, so two tests can't clobber each other and there is no reset to forget. */
export function buildFwPin(
  upcasters: readonly FwUpcaster[],
  revisions?: Readonly<Record<string, number>>,
): FwUpcastPin {
  return {
    revisions: new Map(Object.entries(revisions ?? {})),
    upcasters: new Map(upcasters.map((u) => [`${u.table}@${u.from}`, u])),
  };
}

/** The current table-shape revision new rows are stamped with (DDL DEFAULT mirrors it at revision 1). */
export function fwTableRevision(
  table: string,
  pin: FwUpcastPin = FRAMEWORK_FW_PIN,
): number {
  return pin.revisions.get(table) ?? 1;
}

/**
 * Walk a stored row to the current revision through the pin's chain; a revision-current row short-circuits.
 * A missing chain link throws loud, naming the gap. `pin` defaults to the framework const; a test injects
 * a synthetic one. `to` defaults to the pin's current revision for `table`.
 */
export function fwUpcastRow(
  table: string,
  row: Record<string, unknown>,
  pin: FwUpcastPin = FRAMEWORK_FW_PIN,
  to: number = fwTableRevision(table, pin), // the current revision — kept DRY with fwTableRevision, never re-inlined
): Record<string, unknown> {
  let rev = typeof row._fw_schema_version === "number"
    ? row._fw_schema_version
    : 1;
  if (rev === to) return row;
  if (rev > to) {
    throw new Error(
      `fw-upcast: a '${table}' row is at revision ${rev}, NEWER than this pin's ${to} — a newer framework wrote this store; upgrade the pin (never down-cast at read)`,
    );
  }
  let cur = row;
  while (rev < to) {
    const link = pin.upcasters.get(`${table}@${rev}`);
    if (!link) {
      throw new Error(
        `fw-upcast: no upcaster registered for '${table}' revision ${rev} → ${
          rev + 1
        } (target ${to}) — the pin's chain has a gap; a stored row cannot be read as-current`,
      );
    }
    cur = link.upcast(cur);
    rev++;
  }
  return { ...cur, _fw_schema_version: to };
}
