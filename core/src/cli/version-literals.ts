import {
  collectFrameworkVersionLiterals,
  describeMixedFrameworkVersions,
} from "../core/framework-literals.ts";
import { fingerprint, type Violation } from "../core/verifier-contract.ts";

/** `jsr:@hazelnut/core@<version>` literals across deno.json + app source that name more than one
 *  version — a half-upgraded app whose task line still runs the old CLI. Ship-blocks live in
 *  `deno lint` (ci step 1, current plugin) as well as this fold, because a leftover task is
 *  the old CLI and cannot gate itself. Core-safe: no capability-module import. */
export function versionLiteralViolations(
  denoJson: string | undefined,
  sources: Readonly<Record<string, string>> = {},
  unreadable: readonly string[] = [],
): Violation[] {
  const texts: Record<string, string> = { ...sources };
  if (denoJson !== undefined) texts["deno.json"] = denoJson;
  const mixed = describeMixedFrameworkVersions(
    collectFrameworkVersionLiterals(texts),
  );
  const skipped = unreadable.length === 0
    ? null
    : `${
      unreadable.join(", ")
    } could not be read; a framework pin there was not checked`;
  const message = mixed === null
    ? skipped
    : skipped === null
    ? mixed
    : `${mixed}; ${skipped}`;
  if (message === null) return [];
  const unreadOnly = mixed === null;
  const at = { file: "deno.json", startLine: 1 };
  const responsible = {
    kind: "unknown" as const,
    why: unreadOnly
      ? "a pin-coherence file could not be read"
      : "this tree names more than one published framework version",
  };
  return [{
    id: "version/projection-fresh",
    rung: "runtime-assert",
    // deriveBlocks("runtime-assert") is advisory (a runtime assert normally surfaces post-ship); a
    // half-upgraded version literal is caught pre-ship, on a tree that has not shipped yet, so it hard-gates.
    // An unreadable pin seat is the same gate: a clean report over a file the scan never opened is not a verdict.
    blocks: "ship",
    phase: "pre-ship",
    at,
    responsible,
    message,
    fixHint: {
      kind: "text",
      guidance: unreadOnly
        ? "make the listed path(s) readable and re-run"
        : "make every `jsr:@hazelnut/core@<version>` in deno.json and app source the same version",
    },
    fingerprint: fingerprint({
      id: "version/projection-fresh",
      at,
      responsible,
    }),
    source: "verify",
  }];
}
