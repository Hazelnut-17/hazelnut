import type { Rung } from "./verifier-contract.ts";

/**
 * docRef construction — the resolvable canon pointer the CLI stamps on every emitted invariant/violation.
 * A docRef points at the determinism-axis section for the id's rung, never a fabricated per-id heading;
 * a leaf module so roster-upstream emitters can stamp one with no value cycle. docs-cross-ref.test.ts.
 */

/** The two ids the public+MCP red gate blocks on carry their own resolvable card in 10-invariants.md
 *  (§"MCP read-protection and the spec/missing elevation"); every other id resolves to its axis section. */
const CARDED_IDS: ReadonlySet<string> = new Set([
  "mcp/read-protected",
  "spec/missing",
]);

/** The canon section documenting each determinism axis. `runtime-assert` points at 09-verifier's
 *  determinism-axis checklist since that rung lives outside the pre-ship roster (10-invariants.md §intro). */
const RUNG_SECTION: Record<Rung, string> = {
  "by-construction": "10-invariants.md §by-construction",
  "type": "10-invariants.md §type",
  "static": "10-invariants.md §static-conformance",
  "property": "10-invariants.md §property",
  "runtime-assert": "09-verifier.md §determinism-axis",
  "judge": "10-invariants.md §judge",
};

/** The type-channel ids `runtime/channels.ts` maps tsc errors onto — absent from
 *  `registeredInvariantIds()`; named here so `docref-id.ts` routes `hazelnut explain` for them to §type. */
export const TYPE_RUNG_EMITTED_IDS: readonly string[] = [
  "refs/typed",
  "errors/result-type",
  "transition/legal-target",
  "type/unmapped",
];

/** The runtime-assert ids the `alarm.ts` fold emits — absent from the registry (they read a live `Db`,
 *  not the composed model); listed here for `hazelnut explain`'s id→rung routing. */
export const RUNTIME_ASSERT_EMITTED_IDS: readonly string[] = [
  "outbox/dlq-drained",
  "vector/possibly-stale",
];

/** The two authz/spec differential ids that ride the property rung (10-invariants.md §property table) even
 *  though they register through the non-per-resource spec rung. */
export const PROPERTY_RUNG_EMITTED_IDS: readonly string[] = [
  "policy/rowpolicy-meets-spec",
  "spec/weakened",
];

/** The resolvable `<doc>.md §<section>` pointer for a finding's rung — for emitters that already know
 *  their own rung (`channels.ts`, `alarm.ts`, `enrich`/`enrichApp`). */
export function docRefForRung(rung: Rung): string {
  return RUNG_SECTION[rung];
}

/** The resolvable pointer for an id whose rung is known — a red-gate carded id points at its own card,
 *  every other id at its rung's axis section. Used by `enrich`/`enrichApp`. */
export function docRefFor(id: string, rung: Rung): string {
  return CARDED_IDS.has(id) ? `10-invariants.md §${id}` : docRefForRung(rung);
}
