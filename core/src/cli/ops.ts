import type { Db, Transactor } from "../data/db.ts";
import { explainError } from "./hazelnut-io.ts";
import type { App, ResourceModel } from "../core/app.ts";
import type { Kms } from "../features/encrypt.ts";
import {
  countSealedUnder,
  rotateEncrypted,
  type RotateReport,
} from "../features/rotate.ts";
import {
  forceExpireWorkflowClaim,
  inspectWorkflowClaim,
  runWorkflow,
  WORKFLOW_STEP_LEASE_MS,
} from "../runtime/workflow.ts";
import {
  clearRateCap,
  clearRelayDrain,
  type OpsControlRow,
  readOpsControl,
  redriveDead,
  relayLag,
  setRateCap,
  setRelayDrain,
} from "../runtime/outbox-relay.ts";

import type { WorkflowDecl } from "../runtime/workflow.ts";
import type { ConsumerCtx } from "../runtime/events.ts";
import type { CliResult } from "./cli.ts";
import { planFooter } from "./verb-consequence.ts";

/** CLI OPS verbs: `redrive` · `rotate-key` · `run-workflow` — the operator-facing entrypoints over the DLQ
 *  recovery move, the encrypted-key re-wrap, and the durable workflow runner. All three are classified
 *  `irreversible-write` in `verb-consequence.ts`, so each ships a read-only `…Plan` twin (bottom of this
 *  file) that the bare invocation renders. Pure cores return a `CliResult`; `hazelnut.ts` does the I/O. */
export async function cliRotateKey(
  db: Db,
  app: App,
  opts: { kms: Kms; from: string; batchSize?: number },
): Promise<CliResult> {
  // Every (resource, encrypted column) pair is a rotation target. A resource with no encrypted field contributes
  // none, so an app with zero encrypted columns yields an empty target list (the clean no-op below).
  const targets: Array<{ model: ResourceModel; column: string }> = [];
  for (const model of app.model) {
    for (const column of model.encrypted) targets.push({ model, column });
  }
  if (targets.length === 0) {
    return {
      code: 0,
      stdout:
        `✓ rotate-key: no encrypted columns declared — nothing to rotate (no-op).`,
    };
  }
  try {
    const reports: RotateReport[] = [];
    // Each call re-wraps the same DEK over the same ciphertext under the Kms's current version — a wrong
    // key or a no-op `current === from` Kms throws (caught below as exit 2), never a silent partial rotation.
    for (const { model, column } of targets) {
      reports.push(
        await rotateEncrypted(db, model, column, opts.kms, {
          from: opts.from,
          batchSize: opts.batchSize,
        }),
      );
    }
    const totalRewrapped = reports.reduce((n, r) => n + r.rewrapped, 0);
    // `to` is the new current version every column was re-wrapped to (uniform across columns — one Kms, one
    // current version). With nothing to migrate it stays `from`; that is still a clean pass (idempotent re-run).
    const to = reports.find((r) => r.rewrapped > 0)?.to ?? opts.from;
    // retirement-safety gate: the re-wrap count is not a convergence proof — verify count(key_id=from)=0 by a
    // real re-scan before declaring the old key retirable; a stranded row must never be silently "retirable".
    let remainingOnFrom = 0;
    for (const { model, column } of targets) {
      remainingOnFrom += await countSealedUnder(db, model, column, opts.from);
    }
    const lines = [
      `✓ rotate-key: re-wrapped ${totalRewrapped} row(s) across ${reports.length} encrypted column(s) from version '${opts.from}' to '${to}'`,
      ...reports.map((r) =>
        `  - ${r.column}: ${r.rewrapped} re-wrapped (${r.from} → ${r.to})`
      ),
      remainingOnFrom > 0
        ? `  ⚠ ${remainingOnFrom} row(s) STILL on version '${opts.from}' — NOT retirable. Re-run \`hazelnut rotate-key\` until this reaches 0; retiring '${opts.from}' now would orphan those rows (irrecoverable data loss).`
        : totalRewrapped > 0
        ? `  old version '${opts.from}' is now retirable — VERIFIED count(key_id = '${opts.from}') = 0 across the rotated columns; the custody side may delete it.`
        : `  no row was on version '${opts.from}' — already fully rotated (idempotent no-op re-run).`,
    ];
    return { code: 0, stdout: lines.join("\n") };
  } catch (e) {
    // A rotation failure (wrong/evicted key, no-op current===from, malformed envelope) refuses, never leaves a
    // silent half-rotated column — a mid-pass throw leaves migrated rows on the new version; re-run finishes them.
    return {
      code: 2,
      stdout: `rotate-key: ${explainError(e)}`,
    };
  }
}

/** `hazelnut run-workflow <name> <app>` — resolves a workflow by name off `app.workflows` and runs it against
 *  the live `db`, journaling each step in `_workflow_journal` so a re-run resumes rather than repeats. */
export async function cliRunWorkflow(
  db: Db,
  app: App,
  name: string,
): Promise<CliResult> {
  const wf = (app.workflows ?? []).find((w) => w.name === name) as
    | WorkflowDecl<unknown>
    | undefined;
  if (!wf) {
    const names = (app.workflows ?? []).map((w) => w.name).sort();
    return {
      code: 2,
      stdout: `run-workflow: no workflow named '${name}'${
        names.length
          ? ` — declared: ${names.join(", ")}`
          : " (the app declares no workflows)"
      }`,
    };
  }
  try {
    await runWorkflow(db, wf, undefined, {} as ConsumerCtx, wf.name, app);
    return {
      code: 0,
      stdout:
        `✓ run-workflow: '${name}' ran — every journaled step is committed in _workflow_journal`,
    };
  } catch (e) {
    return {
      code: 2,
      stdout: `run-workflow: '${name}' failed — ${
        explainError(e)
      } (completed steps stand in the journal; re-run to resume)`,
    };
  }
}

/** `hazelnut redrive <app> … --execute` — the DLQ move itself. Sits beside its plan twin so a change to one
 *  is read next to the other; `redriveDead` owns the single-tx move (no lost or duplicated corpse). */
export async function cliRedrive(
  db: Db & Transactor,
  opts: { topic?: string; limit?: number },
): Promise<CliResult> {
  const n = await redriveDead(db, {
    ...(opts.topic !== undefined ? { topic: opts.topic } : {}),
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
  });
  return {
    code: 0,
    stdout: `✓ redrive: re-drove ${n} dead-lettered ${
      opts.topic ? `'${opts.topic}' ` : ""
    }job(s) from _outbox_dead → _outbox${
      opts.limit !== undefined ? ` (capped at ${opts.limit})` : ""
    } — the standing relay will re-process them`,
  };
}

// ── Plan-before-apply: the read-only pre-image of each irreversible ops verb ───────────────────────────────
//
// SEPARATE functions rather than an `execute:` branch inside the executors: a plan that cannot reach a write
// statement cannot be a flag someone forgot to read. Both halves run against one seeded datastore and
// the plan leaves it byte-identical while the executor moves it.

/**
 * `hazelnut redrive <app> [--topic <t>] [--limit <n>]` without `--execute`.
 *
 * Runs the same `WHERE topic / ORDER BY dead_at / LIMIT` the move runs, so the counts are the rows the
 * executor will take rather than an estimate. A re-drive re-fires every listed job's external effect and
 * DELETES the `_outbox_dead` row that recorded why it died — the plan says both, because after the move
 * neither fact is answerable from stored state.
 */
export async function cliRedrivePlan(
  db: Db,
  opts: { topic?: string; limit?: number },
): Promise<CliResult> {
  const scope = opts.topic ? `'${opts.topic}' ` : "";
  const capped = opts.limit !== undefined ? ` (capped at ${opts.limit})` : "";
  const where = opts.topic === undefined ? "" : " WHERE topic = $1";
  const params: unknown[] = opts.topic === undefined ? [] : [opts.topic];
  const limit = opts.limit === undefined ? "" : ` LIMIT $${params.length + 1}`;
  if (opts.limit !== undefined) params.push(opts.limit);
  const { rows } = await db.query<{ topic: string; error: string | null }>(
    `SELECT topic, error FROM "_outbox_dead"${where} ORDER BY dead_at${limit}`,
    params,
  );
  if (rows.length === 0) {
    return {
      code: 0,
      stdout:
        `redrive plan: no ${scope}dead-lettered job in _outbox_dead — nothing to re-drive${capped}.`,
    };
  }
  const byTopic = new Map<string, { n: number; sample: string }>();
  for (const r of rows) {
    const e = byTopic.get(r.topic) ??
      { n: 0, sample: r.error ?? "(no recorded error)" };
    byTopic.set(r.topic, { n: e.n + 1, sample: e.sample });
  }
  return {
    code: 0,
    stdout: [
      `redrive plan: ${rows.length} ${scope}dead-lettered job(s) across ${byTopic.size} topic(s) would move _outbox_dead → _outbox${capped}`,
      ...[...byTopic].sort(([a], [z]) => a.localeCompare(z)).map(([t, e]) =>
        `  - ${t}: ${e.n} — first recorded error: ${e.sample}`
      ),
      `  each re-drive re-fires that job's external effect against this DATABASE_URL and REMOVES its`,
      `  _outbox_dead row, so the attempts, error and dead_at that recorded the failure are gone.`,
      planFooter(
        "redrive",
        `<app>${opts.topic ? ` --topic ${opts.topic}` : ""}${
          opts.limit !== undefined ? ` --limit ${opts.limit}` : ""
        }`,
      ),
    ].join("\n"),
  };
}

/** `hazelnut rotate-key <app> --from <v> …` without `--execute` — the same `countSealedUnder` scan the
 *  retirement gate runs after a rotation, run before one. Reads only; counting needs no Kms. */
export async function cliRotateKeyPlan(
  db: Db,
  app: App,
  opts: { from: string },
): Promise<CliResult> {
  const targets: Array<{ model: ResourceModel; column: string }> = [];
  for (const model of app.model) {
    for (const column of model.encrypted) targets.push({ model, column });
  }
  if (targets.length === 0) {
    return {
      code: 0,
      stdout:
        `rotate-key plan: no encrypted columns declared — nothing to rotate (no-op).`,
    };
  }
  const counts: Array<[string, number]> = [];
  for (const { model, column } of targets) {
    counts.push([
      `${model.name}.${column}`,
      await countSealedUnder(db, model, column, opts.from),
    ]);
  }
  const total = counts.reduce((n, [, c]) => n + c, 0);
  return {
    code: 0,
    stdout: [
      `rotate-key plan: ${total} row(s) across ${targets.length} encrypted column(s) would be re-wrapped off key version '${opts.from}'`,
      ...counts.map(([name, c]) => `  - ${name}: ${c}`),
      `  a re-wrap rewrites every listed row's sealed data key against this DATABASE_URL.`,
      planFooter("rotate-key", `<app> --from ${opts.from} …`),
    ].join("\n"),
  };
}

/** `hazelnut run-workflow <name> <app>` without `--execute`. A workflow's steps are minted by its `run`
 *  body, so the only honest pre-image is the JOURNAL: which steps a re-run short-circuits to a stored
 *  result, and which fire for real. */
export async function cliRunWorkflowPlan(
  db: Db,
  app: App,
  name: string,
): Promise<CliResult> {
  const wf = (app.workflows ?? []).find((w) => w.name === name);
  if (!wf) return await cliRunWorkflow(db, app, name); // the same unknown-name refusal, one copy
  let rows: Array<{ step_id: string; status: string }> = [];
  try {
    rows = (await db.query<{ step_id: string; status: string }>(
      `SELECT step_id, status FROM "_workflow_journal" WHERE workflow_id = $1 ORDER BY created_at`,
      [wf.name],
    )).rows;
  } catch {
    /* no journal table yet: an app that never ran a workflow has journaled nothing, so [] is correct */
  }
  const done = rows.filter((r) => r.status === "done").length;
  return {
    code: 0,
    stdout: [
      `run-workflow plan: '${name}' would run against this DATABASE_URL — ${done} journaled step(s) resume from a stored result, ${
        rows.length - done
      } re-run`,
      ...(rows.length > 0 ? rows.map((r) => `  - ${r.step_id}: ${r.status}`) : [
        `  - (no journal rows) every step this workflow's body reaches fires for the first time`,
      ]),
      `  a step that is not already 'done' performs its real effect, including any external call.`,
      planFooter("run-workflow", `${name} <app>`),
    ].join("\n"),
  };
}

// ── `hazelnut unstick-workflow` — force-reclaim a stuck `_workflow_journal` step claim (05-runtime.md
// §workflow durable steps) ──────────────────────────────────────────────────────────────────────────────
//
// The claim's own crash-reclaim lease already self-heals: a peer that dies mid-step is retaken automatically
// once its lease lapses (`WORKFLOW_STEP_LEASE_MS`, or the workflow's own `leaseMs` override). This verb is
// for the operator who already KNOWS the prior runner is gone (the container was killed, the crash is in
// their own infra logs) and does not want to wait out a lease that may be minutes long. Forcing a claim that
// is still genuinely live double-runs a non-idempotent step — the plan says so explicitly, every time.

/** Resolve the lease window for a `--workflow` value: match it against `app.workflows` by declared NAME
 *  (the run's `workflow_id` defaults to that name, per `runWorkflow`'s own default) to pick up a per-workflow
 *  `leaseMs` override; a pinned custom run id matches no declared name, so the floor applies and the caller
 *  is told which case it was — a silent floor fallback would understate a workflow's own wider lease. */
function resolveLeaseMs(
  app: App,
  workflowId: string,
): { leaseMs: number; matchedDecl: boolean } {
  const wf = (app.workflows ?? []).find((w) => w.name === workflowId) as
    | WorkflowDecl<unknown>
    | undefined;
  return wf
    ? { leaseMs: wf.leaseMs ?? WORKFLOW_STEP_LEASE_MS, matchedDecl: true }
    : { leaseMs: WORKFLOW_STEP_LEASE_MS, matchedDecl: false };
}

/** `hazelnut unstick-workflow <app> --workflow <id> --step <stepId>` without `--execute`. Read-only: reports
 *  the claim's current status/age/lease and whether it is still genuinely live. */
export async function cliUnstickWorkflowPlan(
  db: Db,
  app: App,
  opts: { workflowId: string; stepId: string },
): Promise<CliResult> {
  const { leaseMs, matchedDecl } = resolveLeaseMs(app, opts.workflowId);
  const state = await inspectWorkflowClaim(
    db,
    opts.workflowId,
    opts.stepId,
    leaseMs,
  );
  const leaseNote = matchedDecl
    ? ""
    : `  '${opts.workflowId}' names no declared workflow — a pinned custom run id, most likely; using the ${leaseMs}ms floor lease (a per-workflow \`leaseMs\` override, if any, could not be resolved).\n`;
  if (!state) {
    return {
      code: 0,
      stdout:
        `unstick-workflow plan: no claim found for workflow '${opts.workflowId}' step '${opts.stepId}' — nothing to unstick (never run, or already reclaimed).\n${leaseNote}`
          .trimEnd(),
    };
  }
  if (state.status === "done") {
    return {
      code: 0,
      stdout:
        `unstick-workflow plan: workflow '${opts.workflowId}' step '${opts.stepId}' is already 'done' — a finished claim is never force-released; this would be a clean no-op.`,
    };
  }
  const ageS = Math.round(state.ageMs / 1000);
  const leaseS = Math.round(state.leaseMs / 1000);
  return {
    code: 0,
    stdout: [
      `unstick-workflow plan: workflow '${opts.workflowId}' step '${opts.stepId}' is '${state.status}', claimed ${ageS}s ago (lease ${leaseS}s)${
        state.attempts > 0 ? `, ${state.attempts} prior attempt(s)` : ""
      }.`,
      leaseNote.trimEnd(),
      state.live
        ? `  ⚠ the claim is STILL LIVE (age < lease) — a runner may genuinely be mid-step right now. Forcing this WILL let a second runner start the same step concurrently, and a non-idempotent step (a charge, an email) would run twice. Confirm the prior runner is actually dead before using --execute.`
        : `  the claim is past its own lease — the standing crash-reclaim would take this over on its own; forcing it now just skips the wait.`,
      state.lastError ? `  last recorded error: ${state.lastError}` : "",
      planFooter(
        "unstick-workflow",
        `<app> --workflow ${opts.workflowId} --step ${opts.stepId}`,
      ),
    ].filter((l) => l !== "").join("\n"),
  };
}

/** `hazelnut unstick-workflow <app> --workflow <id> --step <stepId> --execute` — the force-reclaim itself.
 *  Rewinds the claim's lease to the epoch so the NEXT `runWorkflow`/`ctx.workflows.<name>.start` reclaims it
 *  through the ordinary crash-reclaim path — no bespoke unlock code, no separate correctness argument. */
export async function cliUnstickWorkflow(
  db: Db,
  opts: { workflowId: string; stepId: string },
): Promise<CliResult> {
  const did = await forceExpireWorkflowClaim(db, opts.workflowId, opts.stepId);
  return {
    code: 0,
    stdout: did
      ? `✓ unstick-workflow: workflow '${opts.workflowId}' step '${opts.stepId}' is now reclaimable — the next run takes it over immediately instead of waiting out the lease.`
      : `✓ unstick-workflow: no in-flight claim matched workflow '${opts.workflowId}' step '${opts.stepId}' (clean no-op — already done, already reclaimed, or never run).`,
  };
}

// ── `hazelnut ops` — the levers an operator pulls WITHOUT a deploy (05-runtime.md §ops-levers) ─────────────
//
// Both write `_ops_control`, so both are durable across restart (a row), shared across replicas (the same
// row) and idempotent (a PK upsert). Classified `irreversible-write` like the other datastore-touching
// verbs: the bare form renders the plan, `--execute` lands it.

/** One parsed `ops` invocation. A closed union rather than a bag of optional fields — an action with a
 *  missing key cannot be constructed, so no executor re-decides what the parser already decided. */
export type OpsAction =
  | { readonly kind: "status" }
  | { readonly kind: "pause-relay"; readonly reason?: string }
  | { readonly kind: "resume-relay" }
  | { readonly kind: "cap"; readonly key: string; readonly limit: number }
  | { readonly kind: "uncap"; readonly key: string };

/** The subcommand vocabulary, in the order the usage line prints them. */
export const OPS_ACTIONS = [
  "status",
  "pause-relay",
  "resume-relay",
  "cap",
  "uncap",
] as const;

/** The alternation the usage line interpolates. Pre-joined HERE so the dispatcher's usage template carries
 *  no quote character — the contract tooth scans that line for `--flags` and stops at the first quote. */
export const OPS_ACTION_LIST: string = OPS_ACTIONS.join("|");

/**
 * Parse `hazelnut ops <app> <sub> …` into an action, or into the refusal the CLI prints. `''` is a legal cap
 * key (the fleet-wide default row), so an absent key and an empty key are told apart by ARITY, never by
 * truthiness — the bug that would silently turn `ops cap '' 10` into a usage error.
 */
export function parseOpsAction(
  args: readonly string[],
): { action: OpsAction } | { error: string } {
  const sub = args[0];
  if (sub === undefined || sub.startsWith("--")) {
    return { action: { kind: "status" } };
  }
  if (!(OPS_ACTIONS as readonly string[]).includes(sub)) {
    return {
      error: `ops: unknown action '${sub}' — this verb serves: ${
        OPS_ACTIONS.join(" · ")
      }`,
    };
  }
  if (sub === "status") return { action: { kind: "status" } };
  if (sub === "resume-relay") return { action: { kind: "resume-relay" } };
  if (sub === "pause-relay") {
    const at = args.indexOf("--reason");
    const value = at !== -1 ? args[at + 1] : undefined;
    if (at !== -1 && (value === undefined || value.startsWith("--"))) {
      return {
        error: "ops pause-relay: --reason needs the text that follows it",
      };
    }
    return {
      action: {
        kind: "pause-relay",
        ...(value !== undefined ? { reason: value } : {}),
      },
    };
  }
  const key = args[1];
  if (key === undefined || key.startsWith("--")) {
    return {
      error:
        `ops ${sub}: needs a budget key — the actor id to ${sub}, or '' (two quotes) for every key without its own cap`,
    };
  }
  if (sub === "uncap") return { action: { kind: "uncap", key } };
  const raw = args[2];
  const limit = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isInteger(limit) || limit <= 0) {
    return {
      error: `ops cap: needs a positive integer budget per window (got '${
        raw ?? ""
      }') — a cap of 0 is not "blocked", it is a row the database refuses`,
    };
  }
  return { action: { kind: "cap", key, limit } };
}

/** Render the live lever rows the way an operator reads them: what is set, why, and since when. */
function renderLevers(rows: readonly OpsControlRow[]): string[] {
  if (rows.length === 0) {
    return ["  (no lever set — the app runs on its declared defaults)"];
  }
  return rows.map((r) =>
    r.lever === "relay-drain"
      ? `  relay-drain: HELD since ${r.setAt}${
        r.reason ? ` — ${r.reason}` : ""
      }`
      : `  rate-limit ${
        r.key === "" ? "(every uncapped key)" : `'${r.key}'`
      }: ${r.value} per window, since ${r.setAt}${
        r.reason ? ` — ${r.reason}` : ""
      }`
  );
}

/** `hazelnut ops <app> [status]` and every plan form. Reads `_ops_control` plus the live backlog — a
 *  drain-hold is only readable next to what it is holding — and writes nothing. */
export async function cliOpsPlan(
  db: Db,
  action: OpsAction,
): Promise<CliResult> {
  const rows = await readOpsControl(db);
  const held = rows.find((r) => r.lever === "relay-drain");
  const { pending } = await relayLag(db);
  const current = [
    "ops: levers live against this DATABASE_URL —",
    ...renderLevers(rows),
  ];
  if (action.kind === "status") {
    return {
      code: 0,
      stdout: [
        ...current,
        `  _outbox backlog ready to drain: ${pending}`,
        held
          ? `  the relay is HOLDING: nothing new is claimed, and that backlog does not shrink until you resume.`
          : `  the relay is draining normally.`,
      ].join("\n"),
    };
  }
  const prior = action.kind === "cap" || action.kind === "uncap"
    ? rows.find((r) => r.lever === "rate-limit" && r.key === action.key)
    : undefined;
  const consequence: string[] = action.kind === "pause-relay"
    ? [
      `  the relay would HOLD: every replica stops CLAIMING new messages within one poll interval.`,
      `  a cycle already past its poll finishes the batch it claimed — a hold never stops work mid-transaction.`,
      `  ${pending} ready message(s) would sit undelivered, and the backlog keeps growing while the hold stands.`,
      `  readiness reports 'relay-paused' and stays GREEN, so nothing restarts the workers you just quiesced.`,
      `  framework maintenance sweeps (file-gc, re-embed, read-model maintain) are NOT held — they keep running.`,
    ]
    : action.kind === "resume-relay"
    ? [
      held
        ? `  the hold set at ${held.setAt} would be released; every replica resumes claiming within one poll interval.`
        : `  no hold is standing — this would be a clean no-op.`,
    ]
    : action.kind === "cap"
    ? [
      `  budget key ${
        action.key === "" ? "(every uncapped key)" : `'${action.key}'`
      } would be capped at ${action.limit} per window`,
      prior
        ? `  replacing the standing cap of ${prior.value} (one row, not two — the same key is set once).`
        : `  no cap stands on that key today; the app's declared budget applies.`,
      `  a cap only TIGHTENS: the limiter takes the lower of this and what the app declared, so a number above`,
      `  the declared budget changes nothing. Callers over the new budget get 429 on their next request.`,
    ]
    : [
      prior
        ? `  the cap of ${prior.value} on '${action.key}' would be removed; the app's declared budget applies again.`
        : `  no cap stands on '${action.key}' — this would be a clean no-op.`,
    ];
  return {
    code: 0,
    stdout: [
      ...current,
      `ops ${action.kind} plan:`,
      ...consequence,
      planFooter(
        "ops",
        `<app> ${action.kind}${
          action.kind === "cap"
            ? ` ${action.key === "" ? "''" : action.key} ${action.limit}`
            : action.kind === "uncap"
            ? ` ${action.key === "" ? "''" : action.key}`
            : ""
        }`,
      ),
    ].join("\n"),
  };
}

/** `hazelnut ops <app> <action> --execute` — the lever itself. Every write is a PK upsert or a keyed delete,
 *  so pulling the same lever twice leaves exactly one row (or none): a re-run is a no-op, never a second hold. */
export async function cliOps(db: Db, action: OpsAction): Promise<CliResult> {
  switch (action.kind) {
    case "status":
      return await cliOpsPlan(db, action); // one renderer — status has no executing form to drift from it
    case "pause-relay": {
      await setRelayDrain(db, action.reason);
      const { pending } = await relayLag(db);
      return {
        code: 0,
        stdout:
          `✓ ops pause-relay: the relay is HELD${
            action.reason ? ` — ${action.reason}` : ""
          }. Every replica stops claiming within one poll interval; ${pending} ready message(s) wait. ` +
          `Release with \`hazelnut ops <app> resume-relay --execute\`.`,
      };
    }
    case "resume-relay": {
      const was = await clearRelayDrain(db);
      return {
        code: 0,
        stdout: was
          ? `✓ ops resume-relay: the hold is released — every replica resumes claiming within one poll interval.`
          : `✓ ops resume-relay: no hold was standing (clean no-op).`,
      };
    }
    case "cap": {
      await setRateCap(db, action.key, action.limit);
      return {
        code: 0,
        stdout:
          `✓ ops cap: budget key ${
            action.key === "" ? "(every uncapped key)" : `'${action.key}'`
          } is capped at ${action.limit} per window on every replica. ` +
          `A cap only tightens — the limiter takes the lower of this and the app's declared budget.`,
      };
    }
    case "uncap": {
      const was = await clearRateCap(db, action.key);
      return {
        code: 0,
        stdout: was
          ? `✓ ops uncap: the cap on '${action.key}' is removed — the app's declared budget applies again.`
          : `✓ ops uncap: no cap was standing on '${action.key}' (clean no-op).`,
      };
    }
  }
}
