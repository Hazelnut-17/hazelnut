/** Whether a named `--allow-run=deno` grant can resolve on this host, and the one sentence every door
 * that spawns a child says when it cannot.
 */

/** True iff the directory of `execPath` is an entry of `pathEnv` — the condition named
 *  `--allow-run=deno` grants resolve under. */
export function denoDirOnPath(
  pathEnv: string,
  execPath = Deno.execPath(),
  os: typeof Deno.build.os = Deno.build.os,
): boolean {
  const norm = (p: string) =>
    (os === "windows" ? p.toLowerCase() : p).replaceAll("\\", "/")
      .replace(/\/+$/, "");
  const dir = norm(execPath.replace(/[\\/][^\\/]*$/, ""));
  const sep = os === "windows" ? ";" : ":";
  return pathEnv.split(sep).some((e) => norm(e) === dir && dir !== "");
}

/** True when the current shell's PATH drops the running deno's directory — the condition a named
 *  `--allow-run=deno` grant cannot resolve under. Test `ignore:` expressions read
 *  this instead of touching PATH themselves, so the env-gate detector does not read them as a suite
 *  gate on PATH. */
export function launchBlockedByPath(): boolean {
  return !denoDirOnPath(Deno.env.get("PATH") ?? "");
}

/** The sentence INIT, `launch` and the migrate spawn share when a named `--allow-run=deno` grant cannot
 *  resolve. Deno's own `NotCapable` says to pass `--allow-run`, which a caller that ALREADY passed
 *  `--allow-run=deno` cannot act on — the grant is present and it is the name that will not resolve. */
export function namedRunGrantBlockedMessage(): string {
  return (
    "the running deno's directory is not on PATH — a named `--allow-run=deno` grant cannot resolve " +
    "(an MSYS shell's converted PATH drops it), so the child spawn is refused.\n\n" +
    "  Run from a shell whose PATH carries the deno directory (native PowerShell/cmd), export PATH " +
    "to include it, or pass a bare `--allow-run` (no name list). `hazelnut doctor` reports this as env/path-shape."
  );
}

/** Re-throws anything that is not the named-grant PATH failure; otherwise throws the actionable sentence
 *  in place of Deno's generic remedy. `door` names the spawn that failed, the way each CLI door prefixes
 *  its own refusals. */
export function rethrowAsNamedRunGrantFailure(e: unknown, door: string): never {
  if (e instanceof Deno.errors.NotCapable && launchBlockedByPath()) {
    throw new Error(`${door}: ${namedRunGrantBlockedMessage()}`);
  }
  throw e;
}
