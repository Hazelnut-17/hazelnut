// Barrel re-exports keep import sites stable.
import type { App, ResourceModel } from "../core/app.ts";
import { isBinaryView, protectedProducersOf } from "../features/view.ts";
// the ONE cross-module-exposure predicate: the boot guard's row-visibility face and these column/egress
// faces must never disagree about which views cross a module boundary.
import { viewExposedCrossModule } from "../core/model-guards.ts";
import type { AppViolation } from "../core/structural-violation.ts";

/** `policy/required` (universal, completeness, error — 10-invariants.md §policy/required, view face): every
 *  `defineView` must declare a `rowPolicy`. A view with none is genuine unauthenticated read access —
 *  `runView`/`runViewQuery` default the absent policy to `() => all()`, so the projection returns every row
 *  the WHERE-stack admits. Unlike `policy/required-op` (advisory, auto-defaults to the convention perm),
 *  `defineView` is never auto-defaulted — the obligation stays a ship-blocking error. */
export function checkPolicyRequired(views: App["views"] = []): AppViolation[] {
  const out: AppViolation[] = [];
  for (const v of views ?? []) {
    if (typeof v.rowPolicy !== "function") {
      out.push({
        id: "policy/required",
        message:
          `view '${v.name}' (over '${v.over}') declares no rowPolicy — a view with no policy is unauthenticated read access: the read-tool defaults to all() and returns every row the WHERE-stack admits; declare a rowPolicy (the read-leak authz slot)`,
        responsible: {
          kind: "unknown",
          why: `view '${v.name}' over '${v.over}' has no rowPolicy`,
        },
      });
    }
  }
  return out;
}

/** `boundary/cross-read-narrowed` (view projection face, extends the concern to `defineView`, 02-dsl.md
 *  §defineView lines 69/72). A view crossing a module boundary must declare an explicit projection so a
 *  producer column rename/add cannot silently widen the cross-module contract:
 *   (A) a cross-source `run`-form with row-set output (`json()`, default) must declare `shape` or `columns`
 *       — never leak the producer's raw shape through a hand-written join.
 *   (B) a table-form (`over`) view listed in its module's `exposesRead` is read cross-module via
 *       `ctx.reads.<dep>.<view>`, which with no `columns` projects the producer's whole DECLARED face
 *       (`view.ts §viewColumnsOf`) — every non-sensitive schema key, auto-widening on a new one. Such a view
 *       must declare an explicit projection; a purely in-module `over`-form view keeps the default face.
 *  `output: binary()` (Excel/PDF/CSV) flips arm (A) off — a blob has no columns to narrow. */
export function checkViewProjectionNarrowed(
  views: App["views"] = [],
  model: ReadonlyArray<ResourceModel> = [],
): AppViolation[] {
  const out: AppViolation[] = [];
  const isCrossModuleExposed = viewExposedCrossModule(model);
  for (const v of views ?? []) {
    if (v.output?.kind === "binary") continue; // a blob is not a row set — projection/narrowing demand does not apply (canon line 72).
    const hasProjection = typeof v.shape === "function" ||
      (Array.isArray(v.columns) && v.columns.length > 0);
    if (hasProjection) continue;
    if (typeof v.run === "function") {
      // ARM (A) — cross-source run-form: a json row set with no declared projection leaks the producer's raw shape.
      out.push({
        id: "boundary/cross-read-narrowed",
        message:
          `view '${v.name}' is a run-form cross-source projection with output json() but declares no projected columns (shape/columns) — a json view's row set must be NARROWED so a producer column rename cannot silently leak through the hand-written join; declare 'shape' (the typed projection) or 'columns', or mark output: binary() (a blob has no columns to narrow)`,
        responsible: {
          kind: "unknown",
          why: `run-form view '${v.name}' json output with no projection`,
        },
      });
      continue;
    }
    // ARM (B) — the single-`over` table form: gated only when cross-module-exposed via `exposesRead`. An in-module
    // (non-exposed) over-form view crosses no boundary → its undeclared projection is unaffected (allowed).
    if (isCrossModuleExposed(v)) {
      out.push({
        id: "boundary/cross-read-narrowed",
        message:
          `view '${v.name}' is a table-form view exposed cross-module via exposesRead but declares no projected columns (columns/shape) — it projects every declared column of '${v.over}', so it leaks EVERY non-sensitive producer column cross-module via ctx.reads AND silently WIDENS when the producer adds a column; a cross-module-exposed view MUST declare an explicit 'columns' (or 'shape') projection so a new producer column cannot auto-widen the cross-module contract without re-review`,
        responsible: {
          kind: "unknown",
          why:
            `exposesRead over-form view '${v.name}' with no declared projection`,
        },
      });
    }
  }
  return out;
}

/**
 * `view/reads-protected-producer` (feature·authz, advisory — 13-authz.md §defineView-cross-source-visibility).
 * A cross-source `run`-form view applies the producer's non-actor conjuncts (scope/softDelete/expiry/temporal)
 * but by design does not re-apply the producer's actor-relative `rowPolicy` — doing so under the consuming
 * actor would defeat the cross-owner aggregate a staff dashboard exists for. When a view reads a
 * `rowPolicy`-protected producer, the actor gate is only the view's own `policy`; this advisory surfaces that
 * boundary for explicit review, never ship-blocking. Unregistered — an advisory Violation, no roster slot.
 */
export function checkViewReadsProtectedProducer(
  views: App["views"] = [],
  model: ReadonlyArray<ResourceModel> = [],
): AppViolation[] {
  const out: AppViolation[] = [];
  const app = { model, views } as App;
  for (const v of views ?? []) {
    const producers = protectedProducersOf(app, v);
    if (producers.length === 0) continue;
    out.push({
      id: "view/reads-protected-producer",
      rung: "runtime-assert", // advisory axis position → deriveBlocks yields advisory (never ship-blocks)
      message: `view '${v.name}' reads a rowPolicy-protected producer (${
        producers.join(", ")
      }) via its sources — its row visibility is gated only by the view's own 'policy' + the non-actor conjuncts (scope/softDelete/expiry/temporal), NOT the producer's per-row rowPolicy (the producer's actor-relative policy is by design not re-applied, so the cross-owner aggregate the view exists for is preserved). Confirm the view's 'policy' is the intended authz gate for reading across owners — the coarse gate is explicit and reviewed, never silently assumed`,
      responsible: {
        kind: "unknown",
        why:
          `run-form view '${v.name}' reads rowPolicy-protected producer(s): ${
            producers.join(", ")
          }`,
      },
    });
  }
  return out;
}

/**
 * `boundary/exposes-read-not-sensitive` (feature·boundary, advisory — Boundary candidate;
 * the `exposesRead` egress analog of `vector/source-not-sensitive`). A cross-module-exposed table-form view
 * whose explicit `columns` projection names a producer `sensitive`/`encrypted` field declares an incoherent
 * contract: the cross-module read path drops `sensitive ∪ encrypted` at the boundary (view.ts
 * `dropSensitiveAll`), so a consumer never receives those columns — not a runtime leak, a declaration smell.
 * Fires only on the explicit-projection path (the no-`columns` SELECT* case is `checkViewProjectionNarrowed`'s);
 * shares the same cross-module-exposed predicate, so the two never disagree. Unregistered advisory.
 */
export function checkViewExposesReadSensitive(
  views: App["views"] = [],
  model: ReadonlyArray<ResourceModel> = [],
): AppViolation[] {
  const out: AppViolation[] = [];
  const modelByName = new Map<string, ResourceModel>();
  for (const m of model) modelByName.set(m.name, m);
  const isCrossModuleExposed = viewExposedCrossModule(model);
  for (const v of views ?? []) {
    if (v.over === undefined) continue; // table-form only — a run-form view's `columns` aren't producer columns
    if (!isCrossModuleExposed(v)) continue; // only a cross-module egress matters (an in-module view crosses nothing)
    if (!Array.isArray(v.columns) || v.columns.length === 0) continue; // no explicit projection → checkViewProjectionNarrowed owns the SELECT* case
    const producer = modelByName.get(v.over);
    if (producer === undefined) continue;
    const redacted = new Set<string>([
      ...producer.sensitive,
      ...producer.encrypted,
    ]);
    const leaked = v.columns.filter((c) => redacted.has(c));
    if (leaked.length > 0) {
      out.push({
        id: "boundary/exposes-read-not-sensitive",
        rung: "runtime-assert", // advisory axis position → deriveBlocks yields advisory (never ship-blocks)
        message:
          `view '${v.name}' is exposed cross-module via exposesRead and its 'columns' projection names sensitive/encrypted producer field(s) (${
            leaked.join(", ")
          }) of '${v.over}' — the cross-module read path DROPS sensitive∪encrypted at the boundary (view.ts dropSensitiveAll), so a consumer NEVER receives these columns; projecting them is an incoherent contract (the author expects a field the runtime silently strips). Remove them from the projection, or if the data is not actually sensitive, drop the sensitive()/encrypted() marker on '${v.over}'`,
        responsible: {
          kind: "unknown",
          why:
            `exposesRead view '${v.name}' projects redacted producer field(s): ${
              leaked.join(", ")
            }`,
        },
      });
    }
  }
  return out;
}

/**
 * `view/binary-not-mcp` (advisory — 12-mcp §6). A `binary()` view yields a blob (Excel/PDF/CSV), which
 * cannot be shape-narrowed, sensitive-verified, or paginated, so it never projects an MCP tool (viewToolDefs
 * skips it) — a `mcp:` declared on one is inert, a declaration smell. Steer to `json()`. Unregistered advisory.
 */
export function checkBinaryViewNotMcp(
  views: App["views"] = [],
): AppViolation[] {
  const out: AppViolation[] = [];
  for (const v of views ?? []) {
    if (isBinaryView(v) && v.mcp) {
      out.push({
        id: "view/binary-not-mcp",
        rung: "runtime-assert",
        message:
          `view '${v.name}' is a binary() view (a blob) but declares an 'mcp' projection — a binary view NEVER projects an MCP tool (it cannot be shape-narrowed / sensitive-verified / paginated, 12-mcp §6), so the mcp: is inert. Drop the mcp:, or switch the view to json() if an agent should read it.`,
        responsible: {
          kind: "unknown",
          why: `binary() view '${v.name}' declares an inert mcp projection`,
        },
      });
    }
  }
  return out;
}
