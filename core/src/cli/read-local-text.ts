/** Read optional CLI input. Only an absent directory entry counts as missing. */
export async function readOptionalRegularText(
  path: string,
): Promise<string | undefined> {
  let entry: Deno.FileInfo;
  try {
    entry = await Deno.lstat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
  const info = entry.isSymlink ? await Deno.stat(path) : entry;
  if (!info.isFile) throw new Error("expected a regular file");
  return await Deno.readTextFile(path);
}
