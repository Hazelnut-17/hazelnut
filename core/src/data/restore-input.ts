import { z } from "zod";
import type { ResourceModel } from "../core/app.ts";
import { expiryCallerWritableOf } from "./write-plan.ts";

/** The same optional expiry authority as core restore; a fixed-after policy never accepts an override. */
export function restoreOptionsInput(model: ResourceModel): z.ZodObject {
  return z.object(
    expiryCallerWritableOf(model)
      ? {
        expires_at: z.union([z.iso.datetime({ offset: true }), z.null()])
          .optional(),
      }
      : {},
  ).strict();
}
