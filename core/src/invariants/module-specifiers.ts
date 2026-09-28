/** Extract literal module specifiers from TypeScript/JavaScript import syntax without counting prose.
 *
 * This intentionally handles the source forms release assembly can resolve: static imports (including
 * side-effect imports), re-exports, and literal dynamic imports. Tokenizing first keeps multiline syntax
 * and comments valid while excluding comments, quoted prose, regexes, and template text. Code inside a
 * template interpolation is still tokenized, because it is executable JavaScript.
 */
type Token = { kind: "id" | "string" | "punct"; value: string };

export function moduleSpecifiers(src: string): string[] {
  const tokens = tokenize(src);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (
      token.kind !== "id" ||
      (token.value !== "import" && token.value !== "export")
    ) {
      continue;
    }
    if (tokens[i - 1]?.value === "." || tokens[i - 1]?.value === "?.") continue;
    const next = tokens[i + 1];
    if (token.value === "import" && next?.value === "(") {
      const argument = tokens[i + 2];
      const after = tokens[i + 3];
      if (
        argument?.kind === "string" &&
        (after?.value === ")" || after?.value === ",")
      ) out.push(argument.value);
      continue;
    }
    if (token.value === "import" && next?.kind === "string") {
      out.push(next.value); // side-effect import
      continue;
    }
    const specifier = staticSpecifier(tokens, i + 1);
    if (specifier !== undefined) out.push(specifier);
  }
  return out;
}

/** Module edges that can execute at runtime (static imports and re-exports only).
 *
 * Launch uses this narrower view to identify emitted transports. A comment, string, regex, template-text,
 * type-only import, or dynamic import is not the transport the process drives. */
export function runtimeModuleSpecifiers(src: string): string[] {
  const tokens = tokenize(src);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (
      token.kind !== "id" ||
      (token.value !== "import" && token.value !== "export") ||
      tokens[i - 1]?.value === "." || tokens[i - 1]?.value === "?."
    ) continue;

    const next = tokens[i + 1];
    if (token.value === "import" && next?.value === "(") continue;
    if (isTypeOnlyModuleEdge(tokens, i)) continue;
    if (token.value === "import" && next?.kind === "string") {
      out.push(next.value); // side-effect import
      continue;
    }
    const specifier = staticSpecifier(tokens, i + 1);
    if (specifier !== undefined) out.push(specifier);
  }
  return out;
}

/** True for TypeScript's fully erased `import type` / `export type` clauses. */
function isTypeOnlyModuleEdge(tokens: readonly Token[], at: number): boolean {
  const next = tokens[at + 1];
  const afterType = tokens[at + 2];
  if (
    next?.kind === "id" && next.value === "type" &&
    afterType !== undefined && afterType.value !== "from"
  ) return true;
  if (next?.value !== "{") return false;

  const entries: Token[][] = [];
  let depth = 1;
  let entry: Token[] = [];
  for (let i = at + 2; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.value === "{" && token.kind === "punct") {
      depth++;
      entry.push(token);
    } else if (token.value === "}" && token.kind === "punct") {
      depth--;
      if (depth === 0) {
        if (entry.length > 0) entries.push(entry);
        break;
      }
      entry.push(token);
    } else if (
      token.value === "," && token.kind === "punct" && depth === 1
    ) {
      if (entry.length > 0) entries.push(entry);
      entry = [];
    } else {
      entry.push(token);
    }
  }
  return entries.length > 0 &&
    entries.every((part) =>
      part[0]?.kind === "id" && part[0].value === "type" &&
      (part[1]?.kind === "id" || part[1]?.kind === "string") &&
      part[1].value !== "as"
    );
}

/** Find the `from "specifier"` clause of one static import/export, stopping at its statement boundary. */
function staticSpecifier(
  tokens: readonly Token[],
  start: number,
): string | undefined {
  let braces = 0;
  let brackets = 0;
  let parens = 0;
  for (let i = start; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.value === ";" && braces === 0 && brackets === 0 && parens === 0) {
      return undefined;
    }
    if (
      i > start && token.kind === "id" &&
      (token.value === "import" || token.value === "export") &&
      braces === 0 && brackets === 0 && parens === 0
    ) return undefined;
    if (
      token.kind === "id" && token.value === "from" &&
      tokens[i + 1]?.kind === "string"
    ) return tokens[i + 1]!.value;
    if (token.value === "{") braces++;
    else if (token.value === "}") braces = Math.max(0, braces - 1);
    else if (token.value === "[") brackets++;
    else if (token.value === "]") brackets = Math.max(0, brackets - 1);
    else if (token.value === "(") parens++;
    else if (token.value === ")") parens = Math.max(0, parens - 1);
  }
  return undefined;
}

/** A small lexer for module-bearing syntax. It omits comments and template text, not executable tokens. */
function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;

  const scanCode = (interpolation = false): void => {
    let braces = 0;
    while (i < src.length) {
      const c = src[i]!;
      const n = src[i + 1];
      if (/\s/.test(c)) {
        i++;
        continue;
      }
      if (c === "/" && n === "/") {
        i += 2;
        while (i < src.length && src[i] !== "\n") i++;
        continue;
      }
      if (c === "/" && n === "*") {
        i += 2;
        while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
        i = Math.min(src.length, i + 2);
        continue;
      }
      if (c === "'" || c === '"') {
        const read = readString(src, i, c);
        out.push({ kind: "string", value: read.value });
        i = read.end;
        continue;
      }
      if (c === "`") {
        scanTemplate();
        continue;
      }
      if (c === "}" && interpolation && braces === 0) {
        i++;
        return;
      }
      if (c === "{" && interpolation) braces++;
      else if (c === "}" && interpolation) braces--;
      if (c === "/" && opensRegex(out)) {
        i = skipRegex(src, i);
        continue;
      }
      if (/[A-Za-z_$]/.test(c)) {
        const start = i++;
        while (i < src.length && /[A-Za-z0-9_$]/.test(src[i]!)) i++;
        out.push({ kind: "id", value: src.slice(start, i) });
        continue;
      }
      if (/[0-9]/.test(c)) {
        i++;
        while (i < src.length && /[A-Za-z0-9_.]/.test(src[i]!)) i++;
        out.push({ kind: "punct", value: "number" });
        continue;
      }
      if (c === "?" && n === ".") {
        out.push({ kind: "punct", value: "?." });
        i += 2;
        continue;
      }
      out.push({ kind: "punct", value: c });
      i++;
    }
  };

  const scanTemplate = (): void => {
    i++; // opening backtick
    while (i < src.length) {
      const c = src[i]!;
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        i++;
        return;
      }
      if (c === "$" && src[i + 1] === "{") {
        i += 2;
        scanCode(true);
        continue;
      }
      i++;
    }
  };

  scanCode();
  return out;
}

function readString(
  src: string,
  start: number,
  quote: "'" | '"',
): { value: string; end: number } {
  let i = start + 1;
  let value = "";
  while (i < src.length) {
    const c = src[i]!;
    if (c === quote) return { value, end: i + 1 };
    if (c !== "\\") {
      value += c;
      i++;
      continue;
    }
    const escape = src[i + 1];
    if (escape === undefined) return { value, end: src.length };
    const simple: Record<string, string> = {
      "0": "\0",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
      "\\": "\\",
      "'": "'",
      '"': '"',
    };
    if (escape in simple) {
      value += simple[escape]!;
      i += 2;
    } else if (escape === "\n") {
      i += 2; // line continuation contributes no string character
    } else if (escape === "\r" && src[i + 2] === "\n") {
      i += 3;
    } else if (
      escape === "x" && /^[\da-fA-F]{2}$/.test(src.slice(i + 2, i + 4))
    ) {
      value += String.fromCharCode(parseInt(src.slice(i + 2, i + 4), 16));
      i += 4;
    } else if (escape === "u") {
      const braced = /^\{([\da-fA-F]+)\}/.exec(src.slice(i + 2));
      const fixed = /^[\da-fA-F]{4}/.exec(src.slice(i + 2));
      const hex = braced?.[1] ?? fixed?.[0];
      if (hex !== undefined) {
        value += String.fromCodePoint(parseInt(hex, 16));
        i += 2 + (braced ? braced[0].length : 4);
      } else {
        value += escape;
        i += 2;
      }
    } else {
      value += escape;
      i += 2;
    }
  }
  return { value, end: src.length };
}

const REGEX_AFTER = new Set([
  "return",
  "typeof",
  "case",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "instanceof",
  "do",
  "else",
  "yield",
  "await",
  "throw",
]);

function opensRegex(tokens: readonly Token[]): boolean {
  const prev = tokens[tokens.length - 1];
  if (prev?.value === ")" && closesControlCondition(tokens)) return true;
  if (prev === undefined) return true;
  if (prev.kind === "id" && REGEX_AFTER.has(prev.value)) return true;
  if (prev.kind === "id" || prev.kind === "string" || prev.value === "number") {
    return false;
  }
  if ([")", "]", "}"].includes(prev.value)) return false;
  return true;
}

/** A statement body may begin with a regex literal after an if/while/for condition. */
function closesControlCondition(tokens: readonly Token[]): boolean {
  let depth = 0;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const value = tokens[i]!.value;
    if (value === ")") depth++;
    else if (value === "(" && --depth === 0) {
      let keyword = tokens[i - 1];
      let beforeKeyword = tokens[i - 2];
      if (keyword?.value === "await" && beforeKeyword?.value === "for") {
        keyword = beforeKeyword;
        beforeKeyword = tokens[i - 3];
      }
      return keyword?.kind === "id" &&
        ["if", "while", "for"].includes(keyword.value) &&
        beforeKeyword?.value !== "." && beforeKeyword?.value !== "?.";
    }
  }
  return false;
}

function skipRegex(src: string, at: number): number {
  let i = at + 1;
  let inClass = false;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "\n") return i;
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) {
      i++;
      while (i < src.length && /[A-Za-z]/.test(src[i]!)) i++;
      return i;
    }
    i++;
  }
  return i;
}
