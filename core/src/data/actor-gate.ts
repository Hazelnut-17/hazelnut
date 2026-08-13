import type { Actor } from "../authz/auth.ts";

/**
 * True iff an actor gate DENIES. The gate forms — a run-form `defineView`, a materialized
 * `defineReadModel` projection — have no source table to apply a row `Where` to, so the policy doubles as
 * the actor gate: a top-level `none()` denies, anything else allows. Fail-closed on both edges: an
 * uncallable policy and a throwing one both deny, so a gate can never fall through to an open read.
 *
 * A LEAF, not a member of the `repo` barrel: `features/readmodel.ts` needs it and `data/repo-*` imports
 * `readmodel.ts` back, so reaching it through the barrel merged the two clusters into a value-import cycle.
 */
export function actorGateDenies(policy: unknown, actor: Actor | null): boolean {
  if (typeof policy !== "function") return true;
  try {
    const w: unknown = (policy as (a: Actor | null) => unknown)(actor);
    // a shorthand match-object (no `node`) is never a deny; only the `none()` Condition is.
    return typeof w === "object" && w !== null && "node" in w &&
      (w as { node: { kind: string } }).node.kind === "none";
  } catch {
    return true;
  }
}
