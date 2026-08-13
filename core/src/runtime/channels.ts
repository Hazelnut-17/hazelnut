import {
  type Channel,
  deriveBlocks,
  fingerprint,
  type Span,
  type Violation,
} from "../core/verifier-contract.ts";
import { docRefForRung } from "../core/docref.ts";
import { docsOnDisk } from "../core/docs-probe.ts";

// Cross-channel id routing (09-verifier.md §5): one Violation shape, four channels of differing
// fidelity. CH2's lint rule key is dash-mangled, so the canonical slash-id rides in the message's `[id]` prefix.

/** What the lint plugin writes: `[<canonical-id>] <body>` — the `[id]` prefix is the routing key. */
export function lintMessage(canonicalId: string, body: string): string {
  return `[${canonicalId}] ${body}`;
}

/** Recover the canonical slash-id from a lint message's `[id]` prefix (null = no prefix → unrecoverable here). */
export function recoverCanonicalId(message: string): string | null {
  const m = /^\[([^\]]+)\]/.exec(message);
  return m ? m[1]! : null;
}

/** A channel's native fidelity: CH1 verify is full; lint/test/judge are partial; the type channel is lowest. */
export function channelFidelity(
  channel: Channel,
): "full" | "partial" | "lowest" {
  return channel === "verify"
    ? "full"
    : channel === "type"
    ? "lowest"
    : "partial";
}

// CH3 (deno check) re-attribution (09-verifier.md §5): tsc's TSxxxx code maps through a three-tier,
// stop-at-first funnel; tier 2 unmapped emits `type/unmapped` and degrades to `unknown`, never confident-wrong.
const TYPE_INVARIANTS = [
  "refs/typed",
  "errors/result-type",
  "transition/legal-target",
] as const;
const TIER1: Record<string, typeof TYPE_INVARIANTS[number]> = {
  TS2322: "refs/typed", // Type X is not assignable to type Y
  TS2345: "refs/typed", // Argument of type X is not assignable to parameter Y
  TS2741: "errors/result-type", // Property missing — a Result shape that lost its ok/err discriminant
  TS2367: "transition/legal-target", // comparison appears unintentional — an illegal transition target
};

/** Resolves file → package identity for CH3 Tier-2 attribution (09-verifier.md §5); the caller passes the
 *  boot `ImportGraph.packageOf`, or `mapTypeError` falls back to the path-based `frameworkVsAppPath` floor. */
export type PackageOf = (file: string) => "framework" | "app" | "unknown";

/** Path-based framework-vs-app floor (09-verifier.md §5 CH3): framework `src/<file>.ts`, `.d.ts`, or
 *  `/.cache/` paths are `framework`; `<module>/<resource>` or app `*.ts` spans are `app`; else `unknown`. */
export function frameworkVsAppPath(
  file: string,
): "framework" | "app" | "unknown" {
  if (file === "") return "unknown";
  const f = file.replace(/^\.\//, "");
  if (
    /^src\/[^/]+\.ts$/.test(f) || f.endsWith(".d.ts") || f.includes("/.cache/")
  ) return "framework";
  if (
    /^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(f) || f.startsWith("app/") ||
    /\.(ts|tsx)$/.test(f)
  ) return "app";
  return "unknown";
}

export interface TscError {
  readonly code: string;
  readonly message: string;
  readonly at: Span;
  readonly chainMined?: boolean;
}

/** Re-attributes one CH3 tsc diagnostic to a Violation via the default `frameworkVsAppPath` resolver
 *  (09-verifier.md §5); a single-arg mapper so `errors.map(mapTypeError)` stays valid — the package
 *  seam rides the curried `mapTypeErrorVia(packageOf)` instead. */
export function mapTypeError(err: TscError): Violation {
  return mapTypeErrorVia(frameworkVsAppPath)(err);
}

/** Curried CH3 re-attribution bound to a `packageOf` resolver, for a caller holding the boot `ImportGraph`. */
export function mapTypeErrorVia(
  packageOf: PackageOf,
): (err: TscError) => Violation {
  return (err: TscError): Violation => {
    const named = TIER1[err.code];
    const id = named ?? "type/unmapped";
    // tier 1 (named) is deterministic; tier 2 (chain-mined) only attributes when the span is app-authored,
    // else degrades to unknown — a mine never claims a framework declaration (09-verifier.md §5).
    const minedIsApp = err.chainMined === true &&
      packageOf(err.at.file) === "app";
    const responsible = (named || minedIsApp)
      ? {
        kind: "declaration" as const,
        ref: { module: err.at.file, span: err.at },
      }
      : {
        kind: "unknown" as const,
        why: err.chainMined
          ? `tsc ${err.code} chain-mined to a non-app span (${err.at.file}) — degraded to unknown, never a framework declaration`
          : `tsc ${err.code} not in the deterministic type map`,
      };
    return {
      id,
      rung: "type",
      blocks: deriveBlocks("type"),
      phase: "pre-ship",
      at: err.at,
      responsible,
      message: err.message,
      // every CH3 type finding documents at the roster's type-axis section (a slash-bearing `§<id>` never
      // resolves — 10-invariants.md is a table roster, not a heading per id; see docref.ts).
      // Gated like every other emitter: this record reaches a consumer, and a doc pointer is only
      // actionable when the docs sit beside the running framework.
      docRef: docsOnDisk() ? docRefForRung("type") : "",
      fingerprint: fingerprint({ id, at: err.at, responsible }),
      source: "type",
    };
  };
}
