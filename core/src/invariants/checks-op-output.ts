import { withheldFromOpsOf } from "../core/app-refs.ts";
import type { App } from "../core/app.ts";
import { isBuiltinDataDoor } from "../core/resource-doors.ts";
import type { AppViolation, Violation } from "../core/structural-violation.ts";
import { wireJsonSchema } from "../data/schema-types.ts";
import { outputRedactSet } from "../features/redact.ts";
import type { z } from "zod";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function schemaRef(root: unknown, ref: string): unknown {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let node = root;
  for (const part of ref.slice(2).split("/")) {
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
    node = isRecord(node) && Object.hasOwn(node, key) ? node[key] : undefined;
  }
  return node;
}

/** Read named fields from the output schema. The MCP pick applies to each top-level row,
 * including rows in arrays. Fields below a masked or already omitted key cannot reach the wire. */
function withheldOutputFields(
  root: unknown,
  withheld: ReadonlySet<string>,
  hidden: ReadonlySet<string>,
  shape?: readonly string[],
): Set<string> {
  const selected = shape === undefined ? undefined : new Set(shape);
  const fields = new Set(shape?.filter((name) => withheld.has(name)));
  const seen = new Set<unknown>();
  const seenPicked = new Set<unknown>();
  const visit = (value: unknown, pick?: ReadonlySet<string>): void => {
    const visited = pick ? seenPicked : seen;
    if (!isRecord(value) || visited.has(value)) return;
    visited.add(value);
    if (typeof value.$ref === "string") {
      visit(schemaRef(root, value.$ref), pick);
    }

    const visitField = (name: string, child: unknown) => {
      if (hidden.has(name) || (pick && !pick.has(name))) return;
      if (
        child === false ||
        (isRecord(child) && isRecord(child.not) &&
          Object.keys(child.not).length === 0)
      ) return;
      if (withheld.has(name)) fields.add(name);
      else visit(child);
    };
    const properties = isRecord(value.properties) ? value.properties : {};
    for (const [name, child] of Object.entries(properties)) {
      visitField(name, child);
    }
    // Finite-key records declare their names under propertyNames, including optional record keys.
    const propertyNames = isRecord(value.propertyNames)
      ? value.propertyNames
      : {};
    const finiteKeys = Array.isArray(propertyNames.enum)
      ? propertyNames.enum
      : undefined;
    for (const name of finiteKeys ?? []) {
      if (typeof name === "string" && !Object.hasOwn(properties, name)) {
        visitField(name, value.additionalProperties);
      }
    }
    // Unknown keys do not themselves promise a field. Their typed values can have named children.
    if (!finiteKeys && value.additionalProperties !== false) {
      if (!pick) visit(value.additionalProperties);
      else if (Object.keys(propertyNames).every((key) => key === "type")) {
        for (const name of pick) {
          if (!Object.hasOwn(properties, name)) {
            visitField(name, value.additionalProperties);
          }
        }
      }
    }
    if (!pick) {
      if (isRecord(value.patternProperties)) {
        for (const child of Object.values(value.patternProperties)) {
          visit(child);
        }
      }
    }
    if (!Array.isArray(value.items)) visit(value.items, pick);
    for (const key of ["items", "prefixItems", "anyOf", "oneOf", "allOf"]) {
      const children = value[key];
      if (Array.isArray(children)) {
        for (const child of children) visit(child, pick);
      }
    }
  };
  visit(root, selected);
  return fields;
}

/** A served, declared response must survive the app-wide egress fold. Report only names
 * newly suppressed by another resource, with the wire projection still fail-closed. */
export function checkOpOutputWithheld(
  app: App,
  only?: ReadonlySet<"http" | "mcp" | "event">,
): (AppViolation & Violation)[] {
  const http = only?.has("http") ?? true;
  const mcp = only?.has("mcp") ?? true;
  if (!http && !mcp) return [];

  const owned = new Map<App["model"][number], Set<string>>();
  const minters = new Map<string, string[]>();
  const redacted = new Set<string>();
  for (const model of app.model) {
    const fields = withheldFromOpsOf([model]);
    owned.set(model, fields);
    for (const name of outputRedactSet(model)) redacted.add(name);
    for (const name of fields) {
      const owners = minters.get(name) ?? [];
      owners.push(`${model.module}.${model.name}`);
      minters.set(name, owners);
    }
  }
  if (minters.size === 0) return [];

  const out: (AppViolation & Violation)[] = [];
  for (const [model, ownFields] of owned) {
    const hidden = new Set([...redacted, ...ownFields]);
    const withheld = new Set(
      [...minters.keys()].filter((name) => !hidden.has(name)),
    );
    if (withheld.size === 0) continue;
    for (const [op, decl] of Object.entries(model.operations)) {
      const builtin = isBuiltinDataDoor(model, op);
      const httpServed = http && !builtin && Object.hasOwn(model.http, op);
      const mcpEntry = mcp && Object.hasOwn(model.mcp, op)
        ? model.mcp[op]
        : undefined;
      const mcpServed = mcpEntry && (!builtin || mcpEntry.as === "resource");
      if (!httpServed && !mcpServed) continue;

      const output = (decl as { readonly output?: z.ZodType }).output;
      const schema = output &&
        wireJsonSchema(output, "output", { opaqueOutput: true });
      const httpFields = httpServed
        ? withheldOutputFields(schema, withheld, hidden)
        : new Set<string>();
      const mcpFields = mcpServed
        ? withheldOutputFields(schema, withheld, hidden, mcpEntry.shape)
        : new Set<string>();
      const resource = `${model.module}.${model.name}.${op}`;
      for (const name of [...new Set([...httpFields, ...mcpFields])].sort()) {
        const doors = [
          httpFields.has(name) ? "HTTP" : "",
          mcpFields.has(name) ? "MCP" : "",
        ].filter(Boolean);
        out.push({
          id: "wiring/op-output-withheld",
          resource,
          clause: `${resource}.${name}`,
          responsible: {
            kind: "declaration",
            ref: {
              module: model.module,
              resource: model.name,
              clause: `operations.${op}`,
            },
          },
          message: `Operation '${resource}' declares ${
            doors.join(" and ")
          } response field '${name}', which egress drops. The resources withholding a framework column with that name are ${
            minters.get(name)!.slice().sort().join(", ")
          }. Give the app-owned response field a distinct name in the handler, output schema and any field pick, or remove it from the public contract.`,
        });
      }
    }
  }
  return out;
}
