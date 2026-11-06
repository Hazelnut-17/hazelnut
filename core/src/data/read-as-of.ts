import type { ResourceModel } from "../core/app.ts";
import { wireOffsetInstant } from "./schema-types.ts";

/** Wire instants are explicit ISO timestamps with an offset; never a driver's permissive date guess. */
export function readAsOf(
  model: ResourceModel,
  raw: unknown,
): string | undefined {
  if (raw === undefined) return undefined;
  if (
    !model.features.temporal ||
    !wireOffsetInstant.safeParse(raw).success
  ) {
    throw Object.assign(
      new Error("read/asOf: expected an ISO timestamp on a temporal resource"),
      { kind: "validation" },
    );
  }
  return raw as string;
}
