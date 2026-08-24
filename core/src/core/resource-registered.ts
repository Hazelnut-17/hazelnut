/**
 * `wiring/resource-registered` — table identity, HTTP/MCP bare-name, and resolved
 * route base. Shared by the verify invariant and createApp so a collision that
 * verify already names cannot still boot.
 */
import { formatHomes, slotKey } from "./slot.ts";

/** The fields the collision scan needs — a ResourceModel, or a test mutant. */
export interface RegisteredSurface {
  readonly name: string;
  readonly pgSchema: string;
  readonly module?: string;
  readonly path?: string;
  readonly http: Readonly<Record<string, unknown>>;
}

/** The one route-base rule — `path` when set, else mechanical `/${name}s`. */
export function resolvedRouteBase(
  m: { readonly name: string; readonly path?: string },
): string {
  return `/${m.path ?? `${m.name}s`}`;
}

export interface ResourceRegistrationFinding {
  readonly id: "wiring/resource-registered";
  readonly resource: string;
  readonly message: string;
}

function httpExposed(m: RegisteredSurface): boolean {
  return Object.keys(m.http).length > 0;
}

/** The three whole-model lookups the collision scan needs, in ONE pass. Each mirrors a `model.filter`
 *  this function used to run PER RESOURCE — three full scans × n resources is O(n²), and at n=256 that
 *  was 63% of the whole structural fold. Insertion order is declaration order, so the twin lists a message
 *  names are unchanged. */
export interface RegistrationIndex {
  readonly bySlot: ReadonlyMap<string, readonly RegisteredSurface[]>;
  readonly exposedByName: ReadonlyMap<string, readonly RegisteredSurface[]>;
  readonly exposedByBase: ReadonlyMap<string, readonly RegisteredSurface[]>;
}

export function buildRegistrationIndex(
  model: readonly RegisteredSurface[],
): RegistrationIndex {
  const bySlot = new Map<string, RegisteredSurface[]>();
  const exposedByName = new Map<string, RegisteredSurface[]>();
  const exposedByBase = new Map<string, RegisteredSurface[]>();
  const push = (
    m: Map<string, RegisteredSurface[]>,
    k: string,
    v: RegisteredSurface,
  ) => {
    let a = m.get(k);
    if (a === undefined) m.set(k, a = []);
    a.push(v);
  };
  for (const r of model) {
    push(bySlot, slotKey(r.name, r.pgSchema), r);
    if (httpExposed(r)) {
      push(exposedByName, r.name, r);
      push(exposedByBase, resolvedRouteBase(r), r);
    }
  }
  return { bySlot, exposedByName, exposedByBase };
}

/** Findings for ONE resource against the composed model. Verify walks per resource;
 *  createApp folds the same list and throws once. Pass a prebuilt `idx` when walking the whole model —
 *  the default rebuilds it, which is correct but quadratic across a fold. */
export function resourceRegistrationFindings(
  m: RegisteredSurface,
  model: readonly RegisteredSurface[],
  idx: RegistrationIndex = buildRegistrationIndex(model),
): ResourceRegistrationFinding[] {
  const sameSlot = idx.bySlot.get(slotKey(m.name, m.pgSchema)) ?? [];
  if (sameSlot.length > 1) {
    return [{
      id: "wiring/resource-registered",
      resource: m.name,
      message:
        `resource '${m.name}' is registered ${sameSlot.length} times in schema '${m.pgSchema}' (${
          formatHomes(sameSlot)
        }) — duplicate registrations collapse to one table. Rename one of them.`,
    }];
  }
  if (!httpExposed(m)) return [];
  const twins = (idx.exposedByName.get(m.name) ?? []).filter((r) =>
    r.pgSchema !== m.pgSchema
  );
  if (twins.length > 0) {
    const base = resolvedRouteBase(m);
    return [{
      id: "wiring/resource-registered",
      resource: m.name,
      message: `resource '${m.name}' is HTTP-exposed in ${
        twins.length + 1
      } schemas (${
        [m.pgSchema, ...twins.map((t) => t.pgSchema)].join(", ")
      }) — the route base '${base}' and the MCP tool address by BARE name (schema-agnostic), so the surfaces collide; rename one, or keep all but one internal (no http)`,
    }];
  }
  const base = resolvedRouteBase(m);
  const pathTwins = (idx.exposedByBase.get(base) ?? []).filter((r) =>
    r.name !== m.name || r.pgSchema !== m.pgSchema
  );
  if (pathTwins.length > 0) {
    return [{
      id: "wiring/resource-registered",
      resource: m.name,
      message: `resource '${m.name}' HTTP route base '${base}' collides with ${
        pathTwins.map((t) => `'${t.name}' (${t.pgSchema})`).join(", ")
      } — set a distinct \`path\`, or rename; name is DB/perm/MCP identity and is not the URL`,
    }];
  }
  return [];
}

/** Deduped `id: message` lines for createApp. */
export function resourceRegistrationErrors(
  model: readonly RegisteredSurface[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const idx = buildRegistrationIndex(model); // ONE index for the whole fold — createApp was quadratic too
  for (const m of model) {
    for (const f of resourceRegistrationFindings(m, model, idx)) {
      const line = `${f.id}: ${f.message}`;
      if (seen.has(line)) continue;
      seen.add(line);
      out.push(line);
    }
  }
  return out;
}
