// Barrel re-exports keep import sites stable.
import { CRUD_VERB_SET } from "../authz/auth.ts";
import { isPublicRoute } from "../core/app-refs.ts";
import type { ResourceModel } from "../core/app.ts";
import type { Invariant } from "../core/verifier-contract.ts";
import type { Violation } from "../core/structural-violation.ts";
import { wholeImmutable } from "../data/schema-normalize.ts";

/** `encrypted/cols-exist`: every name in the `encrypted` field list must be a real schema column. */
export const encryptedColsExist: Invariant = {
  id: "encrypted/cols-exist",
  check(ctx) {
    const m = ctx.resource;
    return m.encrypted
      .filter((c) => !(c in m.columns))
      .map((c) => ({
        id: "encrypted/cols-exist",
        resource: m.name,
        clause: `encrypted.${c}`,
        message: `encrypted references unknown column '${c}'`,
      }));
  },
};

/**
 * `encrypted/key-source` (advisory, never ship-block; 04-features.md §encrypted): the app key is supplied
 * through `config.encryptionKey`; since the framework only sees a config string, it cannot tell a hardcoded
 * literal from an env-read, so this fires as a standing reminder whenever a key is configured — source it
 * from an env / secret store, never an in-source literal (a leaked repo defeats at-rest encryption). The app
 * key defends at-rest theft only, not a live RCE that can read the config-site env; the `kms` seam covers that.
 */
export const encryptedKeySource: Invariant = {
  id: "encrypted/key-source",
  determinism: "runtime-assert", // advisory axis position → deriveBlocks yields "advisory" (never ship-block)
  check(ctx) {
    const m = ctx.resource;
    if (m.encrypted.length === 0) return []; // no encrypted field ⇒ no key obligation
    if (m.encryptedKeySource !== "config") return []; // "none" ⇒ boot refuses; "config" ⇒ the reminder fires
    return [{
      id: "encrypted/key-source",
      resource: m.name,
      clause: "encrypted.key",
      message:
        `the app master key is supplied through defineConfig({ encryptionKey }) — SOURCE it at the config site from a project-named env / secret store (e.g. \`encryptionKey: Deno.env.get("ENCRYPTION_KEY")\`), never a HARDCODED in-source literal: an in-source key lives in version control next to the data, so a repo read defeats the at-rest encryption. NOTE the app key defends AT-REST theft (a stolen disk/dump), NOT a live RCE that can read the config-site env — for that threat, inject an external KMS through the \`kms\` seam`,
    }];
  },
};

/**
 * `readmodel/possibly-stale` (advisory, never ship-block): a materialized read-model
 * stays fresh via the outbox-fenced re-projection the framework repo write path enqueues. A custom op on a
 * read-model source that writes through the raw query seam (`op({ raw: true })`) bypasses that path, so the
 * read-model can go silently stale. Fires only on that combination; a raw-seam write is a legal escape hatch,
 * so the read-model just needs manual re-projection.
 */
export const readmodelPossiblyStale: Invariant = {
  id: "readmodel/possibly-stale",
  determinism: "runtime-assert", // advisory axis position → deriveBlocks yields "advisory" (never ship-block)
  check(ctx) {
    const m = ctx.resource;
    if (m.readModelSinks.length === 0) return []; // not a read-model source ⇒ no maintenance obligation
    const out: Violation[] = [];
    for (const [opName, decl] of Object.entries(m.operations)) {
      // model-rung half: keys on the `raw` declaration marker. checks-foreign-shape.ts
      // `checkRawWriteOnMaintainedSource` covers the real raw-handler-source signal.
      const raw = typeof decl === "object" && decl !== null &&
        (decl as { raw?: unknown }).raw === true;
      if (raw) {
        out.push({
          id: "readmodel/possibly-stale",
          resource: m.name,
          clause: `operations.${opName}`,
          message:
            `op '${opName}' writes '${m.name}' through the RAW query seam, but '${m.name}' is a source of materialized read-model(s) [${
              m.readModelSinks.join(", ")
            }] — a raw-seam write bypasses the framework repo path that enqueues the outbox-fenced re-projection, so the read-model(s) can go STALE. Re-project by hand (enqueue a maintenance job) after this op, or route the write through ctx.data.{create,update,delete}`,
        });
      }
    }
    return out;
  },
};

/**
 * `rollups/possibly-stale` (advisory, never ship-block): the rollup mirror of `readmodel/possibly-stale`
 * above, over `m.rollupTargets` instead of `m.readModelSinks`. A custom op on the counted child that writes
 * through the raw query seam bypasses the repo write path that adjusts the parent's aggregate, so the
 * aggregate goes silently stale.
 */
export const rollupsPossiblyStale: Invariant = {
  id: "rollups/possibly-stale",
  determinism: "runtime-assert", // advisory axis position → deriveBlocks yields "advisory" (never ship-block)
  check(ctx) {
    const m = ctx.resource;
    if (m.rollupTargets.length === 0) return []; // not a rollup source ⇒ no maintenance obligation
    const out: Violation[] = [];
    const targets = m.rollupTargets.map((t) =>
      `${t.parentTable}.${t.column} (${t.kind})`
    ).join(", ");
    for (const [opName, decl] of Object.entries(m.operations)) {
      // model-rung `raw`-marker half; checks-foreign-shape.ts `checkRawWriteOnMaintainedSource` covers the rest.
      const raw = typeof decl === "object" && decl !== null &&
        (decl as { raw?: unknown }).raw === true;
      if (raw) {
        out.push({
          id: "rollups/possibly-stale",
          resource: m.name,
          clause: `operations.${opName}`,
          message:
            `op '${opName}' writes '${m.name}' through the RAW query seam, but '${m.name}' maintains rollup aggregate(s) [${targets}] — a raw-seam write bypasses the framework repo path that adjusts the parent's aggregate in the same tx, so the rollup can go silently STALE. Re-derive the aggregate after this op, or route the write through ctx.data.{create,update,delete}`,
        });
      }
    }
    return out;
  },
};

/** `resource/has-id`: every resource's table must carry a primary key — a `deriveDDL` regression that drops
 *  the minted `id text PRIMARY KEY` would leave a keyless table (no upsert/conflict target, no FK target). */
export const resourceHasId: Invariant = {
  id: "resource/has-id",
  check(ctx) {
    const m = ctx.resource;
    if (!m.ddl.includes("PRIMARY KEY")) {
      return [{
        id: "resource/has-id",
        resource: m.name,
        message:
          "resource table has no PRIMARY KEY — every resource must have a primary key",
      }];
    }
    return [];
  },
};

/** The always-reserved framework-minted column names, each with the gating predicate that is true when the
 *  framework would legitimately mint it (10-invariants.md §hygiene/handroll-shadows-reserved-col). Excludes
 *  the config-gated default names (parent_id-via-tree, deleted_by-via-softDelete) — legitimate high-base-rate
 *  idioms. `label` names the gating feature for the message. */
const RESERVED_COLS: ReadonlyArray<
  {
    readonly col: string;
    readonly label: string;
    readonly minted: (m: ResourceModel) => boolean;
  }
> = [
  {
    col: "deleted_at",
    label: "softDelete",
    minted: (m) => Boolean(m.features.softDelete),
  },
  {
    col: "created_at",
    label: "timestamps",
    minted: (m) => Boolean(m.features.timestamps),
  },
  {
    col: "updated_at",
    label: "timestamps",
    minted: (m) => Boolean(m.features.timestamps),
  },
  {
    col: "version",
    label: "versioning",
    minted: (m) => Boolean(m.features.versioning),
  },
  {
    col: "expires_at",
    label: "expiry",
    minted: (m) => Boolean(m.features.expiry),
  },
  {
    col: "valid_from",
    label: "temporal",
    minted: (m) => Boolean(m.features.temporal),
  },
  {
    col: "valid_to",
    label: "temporal",
    minted: (m) => Boolean(m.features.temporal),
  },
  {
    col: "created_by_type",
    label: "audit(onRow)",
    minted: (m) => Boolean(m.features.onRow),
  },
  {
    col: "created_by_id",
    label: "audit(onRow)",
    minted: (m) => Boolean(m.features.onRow),
  },
  {
    col: "updated_by_type",
    label: "audit(onRow)",
    minted: (m) => Boolean(m.features.onRow),
  },
  {
    col: "updated_by_id",
    label: "audit(onRow)",
    minted: (m) => Boolean(m.features.onRow),
  },
  {
    col: "search_vector",
    label: "searchable",
    minted: (m) => m.searchable.length > 0,
  },
  {
    col: "scope_key",
    label: "scope",
    minted: (m) => Boolean(m.features.scope),
  },
];

/** `hygiene/handroll-shadows-reserved-col` (warn): a user-declared column whose name exactly matches a
 *  reserved framework-minted column while its gating feature is not declared — a likely hand-rolled shadow
 *  carrying none of that feature's invariants (e.g. a hand-built `version` with no stale-write protection). */
export const handrollShadowsReservedCol: Invariant = {
  id: "hygiene/handroll-shadows-reserved-col",
  check(ctx) {
    const m = ctx.resource;
    const out: Violation[] = [];
    for (const { col, label, minted } of RESERVED_COLS) {
      if (col in m.columns && !minted(m)) {
        out.push({
          id: "hygiene/handroll-shadows-reserved-col",
          resource: m.name,
          clause: `columns.${col}`,
          message:
            `schema column '${col}' shadows the framework-reserved '${label}' column but '${label}' is not declared — a hand-rolled shadow with none of that feature's invariants`,
        });
      }
    }
    return out;
  },
};

/** `hygiene/no-unused-declaration` (warn): a curated `mcp` key naming neither a CRUD verb nor a declared
 *  `operation` — the tool projects into `tools/list` but its `tools/call` dispatch falls through to
 *  `notFound` (mcp.ts default case). Distinct from `http/custom-route-has-op`, which reads `m.http` instead. */
export const noUnusedDeclaration: Invariant = {
  id: "hygiene/no-unused-declaration",
  check(ctx) {
    const m = ctx.resource;
    return Object.keys(m.mcp)
      .filter((k) => !CRUD_VERB_SET.has(k) && !(k in m.operations))
      .map((k) => ({
        id: "hygiene/no-unused-declaration",
        resource: m.name,
        clause: `mcp.${k}`,
        message:
          `mcp curation projects tool '${k}' but no CRUD verb or declared operation backs it — a dangling agent-tool declaration that dispatches to nothing`,
      }));
  },
};

/** `http/exposed-has-policy`: an http-exposed mutating route must be `"policy"`, never `"public"` — writes are
 *  deny-by-default. Reads are out of scope; `policy/read-protected` owns those. */
export const httpExposedHasPolicy: Invariant = {
  id: "http/exposed-has-policy",
  check(ctx) {
    const m = ctx.resource;
    // Through `isPublicRoute`, never a raw `=== "public"`: `HttpRoute` has two legal forms and the object one
    // (`{ policy: "public" }`) fails a string compare — so the route mounted UNGATED while this invariant read
    // clean. That predicate is single-sourced precisely so the verifier and the served-boot guard agree.
    //
    // CRUD ONLY, deliberately. A custom op carries its OWN `policy`, so the rule a CRUD verb obeys does not
    // transfer: widening this to ops would fire on the password-login recipe (`http: { login: "public", … }`),
    // where a pre-auth door legitimately demands no permission. The ungated write op is closed one layer up
    // instead — `OpDef`'s tx↔policy union refuses a `tx:"write"` op that states no decision, and the public
    // door writes `policy: null` to say so.
    return CRUD_WRITE_VERBS
      .filter((k) => isPublicRoute(m.http[k]))
      .map((k) => ({
        id: "http/exposed-has-policy",
        resource: m.name,
        clause: `http.${k}`,
        message:
          `http write route '${k}' is exposed 'public' — a mutating route must be 'policy' (writes are deny-by-default; a public write lets any caller mutate the table)`,
      }));
  },
};

/** The CRUD half of the write surface `http/exposed-has-policy` covers; the rest is the resource's own
 *  `tx:"write"` operations, which are per-declaration and therefore derived, never listed. */
const CRUD_WRITE_VERBS: readonly string[] = ["create", "update", "delete"];

/** The framework-minted column names that legitimately appear in an mcp `shape` output-pick without being
 *  user `schema` columns — real output fields, just not in `m.columns`. */
const MINTED_OUTPUT_COLS: ReadonlySet<string> = new Set([
  "id",
  ...RESERVED_COLS.map((r) => r.col),
]);

/** `mcp/shape-cols-exist`: every field named in an mcp entry's `shape` output-pick must be a real column — a
 *  typo'd pick (`shape:["titel"]`) projects a tool whose declared output resolves to nothing. */
export const mcpShapeColsExist: Invariant = {
  id: "mcp/shape-cols-exist",
  check(ctx) {
    const m = ctx.resource;
    const out: Violation[] = [];
    for (const [tool, entry] of Object.entries(m.mcp)) {
      for (const field of entry.shape ?? []) {
        if (!(field in m.columns) && !MINTED_OUTPUT_COLS.has(field)) {
          out.push({
            id: "mcp/shape-cols-exist",
            resource: m.name,
            clause: `mcp.${tool}.shape.${field}`,
            message:
              `mcp tool '${tool}' shape picks output field '${field}' which is neither a schema column nor a framework-minted column — a dangling output projection`,
          });
        }
      }
    }
    return out;
  },
};

/** `sensitive/not-in-response`: an mcp tool's `shape` output-pick may not name a `sensitive` or `encrypted`
 *  column — projecting it into the agent-facing response is the exact leak that marking exists to prevent. */
export const sensitiveNotInResponse: Invariant = {
  id: "sensitive/not-in-response",
  check(ctx) {
    const m = ctx.resource;
    const guarded = new Map<string, string>();
    for (const c of m.sensitive) guarded.set(c, "sensitive");
    for (const c of m.encrypted) guarded.set(c, "encrypted");
    const out: Violation[] = [];
    for (const [tool, entry] of Object.entries(m.mcp)) {
      for (const field of entry.shape ?? []) {
        const why = guarded.get(field);
        if (why) {
          out.push({
            id: "sensitive/not-in-response",
            resource: m.name,
            clause: `mcp.${tool}.shape.${field}`,
            message:
              `mcp tool '${tool}' shape projects '${why}' field '${field}' into the agent-facing response — that is the leak the ${why} marking exists to prevent`,
          });
        }
      }
    }
    return out;
  },
};

/** `searchable/not-i18n`: a field cannot be both `searchable` and `i18n`. The tsvector indexes only the base
 *  (default-locale) column, while the field's real values live per-locale in the `_i18n` sidecar — declaring
 *  both silently splits search to one locale. */
export const searchableNotI18n: Invariant = {
  id: "searchable/not-i18n",
  check(ctx) {
    const m = ctx.resource;
    const i18n = new Set(m.i18n);
    return m.searchable.filter((c) => i18n.has(c)).map((c) => ({
      id: "searchable/not-i18n",
      resource: m.name,
      clause: `searchable.${c}`,
      message:
        `field '${c}' is both searchable and i18n — the tsvector indexes only the base (default-locale) column while values live per-locale in the sidecar, silently splitting search to one locale`,
    }));
  },
};

/** `parent/no-self`: a resource's `parent` may not be its own name — a self-parent mints a self-referential
 *  cascade FK, a degenerate cycle the parent-scoping / cascade-sweep semantics are not defined over. */
export const parentNoSelf: Invariant = {
  id: "parent/no-self",
  check(ctx) {
    const m = ctx.resource;
    if (m.parent !== null && m.parent === m.name) {
      return [{
        id: "parent/no-self",
        resource: m.name,
        message:
          `resource declares itself as its own parent ('${m.name}') — a self-referential child relation is a degenerate cascade cycle`,
      }];
    }
    return [];
  },
};

/** `unique/no-empty-tuple`: a `unique` entry may not be an empty column list — it emits `CREATE UNIQUE
 *  INDEX … ()`, a syntax error or a whole-table single-row constraint, never the intended per-key uniqueness. */
export const uniqueNoEmptyTuple: Invariant = {
  id: "unique/no-empty-tuple",
  check(ctx) {
    const m = ctx.resource;
    return m.unique
      .filter((tuple) => tuple.length === 0)
      .map(() => ({
        id: "unique/no-empty-tuple",
        resource: m.name,
        message:
          "a unique entry has no columns — an empty unique tuple emits a zero-column index, never the intended per-key uniqueness",
      }));
  },
};

/** `expiry/not-immutable`: `expiry` and `immutable` are contradictory — `immutable` removes the delete path,
 *  so an expired row can never be swept and expiry is unenforceable. */
export const expiryNotImmutable: Invariant = {
  id: "expiry/not-immutable",
  check(ctx) {
    const m = ctx.resource;
    if (m.features.expiry && wholeImmutable(m.features)) {
      return [{
        id: "expiry/not-immutable",
        resource: m.name,
        message:
          "resource is both expiry and immutable — immutable removes the delete path, so an expired row can never be swept and expiry is unenforceable",
      }];
    }
    return [];
  },
};
