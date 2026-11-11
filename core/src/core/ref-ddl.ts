import type { Features } from "./faces.ts";
import type { RefSpec } from "./app-refs.ts";
import {
  deletedAtLivenessOn,
  normalizeColumnGate,
} from "../data/schema-normalize.ts";

/** The action emitted for the generated tree self-FK. */
export function treeDdlDeleteAction(
  features: Features,
): "cascade" | "set-null" | "restrict" {
  const tree = features.tree;
  if (deletedAtLivenessOn(features) || features.audit) return "restrict";
  return typeof tree === "object"
    ? tree.onParentDelete ?? "restrict"
    : "restrict";
}

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
