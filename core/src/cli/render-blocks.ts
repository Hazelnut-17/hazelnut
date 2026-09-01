// Violation-render primitives (blocks/rung ordering + fix-line renderers) — the LEAF both `cli.ts`
// (barrel) and `render.ts` stand on, so neither imports the other (import-cycle-gate keeps this acyclic).
import {
  type Blocks,
  type FixHint,
  responsiblePath,
  type Rung,
  type Violation,
} from "../core/verifier-contract.ts";

/** Group ordering: ship first (it gates), then warn, then advisory — front-load the gating verdict. */
export const BLOCKS_ORDER: readonly Blocks[] = ["ship", "warn", "advisory"];
export const BLOCKS_LABEL: Record<Blocks, string> = {
  ship: "✗ SHIP-BLOCKING",
  warn: "⚠ WARN",
  advisory: "· ADVISORY",
};
/** Within a group: hardest rung first (fix the hard rungs first, 09-verifier.md §rung-delivery). */
const RUNG_ORDER: readonly Rung[] = [
  "by-construction",
  "type",
  "static",
  "property",
  "runtime-assert",
  "judge",
];
export const rungRank = (r: Rung): number => RUNG_ORDER.indexOf(r);

/** The bare `<BLOCKS>` label without the leading glyph — the group header carries the glyph, each finding
 *  line repeats only the label (`SHIP-BLOCKING <id> · …`). */
export const blocksLabelBare = (b: Blocks): string =>
  BLOCKS_LABEL[b].replace(/^[^ ]+ /, "");

/** Render a `FixHint` to the exact next-edit line (09-verifier.md §5). Every one of the contract's six
 *  kinds is covered; the caller omits it entirely when absent (never faked). */
export function renderFixHint(h: FixHint): string {
  switch (h.kind) {
    case "rename-id":
      return `rename id '${h.from}' → '${h.to}'`;
    case "edit":
      return `edit ${h.span.file}:${h.span.startLine} → ${h.replacement}`;
    case "add-clause":
      return `add clause '${h.clause}' to ${h.ref.module}/${
        h.ref.resource ?? ""
      }${h.exampleFrom ? ` (e.g. ${h.exampleFrom})` : ""}`;
    case "remove":
      return `remove ${h.span.file}:${h.span.startLine}`;
    case "add-escape":
      return `add escape: ${h.comment}`;
    case "text":
      return h.guidance;
  }
}

/** The `fix:` cause-location line — the responsible cause, never `at` (the symptom). `unknown` renders the
 *  honest `why`, never a fabricated `file:line`. */
export function renderFix(v: Violation): string {
  const p = responsiblePath(v.responsible);
  return v.responsible.kind === "unknown"
    ? `    fix:  (cause not localized) ${p}`
    : `    fix:  ${p}`;
}
