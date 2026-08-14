// Every verb this CLI dispatches, classified by what its BARE invocation can leave behind — and, for the
// class that escapes the verify loop, which brake holds the bare form back. A partition, held by equality.

/**
 * What the shortest form of a verb can leave behind.
 *
 * `irreversible-write` is the only class the plan rule binds: nothing in this repo's verification apparatus
 * — the invariant registry, the ratchet teeth, `verify`, `doctor` — aims at the operator CLI, so a verb that
 * re-fires production side effects had no rule to violate. This partition is that rule's subject.
 */
export type VerbConsequence =
  | "read" // writes nothing, anywhere
  | "reversible-write" // writes into the working tree — `git checkout` is the undo
  | "standing-process" // a supervised server/drain; acting continuously IS its contract
  | "irreversible-write"; // mutates the connected datastore, or re-fires an external effect

/** The brake that holds an `irreversible-write` verb's bare form back from acting. `--execute` renders a
 *  plan and changes nothing without it; `prod-env-guard` is the migrate family's confirm/flat-refuse gate. */
export type PlanGate = "--execute" | "prod-env-guard";

export interface VerbClass {
  readonly consequence: VerbConsequence;
  /** Present on exactly the `irreversible-write` verbs — the partition IS the rule, so an absent gate on a
   *  writing verb and a present one on a reading verb are both RED. */
  readonly planGate?: PlanGate;
}

/** The classification, one entry per served verb across every capability module.
 *  The key set is EQUAL to `CORE_VERBS ⊎ VERIFY_ENVELOPE_VERBS ⊎ UPGRADE_VERBS`, both directions. */
export const VERB_CLASS: Readonly<Record<string, VerbClass>> = {
  // ── core ──
  help: { consequence: "read" },
  new: { consequence: "reversible-write" },
  add: { consequence: "reversible-write" },
  install: { consequence: "reversible-write" },
  doctor: { consequence: "read" },
  // `verify` re-projects AGENTS.md/ARCHITECTURE.md only under `--refresh`; the bare verdict reads.
  verify: { consequence: "read" },
  migrate: { consequence: "irreversible-write", planGate: "prod-env-guard" },
  launch: { consequence: "standing-process" },
  mcp: { consequence: "reversible-write" }, // writes the transport entry file, never overwrites
  relay: { consequence: "standing-process" },
  // a lever is reversible by its twin, but it lands in the connected datastore and changes what production
  // does the moment it commits — the same class, and the same brake, as the other datastore-writing verbs.
  ops: { consequence: "irreversible-write", planGate: "--execute" },
  redrive: { consequence: "irreversible-write", planGate: "--execute" },
  "rotate-key": { consequence: "irreversible-write", planGate: "--execute" },
  "run-workflow": { consequence: "irreversible-write", planGate: "--execute" },
  "unstick-workflow": {
    consequence: "irreversible-write",
    planGate: "--execute",
  },
  // ── verify module ──
  explain: { consequence: "read" },
  eval: { consequence: "read" },
  steer: { consequence: "read" },
  "verify-integrity": { consequence: "read" },
  // ── upgrade module ──
  upgrade: { consequence: "reversible-write" }, // `--apply` is dry-run by default; `--plan`/`--apply-plan`
  diff: { consequence: "reversible-write" }, // writes the surface locks it just verified
} as const;

/** The ONE reader of `--execute` across the CLI. Centralised so the three plan-first verbs cannot drift
 *  apart on the spelling, and so a new one inherits the same brake by calling this rather than re-deciding. */
export function executeRequested(argv: readonly string[]): boolean {
  return argv.includes("--execute");
}

/** The one line every plan ends on. Shared so the three plan renderers cannot drift apart, and so a reader
 *  who has seen one recognises the next. */
export function planFooter(verb: string, argv: string): string {
  return `  nothing was changed. re-run with --execute to land exactly this:  hazelnut ${verb} ${argv} --execute`;
}
