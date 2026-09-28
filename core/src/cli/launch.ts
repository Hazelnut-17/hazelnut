// `hazelnut launch <app>` — start a served app under the DERIVED least-privilege permission set
// (cli/launch.md). The verb exists because a prod serve command is otherwise hand-maintained: an author
// writes `-A` once and it never narrows again, so the deployed process holds every capability Deno can
// grant no matter what the app actually declares.
//
// Deriving at LAUNCH time (not baking flags at scaffold time) is the whole design: a flag string emitted
// into `deno.json` on day 1 goes stale the moment someone adds a webhook, and a stale allowlist is worse
// than none — it fails in production, so the first fix is always to widen it back to `-A`.
import type { CliResult } from "./cli.ts";
import { launchBlockedByPath, namedRunGrantBlockedMessage } from "./doctor.ts";
import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type PermissionPlan,
  renderLaunchCommand,
  renderPermissionFlags,
  renderPermissionPlan,
  scanEnvKeys,
  scanRelativeImports,
} from "./permissions.ts";

/** The app entry the launcher runs and walks: `main.ts` is the served boot (05-runtime.md §createApp).
 *  Everything the served process can reach — and therefore every env key it can read — is reachable from
 *  here, so the entry is the only root the scan needs. */
export const LAUNCH_ENTRY = "main.ts";

export interface LaunchOptions {
  /** Show every grant with the declaration that forced it. Absent ⇒ render the bare command (`--print`). */
  readonly explain?: boolean;
}

/** Resolves a relative specifier against the importing file, in the app-root-relative forward-slash form
 *  the walk keys on. Returns null when the path escapes the app root — the read grant is `--allow-read=.`,
 *  so a module outside the tree is not readable by the served process either; the scan's reach and the
 *  read grant's reach are deliberately the same boundary. */
function resolveRelative(fromFile: string, spec: string): string | null {
  const at = fromFile.lastIndexOf("/");
  const base = at === -1 ? [] : fromFile.slice(0, at).split("/");
  const out = [...base];
  for (const part of spec.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null; // escaped the app root
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}

/** Walks the served entry's module graph and returns every reachable APP file, keyed by its root-relative
 *  path. This is what the env scan runs over.
 *
 *  A fixed list of entry filenames was the earlier shape and it was wrong in the one way that matters: a
 *  `Deno.env.get` in a `*.module.ts` is as real to the running process as one in `main.ts`, but the list
 *  could not see it, so the derived set looked complete (exit 0, no refusal) and the app died at boot with
 *  `NotCapable`. The graph cannot have that blind spot — its boundary is the app tree itself. */
export async function readAppGraph(
  root: string,
  entry: string = LAUNCH_ENTRY,
  readFile: (path: string) => Promise<string> = (p) => Deno.readTextFile(p),
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const queue = [entry];
  const seen = new Set<string>(queue);
  while (queue.length > 0) {
    const path = queue.shift()!;
    let source: string;
    try {
      source = await readFile(`${root}/${path}`);
    } catch {
      // An unreadable import is the app's own build error — `deno run` will report it far better than the
      // launcher could. Skipping keeps the launcher's job to permissions.
      continue;
    }
    out[path] = source;
    for (const spec of scanRelativeImports(source)) {
      const next = resolveRelative(path, spec);
      if (next !== null && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return out;
}

const LAUNCH_PLANNER_MARKER = "HAZELNUT_LAUNCH_PLAN:";
const PLANNER_ENV_KEYS = [
  "APP_URL",
  "DATABASE_URL",
  "FILES_DIR",
  "HAZELNUT_DEV",
  "HAZELNUT_MCP_TOKEN",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "PORT",
] as const;

function plannerFailurePlan(
  scanned: readonly string[],
  reason: string,
): PermissionPlan {
  return {
    grants: [],
    refusals: [{
      what: reason,
      fix:
        "keep the model entry's module initialization pure: move file writes, network calls, and subprocess work to the served runtime entry; `launch` plans in a process without run, net, or write permission",
    }],
    unstableCron: true,
    scanned,
  };
}

function validPermissionPlan(value: unknown): value is PermissionPlan {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  if (
    typeof p.unstableCron !== "boolean" || !Array.isArray(p.grants) ||
    !Array.isArray(p.refusals) || !Array.isArray(p.scanned)
  ) return false;
  return p.grants.every((g) => typeof g === "object" && g !== null) &&
    p.refusals.every((r) => typeof r === "object" && r !== null) &&
    p.scanned.every((s) => typeof s === "string");
}

/** Read the app declarations in a disposable, capability-restricted process. The launcher itself must retain
 *  `--allow-run=deno` to start the eventual server, so importing app.ts in this process would let its
 *  top-level code inherit that power before a permission plan exists. The planner child gets only app-tree
 *  read and statically named env keys; it has no run, write, or network permission. */
export async function planLaunchRestricted(
  appSpecifier: string,
  entry: string,
  parentEnv: Readonly<Record<string, string | undefined>>,
): Promise<PermissionPlan> {
  const entrySources = await readAppGraph(".", entry);
  const cwd = await Deno.realPath(".");
  let appPath: string;
  try {
    appPath = fileURLToPath(appSpecifier);
  } catch {
    return plannerFailurePlan(
      Object.keys(entrySources),
      "the app model must be a local file inside the launch root",
    );
  }
  const appRelative = relative(cwd, appPath).replaceAll("\\", "/");
  if (
    appRelative === ".." || appRelative.startsWith("../") ||
    appRelative.startsWith("/")
  ) {
    return plannerFailurePlan(
      Object.keys(entrySources),
      "the app model resolves outside the launch root",
    );
  }
  const appSources = await readAppGraph(".", appRelative);
  const scanKeys = [
    ...Object.values(appSources).flatMap(scanEnvKeys),
    ...Object.values(entrySources).flatMap(scanEnvKeys),
  ];
  const envKeys = [...new Set([...PLANNER_ENV_KEYS, ...scanKeys])].sort();
  const env: Record<string, string> = {};
  for (const key of envKeys) {
    const value = parentEnv[key];
    if (value !== undefined) env[key] = value;
  }
  // Preserve the configured cache location for Deno's module loader, but do not grant the app code env
  // access to it. This is runtime configuration, not an app credential.
  if (parentEnv.DENO_DIR !== undefined) env.DENO_DIR = parentEnv.DENO_DIR;

  const plannerUrl = new URL("./launch-plan-child.ts", import.meta.url);
  const readRoots = ["."];
  if (plannerUrl.protocol === "file:") {
    const cliDir = dirname(fileURLToPath(plannerUrl));
    readRoots.push(cliDir, dirname(cliDir));
  }
  const marker = `${LAUNCH_PLANNER_MARKER}${crypto.randomUUID()}:`;
  const config = await Deno.stat("deno.json").then(() => "deno.json")
    .catch(() =>
      Deno.stat("deno.jsonc").then(() => "deno.jsonc").catch(() => undefined)
    );
  const args = [
    "run",
    "--no-prompt",
    ...(config !== undefined ? ["--config", config] : []),
    `--allow-read=${readRoots.join(",")}`,
    ...(envKeys.length > 0 ? [`--allow-env=${envKeys.join(",")}`] : []),
    plannerUrl.href,
    appSpecifier,
    entry,
    JSON.stringify(envKeys),
    marker,
  ];
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(Deno.execPath(), {
      args,
      clearEnv: true,
      env,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch (error) {
    const reason = error instanceof Deno.errors.NotCapable &&
        launchBlockedByPath()
      ? namedRunGrantBlockedMessage()
      : "the restricted app planner could not start";
    return plannerFailurePlan(Object.keys(entrySources), reason);
  }

  const capture = async (
    stream: ReadableStream<Uint8Array>,
    limit: number,
  ): Promise<{ readonly text: string; readonly overflow: boolean }> => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    let overflow = false;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        if (bytes + item.value.length > limit) {
          overflow = true;
          continue;
        }
        bytes += item.value.length;
        text += decoder.decode(item.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
    return { text, overflow };
  };
  const stdout = capture(child.stdout, 256 * 1024);
  const stderr = capture(child.stderr, 64 * 1024);
  let timedOut = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGTERM");
    } catch { /* already exited */ }
    forceKillTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch { /* already exited */ }
    }, 1_000);
  }, 30_000);
  let status: Deno.CommandStatus;
  try {
    status = await child.status;
  } finally {
    clearTimeout(timeout);
    if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
  }
  const [out, err] = await Promise.all([stdout, stderr]);
  if (timedOut) {
    return plannerFailurePlan(
      Object.keys(entrySources),
      "the app model did not finish composing inside the restricted planner",
    );
  }
  if (out.overflow || err.overflow) {
    return plannerFailurePlan(
      Object.keys(entrySources),
      "the restricted app planner exceeded its bounded diagnostic output",
    );
  }
  const line = out.text.split(/\r?\n/).find((candidate) =>
    candidate.startsWith(marker)
  );
  if (line === undefined) {
    return plannerFailurePlan(
      Object.keys(entrySources),
      status.code === 0
        ? "the restricted app planner returned no permission plan"
        : "the app model could not be composed in a process without run, net, or write permission",
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(line.slice(marker.length));
  } catch {
    return plannerFailurePlan(
      Object.keys(entrySources),
      "the restricted app planner returned an unreadable permission plan",
    );
  }
  if (
    typeof payload !== "object" || payload === null ||
    !Object.hasOwn(payload, "ok")
  ) {
    return plannerFailurePlan(
      Object.keys(entrySources),
      "the restricted app planner returned an invalid response",
    );
  }
  const result = payload as { ok: unknown; plan?: unknown; reason?: unknown };
  if (result.ok === true && validPermissionPlan(result.plan)) {
    return result.plan;
  }
  return plannerFailurePlan(
    Object.keys(entrySources),
    typeof result.reason === "string"
      ? result.reason
      : "the app model could not be composed in a process without run, net, or write permission",
  );
}

/** Renders the verb's output for the non-exec paths (`--print` / `--explain` / any refusal). */
export function renderLaunch(
  plan: PermissionPlan,
  entry: string,
  opts: LaunchOptions = {},
): CliResult {
  if (plan.refusals.length > 0 || opts.explain === true) {
    const { lines, exit } = renderPermissionPlan(plan, entry);
    return { code: exit === 1 ? 2 : 0, stdout: lines.join("\n") };
  }
  return { code: 0, stdout: renderLaunchCommand(plan, entry).join(" ") };
}

/** The exec path: runs `deno run <derived flags> <entry>` as a child and forwards the child's exit code so
 *  an orchestrator sees the app's own status, not the launcher's.
 *
 *  Signals are FORWARDED, not swallowed. The launcher is PID 1 in a container, and the app's graceful drain
 *  hangs off its own SIGTERM handler (`main.ts`) — a supervisor that ate the signal would turn every rolling
 *  restart into a hard kill mid-drain, which is a worse failure than the blanket `-A` this verb deletes. */
export async function execLaunch(
  plan: PermissionPlan,
  entry: string,
): Promise<number> {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(Deno.execPath(), {
      args: ["run", ...renderPermissionFlags(plan), entry],
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
  } catch (e) {
    // the derived grant names `deno` and nothing else; a spawn of the concrete binary needs the
    // running deno's directory on PATH to resolve that name. When that is exactly what is missing,
    // the raw NotCapable names neither the shell nor the fix — this does. Any other spawn error
    // keeps its original course.
    if (!(e instanceof Deno.errors.NotCapable) || !launchBlockedByPath()) {
      throw e;
    }
    console.error(`hazelnut launch: ${namedRunGrantBlockedMessage()}\n`);
    return 2;
  }
  const signals: Deno.Signal[] = Deno.build.os === "windows"
    ? ["SIGINT"]
    : ["SIGTERM", "SIGINT"];
  const forward = (sig: Deno.Signal) => () => {
    try {
      child.kill(sig);
    } catch {
      // the child already exited — the status await below is the single source of the exit code
    }
  };
  const handlers = signals.map((sig) => [sig, forward(sig)] as const);
  for (const [sig, handler] of handlers) Deno.addSignalListener(sig, handler);
  try {
    const { code } = await child.status;
    return code;
  } finally {
    for (const [sig, handler] of handlers) {
      Deno.removeSignalListener(sig, handler);
    }
  }
}
