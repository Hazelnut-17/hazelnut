/** Top-level output field names, from the handler's DTO to the wire. */
export type OpOutputAliases = Readonly<Record<string, string>>;

export function opOutputAliasesOf(decl: unknown): OpOutputAliases | undefined {
  return (decl as { readonly outputAliases?: OpOutputAliases } | undefined)
    ?.outputAliases;
}

/** Every destination comes from its declared source, even when another property
 * at that destination was present before projection. */
export function renameOutputFields<T>(
  fields: Record<string, T>,
  aliases: OpOutputAliases,
): Record<string, T> {
  const destinations = new Set(Object.values(aliases));
  return Object.fromEntries(
    Object.entries(fields).flatMap(([name, value]) =>
      Object.hasOwn(aliases, name)
        ? [[aliases[name]!, value]]
        : destinations.has(name)
        ? []
        : [[name, value]]
    ),
  );
}

/** Apply the same root rename to an already projected JSON Schema. */
export function renameOutputSchema(
  schema: Record<string, unknown>,
  aliases: OpOutputAliases | undefined,
): Record<string, unknown> {
  const properties = schema.properties;
  if (!aliases || !properties || typeof properties !== "object") return schema;
  return {
    ...schema,
    properties: renameOutputFields(
      properties as Record<string, unknown>,
      aliases,
    ),
    ...(Array.isArray(schema.required)
      ? {
        required: Object.keys(renameOutputFields(
          Object.fromEntries(schema.required.map((key) => [key, true])),
          aliases,
        )),
      }
      : {}),
  };
}

/** A wire pick is expressed in source names while applying redaction. */
export function sourceOutputShape(
  shape: readonly string[] | undefined,
  aliases: OpOutputAliases | undefined,
): readonly string[] | undefined {
  if (!shape || !aliases) return shape;
  const sources = new Map(
    Object.entries(aliases).map(([from, to]) => [to, from]),
  );
  return shape.flatMap((name) => {
    const source = sources.get(name);
    return source !== undefined
      ? [source]
      : Object.hasOwn(aliases, name)
      ? []
      : [name];
  });
}
