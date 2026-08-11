import { z } from "zod";
import { strictify } from "../data/schema.ts";
import type { OnlyKnownKeys } from "../core/config.ts";

// `definePrompt` (12-mcp.md §prompts; 02-dsl.md §definePrompt). Prompts are the one MCP primitive with no
// op/entity source — authored, never projected. `render` takes ONLY `arguments`, no `ctx`: pure and total
// by construction, so a prompt cannot smuggle an op (why prompts aren't capability-filtered).

/** A prompt message (12-mcp.md §prompts; the MCP `prompts/get` messages-array form). */
export type PromptRole = "user" | "assistant" | "system";
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
  return decl as unknown as PromptDef;
}

export interface McpPromptDef {
  readonly name: string;
  readonly description: string;
  readonly arguments: unknown;
}

/** Project prompts → the MCP `prompts/list` catalog (arguments via the same Zod→MCP deriver as tools). */
export function mcpPromptDefs(
  prompts: ReadonlyArray<PromptDef>,
): McpPromptDef[] {
  return prompts.map((p) => ({
    name: p.name,
    description: p.describe,
    arguments: z.toJSONSchema(p.arguments),
  }));
}

/** `prompts/get` — strict-validate the arguments (mcp/strict-input: unknown keys rejected), then render.
 *  A bare-string `render` normalizes to one `user` message; an array passes through verbatim. */
export function renderPromptMessages(
  prompt: PromptDef,
  rawArgs: unknown,
): PromptMessage[] {
  const out = prompt.render(
    strictify(prompt.arguments).parse(rawArgs) as Record<string, unknown>,
  );
  return typeof out === "string"
    ? [{ role: "user", content: out }]
    : out.map((m) => ({ role: m.role, content: m.content }));
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
