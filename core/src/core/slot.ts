/**
 * Schema-per-module name resolution. A bare resource name is not unique across
 * modules — two modules may each declare `invoice` — so every lookup goes through
 * the `name::pgSchema` slot. A bare name is legal only while it is unambiguous;
 * two declarers and no intra-slot hit is a named refusal, never a last-wins pick.
 */

export function slotKey(name: string, pgSchema: string): string {
  return `${name}::${pgSchema}`;
}

export interface SlotNamed {
  readonly name: string;
  readonly pgSchema: string;
  readonly module?: string;
}

export type SlotResolve<T> =
  | { readonly kind: "hit"; readonly value: T }
  | { readonly kind: "missing" }
  | { readonly kind: "ambiguous"; readonly candidates: readonly T[] };

/** Label a resource home the way `readmodel/source-ambiguous` already does. */
export function homeLabel(x: {
  readonly module?: string;
  readonly pgSchema: string;
}): string {
  if (!x.module || x.module === "app") return "app level";
  return `module '${x.module}'`;
}

export function formatHomes(
  xs: readonly { readonly module?: string; readonly pgSchema: string }[],
): string {
  return xs.map(homeLabel).join(", ");
}

export function bootRoster(
  units: readonly {
    readonly decl: { readonly name: string };
    readonly pgSchema: string;
    readonly module: string;
  }[],
): SlotNamed[] {
  return units.map((u) => ({
    name: u.decl.name,
    pgSchema: u.pgSchema,
    module: u.module,
  }));
}

/**
 * Resolve `name` from a caller that already sits in a pg schema. Intra-slot
 * wins. A unique global same-name is legal. Two+ global same-names with no
 * intra-slot hit is ambiguous — the caller refuses, naming both declarers.
 */
export function resolveFromSlot<T extends SlotNamed>(
  items: readonly T[],
  name: string,
  fromPgSchema: string,
): SlotResolve<T> {
  const intra = items.filter((x) =>
    x.name === name && x.pgSchema === fromPgSchema
  );
  if (intra.length >= 1) return { kind: "hit", value: intra[0]! };
  const all = items.filter((x) => x.name === name);
  if (all.length === 0) return { kind: "missing" };
  if (all.length === 1) return { kind: "hit", value: all[0]! };
  return { kind: "ambiguous", candidates: all };
}

/** A bare name with no from-schema (`defineView.over`, `defineVersion.resource`). */
export function resolveBare<T extends SlotNamed>(
  items: readonly T[],
  name: string,
): SlotResolve<T> {
  const all = items.filter((x) => x.name === name);
  if (all.length === 0) return { kind: "missing" };
  if (all.length === 1) return { kind: "hit", value: all[0]! };
  return { kind: "ambiguous", candidates: all };
}

/** Body of a compose-refusal. Callers prefix `<id>: ` so the id stays a message prefix — the same
 *  shape as the other createApp guards — and is not a quoted finding literal `hazelnut explain` must card. */
export function ambiguousErr(
  site: string,
  name: string,
  candidates: readonly SlotNamed[],
): string {
  return `${site} names resource '${name}', which is declared in ${candidates.length} places (${
    formatHomes(candidates)
  }) — a bare name cannot pick between same-named resources in different schemas. Rename one of them.`;
}

/** `t.arb` / `t.build` key: bare while unique, `name::pgSchema` when shared. */
export function fixtureSlotKey(
  name: string,
  pgSchema: string,
  homes: ReadonlyMap<string, number>,
): string {
  return (homes.get(name) ?? 0) > 1 ? slotKey(name, pgSchema) : name;
}
