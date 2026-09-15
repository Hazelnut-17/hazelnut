/**
 * `hazelnut install` — put the framework tree back into an app that does not carry one.
 *
 * A vendored app pins the framework at `.hazelnut/modules/`, and that directory is git-ignored: it is
 * framework source, not the app's. So the tree travels with a directory copy, an archive or a container
 * image, and a `git clone` arrives without it. This verb is the door back — the same copy `new --vendor`
 * performs, run against an app that already exists.
 *
 * It fetches NOTHING. `--from` names a framework checkout already on the machine; there is no default, no
 * registry lookup and no network path, so running it can never reach out on the consumer's behalf.
 */
import { atomicWrite, CliRefusal, vendorFrameworkTree } from "./hazelnut-io.ts";
import { isModuleSpecifier, sourceTreeImportMap } from "./scaffold.ts";
import { stripJsoncComments } from "../core/framework-literals.ts";

const VENDOR_PIN = "./.hazelnut/modules";

/** Read `--from <path>` out of the argv tail. */
function fromFlag(rest: readonly string[]): string | undefined {
  const at = rest.lastIndexOf("--from");
  if (at === -1) return undefined;
  const v = rest[at + 1];
  return v === undefined || v.startsWith("--") ? undefined : v;
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await Deno.stat(p)).isDirectory;
  } catch {
    return false;
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await Deno.stat(p)).isFile;
  } catch {
    return false;
  }
}

type DenoJson = {
  imports?: Record<string, string>;
  lint?: { plugins?: string[] };
  tasks?: Record<string, string>;
  [k: string]: unknown;
};

function isAlreadyVendorPin(hazel: string): boolean {
  return hazel === VENDOR_PIN || hazel === `${VENDOR_PIN}/mod-core.ts` ||
    hazel.startsWith(`${VENDOR_PIN}/`);
}

function sourcePinBase(hazel: string): string {
  return hazel.replace(/\/mod-core\.ts$/, "").replace(/\/mod\.ts$/, "");
}

/** Rewrite a `--local` / host-path pin to the vendored tree `install --from` just copied.
 *  A registry pin is already portable — the copy is an overlay, the specifier stays. */
export function rewritePinsToVendor(denoJsonText: string): {
  text: string;
  changed: boolean;
  reason: "already-vendor" | "registry" | "no-pin" | "rewritten";
} {
  let cfg: DenoJson;
  try {
    cfg = JSON.parse(stripJsoncComments(denoJsonText)) as DenoJson;
  } catch {
    return { text: denoJsonText, changed: false, reason: "no-pin" };
  }
  const old = cfg.imports?.["hazelnut"];
  if (old === undefined) {
    return { text: denoJsonText, changed: false, reason: "no-pin" };
  }
  if (isAlreadyVendorPin(old)) {
    return { text: denoJsonText, changed: false, reason: "already-vendor" };
  }
  if (isModuleSpecifier(old)) {
    return { text: denoJsonText, changed: false, reason: "registry" };
  }
  const oldBase = sourcePinBase(old);
  const kept = Object.fromEntries(
    Object.entries(cfg.imports ?? {}).filter(([k]) =>
      k !== "hazelnut" && !k.startsWith("hazelnut/") &&
      k !== "@hazelnut/core" && !k.startsWith("@hazelnut/core/")
    ),
  );
  cfg.imports = { ...sourceTreeImportMap(VENDOR_PIN), ...kept };
  const rewrite = (s: string) => s.split(oldBase).join(VENDOR_PIN);
  if (cfg.lint?.plugins) {
    cfg.lint.plugins = cfg.lint.plugins.map(rewrite);
  }
  if (cfg.tasks) {
    for (const [k, v] of Object.entries(cfg.tasks)) {
      cfg.tasks[k] = rewrite(v);
    }
  }
  return {
    text: `${JSON.stringify(cfg, null, 2)}\n`,
    changed: true,
    reason: "rewritten",
  };
}

/** Rewrite a Dockerfile's checkout pin independently of the config rewrite, so a retry can repair either
 * file after the other one was already published. Without the old config pin, the recovery scan recognizes
 * only an absolute or `file://` framework CLI path; it never guesses at a remote or relative specifier. */
export function rewriteDockerfilePinToVendor(
  dockerfile: string,
  oldBase?: string,
  recoverAlreadyVendored = false,
): { text: string; changed: boolean } {
  const bases = oldBase !== undefined ? [oldBase] : recoverAlreadyVendored
    ? [
      ...dockerfile.matchAll(
        /(?:file:\/\/|(?:^|[\s"'=])\/)[^\s"'\\]+\/src(?=\/cli\/hazelnut\.ts(?:["'\\s]|$))/gm,
      ),
    ].map((m) => {
      const matched = m[0]!;
      // The absolute-path alternative preserves its one preceding delimiter so it cannot match a URL
      // (`https://…`) or a relative path (`../…`). Keep that delimiter in the Dockerfile when replacing.
      return matched.startsWith("file://") || matched.startsWith("/")
        ? matched
        : matched.slice(1);
    })
    : [];
  let text = dockerfile;
  for (const base of bases) text = text.split(base).join(VENDOR_PIN);
  return { text, changed: text !== dockerfile };
}

export async function dispatchInstall(
  cmd: string,
  modPath: string,
  rest: string[],
): Promise<void> {
  if (cmd === "install") await runInstall(modPath, rest);
}

async function runInstall(modPath: string, rest: string[]): Promise<void> {
  const argv = modPath === undefined ? rest : [modPath, ...rest];
  const from = fromFlag(argv);
  if (from === undefined) {
    console.error(
      "usage: hazelnut install --from <framework-checkout>\n\n" +
        "  Copies that checkout's `src/` into ./.hazelnut/modules/ (omits `tests/` directories) — the tree a vendored app runs from.\n" +
        "  A host-path / `file://` pin is rewritten to that path so a container build can resolve it.\n" +
        "  Nothing is fetched: `--from` names a directory already on this machine.",
    );
    Deno.exit(2);
  }

  // The app root is the CWD, and it must actually be one: writing a framework tree into an arbitrary
  // directory would leave a `.hazelnut/` nobody asked for, in a place nothing reads it from.
  const configName = await isFile("deno.json")
    ? "deno.json"
    : await isFile("deno.jsonc")
    ? "deno.jsonc"
    : undefined;
  if (configName === undefined) {
    throw new CliRefusal(
      "install: no deno.json or deno.jsonc here — run it from the app root, the directory holding the app's Deno config.",
    );
  }
  if (!(await isDir(from))) {
    throw new CliRefusal(
      `install: --from '${from}' is not a directory.`,
    );
  }
  // `mod-core.ts` is in EVERY framework tree — the public core artifact deliberately ships no `mod.ts`, so
  // testing for that one would refuse a perfectly good core checkout.
  if (!(await isFile(`${from}/src/mod-core.ts`))) {
    throw new CliRefusal(
      `install: --from '${from}' is not a framework checkout — expected ${from}/src/mod-core.ts.\n` +
        "  Point it at the framework repository root, not at its src/ directory.",
    );
  }

  const copied = await vendorFrameworkTree(from, ".");
  const before = await Deno.readTextFile(configName);
  const pins = rewritePinsToVendor(before);
  if (pins.changed) {
    await atomicWrite(configName, pins.text);
  }
  if (await isFile("Dockerfile")) {
    let oldHazel: string | undefined;
    try {
      oldHazel = (JSON.parse(stripJsoncComments(before)) as DenoJson).imports
        ?.["hazelnut"];
    } catch {
      /* the config rewrite already returned no-pin for malformed input */
    }
    if (
      oldHazel === undefined || isAlreadyVendorPin(oldHazel) ||
      isModuleSpecifier(oldHazel)
    ) {
      oldHazel = undefined;
    }
    const docker = await Deno.readTextFile("Dockerfile");
    const rewrittenDocker = rewriteDockerfilePinToVendor(
      docker,
      oldHazel === undefined ? undefined : sourcePinBase(oldHazel),
      pins.reason === "already-vendor",
    );
    if (rewrittenDocker.changed) {
      await atomicWrite("Dockerfile", rewrittenDocker.text);
    }
  }
  const pinNote = pins.reason === "rewritten"
    ? "  Pins now name ./.hazelnut/modules — the same shape `new --vendor` writes."
    : pins.reason === "already-vendor"
    ? "  The app's existing pins already name that path — nothing else changed."
    : pins.reason === "registry"
    ? "  The app's registry pin is already portable; the copy is an overlay, the specifier stayed."
    : "  No `imports.hazelnut` pin to rewrite.";
  console.log(
    `✓ install: copied ${copied} framework files into ./.hazelnut/modules/\n` +
      pinNote,
  );
  Deno.exit(0);
}
