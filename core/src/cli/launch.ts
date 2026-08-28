// `hazelnut launch <app>` — start a served app under the DERIVED least-privilege permission set
// (cli/launch.md). The verb exists because a prod serve command is otherwise hand-maintained: an author
// writes `-A` once and it never narrows again, so the deployed process holds every capability Deno can
// grant no matter what the app actually declares.
//
// Deriving at LAUNCH time (not baking flags at scaffold time) is the whole design: a flag string emitted
// into `deno.json` on day 1 goes stale the moment someone adds a webhook, and a stale allowlist is worse
// than none — it fails in production, so the first fix is always to widen it back to `-A`.
import type { App } from "../core/app-define.ts";
import type { CliResult } from "./cli.ts";
import { launchBlockedByPath, namedRunGrantBlockedMessage } from "./doctor.ts";
import {
  derivePermissions,
  type PermissionPlan,
  renderLaunchCommand,
  renderPermissionFlags,
  renderPermissionPlan,
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

/** Builds the plan for a booted app. Pure over its inputs, so the whole derivation is unit-testable. */
export function planLaunch(
  app: App,
  env: Readonly<Record<string, string | undefined>>,
  entrySources: Readonly<Record<string, string>>,
  entry: string = LAUNCH_ENTRY,
): PermissionPlan {
  return derivePermissions({
    app,
    env,
    entrySources,
    entry,
    ...(env.FILES_DIR !== undefined ? { filesDir: env.FILES_DIR } : {}),
  });
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
