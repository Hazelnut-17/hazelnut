import { z } from "zod";
import {
  bindPermKeyChecks,
  hasPermKeyChecks,
  PERMKEY_SEAL,
} from "../authz/perm-key-check.ts";
import { copySchemaAnnotations } from "./schema-types.ts";

/** Copy a schema graph for one composed app, binding permission refinements to
 * its vocabulary without mutating any schema another app may share. */
export function appPermissionSchemas(vocabulary: readonly string[]) {
  const vocab = new Set(vocabulary);
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
  const containsPermission = (
    node: z.ZodType,
    visited = new WeakSet<object>(),
  ): boolean => {
    if (visited.has(node)) return false;
    visited.add(node);
    const def = node.def as unknown as Record<string, unknown>;
    if (Array.isArray(def.checks) && hasPermKeyChecks(def.checks)) return true;
    // A lazy getter is deliberately not executed during composition.
    if (def.type === "lazy") return true;
    if (def.shape && typeof def.shape === "object") {
      for (const child of Object.values(def.shape)) {
        if (isSchema(child) && containsPermission(child, visited)) return true;
      }
    }
    for (const key of children) {
      const child = def[key];
      if (isSchema(child) && containsPermission(child, visited)) return true;
    }
    for (const key of ["options", "items"]) {
      const values = def[key];
      if (
        Array.isArray(values) &&
        values.some((child) =>
          isSchema(child) && containsPermission(child, visited)
        )
      ) return true;
    }
    return false;
  };
  const project = (node: z.ZodType): z.ZodType => {
    const prior = seen.get(node);
    if (prior) return prior;
    if (!containsPermission(node)) return node;
    const def = node.def as unknown as Record<string, unknown>;
    const descriptors = Object.getOwnPropertyDescriptors(def);
    // A previously parsed authored lazy may carry Zod's cached inner schema;
    // copying that cache would bypass the app-owned projection.
    if (def.type === "lazy") delete descriptors._cachedInner;
    const checks = descriptors.checks;
    const seal = { vocab: vocab as ReadonlySet<string> | null };
    let bound = false;
    if (checks && "value" in checks && Array.isArray(checks.value)) {
      bound = hasPermKeyChecks(checks.value);
      descriptors.checks = {
        ...checks,
        value: bindPermKeyChecks(checks.value, seal),
      };
    }
    const projectShape = (shape: Record<string, unknown>) => {
      const entries = Object.getOwnPropertyDescriptors(shape);
      for (const descriptor of Object.values(entries)) {
        if ("value" in descriptor && isSchema(descriptor.value)) {
          descriptor.value = project(descriptor.value);
        } else if (descriptor.get) {
          const getter = descriptor.get;
          descriptor.get = () => project(getter.call(shape));
        }
      }
      return Object.defineProperties({}, entries);
    };
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (key === "shape") {
        if (
          "value" in descriptor && descriptor.value &&
          typeof descriptor.value === "object"
        ) {
          const shape = descriptor.value as Record<string, unknown>;
          descriptors[key] = {
            configurable: descriptor.configurable,
            enumerable: descriptor.enumerable,
            get: () => projectShape(shape),
          };
        } else if (descriptor.get) {
          const getter = descriptor.get;
          descriptors[key] = {
            ...descriptor,
            get: () => projectShape(getter.call(def)),
          };
        }
      } else if (
        children.has(key) && "value" in descriptor && isSchema(descriptor.value)
      ) {
        descriptors[key] = {
          ...descriptor,
          value: project(descriptor.value),
        };
      } else if (
        (key === "options" || key === "items") && "value" in descriptor &&
        Array.isArray(descriptor.value)
      ) {
        descriptors[key] = {
          ...descriptor,
          value: descriptor.value.map((value: unknown) =>
            isSchema(value) ? project(value) : value
          ),
        };
      } else if (
        key === "getter" && def.type === "lazy" && "value" in descriptor &&
        typeof descriptor.value === "function"
      ) {
        const getter = descriptor.value as () => z.ZodType;
        descriptors[key] = {
          ...descriptor,
          // Keep the getter dynamic for verifier source/shape inspection.
          // Zod itself caches the parse target in its lazy instance.
          value: () => project(getter()),
        };
      }
    }
    const copied = Object.defineProperties({}, descriptors);
    const cloned = copySchemaAnnotations(
      node,
      node.clone(copied as typeof node.def),
      { globalMeta: false },
    );
    const metadata = z.globalRegistry.get(node);
    if (metadata) {
      // A global id identifies exactly one schema. A copy cannot own it too:
      // removing either registration would otherwise unregister the original.
      const { id: _id, ...copyMetadata } = metadata;
      if (Object.keys(copyMetadata).length) {
        z.globalRegistry.add(cloned, copyMetadata);
      }
    }
    if (bound) Object.defineProperty(cloned, PERMKEY_SEAL, { value: seal });
    seen.set(node, cloned);
    return cloned;
  };
  return project;
}

const eventSchemaBinders = new WeakMap<
  object,
  ReturnType<typeof appPermissionSchemas>
>();

/** Capture the same composition-time vocabulary without touching event schema shapes. */
export function registerAppEventPermissions(
  app: object,
  vocabulary: readonly string[],
): void {
  eventSchemaBinders.set(app, appPermissionSchemas(vocabulary));
}

/** Resolve the producer validator on use, leaving authored event metadata and lazy shapes untouched at boot. */
export function appEventPermissionSchema(
  app: { readonly perms?: readonly string[] },
  schema: z.ZodType,
): z.ZodType {
  if (!app.perms) return schema;
  let bind = eventSchemaBinders.get(app);
  if (!bind) {
    bind = appPermissionSchemas(app.perms);
    eventSchemaBinders.set(app, bind);
  }
  return bind(schema);
}
