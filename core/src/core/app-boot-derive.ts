// createApp's derived-model phase: cross-model boot validation + junction/rollup/sweep derivation.
import { deriveJunctionDDL, tamperEvidentOn } from "../data/schema.ts";
import {
  checkViewUnknownKeys,
  isBinaryView,
  type ViewDecl,
} from "../features/view.ts";
import { unprojectableColumns } from "../features/redact.ts";
import { routeColumns, WIRE_READ_VERBS } from "./app-refs.ts";
import type { BootUnit } from "./app-boot.ts";
import type { JunctionModel, ResourceModel } from "./app-types.ts";
import type { RollupKind } from "./faces.ts";

/** Is a column's Postgres type numeric? — the rollup-field allowlist (`sum`/`avg`/`min`/`max` aggregate
 *  numbers only). Accepts numeric PgTypes and a numeric-headed `dbType()` string; text/bool/date/jsonb refused. */
const NUMERIC_PG_HEAD =
  /^(numeric|decimal|double precision|smallint|bigint|integer|int8|int4|int2|int|double|real|float8|float4|float|money)\b/i;
function isNumericCol(c: { readonly pg: string }): boolean {
  return NUMERIC_PG_HEAD.test(c.pg);
}

/** Line heads of a `CREATE TABLE` body that declare a constraint, not a column. */
const CONSTRAINT_HEADS: ReadonlySet<string> = new Set([
  "FOREIGN",
  "CHECK",
  "EXCLUDE",
  "UNIQUE",
  "PRIMARY",
  "CONSTRAINT",
]);

/** The read shape of a resource: the physical column names, read back out of the `CREATE TABLE` the
 *  framework itself emitted. Reads are `SELECT *`, so the table IS the output field set — deriving it from
 *  the emitted DDL keeps a second copy of the feature-mint list (which would drift) out of this check. */
export function readShapeFields(ddl: string): ReadonlySet<string> {
  const out = new Set<string>();
  const open = ddl.indexOf("(\n  ");
  const close = ddl.indexOf("\n)");
  if (open < 0 || close < open) return out;
  for (const line of ddl.slice(open + 4, close).split(",\n  ")) {
    const head = /^"?([A-Za-z_][A-Za-z0-9_]*)"?\s/.exec(line);
    if (!head || CONSTRAINT_HEADS.has(head[1]!.toUpperCase())) continue;
    out.add(head[1]!);
  }
  return out;
}

/** The derived-model phases (createApp, post per-unit build): attaches reverse onDelete sweeps + rollup
 *  targets to each model in place, derives m2m junction tables, and boot-validates views/exposesRead.
 *  Returns the junctions plus collected compose errors. */
export function finalizeModel(
  model: ResourceModel[],
  units: readonly BootUnit[],
  config: {
    readonly modules?: ReadonlyArray<
      { readonly name: string; readonly exposesRead?: readonly string[] }
    >;
    readonly views?: readonly ViewDecl[];
  },
  ctx: {
    ddlSweptRefs: Set<string>;
    restrictSweepRefs: Set<string>;
    names: Set<string>;
  },
): {
  junctions: JunctionModel[];
  views: readonly ViewDecl[];
  errs: string[];
} {
  const { ddlSweptRefs, restrictSweepRefs, names } = ctx;
  const errs: string[] = [];
  // Feature-interaction refuses (compose-time): a pair that would silently mis-compose is refused at boot —
  // the fail-closed posture createApp needs (createApp does not run verify; model-guards.ts).
  for (const m of model) {
    // A file() key declared `encrypted`: the storage key is an opaque handle (encrypting it buys nothing), and
    // on hard-delete the GC key filter cannot read the bytea envelope to reclaim the off-box bytes (they orphan).
    for (const f of m.files) {
      if (m.encrypted.includes(f)) {
        errs.push(
          `file/not-encrypted: resource '${m.name}' declares file() field '${f}' as encrypted — a storage key is an opaque handle (encrypting it buys nothing), and on hard-delete the GC cannot read the bytea envelope to reclaim the off-box bytes (they orphan); drop 'encrypted' on '${f}'`,
        );
      }
    }
    // A vector() source that is `encrypted`/`sensitive` egresses off-box (plaintext or a redacted value) to
    // the embedding provider. Refused at boot, not verify — createApp refuses before verify ever boots.
    if (m.vector) {
      if (new Set(m.encrypted).has(m.vector.source)) {
        errs.push(
          `vector/source-not-encrypted: resource '${m.name}' embeds encrypted field '${m.vector.source}' — the source is sent to an external embedding provider, so this egresses decrypted plaintext off-box (or embeds meaningless ciphertext); drop 'encrypted' on '${m.vector.source}' or embed a non-encrypted field`,
        );
      }
      if (new Set(m.sensitive).has(m.vector.source)) {
        errs.push(
          `vector/source-not-sensitive: resource '${m.name}' embeds sensitive field '${m.vector.source}' — the source is sent to an external embedding provider, egressing a surface-redacted value off-box; embed a non-sensitive field`,
        );
      }
    }
    // transitions × immutable:{ tamperEvident } is a security impossibility, refused at boot: `ctx.transition`
    // CAS-writes status without re-stamping the hash chain — the first transition breaks `verifyHashChain`.
    if (Object.keys(m.transitions).length > 0 && tamperEvidentOn(m.features)) {
      errs.push(
        `transitions/tamper-immutable: resource '${m.name}' declares transitions AND immutable:{ tamperEvident } — ctx.transition writes status without re-stamping the hash chain, so the first transition silently breaks verifyHashChain (a real tamper then reads the same as a sanctioned status change); drop transitions, or drop tamperEvident (a mutable status FSM cannot ride an append-only tamper-evident ledger)`,
      );
    }
  }
  // `mcp: { <tool>: { shape: [...] } }` picks output fields BY NAME, and the call-time pick drops a name the
  // row does not carry — so a typo advertises a projection that resolves to nothing, at every layer silently
  // (`shape` is `readonly string[]`, not keyof-bound). Refused here, in the `decl/unknown-key` family.
  // Auto-CRUD tools only: a custom op's shape narrows the HANDLER's return value, which declares no runtime
  // output contract, so there is nothing to check it against (the resource's columns are the wrong set).
  for (const m of model) {
    const fields = readShapeFields(m.ddl);
    for (const [tool, entry] of Object.entries(m.mcp)) {
      if (tool in m.operations) continue; // custom op — its output is the handler's, not the row
      const picks = entry.shape;
      if (!Array.isArray(picks)) continue; // a fn-escape shape computes/renames — no static field list
      for (const field of picks) {
        if (fields.has(field)) continue;
        errs.push(
          `decl/unknown-key: resource '${m.name}' mcp tool '${tool}' shape picks output field '${field}', which is not part of the read shape — the pick is applied by name, so the tool would advertise a projection that resolves to nothing. Available fields: ${
            [...fields].sort().join(", ")
          }`,
        );
      }
    }
    // `http: { <read>: { columns: [...] } }` is the positive wire projection (03-api-shape.md
    // §wire-projection) — picked by name at serve time, so a name outside the read shape, or one the output
    // chokepoint drops, would advertise a field no response carries. Refused here, at compose time.
    // A short-form `"policy"`/`"public"` (or an object with no `columns`) used to default the wire to
    // `id` + schema keys — that silent default is the SEC-4 hole (a `file()`/`sensitive` key rides out
    // unmarked). Every HTTP-exposed read must name the WHOLE response; MCP list/find rides the same
    // http twin's columns when that twin exists.
    for (const verb of WIRE_READ_VERBS) {
      const route = m.http[verb];
      if (route === undefined) continue;
      if (routeColumns(route) !== undefined) continue;
      const mode = typeof route === "string"
        ? route
        : (route.policy ?? "policy");
      const via = typeof route === "string"
        ? `http '${verb}' is the short-form "${mode}"`
        : `http '${verb}' is an object with no columns`;
      errs.push(
        `http/columns-required: resource '${m.name}' ${via} — a missing positive wire projection defaults to id + schema keys and is refused. Name the WHOLE response: { policy: "${mode}", columns: ["id", …] }`,
      );
    }
    for (const [verb, route] of Object.entries(m.http)) {
      const picks = routeColumns(route);
      if (picks === undefined) continue;
      if (!(WIRE_READ_VERBS as readonly string[]).includes(verb)) {
        errs.push(
          `decl/unknown-key: resource '${m.name}' http route '${verb}' declares 'columns', but only the read verbs (${
            WIRE_READ_VERBS.join(", ")
          }) return a row — a write returns an id/updated envelope and a custom op's return is the handler's own contract`,
        );
        continue;
      }
      const unshippable = unprojectableColumns(m);
      for (const col of picks) {
        if (!fields.has(col)) {
          errs.push(
            `decl/unknown-key: resource '${m.name}' http '${verb}' columns names '${col}', which is not a column of the read shape. Available fields: ${
              [...fields].sort().join(", ")
            }`,
          );
        } else if (unshippable.has(col)) {
          errs.push(
            `http/columns-not-redacted: resource '${m.name}' http '${verb}' columns names '${col}', which the output chokepoint drops (sensitive ∪ encrypted ∪ the minted <f>_bidx) — the projection would promise a field every response omits; remove it from columns, or remove it from sensitive/encrypted`,
          );
        }
      }
    }
  }
  for (const childModel of model) {
    for (const [field, ref] of Object.entries(childModel.references)) {
      if (ref.external) continue;
      const key = `${childModel.name}.${field}`;
      const swept =
        (ref.onDelete === "cascade" || ref.onDelete === "set-null") &&
        ddlSweptRefs.has(key); // dishonest cascade/set-null → repo sweep
      const restricted = ref.onDelete === "restrict" &&
        restrictSweepRefs.has(key); // soft-deleting parent → repo pre-check
      if (!swept && !restricted) continue; // an honest DB clause owns it — no repo sweep
      const parentModel = model.find((m) => m.name === ref.to);
      if (!parentModel) continue; // target-exists already errored above; skip defensively
      (parentModel.onDeleteSweeps as Array<
        ResourceModel["onDeleteSweeps"][number]
      >).push({
        child: childModel, // the child's own model — the repo sweep recurses through its delete semantics
        fk: field,
        onDelete: ref.onDelete as "cascade" | "set-null" | "restrict",
      });
    }
  }
  // Every modeled FK a child's create/re-parent carries that points at a soft-deleting parent: a bare DB FK
  // only checks existence (soft-delete UPDATE preserves it), so the write path refuses a tombstoned target.
  const qual = (m: ResourceModel) => `"${m.pgSchema}"."${m.name}"`;
  for (const childModel of model) {
    const refs = childModel.softDeleteParentRefs as Array<
      ResourceModel["softDeleteParentRefs"][number]
    >;
    for (const [field, ref] of Object.entries(childModel.references)) {
      if (ref.external) continue; // an unmodeled by-id ref carries no in-model FK / softDelete to read
      const target = model.find((m) =>
        m.name === ref.to && m.pgSchema === childModel.pgSchema
      );
      if (target?.features.softDelete) {
        refs.push({
          fk: field,
          parentTable: qual(target),
          parentName: target.name,
        });
      }
    }
    // `owns` child: the `<parent>_id` FK is ON DELETE CASCADE, which a parent soft-delete never fires.
    if (childModel.parent && childModel.parentFk) {
      const p = model.find((m) =>
        m.name === childModel.parent && m.pgSchema === childModel.pgSchema
      );
      if (p?.features.softDelete) {
        refs.push({
          fk: childModel.parentFk,
          parentTable: qual(p),
          parentName: p.name,
        });
      }
    }
    // tree self-FK: a soft-deleting tree node must not gain a child (or re-parent) under a tombstoned ancestor.
    if (childModel.features.tree && childModel.features.softDelete) {
      refs.push({
        fk: "parent_id",
        parentTable: qual(childModel),
        parentName: childModel.name,
        self: true,
      });
    }
  }
  // Rollups: attach each parent's rollup to the child it aggregates (the child maintains it on write). A
  // non-`count` kind aggregates a child `field` column, validated here (a typo is a loud compose-time fail).
  for (const { pgSchema, decl } of units) {
    if (!decl.rollups) continue;
    const parent = model.find((m) =>
      m.name === decl.name && m.pgSchema === pgSchema
    )!;
    for (const [column, spec] of Object.entries(decl.rollups)) {
      const child = model.find((m) =>
        m.name === spec.count && m.pgSchema === pgSchema
      );
      if (!child) {
        errs.push(
          `rollups/child-exists: '${decl.name}.${column}' counts unknown resource '${spec.count}'`,
        );
        continue;
      }
      if (child.parent !== parent.name) {
        errs.push(
          `rollups/needs-child: '${spec.count}' must be owned by '${parent.name}' via owns (hasMany/hasOne) to be counted by '${decl.name}.${column}'`,
        );
        continue;
      }
      // A scoped parent with an unscoped rollup child is unsound: the child carries no scope_key, so it can
      // point its parent FK at another scope's parent, cross-scope poisoning the aggregate. Refuse the pair.
      if (parent.features.scope && !child.features.scope) {
        errs.push(
          `rollups/scope-match: '${decl.name}.${column}' rolls up UNSCOPED child '${spec.count}' into a SCOPED parent — an unscoped child can point its parent FK at another scope's parent and skew that scope's aggregate; declare 'scope:true' on '${spec.count}' or drop 'scope' from '${decl.name}'`,
        );
        continue;
      }
      const kind: RollupKind = spec.kind ?? "count";
      if (kind !== "count") {
        if (spec.field === undefined) {
          errs.push(
            `rollups/needs-field: '${decl.name}.${column}' (${kind}) needs a child column — e.g. ${kind}(${spec.count}, "<field>")`,
          );
          continue;
        }
        if (!(spec.field in child.columns)) {
          errs.push(
            `rollups/field-exists: '${decl.name}.${column}' (${kind}) aggregates '${spec.field}', not a column of '${spec.count}'`,
          );
          continue;
        }
        // An aggregated field must be a plaintext number: non-numeric (caught by `isNumericCol`) or
        // storage-swapped to bytea by `encrypted` either poisons `sum`/`avg` with NaN or throws on `min`/`max`.
        if (
          !isNumericCol(child.columns[spec.field]!) ||
          child.encrypted.includes(spec.field) ||
          child.files.includes(spec.field)
        ) {
          errs.push(
            `rollups/numeric-field: '${decl.name}.${column}' (${kind}) aggregates un-aggregatable child field '${spec.field}' of '${spec.count}' (pg type '${
              child.columns[spec.field]!.pg
            }'${
              child.encrypted.includes(spec.field) ? ", encrypted→bytea" : ""
            }) — a rollup aggregates PLAINTEXT NUMBERS only (an encrypted bytea envelope, a file() text key, or any text/date/bool corrupts sum→NaN or crashes avg/min/max); aggregate a plaintext numeric column or drop the rollup`,
          );
          continue;
        }
        // The `sensitive` exposure guard (orthogonal to type): a min/max over a sensitive child field publishes
        // the exact extreme value through the parent's un-redacted rollup column, leaking a specific PII value.
        if (
          (kind === "min" || kind === "max") &&
          child.sensitive.includes(spec.field)
        ) {
          errs.push(
            `rollups/no-sensitive: '${decl.name}.${column}' (${kind}) exposes the exact ${kind} of SENSITIVE child field '${spec.field}' of '${spec.count}' through the un-redacted parent rollup column — a min/max over a sensitive value leaks it; drop the rollup or aggregate a non-sensitive field`,
          );
          continue;
        }
      }
      (child.rollupTargets as Array<
        {
          parentTable: string;
          parentFk: string;
          column: string;
          kind: RollupKind;
          field?: string;
        }
      >).push(
        {
          parentTable: `"${parent.pgSchema}"."${parent.name}"`,
          parentFk: child.parentFk!,
          column,
          kind,
          field: spec.field,
        },
      );
    }
  }

  // Many-to-many: one junction table per unordered pair, intra-module by construction — a cross-module
  // junction would FK across pg schemas, forbidden by `boundary/cross-ref-by-id` + `boundary/no-cross-join`.
  const junctions: JunctionModel[] = [];
  const seen = new Set<string>();
  const schemaByName = new Map(units.map((u) => [u.decl.name, u.pgSchema]));
  for (const { pgSchema, decl } of units) {
    for (const r of Object.values(decl.relates ?? {})) {
      const target = r.to;
      if (!names.has(target)) {
        errs.push(
          `relates/target-exists: '${decl.name}' relates to unknown resource '${target}'`,
        );
        continue;
      }
      if (schemaByName.get(target) !== pgSchema) {
        errs.push(
          `relates/same-module: '${decl.name}' relates to '${target}' across modules — a manyToMany() junction would be a cross-schema FK, forbidden by the module boundary (boundary/cross-ref-by-id + boundary/no-cross-join). Associate across modules BY-ID via an exposesRead read-view (ctx.reads.<dep>.<view>), not manyToMany()`,
        );
        continue;
      }
      const pair = [decl.name, target].sort();
      const left = pair[0]!;
      const right = pair[1]!;
      const jname = `${left}_${right}`;
      const jkey = `${pgSchema}.${jname}`;
      if (left === right || seen.has(jkey)) continue;
      seen.add(jkey);
      junctions.push({
        name: jname,
        pgSchema,
        left,
        right,
        leftFk: `${left}_id`,
        rightFk: `${right}_id`,
        ddl: deriveJunctionDDL(jname, pgSchema, left, right),
      });
    }
  }
  // Views (12-mcp §6): validate each `defineView` targets a known resource at boot so a typo'd `over:` is a
  // compose-time failure, not a silent invisible tool. The validated list carries to `app.views`.
  const views = config.views ?? [];
  for (const v of views) {
    // Every `define*` is strict-parsed against its framework-owned key set, so a typo'd view key
    // (stale `policy`, `rowPolciy`) is a loud boot fail, like a resource's decl/unknown-key. Both forms.
    errs.push(...checkViewUnknownKeys(v));
    if (v.http !== undefined) {
      if (v.http.policy !== "public" && v.http.policy !== "policy") {
        errs.push(
          `view/http-policy: view '${v.name}' http.policy must be "public" | "policy"`,
        );
      }
      if (isBinaryView(v)) {
        errs.push(
          `view/http-json-only: view '${v.name}' declares http with output: binary() — HTTP opt-in is the JSON row set`,
        );
      }
    }
    // A cross-source `run`-form view (02-dsl.md §defineView) has no `over` (reads go through
    // `sources`/`exposesRead`), so the over-exists check applies only to the single-`over` sugar.
    if (v.run) continue;
    if (v.over === undefined || !names.has(v.over)) {
      errs.push(
        `view/over-exists: view '${v.name}' is over unknown resource '${v.over}'`,
      );
    }
  }
  // `boundary/cross-read-narrowed` (producer half, 10-invariants.md §boundary): each `exposesRead` name must
  // resolve to a `defineView` whose `over` resource lives in that module — a dangling name is a facade.
  const moduleOfResource = new Map(units.map((u) => [u.decl.name, u.module]));
  const viewByName = new Map(views.map((v) => [v.name, v]));
  for (const m of config.modules ?? []) {
    for (const readName of m.exposesRead ?? []) {
      const v = viewByName.get(readName);
      if (!v) {
        errs.push(
          `exposesRead/view-exists: module '${m.name}' exposesRead '${readName}' but no defineView is named '${readName}'`,
        );
        continue;
      }
      // A run-form view has no single `over` resource — the over→module ownership check is the sugar's
      // producer-resolution; a run-form view skips it (additive).
      if (!v.over) continue;
      if (moduleOfResource.get(v.over) !== m.name) {
        errs.push(
          `exposesRead/own-module: module '${m.name}' exposesRead view '${readName}', but it is over '${v.over}' which is not in module '${m.name}' — a module exposes only its OWN views for cross-module reads`,
        );
      }
    }
  }
  return { junctions, views, errs };
}
