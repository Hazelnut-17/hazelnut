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
import { CliRefusal, vendorFrameworkTree } from "./hazelnut-io.ts";

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
        "  Copies that checkout's `src/` into ./.hazelnut/modules/ — the tree a vendored app runs from.\n" +
        "  Nothing is fetched: `--from` names a directory already on this machine.",
    );
    Deno.exit(2);
  }

  // The app root is the CWD, and it must actually be one: writing a framework tree into an arbitrary
  // directory would leave a `.hazelnut/` nobody asked for, in a place nothing reads it from.
  if (!(await isFile("deno.json"))) {
    throw new CliRefusal(
      "install: no deno.json here — run it from the app root, the directory holding the app's deno.json.",
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
  console.log(
    `✓ install: copied ${copied} framework files into ./.hazelnut/modules/\n` +
      "  The app's existing pins already name that path — nothing else changed.",
  );
  Deno.exit(0);
}
