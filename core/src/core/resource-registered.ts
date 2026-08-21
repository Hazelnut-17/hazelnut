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

/** Findings for ONE resource against the composed model. Verify walks per resource;
 *  createApp folds the same list and throws once. */
export function resourceRegistrationFindings(
  m: RegisteredSurface,
  model: readonly RegisteredSurface[],
): ResourceRegistrationFinding[] {
  const sameSlot = model.filter((r) =>
    slotKey(r.name, r.pgSchema) === slotKey(m.name, m.pgSchema)
  );
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
  const twins = model.filter((r) =>
    r.name === m.name && r.pgSchema !== m.pgSchema && httpExposed(r)
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
  const pathTwins = model.filter((r) =>
    (r.name !== m.name || r.pgSchema !== m.pgSchema) &&
    httpExposed(r) &&
    resolvedRouteBase(r) === base
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
  for (const m of model) {
    for (const f of resourceRegistrationFindings(m, model)) {
      const line = `${f.id}: ${f.message}`;
      if (seen.has(line)) continue;
      seen.add(line);
      out.push(line);
    }
  }
  return out;
}
