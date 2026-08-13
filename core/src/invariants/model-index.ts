import type { ResourceModel } from "../core/app.ts";
import type { ModelIndex, VerifyCtx } from "../core/verifier-contract.ts";

// Leaf module (types-only deps) — the per-run model index. Lives below the invariant const files and the
// engine so both can import it without a circular-init edge (the invariant `check`s call idxOf at run-time;
// keeping it engine-free is what lets roster.ts initialise `invariants[]` before any back-edge fires).

/** Build the per-run `ModelIndex` — one O(n) pass yielding the whole-model lookups cross-model invariants
 *  consult, replacing per-invariant O(n²) rebuilds. Each field's accumulation matches the rebuild it
 *  replaces: `schemaOf`/`moduleOf` last-wins, `byTable`/`firstOfModule` first-wins, `bySlot` keeps decl order. */
export function buildModelIndex(
  model: ReadonlyArray<ResourceModel>,
  /** The app-wide permission catalogue (`app.perms`) — the DERIVED per-resource keys plus the half
   *  `defineConfig({ perms })` declares. Folding the model alone sees only the derived half, so a key no
   *  resource can seed (a role, an operator floor) read as dangling at the one door for declaring it. */
  declaredPerms: readonly string[] = [],
): ModelIndex {
  const schemaOf = new Map<string, string>();
  const moduleOf = new Map<string, string>();
  const permsVocab = new Set<string>(declaredPerms);
  const names = new Set<string>();
  const bySlot = new Map<string, ResourceModel[]>();
  const byTable = new Map<string, ResourceModel>();
  const firstOfModule = new Map<string, ResourceModel>();
  for (const x of model) {
    schemaOf.set(x.name, x.pgSchema);
    moduleOf.set(x.name, x.module);
    names.add(x.name);
    for (const p of x.perms) permsVocab.add(p);
    const slot = `${x.name}::${x.pgSchema}`;
    let arr = bySlot.get(slot);
    if (!arr) bySlot.set(slot, arr = []);
    arr.push(x);
    const table = `"${x.pgSchema}"."${x.name}"`;
    if (!byTable.has(table)) byTable.set(table, x);
    if (!firstOfModule.has(x.module)) firstOfModule.set(x.module, x);
  }
  return {
    schemaOf,
    moduleOf,
    permsVocab,
    names,
    bySlot,
    byTable,
    firstOfModule,
  };
}

/** The per-run model index off the ctx, or a freshly built one (the fallback keeps a hand-built ctx correct — only
 *  the `runVerify`/`verifyCtxFor` hot path is memoized, where `ctx.modelIndex` is always present). */
export function idxOf(ctx: VerifyCtx): ModelIndex {
  return ctx.modelIndex ?? buildModelIndex(ctx.model);
}
