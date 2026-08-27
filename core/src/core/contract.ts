/** The SHAPES of the framework's contract surface — the non-compile-loud surface `hazelnut upgrade` governs:
 * diagnostic ids, err.kind→status, the `starTables` subset, CLI verbs/flags, `ctx` members, features. Separate
 * from the runtime `Invariant`. The VALUES live in `verify/contract-catalog.ts`, on the verify side. Only the
 * verify module reads them, while core signatures name the types — holding both here shipped the entire invariant
 * axis to a public artifact. /
 */

export interface InvariantEntry {
  readonly introducedIn: string;
  readonly aliases?: readonly string[];
  readonly tombstone?: { readonly from: string; readonly asOf: string };
  readonly concerns: readonly string[];
}
export interface FeatureEntry {
  readonly introducedIn: string;
  readonly requiresFeatures?: readonly string[];
  readonly deprecated?: boolean;
}
export interface VerbEntry {
  readonly introducedIn: string;
  readonly aliases?: readonly string[];
  readonly tombstone?: { readonly from: string; readonly asOf: string };
  readonly flags: readonly string[];
}
export interface FlagEntry {
  readonly introducedIn: string;
  readonly aliases?: readonly string[];
  readonly appliesTo: readonly string[];
}
export interface CtxMemberEntry {
  readonly introducedIn: string;
  readonly aliases?: readonly string[];
  readonly type: string;
  readonly deprecated?: boolean;
}
export interface ErrKindEntry {
  readonly introducedIn: string;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly semanticBreak?: boolean;
}
export interface TableSchemaEntry {
  readonly introducedIn: string;
  readonly atRestFormat: "pinned" | "schema_version";
}

export interface ContractCatalog {
  readonly invariants: Readonly<Record<string, InvariantEntry>>;
  readonly features: Readonly<Record<string, FeatureEntry>>;
  readonly cliVerbs: Readonly<Record<string, VerbEntry>>;
  readonly cliFlags: Readonly<Record<string, FlagEntry>>;
  readonly ctxSurface: Readonly<Record<string, CtxMemberEntry>>;
  readonly errKinds: Readonly<Record<string, ErrKindEntry>>;
  readonly starTables: Readonly<Record<string, TableSchemaEntry>>;
}

/**
 * The `explain` flags the live dispatcher actually services (09-verifier.md §15) — the catalog can never
 * advertise a flag the CLI rejects. `--semantics` is deliberately absent: `explain semantics <id|feature>`
 * is a positional mode, not a flag. `hazelnut.ts` rejects any `--flag` not listed here.
 */
export const EXPLAIN_SERVICEABLE_FLAGS = [
  "--as",
  "--residual",
  "--obligations",
  "--stubs",
  "--consumers",
  "--diagram",
] as const;

/** The projected manifest identity — the catalog plus the two pins `manifest.ts` stamps. The projector
 *  (`projectContractManifest`) stays verify-tooling. */
export interface ContractManifest extends ContractCatalog {
  readonly manifestSchemaVersion: string;
  readonly frameworkVersion: string;
}
