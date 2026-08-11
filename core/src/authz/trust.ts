/** Trust-gradient floor predicates (14-trust-gradient.md). Owns reserved-act + the migrate env-guard (prod
 *  safety is capability separation + an explicit `--env` name, not framework prod-detection, §6) behind a
 *  seam for the off-machine mechanism; solo+full-auto+local can't satisfy it, so the gate degrades to floor. */

/** The migrate target class (§6), sourced from the explicit `--env` name — a non-default `--env <name>` is
 *  `prod`, a bare `migrate` (default `.env`) is `dev`. Never host-detection: a same-machine token is forgeable. */
export type TargetClass = "prod" | "dev";

export type MutationVerb = "apply" | "check" | "reset";
export type EnvGuardVerdict = "allowed" | "confirm-required" | "flat-refuse";

/** Classify the migrate connection target for the env-guard (cli/migrate.md §prod-guard). Keys on the
 *  connection source, not the `--env` label: `dev` requires no named `--env` AND a `.env`-file-supplied
 *  DATABASE_URL; a named `--env`, or an ambient DATABASE_URL (`fileSuppliedUrl:false`), both fail closed
 *  to `prod` — an ambient URL under a bare `migrate reset` would otherwise drop a possibly-production DB. */
export function classifyMigrateTarget(
  opts: { readonly envName?: string; readonly fileSuppliedUrl: boolean },
): TargetClass {
  return opts.envName !== undefined || !opts.fileSuppliedUrl ? "prod" : "dev";
}

/** The migrate env-guard (14-trust-gradient.md §6 · cli/migrate.md §prod-guard). `dev` is always `allowed`.
 *  `prod`: `apply` is `confirm-required` (`--yes` lifts it), `reset` is a categorical `flat-refuse` (prod
 *  recovery is roll-forward only), `check` is `allowed`. Pure predicate; entrypoint owns the prompt. */
export function migrateEnvGuard(
  verb: MutationVerb,
  target: TargetClass,
): EnvGuardVerdict {
  if (target === "dev") return "allowed";
  if (verb === "reset") return "flat-refuse"; // categorical — no confirm lifts it
  if (verb === "apply") return "confirm-required"; // destructive apply on a named env → interactive confirm
  return "allowed"; // check reads only
}

export type Consequence =
  | "local-dev"
  | "production"
  | "external-consumer"
  | "downgrade";

/** The reserved predicate (§3): an action is reserved iff its consequence escapes the verify loop's reach —
 *  it lands in (a) production, (b) an external consumer, or (c) downgrades a currently-active guarantee.
 *  A derived per-run predicate against the declared envelope, never a committed list. */
export function isReserved(consequence: Consequence): boolean {
  return consequence !== "local-dev";
}

/** `hazelnut explain` on a prod-tagged target collapses to a bare `forbidden` (a "why was this blocked" on
 *  prod is an id-enumeration oracle); dev targets get the full output. Ergonomics only — row-leak safety is
 *  by-construction elsewhere, not this. */
export function explainOnTarget(
  target: TargetClass,
  fullOutput: string,
): string {
  return target === "prod" ? "forbidden" : fullOutput;
}

/** The off-machine gate (§4) — a seam, not a built-in: an authenticated-human approval the local agent
 *  cannot forge. Teeth are real ONLY when held by a different principal. Absent a gate, a reserved act
 *  degrades to a loud, git-auditable floor record, never silently allowed. */
export interface OffMachineGate {
  readonly approve: (
    act: { readonly id: string; readonly reserved: boolean },
  ) => Promise<boolean>;
}

/** Route a reserved act through the gate if one is provided; otherwise FLOOR — not approved, surfaced loudly. */
export async function gateReservedAct(
  act: { id: string; consequence: Consequence },
  gate?: OffMachineGate,
): Promise<{ approved: boolean; floor: boolean }> {
  const reserved = isReserved(act.consequence);
  if (!reserved) return { approved: true, floor: false };
  if (!gate) return { approved: false, floor: true }; // solo-full-auto-local: loud + git-auditable, never forged-green
  return {
    approved: await gate.approve({ id: act.id, reserved }),
    floor: false,
  };
}

// ── The reserved-prediction projection (§3 reserved set + §4 "Deliverable: per-action guidance") ──
// A pure projection: given a target class, lists what the gradient will gate and how each act routes — data,
// not enforcement. Keys on the target (`--env` name → prod|dev, §6), not the command name.

/** How a reserved act resolves once it fires (§4 + §6): `off-machine-sign` routes through the second-principal
 *  seam; `flat-refuse` is categorical (prod reset — no `--accept`); `loud-floor` is the solo-full-auto-local
 *  degrade; `free` is the §3/§8 non-reserved baseline. */
export type Routing =
  | "off-machine-sign"
  | "flat-refuse"
  | "loud-floor"
  | "free";

/** One predicted reserved act: what lands outside the verify loop, its cited doc home (never minted here),
 *  and how it routes for the given target. Pure description. */
export interface ReservedActPrediction {
  readonly act: string; // the action class (§3 current instances)
  readonly consequence: Consequence; // why it escapes the verify loop's reach
  // The HANDBOOK page this act is governed by. Printed to the consumer, so it may only name a page that
  // ships with the framework — a pointer into the private spec tree is a 404 for every reader.
  readonly home: string;
  readonly routing: Routing; // how it resolves once fired — keyed on the target, not the command
}

// The §3 "current instances," each citing an existing home — a per-run projection, not a committed list.
const RESERVED_INSTANCES: ReadonlyArray<
  Omit<ReservedActPrediction, "routing"> & { readonly prodOnly: boolean }
> = [
  {
    act: "migrate apply/push on prod",
    consequence: "production",
    home: "cli/migrate.md §prod-guard",
    prodOnly: true,
  },
  {
    act: "migrate reset on prod",
    consequence: "production",
    home: "cli/migrate.md §reset",
    prodOnly: true,
  },
  {
    act:
      "envelope-weakening (delete/weaken an invariant, relax a baseline, remove an active feature)",
    consequence: "downgrade",
    home: "VERSIONING.md §lane-contract",
    prodOnly: false,
  },
  {
    act:
      "accept a non-additive break on a surface with a declared external consumer",
    consequence: "external-consumer",
    home: "VERSIONING.md §lane-contract",
    prodOnly: false,
  },
  {
    act:
      "downgrade the framework-version pin in a way that changes reserved-set membership",
    consequence: "downgrade",
    // Public handbook — never a private-module path: the assembled artifact sanitizes those away, and
    // this string is what the reserved-act predictor cites to the operator.
    home: "VERSIONING.md",
    prodOnly: false,
  },
];

/** Project the reserved acts the gradient will gate for a target, with each act's predicted routing. Pure:
 *  builds and returns data, gates nothing. `prod`-only acts are omitted for `dev` (§6 mode-inversion).
 *  `reset on prod` stays `flat-refuse` regardless of gate presence. */
export function predictReservedActs(
  target: TargetClass,
  opts: { hasSecondPrincipalGate?: boolean } = {},
): ReadonlyArray<ReservedActPrediction> {
  const floorToGated: Routing = opts.hasSecondPrincipalGate
    ? "off-machine-sign"
    : "loud-floor";
  return RESERVED_INSTANCES
    .filter((i) => target === "prod" || !i.prodOnly)
    .map(({ prodOnly: _prodOnly, ...i }) => ({
      ...i,
      routing: i.act === "migrate reset on prod" ? "flat-refuse" : floorToGated,
    }));
}

// The waiver "cannot self-clear" data model (§8 born-unreviewed + §13 acceptance discipline) lives in
// trust-reserved.ts; re-exported here so importers stay stable.
export * from "./trust-reserved.ts";
