// did-you-mean lives in core/validation.ts (a leaf, so the deriver can reach it too); re-exported here
// because `cli.ts` is the CLI barrel and its consumers name it there.
export { didYouMean } from "../core/validation.ts";

import type { Violation } from "../core/verifier-contract.ts";
import { docsOnDisk } from "../core/docs-probe.ts";
import {
  BLOCKS_LABEL,
  BLOCKS_ORDER,
  blocksLabelBare,
  groupRepeatedFindings,
  renderFix,
  renderFixHint,
  rungRank,
} from "./render-blocks.ts";
/** Violation rendering: `renderViolation` (one finding → a human line with rung/at/responsible/fixHint) +
 *  `renderViolations` (a grouped block). Shared by the verify/explain CLI surfaces. */
/** CH1 single-violation render (09-verifier.md §violation-across-four-channels): `<BLOCKS> <id> · <message>` plus fix/at/docs lines; `at:`
 *  is suppressed when the symptom file equals the responsible cause path. */
export function renderViolation(
  v: Violation,
  opts: { feature?: string; docsOnDisk?: boolean; explainAvailable?: boolean } =
    {},
): string {
  return renderFindingGroup(v, [], opts);
}

function renderFindingGroup(
  v: Violation,
  others: readonly Violation[],
  opts: { feature?: string; docsOnDisk?: boolean; explainAvailable?: boolean },
): string {
  const count = others.length > 0 ? ` (${others.length + 1} locations)` : "";
  const lines = [
    `  ${blocksLabelBare(v.blocks)} ${v.id}${count} · ${v.message}`,
    renderFix(v),
  ];
  if (v.fixHint) lines.push(`          → ${renderFixHint(v.fixHint)}`);
  // The cause path for a localized declaration/logic Violation; `at.file` shares its shape, so an equal value
  // means the symptom pointer is redundant — suppress it (09-verifier.md §violation-across-four-channels). A derived symptom always shows.
  const causeFile = v.responsible.kind === "declaration"
    ? `${v.responsible.ref.module}/${v.responsible.ref.resource ?? ""}`
    : v.responsible.kind === "logic"
    ? v.responsible.file
    : undefined;
  for (const { at } of [v, ...others]) {
    const generated = at.file.includes("(generated)") ||
      at.file.endsWith("__generated");
    if (causeFile === undefined || at.file !== causeFile || generated) {
      lines.push(
        `    at:   ${at.file}:${at.startLine}${
          generated ? " (generated)" : ""
        }`,
      );
    }
  }
  // The docs: pointer renders only when the canon tree is on disk beside the CLI — a vendored / `--pin`
  // consumer ships src/ only, so the pointer would be a dead end; the explain footer is their path.
  if (
    opts.explainAvailable && v.docRef !== undefined &&
    (opts.docsOnDisk ?? docsOnDisk())
  ) {
    lines.push(`    docs: ${v.docRef}`);
  }
  // Semantics footer (09-verifier.md §violation-across-four-channels): a render-layer affordance closing the symptom→semantics loop —
  // `hazelnut explain <feature>` when the finding carries a feature, else `hazelnut explain <id>`.
  lines.push(
    opts.explainAvailable
      ? `    · framework semantics: hazelnut explain ${opts.feature ?? v.id}`
      : "    · framework guide: https://github.com/Hazelnut-17/hazelnut/blob/main/core/docs/rundown.md",
  );
  return lines.join("\n");
}

/** CH1 human render — grouped by `blocks`, hardest-rung-first within a group; each finding renders through
 *  the single `renderViolation` grammar (the same `Violation[]` `--json`/`--sarif` serialize). */
export function renderViolations(
  violations: ReadonlyArray<Violation>,
  opts: { explainAvailable?: boolean } = {},
): string {
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
    ...groupRepeatedFindings(g.items).map(([v, ...others]) =>
      renderFindingGroup(v, others, opts)
    ),
  ]).join("\n");
}
