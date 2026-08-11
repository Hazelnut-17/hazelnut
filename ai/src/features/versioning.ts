import type { DeliveredMsg } from "../runtime/outbox.ts";
import type { OnlyKnownKeys } from "../core/config.ts";

/** Event-schema versioned upcasters (05-runtime.md §5.2): a stored outbox/dead/processed payload can outlive
 *  its producer schema, so `schema_version` dispatches a chained vN→vN+1 upcaster at consume. This file owns
 *  the consume-time dispatch and the retention (stale-version) guard; broker/registry and TTL live elsewhere. */

/** One vN→vN+1 link: a total transform of the `from`-version payload to `from+1` (never partial), so a chain
 *  is keyed by ascending `from` (1→2, 2→3, …). */
export interface Upcaster<From = unknown, To = unknown> {
  readonly from: number; // the schema_version this link upgrades from (produces from+1)
  upcast(payload: From): To;
}

/** Declare a versioned upcaster (the verb); register it in a topic's chain. Mirrors `defineSubscriber` /
 *  `defineJob` for a uniform declaration site. */
export function defineUpcaster<From, To, D = unknown>(
  decl: Upcaster<From, To> & OnlyKnownKeys<D, Upcaster<From, To>>,
): Upcaster<From, To> {
  return decl;
}

/** An ordered upcaster chain for a topic: links sorted by ascending `from`, `currentVersion` (the revision the
 *  subscriber expects), and `oldestSupported` (retention guard's floor, 05-runtime.md §5.2). */
export interface UpcasterChain {
  readonly currentVersion: number;
  readonly links: ReadonlyArray<Upcaster>;
  readonly oldestSupported: number;
}

/** Build a topic's upcaster chain from links + the consumer's current revision. Chain MUST be contiguous
 *  from `oldestSupported` to `currentVersion` — a gap or duplicate `from` is a loud boot throw (a silent gap
 *  would drop a payload). `currentVersion` defaults to one past the last link, or 1 when empty. */
export function buildUpcasterChain(
  links: ReadonlyArray<Upcaster>,
  currentVersion?: number,
): UpcasterChain {
  const sorted = [...links].sort((a, b) => a.from - b.from);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.from === sorted[i - 1]!.from) {
      throw new Error(
        `upcaster chain: two links both upgrade from v${
          sorted[i]!.from
        } (a step has no single total transform)`,
      );
    }
  }
  // contiguity: each link's `from` must be exactly one past the prior link's `from`
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.from !== sorted[i - 1]!.from + 1) {
      throw new Error(
        `upcaster chain: gap between v${sorted[i - 1]!.from} and v${
          sorted[i]!.from
        } — a missing link would silently drop a payload at the hole`,
      );
    }
  }
  const current = currentVersion ??
    (sorted.length > 0 ? sorted[sorted.length - 1]!.from + 1 : 1);
  const oldestSupported = sorted.length > 0 ? sorted[0]!.from : current;
  if (current < oldestSupported) {
    throw new Error(
      `upcaster chain: currentVersion v${current} is below the oldest link's source v${oldestSupported}`,
    );
  }
  // the top link must reach currentVersion — a chain whose last link produces less than current cannot
  // upgrade the prior version to today's shape.
  if (sorted.length > 0 && sorted[sorted.length - 1]!.from + 1 !== current) {
    throw new Error(
      `upcaster chain: top link produces v${
        sorted[sorted.length - 1]!.from + 1
      } but currentVersion is v${current} — the chain does not reach the consumer's revision`,
    );
  }
  return { currentVersion: current, links: sorted, oldestSupported };
}

/** The retention-guard verdict for a stored payload's `schema_version` against a chain: `upcast` carries the
 *  steps to run; `reject` carries why a redrive is too old — dead-lettered rather than fed a hole. */
export type UpcastDecision =
  | { readonly kind: "current"; readonly steps: 0 }
  | { readonly kind: "upcast"; readonly steps: number }
  | { readonly kind: "reject"; readonly reason: string };

/** Decide how to handle a stored payload at `storedVersion` against the chain (05-runtime.md §5.2 retention
 *  guard): equal to `currentVersion` ⇒ current; below `oldestSupported` or above ⇒ reject (never a silent
 *  downgrade); otherwise upcast. */
export function decideUpcast(
  storedVersion: number,
  chain: UpcasterChain,
): UpcastDecision {
  if (storedVersion === chain.currentVersion) {
    return { kind: "current", steps: 0 };
  }
  if (storedVersion > chain.currentVersion) {
    return {
      kind: "reject",
      reason:
        `stored v${storedVersion} is newer than the consumer's v${chain.currentVersion} — no downgrade is attempted`,
    };
  }
  if (storedVersion < chain.oldestSupported) {
    return {
      kind: "reject",
      reason:
        `stored v${storedVersion} is older than the oldest live upcaster (v${chain.oldestSupported}) — a redrive this old can no longer be upgraded`,
    };
  }
  return { kind: "upcast", steps: chain.currentVersion - storedVersion };
}

/** Run the chain to upgrade a stored payload at `storedVersion` to `currentVersion`, applying each vN→vN+1 link
 *  in order. Throws a `validation`-kind error on a retention-guard reject, so the relay dead-letters it —
 *  no retry (an un-upgradable payload never becomes upgradable on a re-run). */
export function runUpcasters(
  storedVersion: number,
  payload: unknown,
  chain: UpcasterChain,
): unknown {
  const decision = decideUpcast(storedVersion, chain);
  if (decision.kind === "reject") {
    throw Object.assign(
      new Error(`schema-version upcast rejected: ${decision.reason}`),
      { kind: "validation" },
    );
  }
  if (decision.kind === "current") return payload;
  let cur = payload;
  let v = storedVersion;
  // apply links keyed on the running version until cur reaches currentVersion (contiguity is guaranteed by
  // buildUpcasterChain, so the link for every intermediate `v` exists)
  while (v < chain.currentVersion) {
    const link = chain.links.find((l) => l.from === v);
    if (!link) {
      // unreachable when the chain was built by buildUpcasterChain (it proves contiguity); the loud throw is
      // the defence if a chain was assembled by hand and skipped the contiguity proof.
      throw Object.assign(
        new Error(
          `schema-version upcast: no link for v${v}→v${
            v + 1
          } (chain not contiguous)`,
        ),
        { kind: "validation" },
      );
    }
    cur = link.upcast(cur);
    v++;
  }
  return cur;
}

/** Wrap a `DeliveredMsg` payload through its topic's upcaster chain before consume (05-runtime.md §5.2) — the
 *  one call the relay dispatch makes per message. Rejection throws (dead-lettered); no chain ⇒ unchanged. */
export function upcastDelivered(
  msg: DeliveredMsg,
  chain: UpcasterChain | undefined,
): DeliveredMsg {
  if (!chain) return msg;
  const stored = msg.schemaVersion ?? 1;
  return { ...msg, payload: runUpcasters(stored, msg.payload, chain) };
}
