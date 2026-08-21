import type { z } from "zod";
import { strictify } from "../data/schema.ts";
import type { ResourceModel } from "./app.ts";
import type { NoUnknownKeys } from "./config.ts";
import { ambiguousErr, resolveBare } from "./slot.ts";

/** A multi-version API projection (multi-version.md §1): a direct (non-chained) projection of a resource's
 *  current row into one pinned version's shape. `expose` runs after redaction (never un-redacts); `up`
 *  re-validates its output against current's schema, so a version can never write a shape current rejects. */
export interface VersionDecl {
  readonly version: string; // the pin — date-based, e.g. "2024-05-01" (multi-version.md §3)
  readonly resource: string; // the resource this version reshapes (must resolve — `version/pin-resolves`)
  // Read: current row → this version's shape, run after redaction — a version can NEVER un-redact.
  readonly expose: (
    current: Record<string, unknown>,
  ) => Record<string, unknown>;
  // Write up-cast (multi-version.md §5): this version's body → the current input the handler runs. Must
  // be partial-safe on PATCH (return only touched fields); absent ⇒ read-only, body passes through unreshaped.
  readonly up?: (input: Record<string, unknown>) => Record<string, unknown>;
  // Declared defaults for current fields an old writer cannot know (multi-version.md §5). Merged under
  // the up-cast output on CREATE only — never on PATCH, which must not inject untouched fields.
  readonly defaults?: Record<string, unknown>;
  // A representative valid input for the version/required-supplied build check (§8): up(example) + defaults
  // must satisfy current's schema at boot — a missing required field fails the build, not a live write.
  readonly example?: Record<string, unknown>;
  // This version's own request-body schema (multi-version.md §5/§6). When present, a write validates
  // against it first (a v1-shaped error, not a confusing current-schema one), then still re-validates against current.
  readonly input?: z.ZodObject<z.ZodRawShape>;
  // The current fields expose() depends on (multi-version.md §8/§9, version/field-live): while this
  // version is live, migrate cannot drop a listed column. Opt-in (a boot probe rejects under-declaration).
  readonly fields?: readonly string[];
  // Per-enum-field read contract (multi-version.md §6, version/enum-mapped): an unmapped current enum
  // value would reach an old client at HTTP 200 and break it — a boot check requires known ∪ map ∪ tolerant coverage.
  readonly enums?: Readonly<
    Record<string, {
      readonly known: readonly string[];
      readonly map?: Readonly<Record<string, string>>;
      readonly tolerant?: boolean;
    }>
  >;
  // Declares this transform lossless (multi-version.md §1/§8, version/lossless-round-trips):
  // up(expose(current)) == current, proven at boot via fast-check; requires up.
  readonly lossless?: boolean;
  // ISO deprecation/sunset dates (multi-version.md §9): stamp RFC 9745/8594 headers. sunset is an
  // announcement, not a cutoff — the version keeps serving and holding its field-live lock until removed.
  readonly deprecated?: string;
  readonly sunset?: string;
}

export function defineVersion<const V extends VersionDecl>(
  decl: NoUnknownKeys<V, VersionDecl>,
): V {
  return decl; // pure data; createApp collects it into app.versions, serve.ts applies it per `Hazelnut-Version`
}

// The legal `defineVersion` keys, compile-bound to `VersionDecl` (the CONFIG_KEYS idiom): a new field
// missing here fails `deno check` at the assertion below, so the unknown-key check cannot silently lag.
// `deno run` does not typecheck, so this is the only thing standing between a RETIRED key and silence —
// `materialize:true` used to derive a read-model, and ignoring it would drop a table without a word.
export const VERSION_KEYS = [
  "version",
  "resource",
  "expose",
  "up",
  "defaults",
  "example",
  "input",
  "fields",
  "enums",
  "lossless",
  "deprecated",
  "sunset",
] as const;
type _AssertTrueV<T extends true> = T;
type _VersionKeysComplete = _AssertTrueV<
  Exclude<keyof VersionDecl, (typeof VERSION_KEYS)[number]> extends never ? true
    : false
>;

/** The defineVersion boot-integrity roster (multi-version.md §8): returns version/* declaration errors for
 *  a version set against the composed model, aggregated by createApp into one decl/unknown-key throw so a
 *  mis-declared version cannot construct the app — pure, no db, no io. */
export function checkVersions(
  versions: ReadonlyArray<VersionDecl>,
  model: ReadonlyArray<ResourceModel>,
): string[] {
  const errs: string[] = [];
  const seenPins = new Set<string>(); // `${version}::${resource}` — a pin must resolve to exactly one projection
  for (const v of versions) {
    for (const k of Object.keys(v)) {
      if (!(VERSION_KEYS as readonly string[]).includes(k)) {
        errs.push(
          `version/unknown-key: version '${v.version}' declares unknown key '${k}' — a typo'd or retired knob is silently inert, so it is refused instead`,
        );
      }
    }
    if (!v.version || v.version.trim() === "") {
      errs.push(
        `version/pin-resolves: a defineVersion projecting resource '${v.resource}' has an empty version pin`,
      );
    }
    const resolved = resolveBare(model, v.resource);
    const tm = resolved.kind === "hit" ? resolved.value : undefined;
    if (resolved.kind === "missing") {
      errs.push(
        `version/pin-resolves: version '${v.version}' projects resource '${v.resource}', which is not a declared resource`,
      );
    } else if (resolved.kind === "ambiguous") {
      errs.push(
        `version/resource-ambiguous: ${
          ambiguousErr(
            `version '${v.version}'`,
            v.resource,
            resolved.candidates,
          )
        }`,
      );
    }
    // A duplicate (version, resource) is ambiguous — the read-side .find would silently pick the first; two
    // projections for one pin must be a loud boot fail, not a silent winner.
    const key = `${v.version}::${v.resource}`;
    if (seenPins.has(key)) {
      errs.push(
        `version/pin-resolves: duplicate version '${v.version}' for resource '${v.resource}' — two projections for one pin are ambiguous`,
      );
    }
    seenPins.add(key);
    // Write-side declaration integrity (multi-version.md §5/§8) — only meaningful once the target resolves:
    if (tm) {
      // (a) every `defaults` key must name a real `current` field — a typo'd default silently fills nothing.
      for (const k of Object.keys(v.defaults ?? {})) {
        if (!(k in tm.columns)) {
          errs.push(
            `version/required-supplied: version '${v.version}' declares a default for '${k}', which is not a field of resource '${v.resource}'`,
          );
        }
      }
      // (b) version/example-required: an `up` with no example used to skip the schema proof silently.
      if (v.up && v.example === undefined) {
        errs.push(
          `version/example-required: version '${v.version}' declares up() with no example — the boot check cannot prove the up-cast satisfies current; supply example, or drop up() for a read-only pin`,
        );
      }
      // (c) version/required-supplied build check: a write version's up-cast (+defaults) of its declared
      //     example must satisfy current's schema — a structurally missing field fails the build, not a live write.
      if (v.up && v.example) {
        try {
          const upcasted = { ...(v.defaults ?? {}), ...v.up(v.example) };
          // Strict-parse to match the runtime write path (serve.ts strictify(m.schema)), so an up-cast
          // emitting an extra key current forbids fails the build too — the boot check and live 400 never diverge.
          const parsed = strictify(tm.schema).safeParse(upcasted);
          if (!parsed.success) {
            const bad = parsed.error.issues.map((i) =>
              i.path.join(".") || "(root)"
            ).join(", ");
            errs.push(
              `version/required-supplied: version '${v.version}' up-cast of its example does not satisfy '${v.resource}' current schema (missing/invalid: ${bad}) — supply it in up() or declare a default`,
            );
          }
        } catch (e) {
          errs.push(
            `version/required-supplied: version '${v.version}' up-cast threw on its own example: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        }
      }
      // (c) version/field-live under-declaration probe (§9): a version declaring fields must list every
      //     current field expose() reads (probed via a recording Proxy over a synthesized row); a missed field fails the build.
      if (v.fields) {
        const currentFields = new Set(Object.keys(tm.columns));
        const dummy: Record<string, unknown> = { id: "0" };
        for (const k of currentFields) dummy[k] = ""; // a benign per-field sentinel; expose reads keys, not values
        const read = new Set<string>();
        const probe = new Proxy(dummy, {
          get: (
            t,
            k,
          ) => (typeof k === "string" && read.add(k), Reflect.get(t, k)),
        });
        try {
          v.expose(probe);
        } catch {
          /* a probe-value type quirk in expose — best-effort read capture; the field-live lock is declared, not probed */
        }
        const declared = new Set(v.fields);
        for (const k of read) {
          if (currentFields.has(k) && !declared.has(k)) {
            errs.push(
              `version/field-live: version '${v.version}' reads current field '${k}' in expose() but omits it from fields — migrate could contract '${k}' from under this live version; add '${k}' to fields`,
            );
          }
        }
      }
      // (d) version/enum-mapped (§6): every current enum value must be understood by this version (known,
      //     mapped, or tolerant) — an unhandled value would reach an old client at HTTP 200 and break it, a build error.
      for (const [field, spec] of Object.entries(v.enums ?? {})) {
        const col = tm.columns[field];
        if (!col?.check) {
          errs.push(
            `version/enum-mapped: version '${v.version}' declares enums.${field}, but '${field}' is not an enum field of resource '${v.resource}'`,
          );
          continue;
        }
        if (spec.tolerant) continue; // a tolerant reader accepts any value — no coverage owed
        const understood = new Set<string>([
          ...spec.known,
          ...Object.keys(spec.map ?? {}),
        ]);
        for (const val of col.check) {
          if (!understood.has(val)) {
            errs.push(
              `version/enum-mapped: version '${v.version}' does not handle current '${field}' value '${val}' — add it to enums.${field}.known, map it, or mark the field tolerant`,
            );
          }
        }
      }
    }
  }
  return errs;
}

// checkVersionProperties (the fast-check build proofs) lives in versions-props.ts, split out so fast-check
// stays off the runtime value graph this module rides (mod.ts → serve → versions).
