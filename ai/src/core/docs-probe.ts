// Does the framework canon (`docs/`) exist beside this running CLI? A checkout has it; a vendored copy
// and a compiled `--pin` binary ship `src/` only, so a `<doc>.md §<section>` pointer would be a dead end.
import { fileURLToPath } from "node:url";

let cached: boolean | undefined;

/** True when the canon tree is on disk beside the running framework source — the human render gates its
 *  `docs:`/`see:` pointer lines on this; the `hazelnut explain` semantics catalog is the docs-free path. */
export function docsOnDisk(): boolean {
  if (cached !== undefined) return cached;
  try {
 const probe = new URL("../../", import.meta.url);
    cached = probe.protocol === "file:" &&
      Deno.statSync(fileURLToPath(probe)).isFile;
  } catch {
    cached = false; // no fs permission / embedded VFS / missing tree — all read as "no docs on disk"
  }
  return cached;
}
