import { type Actor, derivePerms, isAnonymous } from "../authz/auth.ts";
import {
  collectFileFields,
  collectI18nFields,
  collectPasswordFields,
  dbTypeOf,
  DEFAULT_ID_STRATEGY,
  deriveColumns,
  deriveDDL,
  deriveI18nDDL,
  idFkColType,
  idIsDbAllocated,
  type IdStrategy,
  pgIdent,
  rectifiableOn,
  resolveIdStrategy,
  temporalNoOverlap,
  unwrap,
  type ZType,
} from "../data/schema.ts";
import { volatileColsOf } from "../data/write-plan.ts";
import { normalizeVector } from "../features/embed.ts";
import { type KeySource, normalizeEncrypted } from "../features/encrypt.ts";
import {
  checkUnknownKeys,
  normalizeSensitive,
  pathSegmentErr,
  segmentErr,
} from "./app-define.ts";
import type { Cardinality, RefSpec } from "./app-refs.ts";
import type {
  ResourceDecl,
  ResourceModel,
  TransitionEdge,
} from "./app-types.ts";
import {
  ambiguousErr,
  resolveFromSlot,
  slotKey,
  type SlotNamed,
} from "./slot.ts";
import { none, owned, toNode } from "./where.ts";
import type { Node, Where } from "./where.ts";

/** The `unique/partial-predicate-local` guard (04-features.md §unique): a partial-unique WHERE must
 *  reference only local, non-encrypted columns, with no `exists`-over-relation and a real restriction. */
function partialPredicateErrors(
  resource: string,
  node: Node,
  localCols: ReadonlySet<string>,
  encrypted: readonly string[],
): string[] {
  const out: string[] = [];
  const id = "unique/partial-predicate-local";
  const walk = (n: Node): void => {
    switch (n.kind) {
      case "cmp":
      case "inArray":
      case "isNull":
        if (!localCols.has(n.col)) {
          out.push(
            `${id}: resource '${resource}' partial-unique WHERE references '${n.col}', not a declared LOCAL column of this resource — a partial-index predicate is over the resource's own fields`,
          );
        } else if (encrypted.includes(n.col)) {
          out.push(
            `${id}: resource '${resource}' partial-unique WHERE references encrypted field '${n.col}' — an encrypted field is a bytea envelope at rest, its plaintext cannot be compared in an index predicate`,
          );
        }
        break;
      case "and":
      case "or":
        n.parts.forEach(walk);
        break;
      case "not":
        walk(n.part);
        break;
      case "exists":
        out.push(
          `${id}: resource '${resource}' partial-unique WHERE uses an exists-over-relation — a partial-index predicate must be LOCAL (this resource's own columns), never a cross-table correlation`,
        );
        break;
      case "all":
      case "none":
        out.push(
          `${id}: resource '${resource}' partial-unique WHERE is all()/none() — a partial predicate must be a real restriction (drop \`where\` for a full unique)`,
        );
        break;
    }
  };
  walk(node);
  return out;
}
// createApp boot helpers extracted from app.ts — the per-unit ResourceModel builder + derived-model phases.
// Kept engine-free (imports only leaf composers) so createApp reads as orchestration over these units of work.

/** One normalized declaration unit (a module resource or a flat `app` resource), carrying its module wiring. */
export interface BootUnit {
  readonly module: string;
  readonly pgSchema: string;
  readonly moduleDeps: readonly string[];
  readonly moduleExposes: readonly string[];
  readonly moduleExposesRead: readonly string[];
  readonly moduleEmits: readonly string[];
  readonly decl: ResourceDecl;
}

/** The whole-app pre-pass state a single unit's model build reads (resolved once by createApp before the loop). */
export interface ModelBootCtx {
  readonly names: Set<string>;
  readonly roster: readonly SlotNamed[];
  readonly ddlSweptRefs: Set<string>;
  /** Every resource's resolved id strategy by `name::pgSchema` — a minted FK column must follow its TARGET's
   *  strategy, and the per-resource pass builds children before every parent exists. */
  readonly idStrategyByName: ReadonlyMap<string, IdStrategy>;
  readonly ownsByChild: Map<
    string,
    {
      parent: string;
      pgSchema: string;
      cardinality: Cardinality;
      unique: readonly (readonly string[])[];
    }
  >;
  readonly ownsByParent: Map<
    string,
    Record<string, { child: string; cardinality: Cardinality }>
  >;
  readonly readModelsBySource: Map<string, string[]>;
  readonly keySource: KeySource;
  readonly configId: string | undefined;
}

/** Group the createApp declaration errors by concern (the `<concern>/…` id prefix) so a mis-declared app's
 *  errors localize to a fix area instead of a flat dump. Each error is preserved verbatim, so
 *  `.includes("<id>")` assertions stay unchanged — only the layout groups. */
export function groupDeclErrors(errs: readonly string[]): string {
  const byConcern = new Map<string, string[]>();
  for (const e of errs) {
    const concern = e.match(/^([a-z][a-z-]*)\//)?.[1] ?? "decl";
    (byConcern.get(concern) ?? byConcern.set(concern, []).get(concern)!).push(
      e,
    );
  }
  const grouped = [...byConcern.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  )
    .map(([c, es]) =>
      `  [${c}] (${es.length})\n${es.map((e) => `    · ${e}`).join("\n")}`
    ).join("\n");
  // The umbrella id names the CONCERNS present, never a fixed one: stamping `decl/unknown-key` on an
  // illegal-name or a wrong-zod-spelling error sends a reader grepping for a key that is not there.
  const ids = [...byConcern.keys()].sort();
  const umbrella = ids.length === 1 ? `${ids[0]}/*` : ids.join(" + ");
  return `${umbrella}: ${errs.length} declaration error(s) across ${byConcern.size} concern(s):\n${grouped}`;
}

/** Compose one resource's `ResourceModel` from its declaration + the whole-app pre-pass ctx (03-api-shape.md
 *  — the declaration → derivation contract). Returns the entry plus any compose-time errors. */
export function buildModelEntry(
  u: BootUnit,
  ctx: ModelBootCtx,
): { entry: ResourceModel; errs: string[] } {
  const {
    module,
    pgSchema,
    moduleDeps,
    moduleExposes,
    moduleExposesRead,
    moduleEmits,
    decl,
  } = u;
  const {
    ddlSweptRefs,
    ownsByChild,
    ownsByParent,
    readModelsBySource,
    keySource,
    configId,
  } = ctx;
  const errs: string[] = [];
  errs.push(...checkUnknownKeys(decl));
  // a missing `schema` must surface as THIS resource's grouped declaration error — without the guard
  // the boot crashes on `.shape` below and masks every other finding the app's declarations carry
  if (decl.schema === undefined || decl.schema === null) {
    errs.push(
      `declaration/resource-schema: '${decl.name}' declares no schema — every column, DDL, and read face derives from it`,
    );
    return { entry: null as unknown as ResourceModel, errs };
  }
  {
    const e = segmentErr(decl.name, "resource");
    if (e) errs.push(e);
  }
  if (decl.path !== undefined) {
    if (typeof decl.path !== "string") {
      errs.push(
        `decl/path-invalid: resource '${decl.name}' path must be a string segment (e.g. path: "entries")`,
      );
    } else {
      const e = pathSegmentErr(decl.path, decl.name);
      if (e) errs.push(e);
    }
  } else if (Object.keys(decl.http ?? {}).length > 0) {
    // Mechanical plural can still land on a framework door (`name:"task"` → `/tasks`).
    const e = pathSegmentErr(`${decl.name}s`, decl.name);
    if (e) {
      errs.push(
        e.replace(
          `path '${decl.name}s'`,
          `default route '/${decl.name}s'`,
        ) + `; set path: "…" to a free segment`,
      );
    }
  }
  for (const opName of Object.keys(decl.operations ?? {})) {
    const e = segmentErr(opName, "op");
    if (e) errs.push(e);
  }
  // `_toolVersion` is framework-reserved on the MCP wire (12-mcp §tool-versioning): a tool declaring
  // `version.echo:"required"` peels it off the call before input validation, so an input that also declares
  // `_toolVersion` would be silently masked. Reject the collision loud at boot. The effective input is the
  // OP input for a custom op, else the RESOURCE schema for an auto-CRUD verb (create/update patch) — both can
  // carry `echo:"required"`; ZodEffects (`.refine`) is unwrapped so a wrapped field is not missed.
  const zodTopKeys = (t: unknown): readonly string[] => {
    let cur = t;
    for (let i = 0; i < 8 && cur && typeof cur === "object"; i++) {
      const o = cur as {
        shape?: Record<string, unknown>;
        def?: {
          type?: string;
          innerType?: unknown;
          in?: unknown;
          schema?: unknown;
        };
        _def?: { schema?: unknown };
      };
      if (o.shape) return Object.keys(o.shape);
      if (o.def?.type === "pipe" && o.def.in) {
        cur = o.def.in;
        continue;
      }
      if (o.def?.innerType) {
        cur = o.def.innerType;
        continue;
      }
      const inner = o._def?.schema ?? o.def?.schema;
      if (!inner) break;
      cur = inner;
    }
    return [];
  };
  for (const [opName, entry] of Object.entries(decl.mcp ?? {})) {
    if (
      (entry as { version?: { echo?: string } }).version?.echo !== "required"
    ) {
      continue;
    }
    const opInput =
      (decl.operations as Record<string, { input?: unknown }> | undefined)
        ?.[opName]?.input;
    // auto-CRUD verbs (no `operations[opName]`) validate against the resource schema; a custom op its own input
    const effective = opInput ?? decl.schema;
    if (zodTopKeys(effective).includes("_toolVersion")) {
      errs.push(
        `mcp/reserved-input: resource '${decl.name}' tool '${opName}' declares mcp version.echo:"required" AND an input field '_toolVersion' — that name is the reserved version-echo channel (peeled before input validation), so the field would be silently masked; rename it`,
      );
    }
  }
  const features = decl.features ?? {};
  const columns = deriveColumns(decl.schema);
  // union/tuple/pipe-left used to unwrap to silent `text`. Refuse unless the field pins `dbType()`.
  const UNMAPPABLE_ZOD = new Set(["union", "tuple", "pipe"]);
  for (const [name, field] of Object.entries(decl.schema.shape)) {
    const { inner } = unwrap(field as unknown as ZType);
    if (UNMAPPABLE_ZOD.has(inner.def.type) && dbTypeOf(field) === undefined) {
      errs.push(
        `schema/unmappable: '${decl.name}.${name}' is a Zod ${inner.def.type} — that wrapper used to land as silent text. Pin dbType() or store jsonb.`,
      );
    }
  }
  // translatable fields are declared two equivalent ways — the `i18n:[…]` list and per-field `translatable()`
  // marks — unioned here into the single `model.i18n` source the sidecar + the `i18n/*` invariants read.
  const i18nFields = [
    ...new Set([...(decl.i18n ?? []), ...collectI18nFields(decl.schema)]),
  ];
  const fileFields = collectFileFields(decl.schema);
  const passwordFields = collectPasswordFields(decl.schema); // `password()` fields — hashed on write, auto-sensitive (the hash never enters a read)
  // `sensitive` is declared two equivalent ways (04-features.md §sensitive): a plain field list, or the
  // `{ fields, mask }` card. Normalized to one composed source (`model.sensitive` + `model.maskStyle`).
  const sensitiveCfg = normalizeSensitive(decl.sensitive);
  const encryptedCfg = normalizeEncrypted(decl.encrypted); // parse the list / {fields,table,key} forms (04-features.md §encrypted)
  const encryptedFields = encryptedCfg.fields; // the field list deriveDDL mints as bytea + repo seals
  if (encryptedFields.length > 0 && rectifiableOn(features)) {
    errs.push(
      `encrypted/no-rectifiable: resource '${decl.name}' declares encrypted fields and immutable.rectifiable — rectify rebuilds the row from SELECT * and would persist ciphertext as if it were plaintext. Drop encrypted, or drop rectifiable.`,
    );
  }
  // `encrypted/equality-not-encrypted` (04-features.md §encrypted equality): the blind-index face exists
  // only on an encrypted field — a typo here would silently mint a never-matching index.
  for (const f of encryptedCfg.equality) {
    if (!encryptedFields.includes(f)) {
      errs.push(
        `encrypted/equality-not-encrypted: resource '${decl.name}' declares equality-searchable '${f}' but it is not an encrypted field — equality is the blind-index face OF an encrypted field`,
      );
    }
  }
  // Parse the semantic-vector card (04-features.md §vector): `source` must be a real schema column (a typo
  // is a loud compose-time fail); the minted `field`/shadow column names must not collide with a user column.
  const vectorCfg = normalizeVector(decl.vector);
  if (vectorCfg) {
    if (!(vectorCfg.source in columns)) {
      errs.push(
        `vector/source-exists: '${decl.name}.vector' embeds '${vectorCfg.source}', which is not a schema column`,
      );
    }
    if (vectorCfg.field in columns) {
      errs.push(
        `vector/field-free: '${decl.name}.vector' mints column '${vectorCfg.field}', but a schema field already claims that name`,
      );
    }
    if (vectorCfg.dims <= 0) {
      errs.push(
        `vector/dims-positive: '${decl.name}.vector' declares dims=${vectorCfg.dims} — an embedding width must be a positive integer`,
      );
    }
  }
  // A `singleton` is one row (per scope, or whole-app) and cannot be a `tree` — a hierarchy needs a
  // `parent_id` self-reference over many rows, which a single row has no parent for. Forbidden at compose time.
  const f155 = decl.features ?? {};
  if (f155.singleton && f155.tree) {
    errs.push(
      `singleton/no-tree: '${decl.name}' declares BOTH singleton and tree — a singleton is one row (per scope) and cannot form a hierarchy (a tree needs a parent_id self-reference over many rows); drop one feature`,
    );
  }
  // An encrypted name with no matching column is caught at verify time by `encrypted/cols-exist` — the
  // verifier owns that discipline check; createApp only composes (no boot-time throw here).
  const references = decl.references ?? {};
  for (const [field, ref] of Object.entries(references)) {
    // external (refById) targets are unmodeled by-id refs — no in-model resource to find, by design.
    if (!ref.external) {
      const hit = resolveFromSlot(ctx.roster, ref.to, pgSchema);
      if (hit.kind === "missing") {
        errs.push(
          `references/target-exists: '${decl.name}.${field}' references unknown resource '${ref.to}'`,
        );
      } else if (hit.kind === "ambiguous") {
        errs.push(
          `references/name-ambiguous: ${
            ambiguousErr(
              `'${decl.name}.${field}'`,
              ref.to,
              hit.candidates,
            )
          }`,
        );
      } else if (hit.value.pgSchema !== pgSchema) {
        const home = hit.value.module ?? hit.value.pgSchema;
        errs.push(
          `references/same-module: '${decl.name}.${field}' references '${ref.to}' across modules — a typed ref() would emit a cross-schema FK. Use refById('${home}.${ref.to}') to store the id without an FK.`,
        );
      }
    }
    if (!(field in columns)) {
      errs.push(
        `references/field-exists: '${decl.name}.${field}' is not a schema column`,
      );
    }
  }
  // The DDL-emitted references match the declared ones except a `cascade`/`set-null` the repo sweep owns has
  // its `onDelete` stripped (a bare REFERENCES) — the model keeps the original for verify/openapi to read.
  const ddlReferences: Record<string, RefSpec> = {};
  for (const [field, ref] of Object.entries(references)) {
    ddlReferences[field] = ddlSweptRefs.has(`${decl.name}.${field}`)
      ? { to: ref.to, ...(ref.external ? { external: true } : {}) }
      : ref;
  }
  // Ownership is parent-side only (`owns` + hasMany/hasOne). The FK still lives on the child; this fill
  // is what `ResourceModel.parent` / `parentFk` (cascade, rollups, GDPR fanout) read.
  const owned = ownsByChild.get(slotKey(decl.name, pgSchema)); // set iff some parent declared `owns: { … : has*(<this>) }`
  const parent = owned?.parent ?? null;
  const parentFk = parent ? `${parent}_id` : null;
  // Child-collection unique (04-features.md §unique): an `owns` child's `unique` tuples are made per-parent
  // by prepending the parent FK; `hasOne` adds an implicit unique on the bare parent FK (≤1 child per parent).
  const childUnique: (readonly string[])[] = [];
  if (owned) {
    if (owned.cardinality === "one") childUnique.push([parentFk!]); // hasOne: at most one child row per parent
    for (const tuple of owned.unique) childUnique.push([parentFk!, ...tuple]); // hasMany({unique}): parent-FK-prefixed
  }
  // Normalize `unique`: a plain `string[]` is a full unique; a `{cols,where}` is partial (04-features.md
  // §unique) — its cols still ride `unique`, its validated predicate rides `uniquePartial`.
  const uniqueCols: (readonly string[])[] = [];
  const uniquePartial: {
    readonly cols: readonly string[];
    readonly where: Node;
  }[] = [];
  const localCols = new Set(Object.keys(columns));
  for (const u of decl.unique ?? []) {
    if (!("cols" in u)) {
      uniqueCols.push(u);
      continue;
    } // a plain `string[]` (no `cols` key) = a full unique
    const node = toNode(u.where as Where<Record<string, unknown>>);
    errs.push(
      ...partialPredicateErrors(decl.name, node, localCols, encryptedFields),
    ); // unique/partial-predicate-local
    uniqueCols.push(u.cols);
    uniquePartial.push({ cols: u.cols, where: node });
  }
  const unique = [...uniqueCols, ...childUnique];
  // `temporal/overlap-cols-local` (04-features.md §temporal migrate): `noOverlap` key columns must be this
  // resource's own local, non-encrypted fields — an encrypted bytea envelope can never equality-partition one.
  for (const c of temporalNoOverlap(decl.features?.temporal) ?? []) {
    if (!localCols.has(c)) {
      errs.push(
        `temporal/overlap-cols-local: resource '${decl.name}' temporal.noOverlap references '${c}', not a declared LOCAL column of this resource — the exclusion key is over the resource's own fields`,
      );
    } else if (encryptedFields.includes(c)) {
      errs.push(
        `temporal/overlap-cols-local: resource '${decl.name}' temporal.noOverlap references encrypted field '${c}' — an encrypted envelope cannot equality-partition an exclusion constraint`,
      );
    }
  }
  // `encrypted/not-unique` (04-features.md §encrypted): an encrypted field may not sit in a `unique` tuple —
  // its per-row-DEK random nonce makes duplicate plaintexts always distinct, so the index never fires.
  // EXCEPT an `encrypted.equality` field: its unique index rides the deterministic `<f>_bidx` sidecar
  // (MAC-uniqueness is plaintext-uniqueness), so declaring equality IS the opt-in.
  if (encryptedFields.length > 0) {
    const enc = new Set(encryptedFields);
    const eq = new Set(encryptedCfg.equality);
    for (const tuple of unique) {
      for (const col of tuple) {
        if (enc.has(col) && !eq.has(col)) {
          errs.push(
            `encrypted/not-unique: resource '${decl.name}' unique tuple includes encrypted column '${col}' — an encrypted field is a per-row-DEK bytea envelope (a random nonce makes duplicate plaintexts always distinct), so a unique index over it never fires; declare '${col}' in encrypted.equality (the unique index then rides its blind-index sidecar) or drop it from the unique tuple`,
          );
        }
      }
    }
  }
  // `unique/duplicate-cols`: the derived index name is minted per pg schema, so a collision is app-global —
  // the check lives in `createApp` over all models (`uniqueIndexCollisions`), not here per-resource.
  // resolve the PK type: per-resource `id` overrides the app default `configId`, else the framework
  // default uuidv7 (02-dsl.md §id). An unknown value loud-fails here — the silent-swallow this closes.
  let idStrategy: IdStrategy = DEFAULT_ID_STRATEGY;
  try {
    idStrategy = resolveIdStrategy(
      decl.id,
      configId,
      `resource '${decl.name}'`,
    );
  } catch (e) {
    errs.push(e instanceof Error ? e.message : String(e));
  }
  // Encrypted ciphertext is AAD-sealed to `schema.table.field.rowId`, so the id must exist before the
  // INSERT carries the ciphertext — a DB-allocated id (uuidv4/serial) is only known via RETURNING, too late.
  if (encryptedFields.length > 0 && idIsDbAllocated(idStrategy)) {
    errs.push(
      `encrypted/id-app-minted: resource '${decl.name}' declares encrypted fields with id: '${idStrategy}' — a DB-allocated id is unknown at encrypt time, so the ciphertext cannot be sealed to its row position. Use the app-minted default (uuidv7) or drop the id override on this resource.`,
    );
  }
  // A `file()` key is minted under `<pgSchema>/<table>/<field>/<rowId>/` (`data/storage.ts
  // §keepOrMintFileKey`), so the row id must be settled BEFORE the INSERT that carries the key — the same
  // reason `encrypted` demands one, and the same refusal.
  if (fileFields.length > 0 && idIsDbAllocated(idStrategy)) {
    errs.push(
      `file/id-app-minted: resource '${decl.name}' declares file() fields with id: '${idStrategy}' — a DB-allocated id is unknown when the storage key is minted, so the key cannot be scoped to its row. Use the app-minted default (uuidv7) or drop the id override on this resource.`,
    );
  }
  const rollupOwnCols = Object.keys(decl.rollups ?? {}); // owner-side maintained aggregate columns
  let ddl = "";
  try {
    ddl = deriveDDL(
      decl.name,
      pgSchema,
      decl.schema,
      features,
      ddlReferences,
      unique,
      parent
        ? {
          fk: parentFk!,
          to: parent,
          colType: idFkColType(
            ctx.idStrategyByName.get(slotKey(parent, pgSchema)) ??
              DEFAULT_ID_STRATEGY,
          ),
        }
        : null,
      decl.searchable ?? [],
      Object.entries(decl.rollups ?? {}).map(([name, spec]) => ({
        name,
        kind: spec.kind ?? "count",
      })),
      encryptedFields,
      idStrategy,
      vectorCfg,
      uniquePartial,
      encryptedCfg.equality,
      typeof decl.rowPolicy === "string" ? decl.rowPolicy : null,
    );
  } catch (e) {
    errs.push(e instanceof Error ? e.message : String(e));
  }
  const entry: ResourceModel = {
    name: decl.name,
    ...(decl.path !== undefined ? { path: decl.path } : {}),
    module,
    moduleDeps,
    moduleExposes,
    moduleExposesRead,
    moduleEmits,
    pgSchema,
    schema: decl.schema,
    features,
    idStrategy,
    columns,
    ddl,
    hasRowPolicy: decl.rowPolicy != null,
    // The ownership SHORTHAND is resolved here and nowhere else: every downstream reader (the read WHERE
    // stack, the write conjunct, serve/mcp/data) sees the same `(actor) => Where` a written policy produces,
    // so the shorthand cannot behave differently from the fragment it stands for.
    rowPolicy: resolveRowPolicy(decl.rowPolicy),
    // the bare-column form, KEPT — the fragment above cannot be read back for the column it narrows on.
    rowPolicyColumn: typeof decl.rowPolicy === "string" ? decl.rowPolicy : null,
    http: decl.http ?? {},
    mcp: decl.mcp ?? {},
    ...normalizeTransitions(decl.name, decl.transitions, errs),
    unique,
    uniquePartial,
    encrypted: encryptedFields,
    encryptedConfig: encryptedCfg,
    // the app-key provenance for this resource: the resolved app-wide source iff it declares encrypted, else
    // `"none"` (a non-encrypted resource has no key obligation, so the `encrypted/key-source` advisory skips it).
    encryptedKeySource: encryptedFields.length > 0 ? keySource : "none",
    references,
    onDeleteSweeps: [], // populated post-loop (needs every model's table/features resolved)
    softDeleteParentRefs: [], // populated post-loop (needs every target's softDelete + table resolved)
    parent,
    parentFk,
    owns: ownsByParent.get(slotKey(decl.name, pgSchema)) ?? {},
    // many-to-many relation names (02-dsl.md §relates) — the declaring side's map for the ctx.data.<r> junction
    // runtime; boot-validated same-module (relates/target-exists + relates/same-module, app-boot-derive.ts).
    relates: Object.fromEntries(
      Object.entries(decl.relates ?? {}).map((
        [rel, spec],
      ) => [rel, { to: spec.to }]),
    ),
    // `operations` is stored verbatim — the deny-by-default policy injection (13-authz.md §authz-seam) is
    // composed at the dispatch boundary, not here, so `policy/required` still reads the raw declaration.
    operations: decl.operations ?? {},
    rollupTargets: [],
    rollupOwnCols,
    // Framework-maintained columns excluded from the tamper hash — derived from the write-plan cards'
    // `volatileCols` (data/write-plan.ts), so a new column-rewriting feature declares its own volatility.
    tamperVolatileCols: volatileColsOf({
      encrypted: encryptedFields,
      vector: vectorCfg,
      rollupOwnCols,
      features,
    }),
    searchable: decl.searchable ?? [],
    vector: vectorCfg,
    i18n: i18nFields,
    i18nDdl: i18nFields.length > 0
      ? deriveI18nDDL(decl.name, pgSchema, idStrategy)
      : null,
    i18nFallback: decl.i18nFallback ?? [],
    files: fileFields,
    passwords: passwordFields,
    // A `password()` field is sensitive by construction (rides `sensitive/not-in-response` redaction;
    // `password/never-selectable` guards it). Union, not replace, so an explicit `sensitive` field stays sensitive.
    sensitive: [...new Set([...sensitiveCfg.fields, ...passwordFields])],
    // the decl key's PRESENCE, not the resulting field list — `audit/sensitive-declared` reads it to tell
    // "I answered: nothing here is PII" (`sensitive: []`) apart from "I never considered it".
    sensitiveDeclared: decl.sensitive !== undefined,
    maskStyle: sensitiveCfg.mask,
    capabilities: decl.capabilities ?? [],
    // Seed the live perm vocabulary (13-authz.md §authz-seam): CRUD ∪ ops ∪ capabilities, minted to the
    // `<name>:<key>` wire form. `derivePerms` runs here, on the boot path — the verifier reads its output.
    perms: Object.values(derivePerms(decl)).sort(),
    // the materialized read-models this resource feeds — the repo write path reads this to enqueue the
    // outbox-fenced re-projection on every create/update/remove. [] when none.
    readModelSinks: (readModelsBySource.get(decl.name) ?? []).slice().sort(),
  };
  return { entry, errs };
}

/** `unique/duplicate-cols`: the derived index name `<name>_<cols>_uniq` is per-pg-schema, and `CREATE UNIQUE
 *  INDEX IF NOT EXISTS` keeps the first collision and silently drops the rest. Collisions are app-global (the
 *  `_` join is delimiter-ambiguous across resources) — scanned once, keyed by (pgSchema, indexName). */
export function uniqueIndexCollisions(
  model: readonly ResourceModel[],
): string[] {
  interface Bucket {
    readonly pgSchema: string;
    readonly indexName: string;
    readonly members: { resource: string; source: string }[];
  }
  const byName = new Map<string, Bucket>();
  const add = (
    pgSchema: string,
    indexName: string,
    resource: string,
    source: string,
  ): void => {
    const key = `${pgSchema}::${indexName}`; // "::" sep — a resource/schema segment never contains one, so the key is unambiguous
    const bucket = byName.get(key) ?? { pgSchema, indexName, members: [] };
    bucket.members.push({ resource, source });
    byName.set(key, bucket);
  };
  for (const m of model) {
    for (const cols of m.unique) {
      add(
        m.pgSchema,
        pgIdent(`${m.name}_${cols.join("_")}_uniq`),
        m.name,
        `[${cols.join(", ")}]`,
      );
    }
    if (m.features.singleton && m.features.scope) {
      add(
        m.pgSchema,
        pgIdent(`${m.name}_scope_singleton_uniq`),
        m.name,
        "scope-singleton",
      );
    }
  }
  const errs: string[] = [];
  for (const { pgSchema, indexName, members } of byName.values()) {
    if (members.length <= 1) continue;
    errs.push(
      `unique/duplicate-cols: ${members.length} unique constraints in pg schema '${pgSchema}' collide on the derived index name '${indexName}' (${
        members.map((g) => `${g.resource} ${g.source}`).join(", ")
      }) — the derived unique-index name is minted per pg schema, so \`CREATE UNIQUE INDEX IF NOT EXISTS\` keeps the FIRST and silently drops the rest (a dropped unique never exists; a partial predicate on one would weaken a full unique to partial). Give the colliding constraints distinct derived names (rename a resource, or declare at most one unique per column tuple).`,
    );
  }
  return errs;
}

// roster/engine extracted into cohesive submodules, re-exported so importers stay stable.
export * from "./app-boot-derive.ts";

/** Normalize the `transitions` decl (04-features.md §transitions edge form) into two model shapes: the plain
 *  string-target map every reachability reader walks, and the per-edge guard/hook records the executor
 *  consults. Ghost keys and a missing/duplicate `to` on an edge object are loud compose-errors. */
export function normalizeTransitions(
  resource: string,
  declared: ResourceDecl["transitions"],
  errs: string[],
): {
  transitions: Readonly<Record<string, readonly string[]>>;
  transitionEdges: Readonly<
    Record<string, Readonly<Record<string, TransitionEdge>>>
  >;
} {
  const transitions: Record<string, string[]> = {};
  const transitionEdges: Record<string, Record<string, TransitionEdge>> = {};
  for (const [from, edges] of Object.entries(declared ?? {})) {
    const targets: string[] = [];
    for (const e of edges) {
      if (typeof e === "string") {
        if (targets.includes(e)) {
          errs.push(
            `decl/unknown-key: resource '${resource}' declares the transition '${from}' → '${e}' twice — one edge per (from, to); use the edge object form if the second listing carries a guard`,
          );
          continue;
        }
        targets.push(e);
        continue;
      }
      for (const k of Object.keys(e)) {
        if (k !== "to" && k !== "guard" && k !== "onExit" && k !== "onEnter") {
          errs.push(
            `decl/unknown-key: unknown key '${k}' on resource '${resource}' transitions edge '${from}' — the edge card is { to, guard, onExit, onEnter }`,
          );
        }
      }
      if (typeof e.to !== "string" || e.to.length === 0) {
        errs.push(
          `decl/unknown-key: resource '${resource}' transitions edge from '${from}' carries no string 'to' — an edge object must name its target state`,
        );
        continue;
      }
      if (targets.includes(e.to)) {
        errs.push(
          `decl/unknown-key: resource '${resource}' declares the transition '${from}' → '${e.to}' twice — one edge per (from, to)`,
        );
        continue;
      }
      targets.push(e.to);
      (transitionEdges[from] ??= {})[e.to] = e;
    }
    transitions[from] = targets;
  }
  return { transitions, transitionEdges };
}

/**
 * The declared `rowPolicy`, with the ownership shorthand lowered to the fragment it names.
 *
 * `rowPolicy: "owner_id"` is `owned(fields<Row>().owner_id)` narrowed to a NAMED caller — the slot type
 * constrains the string to a text-shaped column of the declaration's own schema, so a name the table does
 * not have is a compile error rather than a policy that matches nothing. Anything else passes untouched.
 *
 * ANONYMOUS is denied outright: anonymous arrives as a non-null actor whose id is the literal
 * `"anonymous"`, so `owner_id = 'anonymous'` alone would hand every unauthenticated caller every row an
 * anonymous request created, shared across all of them. `owned` carries the ANON floor itself; the
 * shorthand's own guard is the belt to that suspenders.
 */
export function resolveRowPolicy(declared: unknown): unknown {
  if (typeof declared !== "string") return declared ?? null;
  const frag = owned<Record<string, unknown>, string>({ __col: declared });
  return (actor: Actor | null) => isAnonymous(actor) ? none() : frag(actor);
}
