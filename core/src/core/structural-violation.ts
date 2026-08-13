import type { Responsible, Rung } from "./verifier-contract.ts";

// The NARROW structural-rung finding an invariant `check` returns (and runtime advisories emit);
// the verifier's `enrich` widens it to the canon cross-channel `Violation` (09-verifier.md §3).
export interface Violation {
  readonly id: string;
  readonly resource: string;
  readonly message: string;
  // Dotted clause the finding is about (column/route/ref) — part of finding identity (09-verifier.md
  // §dedupe): a waiver on one clause never masks another. Omitted = resource-granular.
  readonly clause?: string;
}

/** A raw app-level finding — no single `resource` owns it, so it carries an explicit `responsible`
 *  (`kind:"unknown"` with a `why`, the honest floor for a framework-roster/topology fault;
 *  09-verifier.md §finding-contract). */
export interface AppViolation {
  readonly id: string;
  readonly message: string;
  readonly rung?: Rung;
  readonly responsible: Responsible;
}
