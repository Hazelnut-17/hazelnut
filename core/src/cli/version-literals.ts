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
): Violation[] {
  const texts: Record<string, string> = { ...sources };
  if (denoJson !== undefined) texts["deno.json"] = denoJson;
  const message = describeMixedFrameworkVersions(
    collectFrameworkVersionLiterals(texts),
  );
  if (message === null) return [];
  const at = { file: "deno.json", startLine: 1 };
  const responsible = {
    kind: "unknown" as const,
    why: "this tree names more than one published framework version",
  };
  return [{
    id: "version/projection-fresh",
    rung: "runtime-assert",
    blocks: "ship",
    phase: "pre-ship",
    at,
    responsible,
    message,
    fixHint: {
      kind: "text",
      guidance:
        "make every `jsr:@hazelnut/core@<version>` in deno.json and app source the same version",
    },
    fingerprint: fingerprint({
      id: "version/projection-fresh",
      at,
      responsible,
    }),
    source: "verify",
  }];
}
