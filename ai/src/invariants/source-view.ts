// Source projections for the checks that regex over authored source (`handler.toString()`, an AST text
// slice). Core content, so every rung that reads source sees the same characters.

/** Characters after which a `/` opens a REGEX literal rather than a division — the standard lexical
 *  heuristic. Without it `/a\/\//` reads as a line comment and blanks the rest of its line, which a
 *  deliberate author can aim at the very statement a check is looking for. */
const REGEX_PRECEDERS = new Set(
  ["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*"],
);

/** Blank every character except newlines — keeps offsets and line numbers, removes the content. */
function blanked(s: string): string {
  return s.replace(/[^\n]/g, " ");
}

/** The offset just past the `}` closing a `${` hole that opens at `open` (the `$`), or the source length
 *  when it never closes. Nested braces and nested literals inside the hole are skipped. */
function endOfHole(src: string, open: number): number {
  let depth = 1;
  let i = open + 2;
  for (; i < src.length && depth > 0; i++) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < src.length && src[i] !== c) i += src[i] === "\\" ? 2 : 1;
    } else if (c === "{") depth++;
    else if (c === "}") depth--;
  }
  return i;
}

/** One scanner, two projections. `blankStrings` decides whether string/template TEXT survives; a `${…}` hole
 *  is code either way, so it is projected, never blanked. */
function project(src: string, blankStrings: boolean): string {
  let out = "";
  let prev = ""; // last emitted code character — the regex-vs-division discriminator
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      const stop = nl < 0 ? src.length : nl;
      out += blanked(src.slice(i, stop));
      i = stop - 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += blanked(src.slice(i, stop));
      i = stop - 1;
      continue;
    }
    if (c === "/" && (prev === "" || REGEX_PRECEDERS.has(prev))) {
      const start = i++;
      let inClass = false;
      while (i < src.length && src[i] !== "\n") {
        const r = src[i]!;
        if (r === "\\") i++;
        else if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        else if (r === "/" && !inClass) break;
        i++;
      }
      out += src.slice(start, i + 1); // a regex literal is code, kept verbatim in both projections
      prev = "/";
      continue;
    }
    if (c === "`") {
      out += "`";
      i++;
      while (i < src.length && src[i] !== "`") {
        if (src[i] === "\\") {
          const pair = src.slice(i, i + 2);
          out += blankStrings ? blanked(pair) : pair;
          i += 2;
          continue;
        }
        if (src[i] === "$" && src[i + 1] === "{") {
          const end = endOfHole(src, i);
          out += "${" + project(src.slice(i + 2, end - 1), blankStrings) + "}";
          i = end;
          continue;
        }
        out += blankStrings ? blanked(src[i]!) : src[i]!;
        i++;
      }
      if (i < src.length) out += "`";
      prev = "`";
      continue;
    }
    if (c === '"' || c === "'") {
      const start = i++;
      while (i < src.length && src[i] !== c) i += src[i] === "\\" ? 2 : 1;
      const lit = src.slice(start, Math.min(i, src.length - 1) + 1);
      out += blankStrings ? blanked(lit) : lit;
      prev = c;
      continue;
    }
    out += c;
    if (c.trim() !== "") prev = c;
  }
  return out;
}

/** Source with COMMENTS blanked, string/template literals preserved — the projection a check that ACCUSES
 *  runs over: prose describing a raw read must not be read as one, but the read's SQL lives in a literal. */
export function withoutComments(src: string): string {
  return project(src, false);
}

/** Source with comments AND string/template TEXT blanked — the projection a check that EXCUSES runs over.
 *  A rowPolicy re-application is a CALL; a comment or string that merely names it is prose, and reading
 *  prose as a call means the plainest sentence an author writes about the defect silences the check. A
 *  `${…}` hole survives: its contents are executed, so a call there is a real one. */
export function withoutCommentsOrStrings(src: string): string {
  return project(src, true);
}
