import type { Features } from "./faces.ts";
import type { RefSpec } from "./app-refs.ts";
import { normalizeColumnGate } from "../data/schema-normalize.ts";

/** Whether declared reference semantics require a repo sweep instead of a DB action. */
export function refNeedsDdlSweep(
  parent: Features,
  child: Features,
  action: RefSpec["onDelete"],
  label = "resource timestamps",
): boolean {
  if (action !== "cascade" && action !== "set-null") return false;
  const updated =
    normalizeColumnGate(child.timestamps, label)?.updated === true;
  const detachMovesStamp = action === "set-null" &&
    (!!child.versioning || updated);
  return !!parent.softDelete || !!child.softDelete || !!child.audit ||
    detachMovesStamp;
}
