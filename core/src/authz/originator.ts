// The principal background work runs as: the actor whose op started it, stamped onto the outbox row and
// rebuilt when the row drains. Framework-internal — not re-exported by `auth.ts`, so no app code mints from it.
import {
  type Actor,
  ANON,
  isSystem,
  type PermKey,
  tenantOf,
  withTenant,
} from "./auth-core.ts";

export interface OriginatorStamp {
  readonly id: string;
  readonly type: Actor["type"];
  readonly claims: readonly string[];
  readonly onBehalfOf?: string;
  readonly tenant?: string;
}

/** The stamp for work `actor` starts; `undefined` for no actor or the system principal, whose work is the
 *  framework's own and keeps the system bypass. */
export function originatorStamp(
  actor: Actor | null,
): OriginatorStamp | undefined {
  if (actor === null || isSystem(actor)) return undefined;
  const tenant = tenantOf(actor);
  return {
    id: actor.id,
    type: actor.type,
    claims: [...actor.claims],
    ...(actor.onBehalfOf !== undefined ? { onBehalfOf: actor.onBehalfOf } : {}),
    ...(tenant !== null ? { tenant } : {}),
  };
}

const isStamp = (s: unknown): s is OriginatorStamp => {
  const o = s as Partial<OriginatorStamp> | null;
  return o !== null && typeof o === "object" && typeof o.id === "string" &&
    (o.type === "user" || o.type === "agent" || o.type === "system") &&
    Array.isArray(o.claims) && o.claims.every((c) => typeof c === "string") &&
    (o.onBehalfOf === undefined || typeof o.onBehalfOf === "string") &&
    (o.tenant === undefined || typeof o.tenant === "string");
};

/** The actor a drained row's work runs as, rebuilt from its `trace_context.originator` — never the system
 *  principal. `undefined` when nothing was stamped; a malformed stamp is `ANON`, least privilege. */
export function originatorActor(traceContext: unknown): Actor | undefined {
  const stamp = (traceContext as { originator?: unknown } | null | undefined)
    ?.originator;
  if (stamp === undefined) return undefined;
  if (!isStamp(stamp) || stamp.id === ANON.id) return ANON;
  const actor: Actor = Object.freeze({
    id: stamp.id,
    type: stamp.type,
    claims: new Set(stamp.claims as PermKey[]),
    ...(stamp.onBehalfOf !== undefined ? { onBehalfOf: stamp.onBehalfOf } : {}),
  });
  return stamp.tenant !== undefined ? withTenant(actor, stamp.tenant) : actor;
}
