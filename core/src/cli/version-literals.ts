import { collectFrameworkVersionLiterals } from "./doctor.ts";
import { fingerprint, type Violation } from "../core/verifier-contract.ts";

/** `jsr:@hazelnut/core@<version>` literals across deno.json + app source that name more than one
 *  version — a half-upgraded app whose `verify` task still runs the old CLI. Ship-blocks: `ci`
 *  chains verify, and a warn here is how a mixed pin stayed green. Core-safe: no verify-module import. */
export function versionLiteralViolations(
  denoJson: string | undefined,
  sources: Readonly<Record<string, string>> = {},
): Violation[] {
  const texts: Record<string, string> = { ...sources };
  if (denoJson !== undefined) texts["deno.json"] = denoJson;
  const found = collectFrameworkVersionLiterals(texts);
  if (found.size <= 1) return [];
  const at = { file: "deno.json", startLine: 1 };
  const where = [...found.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([v, paths]) => `${v} (${[...paths].sort().join(", ")})`);
  const responsible = {
    kind: "unknown" as const,
    why: `this tree names ${found.size} published framework versions`,
  };
  return [{
    id: "version/projection-fresh",
    rung: "runtime-assert",
    blocks: "ship",
    phase: "pre-ship",
    at,
    responsible,
    message: `this tree names ${found.size} framework versions — ${
      where.join("; ")
    }. A task or import still running the older CLI is not verifying the app you think.`,
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
