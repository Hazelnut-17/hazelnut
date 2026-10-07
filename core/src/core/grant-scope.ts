/** Binds each `relate().via` grant in a lowered policy to the request scope: the one rule the read stack,
 *  the write stack and the boot refusal all apply, so the three can never disagree about a grant. */
import type { Node } from "./where.ts";

/** What the rule reads off the resource a policy guards. `grantScopes` maps every resource of its module
 *  to whether that resource is scoped. */
export interface GrantScopeOwner {
  readonly name: string;
  readonly features: { readonly scope?: unknown };
  readonly grantScopes: ReadonlyMap<string, boolean>;
}

/**
 * A scoped grant resource joins only grants written in `scope`. A scoped resource whose grant is unscoped
 * or unmodeled cannot keep that partition, so it is refused (`authz/relate-scope`).
 */
export function bindGrantScopes(
  node: Node,
  outer: GrantScopeOwner,
  scope: string,
): Node {
  switch (node.kind) {
    case "and":
    case "or":
      return {
        ...node,
        parts: node.parts.map((p) => bindGrantScopes(p, outer, scope)),
      };
    case "not":
      return { ...node, part: bindGrantScopes(node.part, outer, scope) };
    case "exists": {
      if (outer.grantScopes.get(node.rel.via) === true) {
        return { ...node, rel: { ...node.rel, viaScope: scope } };
      }
      if (outer.features.scope) {
        throw new Error(
          `authz/relate-scope: resource '${outer.name}' is scoped, but its relate().via grant '${node.rel.via}' is not a scoped resource of the same module — a grant row written in one scope would open rows in another. Declare features: { scope: true } on '${node.rel.via}'.`,
        );
      }
      return node;
    }
    default:
      return node;
  }
}
