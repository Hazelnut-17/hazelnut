import { z } from "zod";
import type { ResourceModel } from "../core/app.ts";

/** Wire instants are explicit ISO timestamps with an offset; never a driver's permissive date guess. */
export function readAsOf(
  model: ResourceModel,
  raw: unknown,
): string | undefined {
  if (raw === undefined) return undefined;
  if (
    !model.features.temporal ||
    !z.iso.datetime({ offset: true }).safeParse(raw).success
  ) {
    throw Object.assign(
      new Error("read/asOf: expected an ISO timestamp on a temporal resource"),
      { kind: "validation" },
    );
  }
  return raw as string;
}
