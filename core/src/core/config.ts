import type { AppConfig, CreateAppConfig } from "./app.ts";
import type { Actor } from "../authz/auth.ts";

/**
 * `defineConfig` (02-dsl.md §defineConfig) — the app-level entry naming modules/resources plus app-wide
 * knobs (`scope`, passthrough `mcp`). A typed identity function like `defineModule`/`defineResource`:
 * pure data, materialized at boot by `createApp`. Additive over flat `AppConfig`, so `createApp` accepts either.
 */

/**
 * The per-request input the app-wide scope resolver reads (04-features.md §scope: scope is generic
 * row-scoping, not framework-owned tenancy) — the raw `Request` plus the seam-resolved `Actor` (null
 * before authn). Derive from a claim via `actor.claims`, from a header/host via `req`.
 */
export interface ScopeInput {
  readonly req: Request;
  readonly actor: Actor | null;
}

/**
 * App-wide row-scoping config (04-features.md §scope) — one key + one resolver, app-level not
 * per-resource. The per-resource `features:{ scope:true }` flag opts a table into scoping (structural);
 * this object names which key and how to resolve its per-request value (resolution) → `ctx.scope`.
 */
export interface ScopeConfig {
  readonly key: string; // the scoping column/key (generic — not "tenant"); e.g. "tenantId"
  readonly resolve: (input: ScopeInput) => string; // per-request → ctx.scope
}

/**
 * The app-level config, additive over flat `AppConfig` — `scope`, `prompts` and the `mcp` block wire
 * directly onto `App` at `createApp`. It does NOT re-declare `mcp`: this interface used to narrow it to
 * `{ instructions }`, which silently made `mcp.allowedOrigins` unwritable through `defineConfig` — one key
 * declared twice, and the narrower copy is the one a consumer's config is checked against. No `db` slot: the connection is the boot seam + `.env` `DATABASE_URL`,
 * never committed config (14-trust-gradient.md §off-machine-gate); migrate.ts owns it.
 */
/** PICKED from `CreateAppConfig`, never restated: a key spelled out again here can end up NARROWER than the
 *  door it feeds, and `defineConfig` constrains against this type — which is how `mcp` was once
 *  `{ instructions }` here while `createApp` already took `allowedOrigins`, making the wider key unwritable. */
export interface AppLevelConfig extends
  AppConfig,
  Pick<
    CreateAppConfig,
    "scope" | "mcp" | "runtimeAsserts" | "encryptionKey"
  > {}

/**
 * The exactness conjunct: every key of `C` outside `Legal` is required to hold an uninhabited value, so the
 * stray property itself is the compile error. `Exclude<keyof C, keyof Legal>` is `never` for a clean literal
 * and `Record<never, T>` is `{}`, so a legal declaration is unconstrained.
 *
 * `{ [K in keyof C]: unknown }` is the INFERENCE SITE, and its shape is the whole reason this type is split
 * from `NoUnknownKeys`. A verb whose declaration type must stay an inference site for its own parameters
 * (`defineSubscriber`'s emits witness, `defineTask`'s input) writes `TheirDecl & OnlyKnownKeys<D, TheirDecl>`.
 * Intersecting the caller's literal itself there — `TheirDecl & D` — makes TypeScript reduce the whole
 * parameter to `never` the moment ONE unit-typed property disagrees, so a single typo'd `topic` reports as
 * every property being uninhabited and the authored message is lost. Mapping to `unknown` carries the keys
 * and nothing else, so exactness stays and the declaration's own diagnostic survives.
 */
export type OnlyKnownKeys<C, Legal> =
  & NestedKnownKeys<C, Legal>
  & Record<Exclude<keyof C, keyof Legal>, never>;

/**
 * The CARD half of a legal slot type: the object branch of a union (`HttpRoute = HttpMode | {…}`), with
 * functions and arrays dropped. A slot whose legal type has no card half is unconstrained below the top.
 */
type CardOf<T> = Extract<NonNullable<T>, object> extends infer O
  ? [O] extends [never] ? never
  : O extends (...args: never[]) => unknown ? never
  : O extends readonly unknown[] ? never
  : [AllKeys<O>] extends [never] ? never // `unknown`/`{}` — a keyless slot names no roster, so it constrains nothing
  : O
  : never;

/**
 * Exactness ONE level into a nested card literal: `http: { list: { authnFrst } }` is a typo the top-level
 * conjunct cannot see, because `keyof C` stops at `http`. An index-signature slot (`Record<string, HttpRoute>`)
 * is drilled through — its own `keyof` is `string`, so the card is what the author actually wrote.
 *
 * Value positions stay `unknown` at the leaf, exactly as the top level does, so this never becomes a second
 * assignability check: it constrains KEYS and hands inference back. Recursion is capped here — a slot value
 * that is a Zod schema, a handler, or a `Where` node is an opaque leaf, never walked.
 */
type NestedKnownKeys<C, Legal> = {
  readonly [K in keyof C]: K extends keyof Legal
    ? CardKnownKeys<C[K], CardOf<Legal[K]>>
    : unknown;
};

type CardKnownKeys<Cv, Lcard> = [Lcard] extends [never] ? unknown
  : [CardOf<Cv>] extends [never] ? unknown
  : string extends keyof Lcard // an index-signature slot: the author's keys are verbs, the card is one deeper
    ? { readonly [K in keyof Cv]: CardExactKeys<Cv[K], CardOf<Lcard[string]>> }
  : unknown;

type CardExactKeys<Cv, Lcard> = [Lcard] extends [never] ? unknown
  : [CardOf<Cv>] extends [never] ? unknown
  : [DataCard<Lcard>] extends [never] ? unknown
  : Record<Exclude<keyof Cv, AllKeys<Lcard>>, never>;

/** A DATA card — every member is data (scalar, list, or a nested record), so no member is callable. A slot
 *  whose card is CLASS-like (an op decl, a Zod schema) is left alone: it carries its own exactness conjunct,
 *  and a StandardSchema (`~standard`) is excluded by NAME because its members do satisfy the data test —
 *  matching structurally made every `schema:` exact and reported a legal Zod object as a type error.
 *  and walking its `keyof` here costs the type-checker its heap (measured: an ungated walk OOMs
 *  `deno check src scripts`). A card that merely fails this test loses coverage, never gains a false error. */
type DataCard<T> = [T] extends [{ readonly "~standard": unknown }] ? never
  : [T[keyof T]] extends [
    | string
    | number
    | boolean
    | bigint
    | null
    | undefined
    | readonly unknown[]
    | Readonly<Record<string, unknown>>,
  ] ? T
  : never;

/** `keyof` of a union is the INTERSECTION of its members' keys, so a card declared as a union of forms
 *  would reject every key not common to all. Distribute: a key legal on ANY form is legal. */
type AllKeys<T> = T extends unknown ? keyof T : never;

/**
 * Makes a config literal EXACT against its legal key roster — `OnlyKnownKeys` plus the literal itself, for a
 * verb that RETURNS `C` (`defineResource`, `defineConfig`) and constrains it to `Legal` directly.
 *
 * A bare `<const C extends Legal>(config: C)` never gets TypeScript's excess-property check — the literal is
 * assigned to a type PARAMETER, not to `Legal` — so an unknown key type-checks clean and only surfaces at boot
 * as `decl/unknown-key`.
 */
export type NoUnknownKeys<C, Legal> = C & OnlyKnownKeys<C, Legal>;

/**
 * The typed identity entry. `<const C>` preserves the literal config for downstream type inference,
 * exactly as `defineModule`/`defineResource` do. No runtime work happens here — the model is assembled
 * at `createApp(config)`.
 *
 * Exact against `CreateAppConfig` — the SAME roster `CONFIG_KEYS`/`decl/unknown-key` enforces at boot, so the
 * two cannot drift. A verify-module key (`rules`, `llmCalls`, …) is unknown HERE by construction: core does not
 * ship that module, and `mod.ts` shadows this entry with the module one that does accept them.
 */
export function defineConfig<const C extends AppLevelConfig>(
  config: NoUnknownKeys<C, CreateAppConfig>,
): C {
  return config;
}

/**
 * A `.data.ts` data-migration declaration (cli/migrate.md §data-migration). drizzle-kit is DDL-only, so a
 * value transform (split/recompute/backfill) carries a hand-written `forward`; the scaffolded shell dissolves
 * on rebase, only `forward` is irreducible. `Reads`/`Writes` are inferred, never code-generated.
 */
export interface DataMigrationSpec<Reads = unknown, Writes = unknown> {
  readonly reads?: Reads; // the intermediate-state (old + new coexisting) row type — framework-supplied
  readonly writes?: Writes; // the new column(s) the transform produces
  // The hand-written value transform, born RED in a scaffolded stub. Typed loosely so any project `forward`
  // signature fits; `dataMigration`'s `<const S>` preserves the literal old→new faces (z.infer/Drizzle).
  readonly forward: (row: never) => unknown;
  readonly reversible?: boolean; // the project flags whether `forward` can be undone (default: false / one-way)
}

/**
 * The typed identity entry for a `.data.ts` data-migration (cli/migrate.md §data-migration) — a pure
 * pass-through the framework reads at migrate time, no disk side-effects, no codegen. `Reads`/`Writes` infer
 * from the project's `forward`; `<const S>` preserves its literal signature, exactly as `defineResource`.
 */
export function dataMigration<const S extends DataMigrationSpec>(
  spec: NoUnknownKeys<S, DataMigrationSpec>,
): S {
  return spec;
}
