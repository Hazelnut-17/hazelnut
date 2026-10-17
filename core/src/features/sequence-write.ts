import type { ResourceModel } from "../core/app.ts";

/** A sequence's named partition is caller-supplied on create and set once thereafter. */
export function markSequencePartitionReadOnly(
  model: Pick<ResourceModel, "features">,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const cfg = model.features.sequence;
  const partition = cfg && typeof cfg === "object" ? cfg.scope : undefined;
  const props = schema.properties as Record<string, unknown> | undefined;
  const property = partition !== undefined ? props?.[partition] : undefined;
  if (
    !props || partition === undefined || !property ||
    typeof property !== "object"
  ) return schema;
  return {
    ...schema,
    properties: {
      ...props,
      [partition]: { ...property as Record<string, unknown>, readOnly: true },
    },
  };
}
