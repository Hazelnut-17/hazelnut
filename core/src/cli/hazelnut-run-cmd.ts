// hazelnut runtime command group: launch, relay, redrive, rotate-key, verify-integrity, run-workflow, eval.
import type { App } from "../core/app.ts";
import { flagValue } from "./flag-roster.ts";
import { type Db, postgresDb } from "../data/db.ts";
import { decodeMasterKey, RotatingAppKeyKms } from "../features/encrypt.ts";
import {
  cliOps,
  cliOpsPlan,
  cliRedrive,
  cliRedrivePlan,
  cliRotateKey,
  cliRotateKeyPlan,
  cliRunWorkflow,
  cliRunWorkflowPlan,
  cliUnstickWorkflow,
  cliUnstickWorkflowPlan,
  OPS_ACTION_LIST,
  parseOpsAction,
} from "./cli.ts";
import { executeRequested } from "./verb-consequence.ts";
import { moduleSlot } from "./module-slot.ts";
import {
  explainError,
  hazelRelay,
  importAppModule,
  moduleSpec,
  type RelaySeams,
  relaySeamsGap,
} from "./hazelnut-io.ts";

export async function dispatchRuntime(
  cmd: string,
  modPath: string,
  rest: string[],
): Promise<void> {
  // `hazelnut launch <app> [--print] [--explain] [--entry <file>]` (cli/launch.md) — serve under the
  // permission set DERIVED from the declarations, never `-A`. Derivation happens here, at launch, so the
  // grant tracks the app instead of a flag string someone maintains by hand.
  if (cmd === "launch") {
    if (!modPath) {
      console.error(
        "usage: hazelnut launch <app> [--print] [--explain] [--entry <file>]",
      );
      Deno.exit(2);
    }
    const spec = moduleSpec(modPath);
    const mod = await importAppModule(spec) as { app?: App; default?: App };
    const app = mod.app ?? mod.default;
    if (!app) {
      console.error(`module '${modPath}' does not export 'app'`);
      Deno.exit(2);
    }
    const {
      execLaunch,
      LAUNCH_ENTRY,
      planLaunch,
      readAppGraph,
      renderLaunch,
    } = await import("./launch.ts");
    // the value must FOLLOW the flag and not itself be a flag — `--entry --print` is a typo, and silently
    // launching a file called "--print" is the kind of failure that reads as "the launcher is broken".
    // LAST occurrence wins: the scaffolded `start` task already spells `--entry main.ts`, so
    // `deno task start --entry other.ts` APPENDS a second one and first-wins made the operator's flag a no-op.
    const entryAt = rest.lastIndexOf("--entry");
    const entryArg = entryAt !== -1 ? rest[entryAt + 1] : undefined;
    if (
      entryAt !== -1 && (entryArg === undefined || entryArg.startsWith("--"))
    ) {
      console.error("launch: --entry needs a file path (e.g. --entry main.ts)");
      Deno.exit(2);
    }
    const entry = entryArg ?? LAUNCH_ENTRY;
    // the graph is walked from the SERVED entry, so `--entry` moves the scan with it
    const plan = planLaunch(
      app,
      Deno.env.toObject(),
      await readAppGraph(".", entry),
      entry,
    );
    const print = rest.includes("--print");
    const explain = rest.includes("--explain");
    if (print || explain || plan.refusals.length > 0) {
      const r = renderLaunch(plan, entry, { explain });
      console.log(r.stdout);
      Deno.exit(r.code);
    }
    Deno.exit(await execLaunch(plan, entry));
  }

  if (cmd === "relay") {
    if (!modPath) {
      console.error(
        "usage: hazelnut relay <app> [--loop] [--interval <ms>] [--health-port <n>]",
      );
      Deno.exit(2);
    }
    const spec = moduleSpec(modPath);
    const mod = await importAppModule(spec) as {
      app?: App;
      default?: App;
      relaySeams?: () => RelaySeams;
    };
    const app = mod.app ?? mod.default;
    if (!app) {
      console.error(`module '${modPath}' does not export 'app'`);
      Deno.exit(2);
    }
    const url = Deno.env.get("DATABASE_URL");
    if (!url) {
      console.error("relay: DATABASE_URL is not set");
      Deno.exit(2);
    }
    const postgres = (await import("postgres")).default;
    const sql = postgres(url, { onnotice: () => {} });
    // The live relay db must be a Transactor — `postgresDb` adds `.transaction` so the per-consumer claim
    // and handler write run in one tx (DB effectively-once); a hand-rolled db degrades to at-least-once.
    const db = postgresDb(sql);
    const loop = rest.includes("--loop");
    const intervalAt = rest.lastIndexOf("--interval");
    const intervalMs = intervalAt !== -1 && rest[intervalAt + 1]
      ? Number(rest[intervalAt + 1])
      : undefined;
    // Guards the interval exactly as --health-port below — an unparseable/NaN/non-positive value would
    // become `setTimeout(…, NaN)` → 0ms, busy-polling the prod DB. Refuse loudly instead of silently spinning.
    if (
      intervalAt !== -1 &&
      (intervalMs === undefined || Number.isNaN(intervalMs) || intervalMs <= 0)
    ) {
      console.error(
        "relay: --interval needs a positive number of milliseconds",
      );
      Deno.exit(2);
    }
    // `--health-port <n>` (05-runtime.md §5.1 external mode): the headless worker's own /healthz — the
    // no-server relay process has no `/ready`, so an orchestrator probes this instead.
    const healthAt = rest.lastIndexOf("--health-port");
    const healthPort = healthAt !== -1 && rest[healthAt + 1]
      ? Number(rest[healthAt + 1])
      : undefined;
    if (
      healthAt !== -1 && (healthPort === undefined || Number.isNaN(healthPort))
    ) {
      console.error("relay: --health-port needs a port number");
      Deno.exit(2);
    }
    // in loop mode SIGINT aborts the supervisor cleanly (drain finishes the in-flight pass, then exits).
    const controller = new AbortController();
    if (loop) Deno.addSignalListener("SIGINT", () => controller.abort());
    // The framework-topic drains need seams (storage, embed, kms); the relay module optionally exports a
    // `relaySeams: () => RelaySeams` factory. An app declaring those features without them refuses here — fail-closed.
    const seams = mod.relaySeams ? mod.relaySeams() : {};
    const missing = relaySeamsGap(app, seams);
    if (missing.length > 0) {
      console.error(
        `relay: '${modPath}' declares ${
          missing.join(", ")
        }, but no relaySeams provides them — the external relay would leave those framework topics undrained (file-gc rows pile up → every serve replica's /ready flips 503; encrypted consumers throw). ` +
          `Export a factory from the relay module: \`export const relaySeams = () => ({ storage: localDriver({ dir: Deno.env.get("FILES_DIR")! }) });\` — or run the relay in-process (createApp(config, { db, storage, relay: "in-process", scheduler: "in-process" }) in main.ts).`,
      );
      Deno.exit(2);
    }
    try {
      const r = await hazelRelay(db, app, {
        loop,
        intervalMs,
        signal: controller.signal,
        ...(healthPort !== undefined ? { healthPort } : {}),
      }, seams);
      console.log(
        `✓ relay: drained — processed=${r.processed} failed=${r.failed} dead=${r.dead}`,
      );
    } finally {
      await sql.end();
    }
    Deno.exit(0);
  }

  // `hazelnut ops <app> [status|pause-relay|resume-relay|cap|uncap] … [--execute]` (05-runtime.md §ops-levers)
  // — the operator levers that need no deploy, because each is a row every replica reads on the cycle that
  // needs it. PLAN-FIRST like the other datastore-writing verbs: without `--execute` this reads and prints.
  if (cmd === "ops") {
    const usage =
      `usage: hazelnut ops <app> [${OPS_ACTION_LIST}] [--reason <text>] [--execute]  (without --execute: prints the plan, changes nothing)`;
    if (!modPath) {
      console.error(usage);
      Deno.exit(2);
    }
    const spec = moduleSpec(modPath);
    const mod = await importAppModule(spec) as { app?: App; default?: App };
    if (!(mod.app ?? mod.default)) {
      console.error(`module '${modPath}' does not export 'app'`);
      Deno.exit(2);
    }
    const parsed = parseOpsAction(rest);
    if ("error" in parsed) {
      console.error(`${parsed.error}\n${usage}`);
      Deno.exit(2);
    }
    const url = Deno.env.get("DATABASE_URL");
    if (!url) {
      console.error("ops: DATABASE_URL is not set");
      Deno.exit(2);
    }
    const postgres = (await import("postgres")).default;
    const sql = postgres(url, { onnotice: () => {} });
    const db = postgresDb(sql);
    let code: 0 | 1 | 2;
    try {
      const r = executeRequested(rest)
        ? await cliOps(db, parsed.action)
        : await cliOpsPlan(db, parsed.action);
      console.log(r.stdout);
      code = r.code;
    } finally {
      await sql.end();
    }
    Deno.exit(code);
  }

  // `hazelnut redrive <app> [--topic <t>] [--limit <n>] [--execute]` — DLQ recovery: moves dead-lettered
  // corpses `_outbox_dead → _outbox` so the standing relay re-drains them; `--limit` chunks a huge DLQ.
  // PLAN-FIRST (`verb-consequence.ts`): without `--execute` this reads and prints, and changes nothing.
  if (cmd === "redrive") {
    if (!modPath) {
      console.error(
        "usage: hazelnut redrive <app> [--topic <t>] [--limit <n>] [--execute]  (without --execute: prints the plan, changes nothing)",
      );
      Deno.exit(2);
    }
    const spec = moduleSpec(modPath);
    const mod = await importAppModule(spec) as { app?: App; default?: App };
    if (!(mod.app ?? mod.default)) {
      console.error(`module '${modPath}' does not export 'app'`);
      Deno.exit(2);
    }
    const url = Deno.env.get("DATABASE_URL");
    if (!url) {
      console.error("redrive: DATABASE_URL is not set");
      Deno.exit(2);
    }
    const topicAt = rest.lastIndexOf("--topic");
    const topic = topicAt !== -1 && rest[topicAt + 1]
      ? rest[topicAt + 1]
      : undefined;
    const limitAt = rest.lastIndexOf("--limit");
    const limit = limitAt !== -1 && rest[limitAt + 1]
      ? Number(rest[limitAt + 1])
      : undefined;
    // guard --limit like relay's --interval — an unparseable/non-positive cap would silently degrade the batch.
    if (
      limitAt !== -1 &&
      (limit === undefined || Number.isNaN(limit) || limit <= 0 ||
        !Number.isInteger(limit))
    ) {
      console.error("redrive: --limit needs a positive integer");
      Deno.exit(2);
    }
    const postgres = (await import("postgres")).default;
    const sql = postgres(url, { onnotice: () => {} });
    // must be a Transactor — redriveDead moves each corpse _outbox_dead → _outbox in one tx (no lost/duplicated corpse).
    const db = postgresDb(sql);
    const scoped = {
      ...(topic !== undefined ? { topic } : {}),
      ...(limit !== undefined ? { limit } : {}),
    };
    let code: 0 | 1 | 2;
    try {
      const r = executeRequested(rest)
        ? await cliRedrive(db, scoped)
        : await cliRedrivePlan(db, scoped);
      console.log(r.stdout);
      code = r.code;
    } finally {
      await sql.end();
    }
    Deno.exit(code);
  }

  // `hazelnut rotate-key` (04-features.md §encrypted "Key lifecycle") — re-wraps every row's DEK off the old
  // key version, never the ciphertext. Keys are named by env-var name only — a raw key never enters argv.
  if (cmd === "rotate-key") {
    const usage =
      "usage: hazelnut rotate-key <app> --from <old-version> [--to <new-version>] --new-key-env <VAR> --old-key-env <VAR> [--execute]  (VAR names the env var holding the base64-32 master key — the key itself never enters argv; without --execute: prints the plan, re-wraps nothing)";
    if (!modPath) {
      console.error(usage);
      Deno.exit(2);
    }
    const spec = moduleSpec(modPath);
    const mod = await importAppModule(spec) as { app?: App; default?: App };
    const app = mod.app ?? mod.default;
    if (!app) {
      console.error(`module '${modPath}' does not export 'app'`);
      Deno.exit(2);
    }
    // `--from <old>` is required (rows are sealed under it today — `"app"` for the single-key floor default);
    // `--to <new>` labels the new version (default `"v2"`). The value follows the flag (space form).
    const flagAfter = (flag: string): string | undefined => {
      const v = flagValue(rest, flag);
      return v.present && "value" in v ? v.value : undefined;
    };
    const from = flagAfter("--from");
    const to = flagAfter("--to") ?? "v2";
    if (!from) {
      console.error(usage);
      Deno.exit(2);
    }
    if (from === to) {
      console.error(
        `rotate-key: --from and --to are both '${from}' — nothing to rotate to (name the NEW version differently)`,
      );
      Deno.exit(2);
    }
    // `--new-key-env`/`--old-key-env` name the env vars holding the keys — the CLI reads the values itself,
    // so a raw key never enters argv. A missing/garbled key throws (loud refuse), never a silent skip.
    const newVar = flagAfter("--new-key-env");
    const oldVar = flagAfter("--old-key-env");
    if (!newVar) {
      console.error(
        "rotate-key: --new-key-env <VAR> (name of the env var holding the NEW/current base64-32 master key) is required, e.g. --new-key-env ENCRYPTION_KEY",
      );
      Deno.exit(2);
    }
    if (!oldVar) {
      console.error(
        "rotate-key: --old-key-env <VAR> (name of the env var holding the OLD base64-32 master key) is required, e.g. --old-key-env ENCRYPTION_KEY_PREVIOUS",
      );
      Deno.exit(2);
    }
    const newB64 = Deno.env.get(newVar);
    const oldB64 = Deno.env.get(oldVar);
    if (!newB64) {
      console.error(
        `rotate-key: env var ${newVar} (named by --new-key-env) is not set or empty`,
      );
      Deno.exit(2);
    }
    if (!oldB64) {
      console.error(
        `rotate-key: env var ${oldVar} (named by --old-key-env) is not set or empty`,
      );
      Deno.exit(2);
    }
    let kms: RotatingAppKeyKms;
    try {
      kms = new RotatingAppKeyKms({
        [from]: decodeMasterKey(oldB64),
        [to]: decodeMasterKey(newB64),
      }, to);
    } catch (e) {
      console.error(
        `rotate-key: ${explainError(e)}`,
      );
      Deno.exit(2);
    }
    const url = Deno.env.get("DATABASE_URL");
    if (!url) {
      console.error("rotate-key: DATABASE_URL is not set");
      Deno.exit(2);
    }
    const postgres = (await import("postgres")).default;
    const sql = postgres(url, { onnotice: () => {} });
    // the canonical postgres.js adapter (adds `.transaction`); rotate-key never calls it (its re-wrap is
    // per-row auto-commit), so this only standardizes the boot db — the `.query`/`.exec` shape is unchanged.
    const db = postgresDb(sql);
    let code: 0 | 1 | 2;
    try {
      const r = executeRequested(rest)
        ? await cliRotateKey(db, app, { kms, from })
        : await cliRotateKeyPlan(db, app, { from });
      console.log(r.stdout);
      code = r.code;
    } finally {
      await sql.end();
    }
    Deno.exit(code);
  }

  // `hazelnut verify-integrity <app>` — walks every `tamperEvident` resource's hash-chain via
  // `verifyHashChain`. Exit 1 on a detected row rewrite (a CI/operator gate notices), 0 clean.
  if (cmd === "verify-integrity") {
    if (!modPath) {
      console.error(
        "usage: hazelnut verify-integrity <app>  (uses DATABASE_URL)",
      );
      Deno.exit(2);
    }
    const spec = moduleSpec(modPath);
    const mod = await importAppModule(spec) as { app?: App; default?: App };
    const app = mod.app ?? mod.default;
    if (!app) {
      console.error(`module '${modPath}' does not export 'app'`);
      Deno.exit(2);
    }
    const url = Deno.env.get("DATABASE_URL");
    if (!url) {
      console.error("verify-integrity: DATABASE_URL is not set");
      Deno.exit(2);
    }
    const postgres = (await import("postgres")).default;
    const sql = postgres(url, { onnotice: () => {} });
    // the canonical postgres.js adapter; verify-integrity only reads the hash-chain (no tx needed).
    const db = postgresDb(sql);
    let code: 0 | 1 | 2;
    try {
      // By KEY, never by specifier. A literal dynamic import is what Deno statically analyses, so gating
      // the CALL on the build never kept the module out of the core graph (`module-slot.ts`). The core CLI
      // refuses this verb at the gate, so the slot is empty there.
      const cliVerifyIntegrity = moduleSlot<
        (db: Db, app: App) => Promise<{ code: 0 | 1 | 2; stdout: string }>
      >("cmd.integrity");
      if (!cliVerifyIntegrity) {
        throw new Error("verify-integrity: this build does not serve it");
      }
      const r = await cliVerifyIntegrity(db, app);
      console.log(r.stdout);
      code = r.code;
    } finally {
      await sql.end();
    }
    Deno.exit(code);
  }

  // `hazelnut run-workflow <name> <app>` — runs `app.workflows` by name through `runWorkflow` (journaled
  // steps in `_workflow_journal`); re-running the same name resumes. Exit 0 ran / 2 unknown-name|throw.
  if (cmd === "run-workflow") {
    const name = modPath;
    const appArg = rest[0];
    if (!name || !appArg) {
      console.error(
        "usage: hazelnut run-workflow <name> <app> [--execute]  (uses DATABASE_URL; without --execute: prints the plan, runs nothing)",
      );
      Deno.exit(2);
    }
    const spec = moduleSpec(appArg);
    const mod = await importAppModule(spec) as { app?: App; default?: App };
    const app = mod.app ?? mod.default;
    if (!app) {
      console.error(`module '${appArg}' does not export 'app'`);
      Deno.exit(2);
    }
    const url = Deno.env.get("DATABASE_URL");
    if (!url) {
      console.error("run-workflow: DATABASE_URL is not set");
      Deno.exit(2);
    }
    const postgres = (await import("postgres")).default;
    const sql = postgres(url, { onnotice: () => {} });
    // the canonical postgres.js adapter; the workflow journal manages its own step boundaries, so this
    // standardizes the boot db (the `.query`/`.exec` shape is unchanged) and a Transactor is available if needed.
    const db = postgresDb(sql);
    let code: 0 | 1 | 2;
    try {
      const r = executeRequested(rest)
        ? await cliRunWorkflow(db, app, name)
        : await cliRunWorkflowPlan(db, app, name);
      console.log(r.stdout);
      code = r.code;
    } finally {
      await sql.end();
    }
    Deno.exit(code);
  }

  // `hazelnut unstick-workflow <app> --workflow <id> --step <stepId> [--execute]` — force-reclaim a stuck
  // `_workflow_journal` step claim before its crash-reclaim lease naturally expires. PLAN-FIRST: without
  // `--execute` this reads and warns, and changes nothing.
  if (cmd === "unstick-workflow") {
    const usage =
      "usage: hazelnut unstick-workflow <app> --workflow <id> --step <stepId> [--execute]  (uses DATABASE_URL; without --execute: prints the plan, changes nothing)";
    if (!modPath) {
      console.error(usage);
      Deno.exit(2);
    }
    const workflowAt = rest.lastIndexOf("--workflow");
    const workflowId = workflowAt !== -1 ? rest[workflowAt + 1] : undefined;
    const stepAt = rest.lastIndexOf("--step");
    const stepId = stepAt !== -1 ? rest[stepAt + 1] : undefined;
    if (!workflowId || !stepId) {
      console.error(
        `unstick-workflow: needs --workflow <id> and --step <stepId>\n${usage}`,
      );
      Deno.exit(2);
    }
    const spec = moduleSpec(modPath);
    const mod = await importAppModule(spec) as { app?: App; default?: App };
    const app = mod.app ?? mod.default;
    if (!app) {
      console.error(`module '${modPath}' does not export 'app'`);
      Deno.exit(2);
    }
    const url = Deno.env.get("DATABASE_URL");
    if (!url) {
      console.error("unstick-workflow: DATABASE_URL is not set");
      Deno.exit(2);
    }
    const postgres = (await import("postgres")).default;
    const sql = postgres(url, { onnotice: () => {} });
    const db = postgresDb(sql);
    let code: 0 | 1 | 2;
    try {
      const r = executeRequested(rest)
        ? await cliUnstickWorkflow(db, { workflowId, stepId })
        : await cliUnstickWorkflowPlan(db, app, { workflowId, stepId });
      console.log(r.stdout);
      code = r.code;
    } finally {
      await sql.end();
    }
    Deno.exit(code);
  }

  // `hazelnut eval <app> [<name>]` (09-verifier.md §eval) — runs each declared eval through `runEval`
  // with the app's own client and optional judge, both resolved inside the runner; offline, no DB.
  if (cmd === "eval") {
    if (!modPath) {
      console.error("usage: hazelnut eval <app> [<name>]");
      Deno.exit(2);
    }
    const spec = moduleSpec(modPath);
    const mod = await importAppModule(spec) as { app?: App; default?: App };
    const app = mod.app ?? mod.default;
    if (!app) {
      console.error(`module '${modPath}' does not export 'app'`);
      Deno.exit(2);
    }
    // LAZY, and the shape is DECLARED: `eval` is a verify-module verb (the core CLI refuses it at the gate
    // before reaching here), so the runner must not be a STATIC edge from this core dispatcher — that is
    // exactly how the eval runner reached the public core artifact. The client + judge resolve INSIDE
    // `cliEval`, because naming either here would put the module's types back on the core path.
    const cliEval = moduleSlot<
      (app: App, name: string | undefined) => Promise<
        { code: number; stdout: string }
      >
    >("cmd.eval");
    if (!cliEval) throw new Error("eval: this build does not serve it");
    const r = await cliEval(app, rest[0]);
    console.log(r.stdout);
    Deno.exit(r.code);
  }

  // `hazelnut new <name> [--example] [--no-git]` — scaffold a starter app directory
}
