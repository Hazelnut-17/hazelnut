/** One ignored framework scratch namespace; concurrent verify invocations own separate generations. */
import { join, resolve } from "node:path";
import { VERIFY_SCRATCH_DIR } from "../core/app-walk.ts";

const active = new Map<string, Set<Deno.ChildProcess>>();
const installed: Array<[Deno.Signal, () => void]> = [];
function hooks(): void {
  if (installed.length > 0) return;
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    const cleanup = () => {
      for (const [path, children] of active) {
        for (const child of children) {
          try {
            child.kill("SIGKILL");
          } catch { /* child already completed */ }
        }
        try {
          Deno.removeSync(path, { recursive: true });
        } catch { /* crash residue stays outside the source population */ }
      }
      Deno.exit(code);
    };
    try {
      Deno.addSignalListener(signal, cleanup);
      installed.push([signal, cleanup]);
    } catch {
      /* unsupported platform signal; normal/finally cleanup and scratch isolation still hold */
    }
  }
}
export async function createVerifyScratch(
  root: string,
  prefix: string,
): Promise<string> {
  const base = join(await Deno.realPath(resolve(root)), VERIFY_SCRATCH_DIR);
  await Deno.mkdir(base, { recursive: true });
  // Never follow a pre-existing app-selected link outside the granted scratch root.
  if (
    !(await Deno.lstat(base)).isDirectory ||
    (await Deno.realPath(base)) !== base
  ) {
    throw new Error(
      "verify scratch root must be an ordinary app-local directory",
    );
  }
  const generation = await Deno.makeTempDir({ dir: base, prefix });
  active.set(generation, new Set());
  hooks();
  // Deno stops inherited ignore discovery at this repository boundary. The actual app ignore chain
  // remains measured separately; the framework-owned mirror must always expose its copied population.
  try {
    await Deno.mkdir(join(generation, ".git"));
  } catch (error) {
    await removeVerifyScratch(generation).catch(() => {});
    throw error;
  }
  return generation;
}
/** Signal cleanup stops only children belonging to this process's active generation. */
export function trackVerifyChild(
  generation: string,
  child: Deno.ChildProcess,
): () => void {
  const children = active.get(generation);
  children?.add(child);
  return () => {
    children?.delete(child);
  };
}
export async function removeVerifyScratch(generation: string): Promise<void> {
  try {
    await Deno.remove(generation, { recursive: true });
  } finally {
    active.delete(generation);
    if (active.size === 0) {
      for (const [signal, listener] of installed.splice(0)) {
        Deno.removeSignalListener(signal, listener);
      }
    }
  }
}
