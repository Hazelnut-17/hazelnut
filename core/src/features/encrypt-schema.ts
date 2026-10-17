/** Known output vocabulary only; never evaluate a default or execute an authored transform at boot. */
export function encryptedSchemaOutput(
  schema: unknown,
): "string" | "other" | "unknown" {
  const def = (schema as {
    def?: {
      type?: string;
      innerType?: unknown;
      out?: unknown;
      options?: readonly unknown[];
      entries?: Record<string, unknown>;
      values?: readonly unknown[];
    };
  } | null)?.def;
  if (!def) return "unknown";
  if (def.innerType) return encryptedSchemaOutput(def.innerType);
  if (def.type === "pipe") return encryptedSchemaOutput(def.out);
  if (
    def.type === "transform" || def.type === "custom" || def.type === "lazy"
  ) return "unknown";
  if (def.type === "string" || def.type === "null") return "string";
  if (def.type === "enum") {
    return Object.values(def.entries ?? {}).every((value) =>
        typeof value === "string"
      )
      ? "string"
      : "other";
  }
  if (def.type === "literal") {
    return (def.values ?? []).every((value) =>
        typeof value === "string" || value === null
      )
      ? "string"
      : "other";
  }
  if (def.type === "union") {
    const outputs = (def.options ?? []).map(encryptedSchemaOutput);
    return outputs.includes("other")
      ? "other"
      : outputs.includes("unknown")
      ? "unknown"
      : "string";
  }
  return "other";
}
