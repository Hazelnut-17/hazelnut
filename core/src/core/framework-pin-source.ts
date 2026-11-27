// The pin gate reads source literals as well as config strings. Parse only
// candidate source files; on malformed or unsupported syntax retain the raw
// text so a real old pin cannot disappear from the verdict.
// This core lint plugin also loads as a direct file URL outside a workspace
// import map. Keep this pin equal to APP_DEPENDENCY_PINS and deno.json.
// deno-lint-ignore no-import-prefix
import { parse } from "npm:@babel/parser@8.1.3";

function maskComments(path: string, text: string, blockOnly = false): string {
  if (!/\.[cm]?[jt]sx?$/i.test(path)) return text;
  try {
    const parsed = parse(text, {
      sourceType: "unambiguous",
      plugins: /\.[jt]sx$/i.test(path) ? ["typescript", "jsx"] : ["typescript"],
      allowAwaitOutsideFunction: true,
    });
    let cursor = 0;
    let result = "";
    for (const comment of parsed.comments ?? []) {
      if (blockOnly && comment.type !== "CommentBlock") continue;
      if (
        comment.start == null || comment.end == null || comment.start < cursor
      ) {
        return text;
      }
      result += text.slice(cursor, comment.start);
      result += text.slice(comment.start, comment.end).replace(/[^\r\n]/g, " ");
      cursor = comment.end;
    }
    return result + text.slice(cursor);
  } catch {
    return text;
  }
}

export function pinSourceWithoutComments(path: string, text: string): string {
  if (
    !text.includes("jsr:@hazelnut/core@") &&
    !text.includes("https://jsr.io/@hazelnut/core/")
  ) return text;
  return maskComments(path, text);
}

/** Directive examples inside parsed block comments are prose. Keep source
 * offsets and retain the original when the parser cannot confirm the spans. */
export function lintDirectiveSource(path: string, text: string): string {
  return text.includes("/*") && text.includes("deno-lint-ignore")
    ? maskComments(path, text, true)
    : text;
}
