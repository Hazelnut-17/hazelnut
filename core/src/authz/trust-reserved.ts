/** A principal is an opaque identity string (a git author, a CI actor), never trusted as unforgeable (§2) —
 *  only the structural `creator !== clearer` distinctness is enforced. */
export type Principal = string;

/** A born-unreviewed waiver: no `clearedBy` field at creation (§8 "born unreviewed" — a self-mintable
 *  `accepted` would be self-suppressing). Clearing produces a distinct `ClearedWaiver`, never mutates this. */
export interface Waiver {
  readonly id: string;
  readonly createdBy: Principal;
  readonly why: string;
}

/** A waiver cleared by an independent principal. Reachable only through `clearWaiver`, which refuses a
 *  same-principal clear — so the type itself witnesses `clearedBy !== createdBy`. */
export interface ClearedWaiver extends Waiver {
  readonly clearedBy: Principal;
}

/** Mint a born-unreviewed waiver. No actor can mint it pre-cleared (§8: born unreviewed). */
export function createWaiver(
  args: { id: string; createdBy: Principal; why: string },
): Waiver {
  return { id: args.id, createdBy: args.createdBy, why: args.why };
}

/** Structural check (the dev-loop `ctx.actor` rule): a waiver is clearable by `principal` IFF that principal is
 *  not its creator. A self-clear is forbidden by construction, never by configurable policy. */
export function canClearWaiver(waiver: Waiver, principal: Principal): boolean {
  return waiver.createdBy !== principal;
}

/** Clear a waiver with an independent principal. Returns the `ClearedWaiver`, or `null` on a self-clear
 *  (§8/§13 — the generating agent can NEVER self-clear); `null` not a throw, the caller surfaces it loudly. */
export function clearWaiver(
  waiver: Waiver,
  clearedBy: Principal,
): ClearedWaiver | null {
  if (!canClearWaiver(waiver, clearedBy)) return null; // self-clear refused by construction (the ctx.actor rule)
  return { ...waiver, clearedBy };
}

// ── The acceptance-discipline STATUS classifier (§13 + 15-oversight.md §3) ──
// The dev-loop mirror of `ctx.actor` on a review-queue item: born `unreviewed`; only an independent principal
// flips it to `accepted`; the generating principal may annotate (`self-acked`) but never self-clear. Pure
// creator-vs-acker classification — the git-blame resolution of actual principals is build-sequenced
// (15-oversight.md §8) and feeds this floor predicate. No mintable `accepted` label exists (§13).
/**
 * There is NO `accepted` MARKER (§13 / 15-oversight.md §3): a comment that self-flips a still-firing item to
 * `accepted` would be queue-suppressing — exactly the self-laundering `// hazelnut-escalated` is denied. So
 * `accepted` is reachable ONLY through an independent principal here, never a mintable label.
 */
export type AckStatus = "unreviewed" | "self-acked" | "accepted";

/** Classify a review item's ack status: no acker → `unreviewed`; creator acking itself → `self-acked`
 *  (never `accepted`); a distinct principal acking → `accepted` (the only state with teeth, off-machine, §4). */
export function classifyAck(
  args: { createdBy: Principal; ackedBy?: Principal },
): AckStatus {
  if (args.ackedBy === undefined) return "unreviewed";
  return args.ackedBy === args.createdBy ? "self-acked" : "accepted";
}

// ── The monotone-reach closure classifier (§3 "Monotone-reach closure" + "Meta-gate") ──
// §3: any edit that shrinks the verify loop's declared reach is envelope-weakening (reserved), judged against
// the prior-committed envelope (the git baseline), never the post-edit world. The meta-gate: reclassifying an
// action as non-reserved is itself a reach-shrink on the reserved-act axis.

/** The declared reach of one envelope snapshot — the set of guarantees the verify loop covers, one §3
 *  closed-set axis per field. Extracted from a composed model, never hand-authored. */
export interface ReachSummary {
  readonly exposedSurfaces: readonly string[]; // surfaces with an `mcp:`/`http:` exposure (un-exposing shrinks)
  readonly externalEdges: readonly string[]; // edges declared external (external→internal re-mark shrinks)
  readonly judgeCoverage: readonly string[]; // the gated `verify.judge` subset (narrowing shrinks)
  readonly customInvariants: readonly string[]; // the custom-invariant config (blanking shrinks)
  readonly perfCorpus: readonly string[]; // the perf-baseline input corpus (shrinking shrinks)
  readonly reservedActs: readonly string[]; // the reserved-act set itself (the meta-gate: shrinking it is reserved)
}

/** Which §3 closed-set axis a shrink rode (so a reviewer / `hazelnut steer` surface names the precise downgrade). */
export type ReachAxis =
  | "surface"
  | "external-edge"
  | "judge-coverage"
  | "custom-invariant"
  | "perf-corpus"
  | "reserved-set";

/** One reserved reach-shrink: what left the declared reach, on which §3 axis. `metaGate` flags the
 *  reserved-set axis (reclassifying an action as non-reserved is itself reserved). */
export interface ReachShrink {
  readonly axis: ReachAxis;
  readonly member: string; // the specific surface / edge / coverage entry / act that left the reach
  readonly metaGate: boolean; // true ONLY for the reserved-set axis (the §3 meta-gate)
}

const AXIS_KEYS: ReadonlyArray<[keyof ReachSummary, ReachAxis]> = [
  ["exposedSurfaces", "surface"],
  ["externalEdges", "external-edge"],
  ["judgeCoverage", "judge-coverage"],
  ["customInvariants", "custom-invariant"],
  ["perfCorpus", "perf-corpus"],
  ["reservedActs", "reserved-set"],
];

/** Classify the reserved reach-shrinks between a prior-committed envelope and the post-edit one (§3). A member
 *  present in `prior` but absent from `after` is a reserved downgrade; a member only added in `after` is free. */
export function classifyReachShrink(
  prior: ReachSummary,
  after: ReachSummary,
): readonly ReachShrink[] {
  const shrinks: ReachShrink[] = [];
  for (const [key, axis] of AXIS_KEYS) {
    const afterSet = new Set(after[key]);
    for (const member of prior[key]) {
      if (!afterSet.has(member)) {
        shrinks.push({ axis, member, metaGate: axis === "reserved-set" });
      }
    }
  }
  return shrinks;
}

/** True iff the edit is envelope-weakening by the §3 monotone-reach closure — any reach-shrink makes it
 *  reserved (feeds `gateReservedAct` with `consequence:"downgrade"`). */
export function isReachShrinkReserved(
  prior: ReachSummary,
  after: ReachSummary,
): boolean {
  return classifyReachShrink(prior, after).length > 0;
}
