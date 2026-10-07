import type { Actor } from "../authz/auth.ts";
import { isMatchNone, toNode, type Where } from "../core/where.ts";

/**
 * True iff an actor gate DENIES. The gate forms — a run-form `defineView`, a materialized
 * `defineReadModel` projection — have no source table to apply a row `Where` to, so the policy doubles as
 * the actor gate: it denies exactly the answers the lowering makes FALSE (`isMatchNone`: `none()`, the empty
 * `or()`, `inArray(x, [])`, `not(all())`); any other answer admits — the gate is not a row filter.
 * Fail-closed on both edges: an uncallable policy and a throwing one both deny.
 *
 * A LEAF, not a member of the `repo` barrel: `features/readmodel.ts` needs it and `data/repo-*` imports
 * `readmodel.ts` back, so reaching it through the barrel merged the two clusters into a value-import cycle.
 */
export function actorGateDenies(policy: unknown, actor: Actor | null): boolean {
  if (typeof policy !== "function") return true;
  try {
    const w: unknown = (policy as (a: Actor | null) => unknown)(actor);
    if (typeof w !== "object" || w === null) return true;
    return isMatchNone(toNode(w as Where<Record<string, unknown>>));
  } catch {
    return true;
  }
}
