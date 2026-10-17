import { z } from "zod";

const omittedDefaults = new WeakSet<object>();

/** Private metadata marker: the converter's inert JSON placeholder is never published. */
export function wireMetadataDefaultOmitted(schema: object): boolean {
  return omittedDefaults.has(schema);
}

/** A metadata-only schema graph. Zod exposes both literal and callback defaults through getters;
 * reading one to classify it executes application code. Keep the wrapper's optionality while replacing
 * uninspectable defaults with inert data. Parsing and DDL continue to use the untouched declaration. */
export function schemaForWireMetadata(
  schema: z.ZodType,
  jsonSerialization = false,
  metadata?: z.core.$ZodRegistry<z.core.GlobalMeta>,
  jsonOutput = false,
): z.ZodType {
  const seen = new WeakMap<object, z.ZodType>();
  const children = new Set([
    "innerType",
    "element",
    "keyType",
    "valueType",
    "left",
    "right",
    "in",
    "out",
    "rest",
    "catchall",
  ]);
  const isSchema = (value: unknown): value is z.ZodType =>
    value !== null && typeof value === "object" && "_zod" in value &&
    "clone" in value && typeof value.clone === "function";
  const shape = (value: Record<string, z.ZodType>) => {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if ("value" in descriptor && isSchema(descriptor.value)) {
        descriptor.value = project(descriptor.value);
      } else if (descriptor.get) {
        const get = descriptor.get;
        descriptors[key] = {
          ...descriptor,
          get: () => project(get.call(value)),
        };
      }
    }
    return Object.defineProperties({}, descriptors);
  };
  const arrayItem = (node: z.ZodType): z.ZodType => {
    const projected = project(node);
    // JSON omits an undefined object property but emits null for an undefined array slot. Keep the
    // distinction local to output metadata; input null never becomes an accepted optional value.
    return jsonOutput && projected._zod.optout === "optional"
      ? z.union([projected, z.null()])
      : projected;
  };
  const project = (node: z.ZodType): z.ZodType => {
    const cached = seen.get(node);
    if (cached) return cached;
    const def = node.def as unknown as Record<string, unknown>;
    const descriptors = Object.getOwnPropertyDescriptors(def);
    const value = descriptors.defaultValue;
    const omitDefault = !!value &&
      (value.get !== undefined || value.value === undefined ||
        value.value === "now()" || value.value === "gen_random_uuid()");
    if (omitDefault) {
      // The pinned JSON converter parses JSON.stringify(defaultValue), so undefined cannot reach
      // that processor. Its null placeholder is removed by override using the node marker below.
      descriptors.defaultValue = {
        configurable: true,
        enumerable: value.enumerable,
        writable: true,
        value: jsonSerialization ? null : undefined,
      };
    }
    const omitCatch = def.type === "catch";
    if (omitCatch) {
      // The JSON converter probes catchValue(undefined). Metadata must never execute an application
      // fallback; the parse-time declaration remains untouched, and the inert annotation is removed.
      descriptors.catchValue = {
        configurable: true,
        enumerable: true,
        writable: true,
        value: () => null,
      };
    }
    // Cloning the outer node first makes recursive lazy/object references share its projection.
    const copied = Object.defineProperties({}, descriptors);
    const projected = node.clone(copied as typeof node.def);
    seen.set(node, projected);
    if (omitDefault || omitCatch) omittedDefaults.add(projected);
    // Metadata normally inherits through an original-schema parent pointer. Copy its resolved value
    // into a conversion-local registry instead: following the original parent could revisit its getter.
    const meta = metadata && z.globalRegistry.get(node);
    if (meta) metadata!.add(projected, meta);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (key === "shape") {
        if (
          "value" in descriptor && descriptor.value &&
          typeof descriptor.value === "object"
        ) {
          Object.defineProperty(copied, key, {
            ...descriptor,
            value: shape(descriptor.value),
          });
        } else if (descriptor.get) {
          const get = descriptor.get;
          Object.defineProperty(copied, key, {
            configurable: true,
            enumerable: descriptor.enumerable,
            get: () => shape(get.call(def)),
          });
        }
      } else if (
        children.has(key) && "value" in descriptor && isSchema(descriptor.value)
      ) {
        Object.defineProperty(copied, key, {
          ...descriptor,
          value: jsonOutput && (key === "element" || key === "rest")
            ? arrayItem(descriptor.value)
            : project(descriptor.value),
        });
      } else if (
        (key === "options" || key === "items") &&
        Array.isArray(descriptor.value)
      ) {
        Object.defineProperty(copied, key, {
          ...descriptor,
          value: descriptor.value.map((child: unknown) =>
            isSchema(child)
              ? jsonOutput && key === "items"
                ? arrayItem(child)
                : project(child)
              : child
          ),
        });
      } else if (
        key === "getter" && def.type === "lazy" &&
        typeof descriptor.value === "function"
      ) {
        const get = descriptor.value as () => z.ZodType;
        Object.defineProperty(copied, key, {
          ...descriptor,
          value: () => project(get()),
        });
      }
    }
    return projected;
  };
  return project(schema);
}
