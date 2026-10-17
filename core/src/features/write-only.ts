import type { ResourceModel } from "../core/app.ts";

/** Write properties withheld from resource reads must not promise a round trip to generated clients. */
export function markWriteOnly(
  model: Pick<ResourceModel, "passwords" | "sensitive" | "encrypted">,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const props = schema.properties as Record<string, unknown> | undefined;
  if (!props) return schema;
  const fields = new Set([
    ...model.passwords,
    ...model.sensitive,
    ...model.encrypted,
  ]);
  const next = { ...props };
  for (const field of fields) {
    const prop = props[field];
    if (prop && typeof prop === "object") {
      next[field] = {
        ...prop as Record<string, unknown>,
        writeOnly: true,
        ...(model.passwords.includes(field) ? { format: "password" } : {}),
      };
    }
  }
  return { ...schema, properties: next };
}

/** Set-once user fields remain create-writable, but a PATCH must not teach clients to re-set them. */
export function markUpdateReadOnly(
  model: Pick<ResourceModel, "features">,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const props = schema.properties as Record<string, unknown> | undefined;
  const immutable = model.features.immutable;
  const fields = typeof immutable === "object" ? immutable.fields ?? [] : [];
  if (!props || fields.length === 0) return schema;
  const next = { ...props };
  for (const field of fields) {
    if (props[field] && typeof props[field] === "object") {
      next[field] = {
        ...props[field] as Record<string, unknown>,
        readOnly: true,
      };
    }
  }
  return { ...schema, properties: next };
}
