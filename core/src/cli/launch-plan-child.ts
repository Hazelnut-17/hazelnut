/** Restricted child used only by `hazelnut launch` to compose the pure model before deriving serve grants. */
import { derivePermissions } from "./permissions.ts";
import { readAppGraph } from "./launch.ts";
import { CliRefusal, importAppModule } from "./hazelnut-io.ts";
import type { App } from "../core/app-define.ts";

const [appSpecifier, entry, envKeysJson, marker] = Deno.args;
const encoder = new TextEncoder();

async function report(value: unknown): Promise<void> {
  await Deno.stdout.write(
    encoder.encode(`${marker}${JSON.stringify(value)}\n`),
  );
}

try {
  if (
    appSpecifier === undefined || entry === undefined ||
    envKeysJson === undefined || marker === undefined
  ) {
    throw new Error("planner arguments are incomplete");
  }
  const envKeys: unknown = JSON.parse(envKeysJson);
  if (
    !Array.isArray(envKeys) || !envKeys.every((key) => typeof key === "string")
  ) {
    throw new Error("planner environment roster is invalid");
  }
  const env = Object.fromEntries(
    envKeys.map((key: string) => [key, Deno.env.get(key)]),
  );
  const mod = await importAppModule(appSpecifier);
  const app = mod.app ?? mod.default;
  if (!app || typeof app !== "object") {
    throw new Error("the model entry does not export app");
  }
  const entrySources = await readAppGraph(".", entry);
  const plan = derivePermissions({
    app: app as App,
    env,
    entrySources,
    entry,
    ...(env.FILES_DIR !== undefined ? { filesDir: env.FILES_DIR } : {}),
  });
  await report({ ok: true, plan });
} catch (error) {
  const reason = error instanceof CliRefusal
    ? error.message
    : error instanceof Deno.errors.NotCapable
    ? `the model entry attempted an undeclared planner capability: ${error.message}`
    : "the app model could not be composed in a process without run, net, or write permission";
  await report({ ok: false, reason });
  Deno.exitCode = 1;
}
