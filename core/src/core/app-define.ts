// App/AppConfig/BootSeams types + defineModule/defineResource — the declaration surface createApp composes.
import type { z } from "zod";
import type { CtxExtras, SchedulingCapConfig } from "./ctx.ts"; // type-only (erased) — the per-app cap config + the injected-ctx-member seam carried on App
import type { Actor, AuthConfig, CrudVerb } from "../authz/auth.ts";
import type { RuntimeAssertsConfig } from "../runtime/alarm.ts"; // type-only (erased) — no runtime edge into the verify layer
import type { Db } from "../data/db.ts";
import type { ReadCtx, RowPolicy } from "../data/repo.ts";
import type { IdStrategy } from "../data/schema.ts";
import type { StorageDriver } from "../data/storage.ts";
import type { EmbeddingProvider } from "../features/embed.ts";
import type { Kms } from "../features/encrypt.ts";
import type { Features } from "./faces.ts"; // type-only — the phantom-carrier vocabulary the StrictFeatures input guard reads
import type { ReadModelDef } from "../features/readmodel.ts";
import type { MaskStyle } from "../features/redact.ts";
import type { RateLimitStore } from "../features/throttle.ts";
import type { BackpressureState } from "../runtime/outbox-emit.ts"; // type-only (erased) — the per-app backpressure state carried on App
import type { Upcaster } from "../features/versioning.ts";
import type { ViewDecl } from "../features/view.ts";
import type { PromptDef } from "../mcp/prompt.ts";
import type { AnySubscriber, AnyWorker } from "../runtime/events.ts";
import type { RelayRegistry } from "../runtime/relay.ts";
import type { AnyJob } from "../runtime/scheduler-core.ts"; // type-only (erased) — scheduler-core imports App as a type too, so no runtime value cycle
import type { TaskDecl } from "../runtime/tasks.ts"; // type-only (erased) — tasks.ts imports App as a type too, so no runtime value cycle
import type { WebhookDecl } from "../runtime/webhook.ts"; // type-only (erased) — the egress declaration carried on App
import type { WorkflowDecl } from "../runtime/workflow.ts";
import type {
  JunctionModel,
  ModuleDecl,
  ResourceDecl,
  ResourceModel,
} from "./app-types.ts";
import type { NoUnknownKeys, ScopeConfig } from "./config.ts";
import { didYouMean } from "./validation.ts";
import {
  canonicalFormatSpelling,
  chainedStringFormat,
  unwrap,
  type ZType,
} from "../data/schema-zod.ts";
import type { VersionDecl } from "./versions.ts";

/** One declared module dependency: the dep module's VALUE — the anchor `Ctx<typeof thisModule>` reads to type
 *  `ctx.modules.<dep>` / `ctx.reads.<dep>` — or its bare NAME, which declares the boundary edge and nothing
 *  else. The bare name is not a weaker spelling of the same thing: a name that resolves to no module is a
 *  compile error naming the fix, so nothing rides on the author picking the richer form. */
export type ModuleDep = string | ModuleDecl;

/** `defineModule`'s input — `ModuleDecl` with `deps` widened to admit module values. Same key roster, so
 *  exactness (`NoUnknownKeys`) and the boot-side `ModuleDecl` reader stay one vocabulary. */
export type ModuleDeclInput =
  & Omit<ModuleDecl, "deps">
  & { readonly deps?: readonly ModuleDep[] };

/** The dep declarations a `deps` list named by value — a name carries no type, so it contributes nothing. */
type DepDeclsOf<M> = M extends
  { readonly deps: infer Ds extends readonly unknown[] }
  ? Extract<Ds[number], ModuleDecl>
  : never;

/** What `defineModule` hands back: `deps` NORMALIZED to names — the composed model is name-keyed everywhere —
 *  with the dep declarations kept on `depModules`, the anchor `faces-ctx.ts §ModulesOf` derives the facade from. */
export type ModuleOf<M> =
  & Omit<M, "deps">
  & {
    readonly deps: readonly string[];
    readonly depModules: readonly DepDeclsOf<M>[];
  };

/** Exact against `ModuleDeclInput` (`NoUnknownKeys`) — a bare `<const M>(decl: M)` never gets the excess-property
 *  check, and nothing reads module keys at boot, so an invented key would be ignored for the app's lifetime.
 *  The returned object is a normalized COPY, not the literal: `deps` must reach `createApp` as names. */
export function defineModule<const M extends ModuleDeclInput>(
  decl: NoUnknownKeys<M, ModuleDeclInput>,
): ModuleOf<M> {
  const deps: readonly ModuleDep[] = (decl as ModuleDeclInput).deps ?? [];
  return {
    ...(decl as ModuleDeclInput),
    deps: deps.map((d) => typeof d === "string" ? d : d.name),
    depModules: deps.filter((d): d is ModuleDecl => typeof d !== "string"),
  } as unknown as ModuleOf<M>;
}

/** The schema-qualified table reference for a model — `"schema"."table"`. */
export const tableOf = (m: ResourceModel): string =>
  `"${m.pgSchema}"."${m.name}"`;

/** The fully-parsed `sensitive` card (04-features.md §sensitive). `fields` is the PII column list (→ redact/drop);
 *  `mask` is the log mask style (`"full"` / `"partial"`) the runtime applies on the audit-diff/log/OTel path. */
interface SensitiveConfig {
  readonly fields: readonly string[];
  readonly mask: MaskStyle;
}

/** Normalize the two `sensitive` declaration forms into one `{ fields, mask }` card (04-features.md
 *  §sensitive). `mask` defaults to `"full"` (the fail-safe — a leaked tail is still PII); `"partial"` is
 *  opted into, never inherited. Absent ⇒ `{ fields: [], mask: "full" }`. */
export function normalizeSensitive(
  raw: readonly string[] | {
    readonly fields: readonly string[];
    readonly mask?: MaskStyle;
  } | undefined,
): SensitiveConfig {
  if (raw === undefined) return { fields: [], mask: "full" };
  if (Array.isArray(raw)) return { fields: raw, mask: "full" };
  const o = raw as {
    readonly fields: readonly string[];
    readonly mask?: MaskStyle;
  };
  return { fields: o.fields ?? [], mask: o.mask ?? "full" };
}

/** The framework-owned key vocabulary (the meta-schema) — strict on framework keys, transparent on user
 *  values (schema / rowPolicy bodies). Exported so the example-dogfood coverage tooth
 *  forces a new dogfood or goes RED on a new face. */
/** Compile-bound to `ResourceDecl` via `Record<keyof ResourceDecl, true>` (the shape `defineView`'s
 *  `VIEW_DECL_KEY_MAP` already uses): a declaration key added to the type with no entry here is a `deno
 *  check` error, and an entry naming a key the type does not have is the same error the other way. The Set
 *  below is DERIVED from it, so the meta-schema and the type can never describe different vocabularies —
 *  which is how a phantom `policy` key sat in this roster with no member and no reader tree-wide. */
const DECL_KEY_MAP: Record<keyof ResourceDecl, true> = {
  name: true,
  path: true,
  schema: true,
  features: true,
  operations: true,
  transitions: true,
  unique: true,
  references: true,
  rowPolicy: true,
  http: true,
  mcp: true,
  rollups: true,
  owns: true,
  relates: true,
  id: true,
  capabilities: true,
  encrypted: true,
  searchable: true,
  vector: true,
  i18n: true,
  i18nFallback: true,
  sensitive: true,
};

export const DECL_KEYS: ReadonlySet<string> = new Set(
  Object.keys(DECL_KEY_MAP),
);
/** The `features:{}` flag vocabulary. Exported so the example-dogfood coverage tooth
 *  forces a new dogfood or goes RED on a new feature. */
export const FEATURE_KEYS: ReadonlySet<string> = new Set([
  "softDelete",
  "timestamps",
  "audit",
  "onRow",
  "versioning",
  "expiry",
  "temporal",
  "tree",
  "treeClosure",
  "sequence",
  "idempotency",
  "immutable",
  "scope",
  "singleton",
]);

/** The phantom-carrier keys on `Features` — declared as top-level `defineResource` keys (decl.searchable,
 *  decl.transitions, decl.rollups, decl.vector), surfaced on `Features` only for face-shaping, NEVER valid flags. */
type PhantomCarrierKey = "searchable" | "transitions" | "rollups" | "vector";
/** The valid `features:{}` flag keys = `FEATURE_KEYS` at the type level: `Features` minus the phantom
 *  carriers, plus `idempotency`. A drift tooth binds this so the two rosters can't drift. */
type FeatureFlagKeys =
  | Exclude<keyof Features, PhantomCarrierKey>
  | "idempotency";
/** Reject a `features:{}` object naming a non-flag key (a phantom carrier or a typo) at author time, so
 *  `features:{ searchable:true }` fails `deno check`. */
//  `[Features] extends [F]` passes the wide `Features` type through unbranded — a value explicitly cast as
//  `Features` is a deliberate escape, not an author typo; only a narrow literal is brand-checked key-by-key.
//  The rejection is an OBJECT carrying the sentence as its key, never the sentence itself — the same carrier
//  `StrictSurfaceKeys` and `RowPolicySlot` use, and for the same reason: the author's literal is intersected
//  in, `true & "✗ …"` reduces to `never` and prints as `not assignable to type 'never'` (the location with no
//  reason), while a boolean ∧ an object does not reduce, so the sentence survives into the diagnostic.
export type StrictFeatures<F> = [Features] extends [F] ? F : {
  readonly [K in keyof F]: K extends FeatureFlagKeys ? F[K]
    : {
      readonly [
        _ in `'${
          & K
          & string}' is not a features:{} flag: declare it as a TOP-LEVEL defineResource key`
      ]: never;
    };
};

/**
 * A column THIS declaration's table actually has AND can hold an actor id — the ownership shorthand's key
 * space. Checked against `D["schema"]` rather than a hand-supplied `Row`, so the name cannot disagree with
 * the table.
 *
 * The TYPE filter is not decoration. The shorthand lowers to `owner_col = <actor.id>`, and `actor.id` is a
 * string, so a numeric or boolean column yields SQL Postgres refuses — `invalid input syntax for type
 * double precision` on every authenticated read, discovered at request time on a declaration that
 * type-checked, booted and verified clean.
 *
 * `id` joins the declared keys because the framework mints it on every resource and it is the ownership
 * column of the standing case: a user row whose OWN id is the actor's, which is what both reference apps
 * narrow their `app_user` on. The other minted columns are deliberately out — owning a row by its
 * `created_at` is not a rule anyone means.
 */
type OwnColumn<D extends ResourceDecl> =
  | (D["schema"] extends z.ZodObject<infer S> ? {
      [K in Extract<keyof S, string>]: NonNullable<z.infer<S[K]>> extends string
        ? K
        : never;
    }[Extract<keyof S, string>]
    : never)
  | "id";

/**
 * The `rowPolicy` slot types the actor as `Actor|null` only (13-authz.md §open-tails); the return stays
 * `unknown` (not `Where<Row>`) since a Row-typed return can't admit both authoring forms.
 *
 * A bare COLUMN NAME is the ownership shorthand — `rowPolicy: "owner_id"` means what
 * `owned(fields<Row>().owner_id)` means, and costs one line and no import. It exists because the secure
 * form was measurably longer than the insecure one: `http: { list: { policy: "public", columns: ["id"] } }`
 * names the open door in one card, while the fragment form additionally needs the schema hoisted to a const
 * to build a `fields<Row>()` proxy. Same shorthand↔full-form shape `HttpRoute` already has (a write may stay
 * `create: "policy"` beside the fuller read card with `columns`).
 */
// Branches on what was WRITTEN, never a union of the two: a union has no single call signature, so an
// un-annotated `(actor) => …` loses its contextual type and becomes an implicit `any` parameter.
// The rejection is a branded OBJECT, never the `OwnColumn` union: handing back a union the literal is not a
// member of makes `D` itself un-inferable, and TypeScript then reports EVERY property of the declaration as
// `not assignable to never` — the one real error buried under `name` and `schema`.
type RowPolicySlot<D extends ResourceDecl> = [unknown] extends [D["rowPolicy"]]
  ? D["rowPolicy"]
  : D["rowPolicy"] extends string
    ? [D["rowPolicy"]] extends [OwnColumn<D>] ? D["rowPolicy"]
    : {
      readonly [
        _ in `rowPolicy: '${
          & D["rowPolicy"]
          & string}' is not a string column of this resource's schema. The ownership shorthand lowers to '<col> = <actor.id>' and an actor id is a string, so it needs a string column that carries ownership`
      ]: never;
    }
  : (actor: Actor | null) => unknown;

/** Does one op value carry the decisions the pipeline dispatches on — an `input` schema and a `policy` slot
 *  always, plus an `idempotent` verdict whenever the op is a write? `defineOp`'s own slot type says the same
 *  thing; this restates it structurally so the value's ORIGIN stops mattering. */
type OpDecisionsWritten<O> = O extends { readonly input: unknown }
  ? O extends { readonly policy: unknown }
    // `tx` first, and as its OWN conjunct: an omitted one lands `write` at the pipeline, so a read-only op
    // silently takes a write transaction — locks it does not need, and no read replica can serve it.
    //
    // PRESENCE, not the literal. This layer checks what survives its own erasure: hoisting a declaration into
    // a `const` (the blessed idiom for defeating the freshness check) widens `"write"` to `string`, and a
    // literal-union test would then reject a declaration that states `tx` perfectly well. `policy` and
    // `idempotent` survive hoisting because neither is a literal union; asking `tx` for its VALUE here would
    // make it the one slot the idiom breaks. The VALUE is checked where it survives — `defineOp`'s own slot
    // type on the literal door, and `op/decisions-written` at boot on every door.
    ? O extends { readonly tx: unknown }
      ? O extends { readonly tx: "read" } ? true
      : O extends { readonly idempotent: boolean } ? true
        // a LITERAL write with no verdict is refused here; a widened `tx` leaves the pairing to the boot guard,
        // which reads the runtime value and cannot be fooled by erasure.
      : O extends { readonly tx: "write" } ? false
      : true
    : false
  : false
  : false;

/** Reject an op that reaches `operations` with a decision unmade. `ResourceDecl.operations` is the erased
 *  runtime shape (`Record<string, unknown>`) every dispatch site reads, so the INLINE object-literal spelling
 *  skips `defineOp` and its slot type entirely; this conjunct type-checks the literal at the declaration.
 *  The boot guard `op/decisions-written` is the floor under both spellings — this is the earlier, louder half. */
type StrictOperations<Ops> = [Readonly<Record<string, unknown>>] extends [Ops]
  ? Ops
  : {
    readonly [
      // `NonNullable`, because a conditionally-spread op key arrives as `OpDecl | undefined` and the
      // `undefined` arm alone would fail the check. The boot guard still refuses an actually-undefined value.
      K in keyof Ops
    ]: OpDecisionsWritten<NonNullable<Ops[K]>> extends true ? Ops[K]
      : {
        readonly [
          _ in `op '${
            & K
            & string}' leaves a pipeline decision unmade: write input (the z.* schema the pipeline validates the body against), policy (null = the deliberate public door), tx: "read" | "write", and, on a write, idempotent: boolean`
        ]: never;
      };
  };

/**
 * The route names a resource's surface cards may key — the five CRUD verbs plus this declaration's own
 * `operations` keys. Both `http` and `mcp` are read by NAME at boot (`app-refs.ts §isPolicyExposedOp`),
 * so a name outside this set addresses nothing: the route the author believes they declared is simply
 * never mounted, and every downstream guard agrees with them because it reads the same empty map.
 */
type SurfaceKey<D extends ResourceDecl> =
  | CrudVerb
  | (keyof NonNullable<D["operations"]> & string);

/**
 * Reject a surface card keyed on a name this resource does not have. `Record<string, …>` is the legal
 * slot type — it must be, because the key space is per-declaration — and an index signature admits every
 * spelling, so `http: { get: "policy" }` type-checked and booted with the route silently unmounted.
 *
 * `http/custom-route-has-op` and `hygiene/no-unused-declaration` are the FLOOR under both spellings; this
 * is the earlier, louder half, exactly as `StrictOperations` is to `op/decisions-written`. There is
 * deliberately NO runtime twin: two refusals for one rule is the dual path this project rejects, and those
 * rungs already answer for a declaration that reached the model past the type layer. What this half buys is
 * the mcp case — `hygiene/no-unused-declaration` derives `blocks:"warn"`, so a dangling agent tool ships.
 *
 * The escape is the INDEX SIGNATURE (`string extends keyof Card`), not assignability to one wide type: a
 * computed map declared `Record<string, "public" | "policy">` is narrower than `Record<string, unknown>`
 * and an assignability escape reads it as an author's literal, branding every key it carries. A card whose
 * `keyof` includes `string` was not written key by key, so there is nothing to check key by key.
 */
// The rejection is an OBJECT whose single key carries the sentence, never the sentence itself: the caller's
// literal is intersected in (`NoUnknownKeys` is `D & …`), and `"policy" & "✗ …"` reduces to `never`, which
// prints as `not assignable to type 'never'` — the location without the reason. A string ∧ an object does
// not reduce, so the message survives into the diagnostic.
export type StrictSurfaceKeys<Card, D extends ResourceDecl> = string extends
  keyof Card ? Card
  : {
    readonly [K in keyof Card]: K extends SurfaceKey<D> ? Card[K]
      : {
        readonly [
          _ in `'${
            & K
            & string}' is not a route name on this resource: key it on a CRUD verb (list/find/create/update/delete) or on one of its own operations keys`
        ]: never;
      };
  };

/** The `NoUnknownKeys` conjunct makes the literal exact against `ResourceDecl`: a typo'd top-level key is a
 *  compile error at the property, not a boot-time `decl/unknown-key` the author meets on first run. */
export function defineResource<const D extends ResourceDecl>(
  decl:
    & NoUnknownKeys<D, ResourceDecl>
    & {
      readonly features?: StrictFeatures<D["features"]>;
      readonly rowPolicy?: RowPolicySlot<D>;
      readonly operations?: StrictOperations<D["operations"]>;
      readonly http?: StrictSurfaceKeys<D["http"], D>;
      readonly mcp?: StrictSurfaceKeys<D["mcp"], D>;
    },
): D {
  return decl; // declaration is pure data; the model is assembled at createApp
}

// `VersionDecl` + `defineVersion` + the `version/*` boot checks live in `./versions.ts`, re-exported
// through `mod.ts`. The `App`/`AppConfig` version fields below reference the imported `VersionDecl` type.

/**
 * `zod/format-canonical` — a string subtype must be spelled at top level (`z.uuid()`), never chained
 * (`z.string().uuid()`). Both spellings declare the same type and both compile, so the chained one is a
 * deprecated-but-working path: it is what a generator has seen most, and it silently derived `text` where
 * the canonical spelling derives `uuid`/`timestamptz` until `stringFormatOf` unified the two readers.
 * Refusing it removes the wrong answer from the corpus rather than merely making it harmless.
 */
function checkZodFormatSpelling(decl: ResourceDecl): string[] {
  const shape = (decl.schema as unknown as { shape?: Record<string, unknown> })
    ?.shape;
  if (!shape) return [];
  const errs: string[] = [];
  for (const [field, raw] of Object.entries(shape)) {
    const { inner } = unwrap(raw as ZType);
    const chained = chainedStringFormat(inner);
    if (chained === undefined) continue;
    errs.push(
      `zod/format-canonical: resource '${decl.name}' field '${field}' is declared \`z.string().${chained}()\` — write \`${
        canonicalFormatSpelling(chained)
      }\` instead. Both spellings compile and declare the same type, which is exactly why the chained one must not exist: it is the form a generator has seen most, and it is the form that derived a \`text\` column where the canonical one derives its real pg type.`,
    );
  }
  return errs;
}

/**
 * `authz/rowpolicy-column-type` — the ownership shorthand's column must be able to hold an actor id.
 *
 * The floor under `OwnColumn`'s type filter, for the spellings the type door cannot reach: a declaration
 * built past the type layer, or a schema whose shape TypeScript infers as something other than `z.ZodObject`.
 * The shorthand lowers to `<col> = <actor.id>` and `actor.id` is a string, so a numeric column produces SQL
 * Postgres rejects — a 500 on every authenticated read of a resource that booted clean.
 */
function checkRowPolicyShorthand(decl: ResourceDecl): string[] {
  const col = decl.rowPolicy;
  if (typeof col !== "string" || col === "id") return []; // `id` is framework-minted and always text-shaped
  const shape = (decl.schema as unknown as { shape?: Record<string, unknown> })
    ?.shape;
  const raw = shape?.[col];
  if (raw === undefined) {
    return [
      `authz/rowpolicy-column-type: resource '${decl.name}' declares \`rowPolicy: "${col}"\` but its schema has no '${col}' — the ownership shorthand names a column of THIS resource, and a name the table lacks is a rule that matches no row`,
    ];
  }
  const { inner } = unwrap(raw as ZType);
  const kind = (inner as { def?: { type?: string } }).def?.type;
  if (kind === "string") return [];
  return [
    `authz/rowpolicy-column-type: resource '${decl.name}' declares \`rowPolicy: "${col}"\` but '${col}' is a ${
      kind ?? "non-string"
    } column — the shorthand lowers to \`${col} = <actor.id>\` and an actor id is a string, so every authenticated read would fail in the database rather than narrow. Name a string column that carries ownership, or write the rule as a fragment.`,
  ];
}

/**
 * `decl/shape-required` — the two facts every declaration needs before anything else can read it. Without
 * this, a declaration built dynamically (a generator loop, a JSON-driven scaffold, anything past the type
 * layer) met `Cannot read properties of undefined (reading 'includes')` from inside the name segmenter and
 * `…(reading 'shape')` from the schema walker: a TypeError names neither the mistake nor the fix, which is
 * the one thing a refusal is for.
 */
export function checkRequiredShape(decl: ResourceDecl): string[] {
  const errs: string[] = [];
  if (typeof decl.name !== "string") {
    errs.push(
      `decl/shape-required: a resource declaration has no \`name\` — every derived face (table, route, tool, invariant) is keyed by it, so nothing can be composed without one`,
    );
  }
  if (
    decl.schema === undefined ||
    (decl.schema as unknown as { shape?: unknown })?.shape === undefined
  ) {
    errs.push(
      `decl/shape-required: resource '${
        typeof decl.name === "string" ? decl.name : "(unnamed)"
      }' has no \`schema\` — declare one with \`schema: z.object({ … })\`; the columns, the wire shapes and the fixtures all derive from it`,
    );
  }
  return errs;
}

/** The `features:{}` flag an invented TOP-LEVEL key is one edit from — the mirror of the features→top-level
 *  steer below. Exact hit first, then near-miss, so both `softDelete` (right word, wrong nesting) and
 *  `softDeletes` (wrong word, wrong nesting) reach the same relocation sentence. */
function nearestFeatureKey(k: string): string | undefined {
  if (FEATURE_KEYS.has(k)) return k;
  const near = didYouMean(k, [...FEATURE_KEYS]);
  return near !== undefined && !DECL_KEYS.has(near) ? near : undefined;
}

export function checkUnknownKeys(decl: ResourceDecl): string[] {
  // Shape first, and RETURN on failure: every check below reads `decl.name` or walks `decl.schema.shape`,
  // so running them against a malformed declaration is how the TypeError got out in the first place.
  const shape = checkRequiredShape(decl);
  if (shape.length > 0) return shape;
  const errs: string[] = [
    ...checkZodFormatSpelling(decl),
    ...checkRowPolicyShorthand(decl),
  ];
  for (const k of Object.keys(decl)) {
    if (!DECL_KEYS.has(k)) {
      // Retired child-side ownership: `parent:` used to mint the FK on THIS resource; ownership is now
      // declared only on the parent via `owns` + `hasMany`/`hasOne` (02-dsl.md §owns). A bare unknown-key
      // would leave the author grepping for a synonym; name the rewrite.
      if (k === "parent") {
        errs.push(
          `unknown declaration key 'parent' on resource '${decl.name}' — child-side \`parent:\` is removed; declare ownership on the parent with \`owns: { …: hasMany(${decl.name}) }\` (or hasOne)`,
        );
        continue;
      }
      // The shipped steer promises this error carries a did-you-mean; without it the reader is told a key
      // is unknown and left to diff two rosters by eye — the guess-and-retry loop the error exists to end.
      // BOTH vocabularies, because the misplacement runs both ways: the features→top-level steer below was
      // written first and its mirror was not, so `softDeletes` — one edit from the real `features:{softDelete}` —
      // got no hint at all while `features:{rowPolicy}` got an exact relocation.
      const feature = nearestFeatureKey(k);
      const steer = feature !== undefined
        ? ` — '${feature}' is a features:{} flag, not a top-level key; write features: { ${feature}: true }`
        : "";
      const near = steer === "" ? didYouMean(k, [...DECL_KEYS]) : undefined;
      errs.push(
        `unknown declaration key '${k}' on resource '${decl.name}'${steer}${
          near ? ` — did you mean '${near}'?` : ""
        }`,
      );
    }
  }
  for (const k of Object.keys(decl.features ?? {})) {
    if (!FEATURE_KEYS.has(k)) {
      // steer the misplacement, not just the rejection: encrypted/sensitive/searchable/… are top-level
      // defineResource keys, and a bare "unknown feature" leaves the self-correction loop blind
      const steer = DECL_KEYS.has(k)
        ? ` — '${k}' is a TOP-LEVEL defineResource key (a sibling of schema and features); move it out of features:{}`
        : "";
      const near = steer === "" ? didYouMean(k, [...FEATURE_KEYS]) : undefined;
      errs.push(
        `unknown feature '${k}' on resource '${decl.name}'${steer}${
          near ? ` — did you mean '${near}'?` : ""
        }`,
      );
    }
  }
  // strict-parse the object-form security cards: a ghost key (a guessed `visibility`/`redactInLog`) must be
  // a loud error, never a silently-ignored security expectation
  if (decl.sensitive !== undefined && !Array.isArray(decl.sensitive)) {
    for (const k of Object.keys(decl.sensitive)) {
      if (k !== "fields" && k !== "mask") {
        errs.push(
          `unknown key '${k}' on resource '${decl.name}' sensitive card — the card is { fields, mask }`,
        );
      }
    }
  }
  if (decl.encrypted !== undefined && !Array.isArray(decl.encrypted)) {
    for (const k of Object.keys(decl.encrypted)) {
      if (k !== "fields" && k !== "table" && k !== "key" && k !== "equality") {
        errs.push(
          `unknown key '${k}' on resource '${decl.name}' encrypted card — the card is { fields, table, key, equality }`,
        );
      }
    }
  }
  if (
    decl.features?.temporal !== undefined &&
    typeof decl.features.temporal === "object"
  ) {
    for (const k of Object.keys(decl.features.temporal)) {
      if (k !== "noOverlap") {
        errs.push(
          `unknown key '${k}' on resource '${decl.name}' temporal card — the card is { noOverlap }`,
        );
      }
    }
  }
  // Nested invent doors that `defineOp` / Exact types close at the helper path but a BARE literal skips —
  // walk them here so an invented key is a loud boot fail on both authoring forms (API-1).
  if (decl.operations !== undefined) {
    for (const [opName, raw] of Object.entries(decl.operations)) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        continue;
      }
      for (const k of Object.keys(raw as Record<string, unknown>)) {
        if (!OP_CARD_KEYS.has(k)) {
          const near = didYouMean(k, [...OP_CARD_KEYS]);
          errs.push(
            `unknown key '${k}' on resource '${decl.name}' operation '${opName}'${
              near ? ` — did you mean '${near}'?` : ""
            }`,
          );
        }
      }
    }
  }
  if (decl.unique !== undefined) {
    for (const entry of decl.unique) {
      if (Array.isArray(entry)) continue; // full unique: a string[] of column names
      if (entry === null || typeof entry !== "object") continue;
      for (const k of Object.keys(entry)) {
        if (k !== "cols" && k !== "where") {
          errs.push(
            `unknown key '${k}' on resource '${decl.name}' unique card — the card is { cols, where }`,
          );
        }
      }
    }
  }
  if (decl.vector !== undefined && typeof decl.vector === "object") {
    for (const k of Object.keys(decl.vector)) {
      if (k !== "field" && k !== "source" && k !== "dims" && k !== "model") {
        errs.push(
          `unknown key '${k}' on resource '${decl.name}' vector card — the card is { field, source, dims, model? }`,
        );
      }
    }
  }
  return errs;
}

/** Keys a bare `operations: { op: { … } }` literal may carry — the same roster `defineOp` Exact-types,
 *  plus framework-stamped private marks (`_passwordBinding` from `passwordLogin`/`passwordRefresh`).
 *  Exported so the invented-key planner refuses a surplus op key against the same set boot uses. */
export const OP_CARD_KEYS: ReadonlySet<string> = new Set([
  "input",
  "output",
  "policy",
  "idempotent",
  "tx",
  "handler",
  "before",
  "after",
  "replace",
  "around",
  "resources",
  "idempotencyLeaseMs",
  "deadlineMs",
  "deprecated",
  "sunset",
  "replacedBy",
  "_passwordBinding",
]);

/**
 * A name segment in the `<module>__<resource>__<op>` MCP tool name (and URI axis): the emitted charset is
 * `[a-z0-9_]` and `__` is reserved as the segment separator (12-mcp §161/§163). An illegal name silently
 * breaks tool-name reversibility (`parseToolName` would split wrong), so it is a loud boot-fail.
 */
const SEGMENT = /^[a-z0-9_]+$/;
export function segmentErr(name: string, what: string): string | null {
  if (!SEGMENT.test(name)) {
    return `illegal ${what} name '${name}' — a name segment is [a-z0-9_] only (the tool-name/URI charset)`;
  }
  if (/^[0-9]/.test(name)) {
    return `illegal ${what} name '${name}' — a name segment must not start with a digit (drizzle identifiers, and the tool-name/URI charset)`;
  }
  if (name.includes("__")) {
    return `illegal ${what} name '${name}' — '__' is reserved as the <module>__<resource>__<op> separator`;
  }
  return null;
}

/** Framework-owned first path segments (`/health`, `/mcp`, …). A resource `path` equal to one of these
 *  mounts business CRUD on the same URL as a protocol/probe door — refused at boot. */
export const RESERVED_ROUTE_SEGMENTS: ReadonlySet<string> = new Set([
  "health",
  "ready",
  "mcp",
  "version",
  "tasks",
  "openapi",
  "views",
]);

/** Validate `defineResource({ path })` — bare segment, same charset as a name, not a reserved door. */
export function pathSegmentErr(
  path: string,
  resource: string,
): string | null {
  if (path === "") {
    return `decl/path-invalid: resource '${resource}' path must be a non-empty segment (e.g. path: "entries"), not empty`;
  }
  if (path.startsWith("/") || path.includes("/")) {
    return `decl/path-invalid: resource '${resource}' path '${path}' must be a bare segment — write path: "entries", not "/entries"`;
  }
  const seg = segmentErr(path, "path");
  if (seg) {
    return `decl/path-invalid: resource '${resource}' path '${path}' — ${
      seg.replace(/^illegal path name '[^']+' — /, "")
    }`;
  }
  if (RESERVED_ROUTE_SEGMENTS.has(path)) {
    return `decl/path-invalid: resource '${resource}' path '${path}' is a framework route segment (reserved: ${
      [...RESERVED_ROUTE_SEGMENTS].sort().join(", ")
    }) — pick another path so CRUD does not share a URL with /${path}`;
  }
  return null;
}

/**
 * A named external datasource (05-runtime.md §datasources): not a second owned substrate — unmigrated, no
 * modeled resource, no WHERE-stack/scope/rowPolicy. `access:"read"` refuses writes; `url` is documentary,
 * the live connection comes from `boot.datasources`.
 */
export interface DatasourceDecl {
  readonly access: "read" | "readwrite";
  readonly url?: string;
}

export interface AppConfig {
  readonly resources?: ReadonlyArray<ResourceDecl>; // flat (module-less) → module "app", schema "public"
  // Named external datasources (05-runtime.md §datasources), reached only via `ctx.datasource("<name>")` (raw
  // SQL, no WHERE-stack/scope/rowPolicy). A declared datasource with no `boot.datasources` connection loud-refuses.
  readonly datasources?: Readonly<Record<string, DatasourceDecl>>;
  readonly modules?: ReadonlyArray<ModuleDecl>; // module-grouped → one pg schema per module
  // Flat-app producer topics (05-runtime.md §event-surface-lock). A module-less app has no
  // `defineModule({ emits })`; webhooks and `event/subscribe-declared` still need a declared producer
  // set, so the same card sits on the app. Unioned with each module's emits at compose.
  readonly emits?: readonly string[] | Readonly<Record<string, z.ZodType>>;
  // the app-wide default PK type (02-dsl.md §id) — `"uuidv7"` (framework default) / `"serial"` / `"uuidv4"`.
  // A per-resource `id` on `defineResource` overrides it; absent both, the framework default applies.
  readonly id?: IdStrategy;
  // Read-only projections (`defineView`, 12-mcp §6) composed onto `App.views`. A view with `mcp` joins the
  // agent read-tool surface (`<module>__<view>__view`); without it, invisible to agents (the safe default).
  readonly views?: ReadonlyArray<ViewDecl>;
  // The app's declared async consumer surface (05-runtime.md §5) — `defineSubscriber`/`defineWorker` composed
  // onto `App.relay`, so the live relay fans each drained `_outbox` message to its consumer.
  readonly subscribers?: ReadonlyArray<AnySubscriber>;
  readonly workers?: ReadonlyArray<AnyWorker>;
  // Per-topic versioned `defineUpcaster` links + `currentVersion`, keyed by topic — composed onto
  // `App.relay.upcasters` so a stored vN payload upgrades to vCurrent before parse-at-consume (05-runtime.md §5.2).
  readonly upcasters?: Readonly<
    Record<
      string,
      { readonly links: readonly Upcaster[]; readonly currentVersion?: number }
    >
  >;
  // Authored MCP `definePrompt` records (12-mcp §prompts) — the one MCP primitive with no op/entity source,
  // composed onto `App.prompts` so `hazelnut verify --surfaces` and the serve layer both reach the same set.
  readonly prompts?: ReadonlyArray<PromptDef>;
  // Materialized `defineReadModel` projections carried to `App.readModels` and stamped
  // onto each source resource's `readModelSinks` so the write path enqueues the outbox-fenced re-projection.
  readonly readModels?: ReadonlyArray<ReadModelDef>;
  // Declared durable `defineWorkflow` records (05-runtime.md §workflow durable steps) carried to
  // `App.workflows` so `runWorkflow` resolves by name; the journal substrate is the `_workflow_journal` table.
  readonly workflows?: ReadonlyArray<WorkflowDecl>;
  // Declared `defineTask` records (05-runtime.md §task, submit→poll). Composed onto `App.tasks`; createApp
  // appends each task's `_task:<name>` drain worker to the relay and builds `ctx.tasks.<name>.submit`.
  readonly tasks?: ReadonlyArray<TaskDecl>;
  // Declared `defineJob` cron records (05-runtime.md §4.1). Composed onto `App.jobs`; `startFeatureScheduler`
  // registers each on the Scheduler seam (alongside feature-auto sweeps). `scheduler.register` remains a
  // test/escape hatch for a job that is not listed here.
  readonly jobs?: ReadonlyArray<AnyJob>;
  // The app's `defineVersion` API-version projections (multi-version.md §1) — a direct projection of a
  // resource's `current` row into one pinned breaking shape. `serve.ts` applies the match per version header.
  readonly versions?: ReadonlyArray<VersionDecl>;
}

export interface App {
  readonly model: ReadonlyArray<ResourceModel>;
  // The DECLARED module-dep graph (10-invariants.md §static-conformance) — one entry per `defineModule`, INCLUDING a
  // module that contributes no resources. The model cannot carry this: `moduleDeps` rides on `ResourceModel`,
  // so a resource-less module has nothing to hang it on and its edges would be invisible to
  // `boundary/no-cycle` — a cycle routed through such a module would go unreported.
  readonly moduleGraph?: ReadonlyArray<{
    readonly name: string;
    readonly deps: readonly string[];
  }>;
  readonly schemas: ReadonlyArray<string>; // the distinct pg schemas to create (migrate)
  readonly junctions: ReadonlyArray<JunctionModel>; // derived many-to-many junction tables
  // The app-wide permission vocabulary (13-authz.md §authz-seam) — the de-duped, sorted union of every
  // resource's `<resource>:<op>` perms. Optional so pre-existing `App`-shaped literals stay valid.
  readonly perms?: ReadonlyArray<string>;
  // The app-wide row-scoping config from `defineConfig({ scope })` (04-features.md §scope) — names which
  // key and how to resolve it per request; null when undeclared. Opt-in per resource is `features:{ scope:true }`.
  readonly scope?: ScopeConfig | null;
  // The boot closure's servable handler (05-runtime.md §createApp): `Deno.serve(app.fetch)`. Present iff
  // `createApp` is given the runtime seam bundle (`boot`); absent on the pure-model path.
  readonly fetch?: (req: Request) => Response | Promise<Response>;
  /** Stops the in-process async drain — present iff `createApp` was booted with `boot.relay: "in-process"`;
   *  clears the poll timer so a graceful shutdown (or a test) can end the drain loop deterministically. */
  readonly stopInProcessRelay?: () => void;
  // Composed `defineView` projections (12-mcp §6) from `AppConfig.views` — the MCP serve layer, surface-
  // lock, and instructions all read `app.views` so a view's read-tool is reached end-to-end.
  readonly views?: ReadonlyArray<ViewDecl>;
  // The composed async consumer registry (05-runtime.md §5) — `defineSubscriber`/`defineWorker` consumers +
  // upcaster chains, in the shape `runLiveRelay(db, app.relay)` consumes. Undeclared topics go un-drained.
  readonly relay?: RelayRegistry;
  // Typed producer payload contracts (05-runtime.md §event-surface-lock) — the app-level fold of every
  // module's `emits: { topic: zod }`; `ctx.emit` strict-parses a typed topic's payload against it (parse-at-emit).
  readonly emitSchemas?: Readonly<Record<string, z.ZodType>>;
  // The per-deployment runtime-assert config surface (09-verifier.md §determinism-axis) from
  // `defineConfig({ runtimeAsserts })` — which asserts run (`exclude`) and the vector-staleness scan bound.
  readonly runtimeAsserts?: RuntimeAssertsConfig;
  // Composed `definePrompt` records (12-mcp §prompts) from `AppConfig.prompts` — `hazelnut verify --surfaces`
  // reads `app.prompts` so a removed/retyped member fires `mcp/additive-only`.
  readonly prompts?: ReadonlyArray<PromptDef>;
  // The MCP Origin allowlist (`AppConfig.mcp.allowedOrigins`), carried so the hardened gateway — which only
  // holds the pure composed App — can enforce the DNS-rebinding check at its own boundary (12-mcp §transport).
  // `null` is CARRIED, not normalised: it is the "open on purpose" declaration, and `hazelnut launch`
  // must tell it apart from absence — absence is what it refuses.
  readonly mcpAllowedOrigins?: readonly string[] | null;
  // The `/openapi.json` exposure as DECLARED, carried onto the pure model so a tool that holds only the app
  // can read the posture. `hazelnut launch` refuses an ungated document: the served route is built from
  // `ServeConfig`, which only exists once something boots, and by then the launcher has already handed the
  // process its grants.
  readonly openapi?: { readonly public?: boolean; readonly gate?: string };
  // The other two DECLARED app-level gates, carried for the same reason `openapi` is: a check that holds
  // only the composed app must be able to read every gated face. `authz/gate-resolves` folds all three.
  readonly version?: { readonly gate: string; readonly appVersion?: string };
  readonly mcpRuntime?: { readonly gate: string };
  // Composed materialized `defineReadModel` projections from `AppConfig.readModels` —
  // the maintenance drain (`runReadModelMaintain`) reads this to resolve a job and project the source row.
  readonly readModels?: ReadonlyArray<ReadModelDef>;
  // Composed external datasource declarations (05-runtime.md §datasources) from `AppConfig.datasources` —
  // `ctx.datasource(name)` reads the access mode. Live connections ride `boot`, not here.
  readonly datasources?: Readonly<Record<string, DatasourceDecl>>;
  // Composed outbound webhook sinks (05-runtime.md §externalization) from `AppConfig.webhooks`. The relay
  // consumes them as derived subscribers; this set is the EGRESS declaration a model-only reader needs —
  // `hazelnut launch` derives one `--allow-net` host per url (cli/launch.md §derivation).
  readonly webhooks?: ReadonlyArray<WebhookDecl>;
  // Composed durable `defineWorkflow` records (05-runtime.md §workflow durable steps) from
  // `AppConfig.workflows` — `runWorkflow` resolves a workflow by name off this set.
  readonly workflows?: ReadonlyArray<WorkflowDecl>;
  // Composed `defineTask` declarations (05-runtime.md §task) from `AppConfig.tasks` — createApp appends each
  // task's drain `Worker` to `app.relay.workers`, and `ctx.tasks.<name>.submit` reads this set.
  readonly tasks?: ReadonlyArray<TaskDecl>;
  // Composed `defineJob` cron declarations (05-runtime.md §4.1) from `AppConfig.jobs` — `startFeatureScheduler`
  // / `registerFeatureJobs` register each on the Scheduler seam at serve boot.
  readonly jobs?: ReadonlyArray<AnyJob>;
  /** Extra `ctx` members a module injects at `createApp` (`core/ctx-surface.ts §CtxExtras`) — the op surface
   *  threads it to `buildOpCtx`, which ADDS them to every op ctx; a name a core member already holds is
   *  refused loud there. Core composes none. */
  readonly ctxExtras?: readonly CtxExtras[];
  // The per-agent scheduling-cap config — carried on the App (never a process global), threaded to
  // `ctx.queue` through the op surface. `createApp` defaults it to `defaultSchedulingCap`; `null` opts out.
  readonly schedulingCap?: SchedulingCapConfig | null;
  /** The per-app outbox producer-backpressure state (watermark + gauge cache), threaded through the op
   *  surface to `emit`/`enqueue` + the relay-tick alarm, never a process global. */
  readonly backpressure?: BackpressureState;
  // Composed `defineVersion` API-version projections (multi-version.md §1) from `AppConfig.versions` —
  // `serve.ts` reads `app.versions` per request and applies the match's `expose` after redaction.
  readonly versions?: ReadonlyArray<VersionDecl>;
}

/** The served App — `createApp(config, boot)`'s `fetch`-present return (05-runtime.md §createApp); the
 *  no-boot overload's bare `App` makes serving a model-only build a compile-time, not first-boot, error. */
export interface ServedApp extends App {
  readonly fetch: (req: Request) => Response | Promise<Response>;
}

/**
 * The runtime seam bundle (06-generators.md §3 Phase 0) — the off-machine instances `createApp` closes the
 * boot handler over: `db` is the only owned substrate; `kms`/`auth`/`rowPolicies`/MCP-identity/`prompts`/
 * `rateLimitStore` are opt-in. Supplying `boot` flips composition from a pure model to a servable `fetch`.
 */
export interface BootSeams {
  readonly db: Db; // the owned substrate (a `Db`, or a `Db & Transactor` when write routes are reachable)
  readonly kms?: Kms; // encrypted-at-rest custody (null ⇒ encrypted fields unusable — the repo throws)
  readonly embed?: EmbeddingProvider; // the embedding provider seam (null ⇒ vector fields unusable — the repo throws)
  // The off-box file bytes seam; null + any file() field ⇒ loud boot refuse — no default floor (unlike
  // kms), never a silent local-disk fallback.
  readonly storage?: StorageDriver;
  /** The live connections for `config.datasources`, keyed by the same name — one `Db` per external
   *  datasource. A datasource declared in config but absent here is a loud boot refuse. */
  readonly datasources?: Readonly<Record<string, Db>>;
  readonly auth?: AuthConfig<Request>; // the authn resolver chain (13-authz §authz-seam); absent ⇒ anon
  // boot-state policies for resources that declare none (shadow/unknown name = loud refuse —
  // authz/rowpolicy-single-source)
  readonly rowPolicies?: Readonly<
    Record<string, RowPolicy<Record<string, unknown>>>
  >;
  readonly mcpServerInfo?: {
    readonly name?: string;
    readonly version?: string;
  }; // MCP `initialize` identity
  readonly mcpInstructions?: string; // the one authored "what is this business" sentence
  readonly prompts?: ReadonlyArray<PromptDef>; // authored MCP prompts (definePrompt)
  readonly rateLimitStore?: RateLimitStore; // opt-in per-actor throttle (13-authz §rate-limit)
  // The opt-in trusted-client-IP resolver — when wired, an anonymous caller is throttled per-IP instead of
  // sharing one global bucket. The deployment asserts trust; the framework never reads a raw client header.
  readonly clientIp?: (req: Request) => string | null | undefined;
  /** The async-drain boot choice: `"in-process"` makes the serve process drain its own `_outbox` on a timer
   *  (`runLiveRelay`), so subscribers/workers/read-models fire with no separate `hazelnut relay --loop`.
   *  `"external"` silences the undrained-async boot warn (a separate process owns the drain). Absent + async
   *  features declared ⇒ a loud boot warning; the drain is idempotent either way (the `_processed` fence). */
  readonly relay?: "in-process" | "external" | {
    readonly mode: "in-process";
    readonly intervalMs?: number;
  };
  /** The feature-scheduler boot choice — the TTL sweeps + `expiry` purges `schedulerJobsFor` derives make
   *  virtually every served app scheduler-dependent. `"in-process"` wires `startFeatureScheduler` onto
   *  `Deno.cron` (needs `--unstable-cron`; absent the flag, jobs warn once and no-op). `"external"` means a
   *  separate process owns it. Absent + scheduler-dependent ⇒ loud boot refuse (same floor as `hazelnut launch`). */
  readonly scheduler?: "in-process" | "external";
}

/** The Phase-5 per-request scope/actor factory (06-generators.md §3): `actor` comes from the serve layer's
 *  authn middleware; `scope` derives from `config.scope.resolve`, or empty when no scope spec is declared. */
export function resolveCtxFactory(
  scope: ScopeConfig | null,
): (req: Request, actor?: Actor) => ReadCtx {
  return (req, actor) => ({
    actor: actor ?? null,
    scope: scope ? scope.resolve({ req, actor: actor ?? null }) : "",
  });
}

// `createApp` (app.ts) composes the app from declarations in memory at boot — never codegen to disk.
// `boot` is the optional runtime seam bundle: absent ⇒ pure model composition; present ⇒ derives `app.fetch`.
