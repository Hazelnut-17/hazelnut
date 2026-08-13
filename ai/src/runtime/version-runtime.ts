import type { ResourceModel } from "../core/app.ts";
import type { VersionDecl } from "../core/versions.ts";
import { strictify } from "../data/schema.ts";

/**
 * The per-request multi-version runtime projection (multi-version.md §4/§5/§6) — the serve-layer half of
 * `defineVersion` (declaration + boot checks live in `core/versions.ts`), keyed off the request's
 * `Hazelnut-Version` header: `applyVersion` (read projection + enum down-map), `upcastBody` (write up-cast +
 * defaults), `versionInputInvalid` (version-first input check) — called by `serve.ts` at read/write routes.
 */

/** A date-shaped pin (`YYYY-MM-DD`) — the only shape date-range resolution applies to. */
const DATE_PIN = /^\d{4}-\d{2}-\d{2}$/;

/** Resolve a request pin against the declared version set (multi-version.md §resolution): an exact match
 *  wins; a date-shaped pin with no exact match resolves to the NEWEST declared date-shaped pin at-or-before
 *  it (lexicographic == chronological for ISO dates). Unresolvable — a non-date unknown pin, or a date
 *  EARLIER than the oldest declared pin — returns null, and the serve gate refuses it loud (the refusal
 *  semantics survive resolution; nothing silently falls through to `current`). */
export function resolvePin(
  versions: ReadonlyArray<Pick<VersionDecl, "version">>,
  pin: string | null,
): string | null {
  if (pin === null) return null;
  if (versions.some((v) => v.version === pin)) return pin;
  if (!DATE_PIN.test(pin)) return null;
  let best: string | null = null;
  for (const v of versions) {
    if (DATE_PIN.test(v.version) && v.version <= pin) {
      if (best === null || v.version > best) best = v.version;
    }
  }
  return best;
}

/** Apply the pinned API version's projection to an output row (multi-version.md §4). Applied after
 *  `dropSensitive` by construction, so a version can never un-redact a `sensitive`/`encrypted` field
 *  (multi-version.md §8) — the value is already gone from `expose`'s input. No pin, or no version declared
 *  for this resource+pin, passes the `current` shape through unchanged. The pin resolves through
 *  `resolvePin` (exact match, else newest date-shaped pin at-or-before). */
export function applyVersion(
  versions: ReadonlyArray<VersionDecl>,
  m: ResourceModel,
  c: { req: { raw: Request } },
  row: Record<string, unknown>,
): Record<string, unknown> {
  const pin = resolvePin(versions, c.req.raw.headers.get("hazelnut-version"));
  if (!pin) return row;
  const v = versions.find((x) => x.version === pin && x.resource === m.name);
  if (!v) return row;
  // before projecting, rewrite any enum value the current schema widened past this version's `known` set into
  // a value it understands (`map`). Boot has proven every current value is covered, so a non-tolerant version
  // never projects a value its client cannot read.
  const mapped = v.enums ? mapEnums(v.enums, row) : row;
  return v.expose(mapped);
}

/** Down-map a row's enum fields to a version's understood values (multi-version.md §6). A value not in the
 *  version's `known` set that has a `map` entry is rewritten; everything else passes through. Copies lazily. */
function mapEnums(
  enums: NonNullable<VersionDecl["enums"]>,
  row: Record<string, unknown>,
): Record<string, unknown> {
  let out = row;
  for (const [field, spec] of Object.entries(enums)) {
    const val = row[field];
    if (typeof val !== "string" || spec.known.includes(val)) continue;
    const to = spec.map?.[val];
    if (to !== undefined) {
      if (out === row) out = { ...row };
      out[field] = to;
    }
  }
  return out;
}

/** Version-first write validation (multi-version.md §5/§6): when the pinned version declares its own `input`
 *  schema, validate the raw body against it before the up-cast, so an old client gets a version-shaped error
 *  rather than a confusing `current`-schema error after the reshape. Returns a message on rejection, else null.
 *  PATCH validates against the `.partial()` of the version's input (only the touched fields). */
export function versionInputInvalid(
  versions: ReadonlyArray<VersionDecl>,
  m: ResourceModel,
  c: { req: { raw: Request } },
  raw: unknown,
  mode: "create" | "update",
): string | null {
  const pin = resolvePin(versions, c.req.raw.headers.get("hazelnut-version"));
  if (!pin || raw === null || typeof raw !== "object") return null;
  const v = versions.find((x) => x.version === pin && x.resource === m.name);
  if (!v || !v.input) return null;
  // strictify so an unknown/typo'd key in the version body is a loud reject, not silently stripped and
  // accepted — the same strict-parse discipline the current-schema check uses.
  const schema = strictify(mode === "update" ? v.input.partial() : v.input);
  return schema.safeParse(raw).success
    ? null
    : `body does not match API version '${pin}' input schema`;
}

/** Up-cast a version-shaped write body to the `current` input the single handler runs (multi-version.md §5).
 *  `up` reshapes the body; on CREATE, `defaults` fill `current` fields an old writer cannot know (the up-cast
 *  wins over a default). The caller then validates the result against `current`'s schema, so a version can
 *  never write a shape `current` rejects. PATCH (`mode:"update"`) injects no defaults — a partial update must
 *  not fill siblings. */
export function upcastBody(
  versions: ReadonlyArray<VersionDecl>,
  m: ResourceModel,
  c: { req: { raw: Request } },
  body: unknown,
  mode: "create" | "update",
): unknown {
  const pin = resolvePin(versions, c.req.raw.headers.get("hazelnut-version"));
  if (!pin || body === null || typeof body !== "object") return body;
  const v = versions.find((x) => x.version === pin && x.resource === m.name);
  if (!v || !v.up) return body; // no version for this pin, or a read-only version → body is already current-shaped
  const upcasted = v.up(body as Record<string, unknown>);
  return mode === "create" && v.defaults
    ? { ...v.defaults, ...upcasted }
    : upcasted;
}
