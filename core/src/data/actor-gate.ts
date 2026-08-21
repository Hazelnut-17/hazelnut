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
/** True iff this Where node is a deny-all under the Condition algebra (`none()`, `and(none(), …)`, …). */
function nodeDenies(n: unknown): boolean {
  if (typeof n !== "object" || n === null || !("kind" in n)) return false;
  const node = n as {
    kind: string;
    parts?: readonly unknown[];
    part?: unknown;
  };
  switch (node.kind) {
    case "none":
      return true;
    case "all":
      return false;
    case "and":
      return Array.isArray(node.parts) && node.parts.some(nodeDenies);
    case "or":
      return Array.isArray(node.parts) && node.parts.length > 0 &&
        node.parts.every(nodeDenies);
    case "not":
      return !nodeDenies(node.part);
    default:
      return false;
  }
}

export function actorGateDenies(policy: unknown, actor: Actor | null): boolean {
  if (typeof policy !== "function") return true;
  try {
    const w: unknown = (policy as (a: Actor | null) => unknown)(actor);
    // a shorthand match-object (no `node`) is never a deny; only a Condition that lowers to none() is.
    return typeof w === "object" && w !== null && "node" in w &&
      nodeDenies((w as { node: unknown }).node);
  } catch {
    return true;
  }
}
