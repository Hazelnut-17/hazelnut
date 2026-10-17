import { z } from "zod";
import { jsonSchemaInput, strictify } from "../data/schema-types.ts";
import type { OnlyKnownKeys } from "../core/config.ts";

// `definePrompt` (12-mcp.md §prompts; 02-dsl.md §definePrompt). Prompts are the one MCP primitive with no
// op/entity source — authored, never projected. `render` takes ONLY `arguments`, no `ctx`: pure and total
// by construction, so a prompt cannot smuggle an op (why prompts aren't capability-filtered).

/** A prompt message (12-mcp.md §prompts; the MCP `prompts/get` messages-array form). */
export type PromptRole = "user" | "assistant";
export interface PromptMessage {
  readonly role: PromptRole;
  readonly content: string;
}
/** `render` returns the canon message array (`02-dsl.md §definePrompt` — multi-turn / non-`user` roles),
 *  or a bare `string` as the single-user-message shorthand. Still no `ctx`. */
export type PromptResult = string | ReadonlyArray<PromptMessage>;

export interface PromptDecl<A extends z.ZodObject<z.ZodRawShape>> {
  readonly name: string;
  readonly describe: string; // agent-facing, in the surface lock
  readonly arguments: A;
  readonly render: (args: z.infer<A>) => PromptResult; // NO ctx — pure, total over arguments
}

export interface PromptDef {
  readonly name: string;
  readonly describe: string;
  readonly arguments: z.ZodObject<z.ZodRawShape>;
  readonly render: (args: Record<string, unknown>) => PromptResult;
}

export function definePrompt<A extends z.ZodObject<z.ZodRawShape>, D = unknown>(
  decl: PromptDecl<A> & OnlyKnownKeys<D, PromptDecl<A>>,
): PromptDef {
  assertPromptArguments(decl);
  return decl as unknown as PromptDef;
}

export interface McpPromptArgument {
  readonly name: string;
  readonly description?: string;
  readonly required: boolean;
}
export interface McpPromptDef {
  readonly name: string;
  readonly description: string;
  readonly arguments: readonly McpPromptArgument[];
}

type InputDef = {
  readonly type?: string;
  readonly coerce?: boolean;
  readonly innerType?: z.ZodType;
  readonly in?: z.ZodType;
  readonly options?: readonly z.ZodType[];
  readonly left?: z.ZodType;
  readonly right?: z.ZodType;
  readonly values?: readonly unknown[];
  readonly entries?: Readonly<Record<string, unknown>>;
};

/** Inspect the public input AST only. Never parse undefined or read a default getter to advertise it. */
function stringInput(schema: z.ZodType, seen = new Set<z.ZodType>()): boolean {
  if (seen.has(schema)) return false;
  const next = new Set(seen).add(schema);
  const d = schema.def as InputDef;
  if (
    d.coerce === true || d.type === "string" || d.type === "template_literal"
  ) return true;
  if (d.type === "enum") {
    return d.entries !== undefined &&
      Object.values(d.entries).every((value) => typeof value === "string");
  }
  if (d.type === "literal") {
    return d.values !== undefined &&
      d.values.every((value) => typeof value === "string");
  }
  if (
    [
      "optional",
      "nullable",
      "default",
      "prefault",
      "catch",
      "readonly",
      "nonoptional",
    ].includes(d.type ?? "")
  ) return d.innerType !== undefined && stringInput(d.innerType, next);
  if (d.type === "pipe") return d.in !== undefined && stringInput(d.in, next);
  if (d.type === "union") {
    return d.options !== undefined && d.options.length > 0 &&
      d.options.every((option) => stringInput(option, next));
  }
  if (d.type === "intersection") {
    return d.left !== undefined && d.right !== undefined &&
      stringInput(d.left, next) && stringInput(d.right, next);
  }
  return false;
}

function requiredArgument(schema: z.ZodType): boolean {
  const d = schema.def as InputDef;
  if (["optional", "default", "prefault", "catch"].includes(d.type ?? "")) {
    return false;
  }
  if (["readonly", "nullable"].includes(d.type ?? "")) {
    return d.innerType === undefined || requiredArgument(d.innerType);
  }
  if (d.type === "pipe") return d.in === undefined || requiredArgument(d.in);
  if (d.type === "union") {
    return d.options === undefined || d.options.every(requiredArgument);
  }
  return true;
}

/** Internal lock projection: remove effect/default wrappers without reading a thunk. The protocol
 * advertises descriptors, while its compatibility lock can still detect enum/required narrowing. */
function promptInput(schema: z.ZodType): z.ZodType {
  const d = schema.def as InputDef;
  if (d.coerce === true) return z.string();
  if (d.type === "pipe" && d.in) return promptInput(d.in);
  if (d.innerType) return promptInput(d.innerType);
  if (d.type === "union" && d.options) {
    return z.union(d.options.map(promptInput));
  }
  if (d.type === "intersection" && d.left && d.right) {
    return z.intersection(promptInput(d.left), promptInput(d.right));
  }
  return schema;
}

export function promptInputJsonSchema(prompt: PromptDef): unknown {
  assertPromptArguments(prompt);
  const fields = Object.fromEntries(
    Object.entries(prompt.arguments.shape).map(([name, schema]) => {
      if (!(schema instanceof z.ZodType)) {
        throw new Error(
          "prompt/string-input: a field must use the public Zod schema API",
        );
      }
      let input = promptInput(schema);
      if (!requiredArgument(schema)) input = input.optional();
      if (schema.description !== undefined) {
        input = input.describe(schema.description);
      }
      return [name, input];
    }),
  );
  return jsonSchemaInput(z.object(fields));
}

export function promptArgumentErrors(prompt: unknown): string[] {
  if (
    prompt === null || typeof prompt !== "object" || !("arguments" in prompt) ||
    !(prompt.arguments instanceof z.ZodObject)
  ) return ["prompt/string-input: arguments must be a Zod object"];
  return Object.entries(prompt.arguments.shape).flatMap(([field, schema]) =>
    schema instanceof z.ZodType && stringInput(schema) ? [] : [
      `prompt/string-input: '${field}' needs an unambiguous string input; use z.coerce.number() or z.string().transform(...) for a parsed output`,
    ]
  );
}

export function assertPromptArguments(
  prompt: { readonly arguments: unknown },
): void {
  const errors = promptArgumentErrors(prompt);
  if (errors.length) {
    throw Object.assign(new Error(errors.join("; ")), {
      kind: "validation" as const,
    });
  }
}

/** Project authored fields to the protocol's argument descriptors, rather than a tool JSON schema. */
export function mcpPromptDefs(
  prompts: ReadonlyArray<PromptDef>,
): McpPromptDef[] {
  return prompts.map((p) => {
    assertPromptArguments(p);
    return {
      name: p.name,
      description: p.describe,
      arguments: Object.entries(p.arguments.shape).map(([name, schema]) => {
        if (!(schema instanceof z.ZodType)) {
          throw new Error(
            "prompt/string-input: a field must use the public Zod schema API",
          );
        }
        return {
          name,
          ...(schema.description === undefined
            ? {}
            : { description: schema.description }),
          required: requiredArgument(schema),
        };
      }),
    };
  });
}

/** Renderer faults are distinct from bad request arguments, even if authored code throws ZodError. */
export class PromptRenderError extends Error {
  constructor(readonly category: "render-threw" | "render-output") {
    super("prompt rendering failed");
    this.name = "PromptRenderError";
  }
}
const MESSAGE_OUTPUT = z.array(
  z.object({ role: z.enum(["user", "assistant"]), content: z.string() })
    .strict(),
);

/** `prompts/get` — strict-validate the arguments (mcp/strict-input: unknown keys rejected), then render.
 *  A bare-string `render` normalizes to one `user` message; an array passes through verbatim. */
export function renderPromptMessages(
  prompt: PromptDef,
  rawArgs: unknown,
): PromptMessage[] {
  const wireArgs = z.record(z.string(), z.string()).parse(rawArgs);
  const args = strictify(prompt.arguments).parse(wireArgs) as Record<
    string,
    unknown
  >;
  let out: unknown;
  try {
    out = prompt.render(args);
  } catch {
    throw new PromptRenderError("render-threw");
  }
  if (typeof out === "string") return [{ role: "user", content: out }];
  try {
    const checked = MESSAGE_OUTPUT.safeParse(out);
    if (!checked.success) throw new PromptRenderError("render-output");
    return checked.data;
  } catch {
    throw new PromptRenderError("render-output");
  }
}

/** The flat string view of a render (message contents joined). Prefer `renderPromptMessages` — it
 *  preserves roles + multi-turn structure. */
export function renderPrompt(prompt: PromptDef, rawArgs: unknown): string {
  return renderPromptMessages(prompt, rawArgs).map((m) => m.content).join("\n");
}

/** Advertise the `prompts` capability IFF at least one prompt is declared. */
export function hasPromptsCapability(
  prompts: ReadonlyArray<PromptDef>,
): boolean {
  return prompts.length > 0;
}
