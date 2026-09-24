import { tableOf } from "../core/app-define.ts";
import type { ResourceModel } from "../core/app.ts";
import type { Db } from "../data/db.ts";
import { err, ok, type Result } from "../core/result.ts";
import type { OutboxMsg } from "../runtime/outbox.ts";
import {
  appendRowPolicyConjunct,
  auditWrite,
  onRowGate,
  type ReadCtx,
  timestampsGate,
} from "../data/repo.ts";
import { enqueueReadModelMaintain } from "./readmodel.ts";
import type { Actor } from "../authz/auth.ts";
import {
  deletedAtLivenessOn,
  wholeImmutable,
} from "../data/schema-normalize.ts";

/** Transition context: `scope` bounds the read+CAS; `actor` (optional) stamps the `_audit` row when the
 *  resource declares `audit` (04-features.md §transitions). */
interface TransitionCtx {
  readonly scope: string;
  readonly actor?: {
    readonly type: string;
    readonly id: string;
    readonly onBehalfOf?: string;
  } | null;
  // the door this status move entered through — an audited transition stamps it like every other write,
  // so an approval an agent moved is answerable as an agent write (repo.ts `ReadCtx.origin`).
  readonly origin?: string;
}

/** Optional transition side-effects (04-features.md §transitions). `emit` is the in-tx `ctx.emit`: when wired,
 *  a successful edge emits `<module>.<resource>.transitioned`; absent, no event. */
export interface TransitionOpts {
  emit?(msg: OutboxMsg): Promise<string>;
}

/** The transition event topic for a resource's state change — `<module>.<resource>.transitioned`
 *  (05-runtime.md §cross-module event-name namespacing `<module>.<resource>.<event>`). */
export function transitionTopic(model: ResourceModel): string {
  return `${model.module}.${model.name}.transitioned`;
}

/** A transition is the only legal later writer of `status`; an immutable status leaves it no operation that
 * can honor both contracts. The verifier reports the declaration conflict, while this runtime check keeps an
 * unchecked composition from silently bypassing the field-level update guard. */
function statusIsImmutable(model: ResourceModel): boolean {
  if (wholeImmutable(model.features)) return true;
  const immutable = model.features.immutable;
  return immutable !== null && typeof immutable === "object" &&
    (immutable as { fields?: readonly string[] }).fields?.includes("status") ===
      true;
}

/** The initial state of a `transitions` resource (04-features.md §transitions): the `status` enum's declared
 *  `.default`. Returns `undefined` for a non-transitions resource or an enum-less `status`. This is the only
 *  state `create` may set — every later state is reachable only through `ctx.transition`. */
export function initialStatusOf(model: ResourceModel): string | undefined {
  if (Object.keys(model.transitions).length === 0) return undefined; // not a transitions resource
  const col = model.columns["status"];
  if (!col?.check || col.check.length === 0) return undefined; // no enum-backed status (a separate completeness gap)
  const d = col.default;
  if (d && d.kind === "literal" && typeof d.value === "string") return d.value; // the declared initial (canon)
  // No enum-order fallback: the framework never infers the initial from enum order (a reorder would silently
  // change which state create may set). A default-less resource gets undefined here — fail-closed, not guessed.
  return undefined;
}

/** The FSM create-status rule (04-features.md §transitions), ONE home for both external projections
 *  (serve-routes.ts + mcp-call.ts): a transitions resource's `status` moves only through `ctx.transition`,
 *  so a create may set `status` to the declared initial value or omit it — a non-initial status would jump
 *  the FSM. Returns `null` when the row is legal, else the reason (each surface wraps it in its own wire
 *  shape: 400 vs `err("validation")`). A parity tooth pins both surfaces to it. */
export function createStatusGuardViolation(
  model: ResourceModel,
  data: Readonly<Record<string, unknown>>,
): string | null {
  if (Object.keys(model.transitions).length === 0) return null;
  const s = data.status;
  if (s === undefined || s === initialStatusOf(model)) return null;
  return "status on create must be the initial state; later states go through the transition primitive";
}

/** The internal `ctx.data` insert face intentionally omits `status` from its public input type. Runtime
 *  validation keeps that contract intact when a custom op forwards a wider variable (structural typing
 *  does not reject extra keys). Even the initial value is refused here: omit it and let the DDL default
 *  seed the FSM; `ctx.transition` owns every explicit status write. */
export function ctxDataCreateStatusGuardViolation(
  model: ResourceModel,
  data: Readonly<Record<string, unknown>>,
): string | null {
  if (Object.keys(model.transitions).length === 0) return null;
  if (Object.hasOwn(data, "status") && data.status !== undefined) {
    return "status is framework-managed; omit it on ctx.data.create and use the transition primitive for later changes";
  }
  return null;
}

/** True when the resource declares `audit` (`true` | `{config}`) — a status change then writes one `_audit`
 *  row. Kept local: `auditConfig` in repo.ts is private. */
function isAudited(model: ResourceModel): boolean {
  const a = model.features.audit as unknown;
  return a === true || (a !== null && typeof a === "object");
}

/** Append the one `_audit` row a status change owes (04-features.md §transitions + 04-features.md §audit): `op:"transition"`,
 *  the `{status:{from,to}}` diff, actor/scope stamped. It must enter through auditWrite, not auditRow,
 *  so configured `fields` and sensitive-field masking constrain this feature door exactly like CRUD. */
async function auditTransition(
  db: Db,
  model: ResourceModel,
  ctx: TransitionCtx,
  id: string,
  from: string,
  to: string,
): Promise<void> {
  await auditWrite(
    db,
    model,
    {
      actor: (ctx.actor ?? null) as Actor | null,
      scope: ctx.scope,
      origin: ctx.origin,
    },
    id,
    "transition",
    {
      before: { status: from },
      after: { status: to },
    },
  );
}

/**
 * `ctx.transition` — the sole writer of `status`: verifies `current → to` is a declared edge (illegal ⇒
 * `conflict`), applies it via CAS so concurrent transitions can't both win (loser gets `conflict`), then
 * audits/emits in the same tx, if wired (04-features.md §transitions).
 */
export async function transition(
  db: Db,
  model: ResourceModel,
  ctx: TransitionCtx,
  id: string,
  to: string,
  opts: TransitionOpts = {},
): Promise<Result<{ id: string; status: string }>> {
  if (statusIsImmutable(model)) {
    return err(
      "conflict",
      `${model.name} declares immutable status, so it cannot also transition`,
    );
  }
  const scoped = Boolean(model.features.scope);
  // a non-live row is invisible here too — the read and the CAS carry `deleted_at IS NULL` when the
  // resource hides via softDelete or rectifiable (deletedAtLivenessOn), so transitioning a
  // tombstoned/superseded row returns notFound (no event/audit).
  const live = deletedAtLivenessOn(model.features)
    ? ` AND deleted_at IS NULL`
    : "";
  // rowPolicy (write-side authz) threads into both the status read and the CAS, like update/remove/restore/move,
  // so a hidden row reads/writes 0 rows → notFound/conflict, never a cross-owner status change or disclosure.
  const rc: ReadCtx = {
    actor: (ctx.actor ?? null) as Actor | null,
    scope: ctx.scope,
  };

  const selParams: unknown[] = [];
  const sp = (v: unknown) => `$${selParams.push(v)}`;
  let selWhere = `id = ${sp(id)}`;
  if (scoped) selWhere += ` AND scope_key = ${sp(ctx.scope)}`;
  selWhere += live + appendRowPolicyConjunct(model, rc, sp, undefined);
  // the edge form needs the row image for its guard/hooks — select it only when the model declares edge
  // behavior; the plain-string FSM keeps the status-only probe.
  //
  // `FOR UPDATE` on the edge form, and only there. A guard judges the WHOLE row (`guard: (row) => row.amount
  // > 100`) while the CAS below arbitrates `status` alone, so an unlocked pre-read lets a concurrent write to
  // any other column land between the judgment and the write — the transition then applies on a row the guard
  // never saw. The plain-string FSM judges nothing but `status`, which its own CAS re-checks, so it takes no
  // lock. Held for the caller's tx; `ctx.transition` always runs inside one.
  const hasEdges = Object.keys(model.transitionEdges).length > 0;
  const r = await db.query<Record<string, unknown>>(
    `SELECT ${hasEdges ? "*" : "status"} FROM ${
      tableOf(model)
    } WHERE ${selWhere}${hasEdges ? " FOR UPDATE" : ""}`,
    selParams,
  );
  const row = r.rows[0];
  if (!row) {
    return err("notFound", `${model.name} ${id} not found`);
  }
  const cur = row.status as string | null | undefined;
  if (cur == null) {
    return err(
      "conflict",
      `${model.name} ${id} has a NULL status — cannot transition`,
    );
  }
  const legal = model.transitions[cur] ?? [];
  if (!legal.includes(to)) {
    // The declared successors ride the refusal: the single-arg face types `to` as the module's whole status
    // union, so a non-successor compiles and can only be answered here — name what would have worked.
    return err(
      "conflict",
      `illegal transition ${cur} → ${to}${
        legal.length === 0
          ? ` — '${cur}' is terminal (no declared edge leaves it)`
          : ` — from '${cur}' the declared edges are: ${legal.join(", ")}`
      }`,
    );
  }
  // per-edge guard: a domain precondition checked at transition time. False or a throw is a fail-closed
  // `business` refuse — never an uncaught 500.
  const edge = model.transitionEdges[cur]?.[to];
  const hookCtx = {
    actor: ctx.actor ?? null,
    scope: ctx.scope,
    id,
    from: cur,
    to,
  };
  if (edge?.guard) {
    let pass = false;
    try {
      pass = await edge.guard(row!, hookCtx);
    } catch (e) {
      return err(
        "business",
        `transition ${cur} → ${to} guard threw (${
          e instanceof Error ? e.message : String(e)
        }) — fail-closed refuse`,
      );
    }
    if (!pass) {
      return err("business", `transition ${cur} → ${to} refused by its guard`);
    }
  }

  // CAS: apply only while status is still `cur` (atomic against a concurrent transition on the same row)
  let stamp = timestampsGate(model)?.updated ? ", updated_at = now()" : "";
  // a transition is a write, so it leaves the same column cards update() does: bump the optimistic-lock
  // version (else a concurrent CAS holding the pre-transition version is blinded) and stamp `updated_by`.
  if (model.features.versioning) stamp += ", version = version + 1";
  const updParams: unknown[] = [];
  const up = (v: unknown) => `$${updParams.push(v)}`;
  const setStatus = up(to);
  if (onRowGate(model)?.updated) {
    stamp += `, updated_by_type = ${
      up(ctx.actor?.type ?? null)
    }, updated_by_id = ${up(ctx.actor?.id ?? null)}`;
  }
  let updWhere = `id = ${up(id)} AND status = ${up(cur)}`;
  if (scoped) updWhere += ` AND scope_key = ${up(ctx.scope)}`;
  updWhere += live + appendRowPolicyConjunct(model, rc, up, undefined);
  const w = await db.query<{ id: string; version: number }>(
    `UPDATE ${
      tableOf(model)
    } SET status = ${setStatus}${stamp} WHERE ${updWhere} RETURNING id${
      model.features.versioning ? ", version" : ""
    }`,
    updParams,
  );
  if (w.rows.length === 0) {
    return err("conflict", `concurrent status change on ${model.name} ${id}`);
  }
  // per-edge hooks fire only after the CAS wins: exit-of-`from` then enter-of-`to`, both seeing the pre-
  // transition row image. A throwing hook aborts the transition — it propagates and rolls back with it.
  if (edge?.onExit) {
    try {
      await edge.onExit(row!, hookCtx);
    } catch (e) {
      throw new Error(
        `transition ${cur} → ${to} onExit hook failed (${
          e instanceof Error ? e.message : String(e)
        }) — transition rolled back`,
      );
    }
  }
  if (edge?.onEnter) {
    try {
      await edge.onEnter(row!, hookCtx);
    } catch (e) {
      throw new Error(
        `transition ${cur} → ${to} onEnter hook failed (${
          e instanceof Error ? e.message : String(e)
        }) — transition rolled back`,
      );
    }
  }

  // provenance in the same tx as the CAS: an `_audit` row when `audit` is declared, and the transition event
  // when `opts.emit` is wired. Both ride the existing `_audit`/`_outbox` tables — no dedicated history table.
  if (isAudited(model)) await auditTransition(db, model, ctx, id, cur, to);
  // re-project into any read model sinking this resource: a status change alters the projected row just like
  // update() does, so the transition door must refresh it or the read model serves the old status forever.
  if (model.readModelSinks.length > 0) {
    await enqueueReadModelMaintain(
      db,
      model,
      { actor: null, scope: ctx.scope },
      id,
      "upsert",
    );
  }
  if (opts.emit) {
    // A versioned transition is a CAS write. Its event must carry the committed version so a subscriber can
    // distinguish this state change from a later write to the same row; `schemaVersion` belongs to the event
    // contract itself and is not that row token.
    const payload = model.features.versioning
      ? { id, from: cur, to, version: w.rows[0]!.version }
      : { id, from: cur, to };
    await opts.emit({
      aggregateType: model.name,
      aggregateId: id,
      topic: transitionTopic(model),
      payload,
      scope: scoped ? ctx.scope : undefined,
    });
  }
  return ok({ id, status: to });
}
