// did-you-mean lives in core/validation.ts (a leaf, so the deriver can reach it too); re-exported here
// because `cli.ts` is the CLI barrel and its consumers name it there.
export { didYouMean } from "../core/validation.ts";

import type { Violation } from "../core/verifier-contract.ts";
import { docsOnDisk } from "../core/docs-probe.ts";
import {
  BLOCKS_LABEL,
  BLOCKS_ORDER,
  blocksLabelBare,
  renderFix,
  renderFixHint,
  rungRank,
} from "./render-blocks.ts";
/** Violation rendering: `renderViolation` (one finding → a human line with rung/at/responsible/fixHint) +
 *  `renderViolations` (a grouped block). Shared by the verify/explain CLI surfaces. */
/** CH1 single-violation render (09-verifier.md §5): `<BLOCKS> <id> · <message>` plus fix/at/docs lines; `at:`
 *  is suppressed when the symptom file equals the responsible cause path. */
export function renderViolation(
  v: Violation,
  opts: { feature?: string; docsOnDisk?: boolean } = {},
): string {
  const lines = [
    `  ${blocksLabelBare(v.blocks)} ${v.id} · ${v.message}`,
    renderFix(v),
  ];
  if (v.fixHint) lines.push(`          → ${renderFixHint(v.fixHint)}`);
  // The cause path for a localized declaration/logic Violation; `at.file` shares its shape, so an equal value
  // means the symptom pointer is redundant — suppress it (09-verifier.md §5). A derived symptom always shows.
  const causeFile = v.responsible.kind === "declaration"
    ? `${v.responsible.ref.module}/${v.responsible.ref.resource ?? ""}`
    : v.responsible.kind === "logic"
    ? v.responsible.file
    : undefined;
  const generated = v.at.file.includes("(generated)") ||
    v.at.file.endsWith("__generated");
  if (causeFile === undefined || v.at.file !== causeFile || generated) {
    lines.push(
      `    at:   ${v.at.file}:${v.at.startLine}${
        generated ? " (generated)" : ""
      }`,
    );
  }
  // The docs: pointer renders only when the canon tree is on disk beside the CLI — a vendored / `--pin`
  // consumer ships src/ only, so the pointer would be a dead end; the explain footer is their path.
  if (v.docRef !== undefined && (opts.docsOnDisk ?? docsOnDisk())) {
    lines.push(`    docs: ${v.docRef}`);
  }
  // Semantics footer (09-verifier.md §5): a render-layer affordance closing the symptom→semantics loop —
  // `hazelnut explain <feature>` when the finding carries a feature, else `hazelnut explain <id>`.
  lines.push(
    `    · framework semantics: hazelnut explain ${opts.feature ?? v.id}`,
  );
  return lines.join("\n");
}

/** CH1 human render — grouped by `blocks`, hardest-rung-first within a group; each finding renders through
 *  the single `renderViolation` grammar (the same `Violation[]` `--json`/`--sarif` serialize). */
export function renderViolations(violations: ReadonlyArray<Violation>): string {
  const groups = BLOCKS_ORDER
    .map((b) => ({
      blocks: b,
      items: violations.filter((v) => v.blocks === b).slice().sort((a, z) =>
        rungRank(a.rung) - rungRank(z.rung)
      ),
    }))
    .filter((g) => g.items.length > 0);
  return groups.flatMap((g) => [
    `${BLOCKS_LABEL[g.blocks]} (${g.items.length})`,
    ...g.items.map((v) => renderViolation(v)),
  ]).join("\n");
}
