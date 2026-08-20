import { withoutComments } from "./source-view.ts";

/** Parse a deno.json's framework pins — the runtime pin (`imports."hazelnut"`), the lint-plugin pin
 *  (`lint.plugins[]`), and every OTHER framework import key — the one parser both the skew-time
 *  check and the edit-time `version-pin-skew` rule read, so the two can never disagree on what "the pins"
 *  are. Each pin is the framework-SOURCE identity: the specifier with its known entry tail stripped
 *  (`/mod.ts`, `/mod-core.ts`, `/verify/lint-plugin.ts`, `/invariants/lint-floor.ts`, `/lint`, a concern barrel's `/surface/<name>.ts`), so two
 *  entries resolve the same framework iff their identities are equal — across every pin shape (checkout
 *  `file://`, `--vendor` relative, registry specifier). `null` per pin when absent/unparseable; a malformed
 *  deno.json is all-empty.
 *
 *  `internalSkew` names the framework keys that resolve a DIFFERENT framework than `imports."hazelnut"`.
 *  Layering the surface turned one pin into six, and a skew between them is a half-upgraded app: the barrel
 *  from one checkout, `hazelnut/query` from another, with types that are structurally identical and
 *  nominally distinct. */
export function parseVersionPins(
  denoJson: string,
): {
  runtimePin: string | null;
  lintPin: string | null;
  internalSkew: readonly string[];
} {
  let parsed: {
    imports?: Record<string, unknown>;
    lint?: { plugins?: unknown };
  };
  try {
    parsed = JSON.parse(denoJson);
  } catch {
    return { runtimePin: null, lintPin: null, internalSkew: [] };
  }
  const identityOf = (url: unknown): string | null => {
    if (typeof url !== "string") return null;
    for (
      const tail of [
        "/mod.ts",
        "/mod-core.ts",
        "/verify/lint-plugin.ts",
        "/invariants/lint-floor.ts",
        "/lint",
      ]
    ) {
      if (url.endsWith(tail)) return url.slice(0, -tail.length);
    }
    const surface = url.match(/^(.*)\/surface\/[A-Za-z0-9_-]+\.ts$/);
    if (surface) return surface[1]!;
    // A prefix key's value is the same location written for import-map matching — `<identity>/`. Strip the
    // slash, never the segment before it: `file:///x/src/` is `file:///x/src`, the identity the barrel's
    // own `/mod-core.ts` strip produces.
    return url.replace(/\/$/, ""); // a bare registry specifier IS the identity (no entry tail to strip)
  };
  const plugins = Array.isArray(parsed.lint?.plugins)
    ? parsed.lint.plugins
    : [];
  const runtimePin = identityOf(parsed.imports?.["hazelnut"]);
  const internalSkew = runtimePin === null ? [] : Object.entries(
    parsed.imports ?? {},
  )
    .filter(([k]) =>
      k !== "hazelnut" &&
      (k.startsWith("hazelnut/") || k === "@hazelnut/core" ||
        k.startsWith("@hazelnut/core/"))
    )
    .filter(([, v]) => {
      const id = identityOf(v);
      return id !== null && id !== runtimePin;
    })
    .map(([k]) => k);
  return {
    runtimePin,
    lintPin: identityOf(
      plugins.find((p) =>
        typeof p === "string" &&
        (p.endsWith("/verify/lint-plugin.ts") ||
          p.endsWith("/invariants/lint-floor.ts") ||
          p.endsWith("/lint"))
      ),
    ),
    internalSkew,
  };
}

/** A node's `[start, end]` source offsets — present on every deno-lint AST node, not on its public type. */
type Ranged = { range: readonly [number, number] };

/** The `[start, end]` source span of any deno-lint node — the cast lives here once, so range-based
 *  passes don't each repeat the `as unknown as Ranged` idiom. */
// hazelnut-escape: deno-lint's public Node type omits `range`, present on every real node — one localized read.
export function rangeOf(node: Deno.lint.Node): readonly [number, number] {
  return (node as unknown as Ranged).range;
}

/** The deno-lint comment shape we read for the `// hazelnut-escape:` valve. */
export type LintComment = { value: string; range: readonly [number, number] };

/** 0-based line of a source offset (count of newlines before it). */
function lineOf(text: string, offset: number): number {
  let line = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

/** True iff a `// hazelnut-escape:` comment sits on the cast's own line or the line directly above it
 *  (09-verifier.md §type-escape). Only the marker's presence + adjacency is checked here, not the reason text. */
export function hasEscapeValve(
  text: string,
  comments: readonly LintComment[],
  nodeStart: number,
): boolean {
  const nodeLine = lineOf(text, nodeStart);
  return comments.some((c) => {
    if (!/^\s*hazelnut-escape:/.test(c.value)) return false;
    const commentLine = lineOf(text, c.range[0]);
    return commentLine === nodeLine || commentLine === nodeLine - 1;
  });
}

/** A SQL-statement OPENING SHAPE — each verb keyed to the token grammar that follows it in real SQL,
 *  so English prose is not read as DML: "we update the user" lacks UPDATE's `SET`, "select a plan from
 *  the list" has an article where SQL has a table name, and the DDL verbs were already keyed to their
 *  object keyword. A bare-verb set lets both prose past every rule gated on this at once. */
const NOT_ARTICLE =
  "(?!the\\b|a\\b|an\\b|your\\b|this\\b|these\\b|our\\b|its\\b)";
const SQL_IDENT = '(?:"[^"]+"|\\w+)(?:\\.(?:"[^"]+"|\\w+))*';
export const RAW_SQL = new RegExp(
  `\\bSELECT\\s+(?:(?:"[^"]+"|[\\w*]+)\\s*,\\s*)*(?:"[^"]+"|[\\w*]+)\\s+FROM\\s+${NOT_ARTICLE}` +
    `|\\bINSERT\\s+INTO\\b` +
    `|\\bUPDATE\\s+${SQL_IDENT}\\s+SET\\b` +
    `|\\bDELETE\\s+FROM\\s+${NOT_ARTICLE}` +
    `|\\bMERGE\\s+INTO\\b` +
    `|\\b(?:CREATE|DROP|ALTER|TRUNCATE|GRANT|REVOKE)\\s+(?:(?:OR\\s+REPLACE|IF\\s+(?:NOT\\s+)?EXISTS|UNIQUE|MATERIALIZED|TEMPORARY|TEMP|ONLY)\\s+)*(?:TABLE|INDEX|VIEW|SCHEMA|SEQUENCE|TYPE|FUNCTION|TRIGGER|DATABASE|EXTENSION|POLICY|ROLE|USER|ALL)\\b`,
  "i",
);

/** The owning module of a `modules/<owner>/…` source path, or null when the path is not module-scoped. */
export function owningModule(filename: string): string | null {
  const m = /(?:^|\/)modules\/([^/]+)\//.exec(filename);
  return m ? m[1]! : null;
}

/** Source text with line and block comments blanked out, strings preserved — so a `emits:` written in prose
 *  ("the `emits:` card") is not read as a declaration. One scanner with the structural rung (`source-view.ts`). */
function stripComments(src: string): string {
  return withoutComments(src);
}

/** The top-level comma-separated segments of the `{…}`/`[…]` literal opening at `open`, or null when the
 *  literal is unterminated or closed by the wrong bracket. */
function literalSegments(src: string, open: number): string[] | null {
  const closer = src[open] === "{" ? "}" : "]";
  const segs: string[] = [];
  let depth = 0;
  let segStart = open + 1;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < src.length && src[i] !== c) i += src[i] === "\\" ? 2 : 1;
      continue;
    }
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") {
      if (--depth === 0) {
        segs.push(src.slice(segStart, i));
        return c === closer ? segs : null;
      }
    } else if (c === "," && depth === 1) {
      segs.push(src.slice(segStart, i));
      segStart = i + 1;
    }
  }
  return null;
}

/** The topics a `defineModule` source declares in `emits` — both the string-array and the typed-object form.
 *  Null when an `emits:` is present but NOT statically readable (bound to a reference, a spread, a computed
 *  key): an incomplete topic set would fire the emit gate on a legal emit, so the caller must not judge. */
export function declaredEmitTopics(source: string): string[] | null {
  const src = stripComments(source);
  const out: string[] = [];
  const re = /\bemits\s*:\s*/g;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    const open = m.index + m[0].length;
    if (src[open] !== "{" && src[open] !== "[") return null;
    const segs = literalSegments(src, open);
    if (segs === null) return null;
    const isArray = src[open] === "[";
    for (const seg of segs) {
      const s = seg.trim();
      if (s === "") continue;
      const str = /^(["'])([^"'\\]*)\1/.exec(s);
      if (isArray) {
        if (!str || s.slice(str[0].length).trim() !== "") return null;
      } else if (str) {
        if (!/^\s*:/.test(s.slice(str[0].length))) return null;
      } else {
        const ident = /^([A-Za-z_$][\w$]*)\s*:/.exec(s);
        if (!ident) return null; // a spread / computed key / shorthand — not statically readable
        out.push(ident[1]!);
        continue;
      }
      out.push(str[2]!);
    }
  }
  return out;
}

/** The module names a source declares — one per `defineModule({ name: "…" })`. Used for the emit gate's
 *  diagnostic, so a reader is told WHICH module's `emits` the topic is missing from. */
export function declaredModuleNames(source: string): string[] {
  const src = stripComments(source);
  const out: string[] = [];
  const re = /\bdefineModule\s*\(\s*/g;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    const open = m.index + m[0].length;
    if (src[open] !== "{") continue;
    const segs = literalSegments(src, open);
    if (segs === null) continue;
    for (const seg of segs) {
      const nm = /^\s*name\s*:\s*(["'])([^"'\\]*)\1/.exec(seg);
      if (nm) {
        out.push(nm[2]!);
        break;
      }
    }
  }
  return out;
}

/** One `define*(…)` call found in a source, with everything the registration rung needs to judge it.
 *  `name` is null when the identity is not a static literal; `eager` is false when the call is not the
 *  direct initializer of a top-level `const` — both mean UNCHECKABLE, never "clean". */
export interface DeclCallSite {
  readonly call: string; // the `define*` verb, verbatim
  readonly name: string | null; // top-level `name:` string literal, or null (not statically readable)
  readonly eager: boolean; // a top-level `const x = define*(…)` — the only form whose composition is knowable
  readonly line: number; // 1-based line of the callee identifier
}

/** True iff the `const x = ` (or `export const x: T = `) initializer position ends at `end`. The lookback is
 *  bounded, so a whole-file scan stays linear; an arrow body (`… => define*(`) ends in `>`, never `=`. */
function isConstInitializer(src: string, end: number): boolean {
  const back = src.slice(Math.max(0, end - 240), end);
  return /(?:^|[;}\s])(?:export\s+)?const\s+[A-Za-z_$][\w$]*\s*(?::[^=;]*)?=\s*$/
    .test(back);
}

/** Brace depth at `at` — 0 means module top level. Strings are skipped so a `{` inside a literal is inert. */
function braceDepthAt(src: string, at: number): number {
  let depth = 0;
  for (let i = 0; i < at; i++) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < at && src[i] !== c) i += src[i] === "\\" ? 2 : 1;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
  }
  return depth;
}

/** Index of the `(` opening a call whose callee identifier ends at `from`, skipping one balanced type-argument
 *  list (`defineJob<[typeof t]>(`). Null when nothing between the identifier and a `(` parses — the caller
 *  then records the site as unreadable rather than dropping it. */
function callOpenAfter(src: string, from: number): number | null {
  let i = from;
  while (i < src.length && /\s/.test(src[i]!)) i++;
  if (src[i] === "<") {
    // `{`, `(` and `;` are all legal inside a type argument (an object type's members, a function type),
    // so ONLY `<`/`>` depth closes the list; `=>` is not a closer. Bounded, so a `<` that was really a
    // comparison ends the scan instead of running to EOF.
    const limit = Math.min(src.length, i + 400);
    let depth = 0;
    for (; i < limit; i++) {
      const c = src[i]!;
      if (c === '"' || c === "'" || c === "`") {
        i++;
        while (i < limit && src[i] !== c) i += src[i] === "\\" ? 2 : 1;
        continue;
      }
      if (c === "<") depth++;
      else if (c === ">" && src[i - 1] !== "=") {
        if (--depth === 0) {
          i++;
          break;
        }
      }
    }
    if (depth !== 0) return null;
    while (i < src.length && /\s/.test(src[i]!)) i++;
  }
  return src[i] === "(" ? i : null;
}

/**
 * Every `define*(…)` call site in a source, for the callee names asked for. Source-scanned (never imported —
 * the same blast-radius rule the prompt/invariant globs carry): a declaration file is read as text, so
 * discovery costs no app boot and no side effect.
 */
export function declaredCallSites(
  source: string,
  calls: ReadonlySet<string>,
): DeclCallSite[] {
  // Import/re-export specifiers name the same identifiers and are not call sites; blanked line-preserving
  // so the reported line still points at the declaration.
  const src = stripComments(source).replace(
    /^[ \t]*(?:import|export)\s[^;]*?\bfrom\s*(["'])[^"']*\1\s*;?/gm,
    (m) => m.replace(/[^\n]/g, " "),
  );
  const out: DeclCallSite[] = [];
  const re = /\b(define[A-Z][A-Za-z0-9_$]*)\b/g;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    const call = m[1]!;
    if (!calls.has(call)) continue;
    const idEnd = m.index + call.length;
    const line = src.slice(0, m.index).split("\n").length;
    const eager = braceDepthAt(src, m.index) === 0 &&
      isConstInitializer(src, m.index);
    // an identifier that no `(` (or a type-argument list leading to one) follows is not a call at all — a
    // property key `defineTask:`, a string `"defineTask"`, a bare re-export. Dropping those keeps a mention
    // of the verb in ordinary prose-shaped code out of the walk; an unreadable type-argument list still
    // records the site, because there a call really is being made and the rung cannot read it.
    let after = idEnd;
    while (after < src.length && /\s/.test(src[after]!)) after++;
    if (src[after] !== "(" && src[after] !== "<") continue;
    const open = callOpenAfter(src, idEnd);
    let name: string | null = null;
    if (open !== null) {
      let j = open + 1;
      while (j < src.length && /\s/.test(src[j]!)) j++;
      if (src[j] === "{") {
        const segs = literalSegments(src, j);
        for (const seg of segs ?? []) {
          const nm = /^\s*name\s*:\s*(["'])([^"'\\]*)\1\s*$/.exec(seg);
          if (nm) {
            name = nm[2]!;
            break;
          }
        }
      }
    }
    out.push({ call, name, eager, line });
  }
  return out;
}

/** Every RELATIVE specifier a source pulls a binding from — `from "…"`, `import("…")`, a bare
 *  `import "…"`, and the re-export form. Comments are blanked first, so a specifier written in prose
 *  is not an edge. */
function relativeImports(source: string): string[] {
  const src = stripComments(source);
  const out: string[] = [];
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.[^"']*)\1/g;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) out.push(m[2]!);
  return out;
}

/** A `./`-relative specifier resolved against the importing file, or null when it is not relative. */
export function resolveRelative(fromFile: string, spec: string): string | null {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null;
  const parts = fromFile.slice(0, fromFile.lastIndexOf("/")).split("/");
  for (const seg of spec.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

// ── one-hop resolution ACROSS files (`policy/custom-read-applies-rowpolicy`) ──────────────────────────
// A rule that resolves helpers only within the file it is linting is turned OFF by `sql/raw-only-in-queries`
// and `placement/queries`, which REQUIRE raw SQL to move out of the declaration file into `queries/`. Obeying
// one framework rule must not disarm another, so the resolver follows the relative import graph.

/** How many files one exported-binding lookup may read, re-export hops included. A `queries/` seam is
 *  shallow; the budget bounds a pathological or cyclic barrel chain, and running out yields "unresolved"
 *  (the caller then cannot judge) rather than a wrong verdict. */
const EXPORT_LOOKUP_BUDGET = 8;

/** file path → its comment-blanked source (null when unreadable), stamped with the mtime+size it was read at.
 *  Keyed on the STAMP, not the path alone: the plugin module outlives one file under `Deno.lint.runPlugin`,
 *  so a path-only memo serves a rewritten fixture its previous contents and turns a tooth green on the wrong
 *  source. `deno lint` reads each file once either way. */
const sourceByFile = new Map<string, { stamp: string; code: string | null }>();

function readCode(file: string): string | null {
  let stamp: string;
  try {
    const st = Deno.statSync(file);
    stamp = `${st.mtime?.getTime() ?? 0}:${st.size}`;
  } catch {
    return null; // unreadable (a synthetic lint filename, a bare-specifier target) — cannot judge
  }
  const cached = sourceByFile.get(file);
  if (cached !== undefined && cached.stamp === stamp) return cached.code;
  let code: string | null;
  try {
    code = stripComments(Deno.readTextFileSync(file));
  } catch {
    code = null;
  }
  sourceByFile.set(file, { stamp, code });
  return code;
}

/** A char an expression cannot END on, so a line break after it CONTINUES the declaration. `>` covers `=>` —
 *  the shape `deno fmt` produces the instant an expression-bodied arrow passes the line width. */
const CONTINUES_AFTER: ReadonlySet<string> = new Set([
  ..."=+-*/%&|^!~?:,.([{<>",
]);
/** A char a statement cannot BEGIN with, so a line break before it CONTINUES the declaration (`.foo()`,
 *  `? a : b`, `+ x`) even when that continuation was written flush at column 0. */
const CONTINUES_BEFORE: ReadonlySet<string> = new Set([
  ..."=+-*/%&|^?:,.)]}<>`([",
]);

/** True iff the newline at `nl` ENDS the declaration that began at `start`, rather than merely wrapping it.
 *  A wrapped line is recognised three ways, so re-flowing source can never shorten a span: the previous line
 *  ends mid-expression, the next line is indented (every `deno fmt` continuation is), or the next line opens
 *  with a char no statement can start with. */
function declarationEndsAt(code: string, start: number, nl: number): boolean {
  let b = nl - 1;
  while (b >= start && /\s/.test(code[b]!)) b--;
  if (b < start || CONTINUES_AFTER.has(code[b]!)) return false;
  const next = code[nl + 1];
  if (next === undefined) return false; // EOF — the caller's whole-tail slice is the span
  if (next === " " || next === "\t") return false; // an indented line continues the declaration
  let f = nl + 1;
  while (f < code.length && /\s/.test(code[f]!)) f++;
  return f < code.length && !CONTINUES_BEFORE.has(code[f]!);
}

/** The source span of the top-level `export`ed binding `name` in `code`: the declaration keyword through the
 *  end of its body/initializer, found by bracket depth (string literals skipped). Null when `name` is not
 *  declared-and-exported here. `"default"` matches `export default`.
 *
 *  The span MUST NOT change when the source is re-flowed. `deno fmt` is mandated by `fmt:check`, and a span
 *  that stopped at the first newline handed callers a bare signature for every wrapped arrow — running the
 *  house formatter silently emptied the body every source-reading rule then judged. */
function exportedSpan(code: string, name: string): string | null {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const head = name === "default" ? /\bexport\s+default\s+/ : new RegExp(
    `\\bexport\\s+(?:async\\s+)?(?:function\\s*\\*?\\s+|const\\s+|let\\s+|var\\s+|class\\s+)${esc}\\b`,
  );
  const m = head.exec(code);
  if (m === null) return null;
  const start = m.index;
  let depth = 0;
  for (let i = start + m[0].length; i < code.length; i++) {
    const c = code[i]!;
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < code.length && code[i] !== c) i += code[i] === "\\" ? 2 : 1;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth <= 0 && c === ";") return code.slice(start, i);
    else if (depth <= 0 && c === "\n" && declarationEndsAt(code, start, i)) {
      return code.slice(start, i);
    }
  }
  return code.slice(start); // runs to EOF — a one-expression file, still a whole declaration
}

/** The specifier a `export { <name> } from "…"` / `export * from "…"` re-export routes `name` through. */
function reExportSpecifierFor(code: string, name: string): string | null {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const named = new RegExp(
    `\\bexport\\s*\\{[^}]*\\b${esc}\\b[^}]*\\}\\s*from\\s*["']([^"']+)["']`,
  ).exec(code);
  if (named !== null) return named[1]!;
  const star = /\bexport\s*\*\s*from\s*["']([^"']+)["']/.exec(code);
  return star !== null ? star[1]! : null;
}

/**
 * The source of the binding `name` exported by `file` — following `export … from` re-exports across relative
 * specifiers — or null when it cannot be resolved (unreadable file, non-relative hop, budget exhausted). Null
 * means CANNOT JUDGE, never CLEAN: the caller must not report on it.
 */
export function exportedBindingSource(
  file: string,
  name: string,
  budget = EXPORT_LOOKUP_BUDGET,
): string | null {
  if (budget <= 0) return null;
  const code = readCode(file);
  if (code === null) return null;
  const own = exportedSpan(code, name);
  if (own !== null) return own;
  const spec = reExportSpecifierFor(code, name);
  if (spec === null) return null;
  const next = resolveRelative(file, spec);
  return next === null ? null : exportedBindingSource(next, name, budget - 1);
}

/** How many files one module root's import closure may reach — a lint pass runs per file, so the walk is
 *  bounded rather than unbounded-but-memoized. Exceeding it shrinks a closure, which can only widen the
 *  judged topic set (the union), never narrow it onto the wrong module. */
const CLOSURE_BUDGET = 512;

/** The module declarations governing one directory: what each `*.module.ts` declares, and which source files
 *  each one OWNS. */
type DirModules = {
  /** module-file path → the names it declares and the topics it emits. */
  readonly decls: ReadonlyMap<
    string,
    { readonly names: readonly string[]; readonly topics: ReadonlySet<string> }
  >;
  /** every declared topic in the directory — the bound used when no single declaration claims a file. */
  readonly union: ReadonlySet<string>;
  /** source file → the module file that SOLELY claims it; a contested or unclaimed file is absent. */
  readonly ownerOf: ReadonlyMap<string, string>;
};

/**
 * Which module owns each file under `dir`: the import closure of every `*.module.ts` root, minus the edges
 * INTO another root (a `.module.ts` is a sibling module's declaration, never a member of this one). Under
 * `boundary/no-internal-import` a module never imports another's internals, so one root's closure is that
 * module's own files; a file two roots reach is shared, and stays unowned rather than guessed.
 */
function ownershipUnder(
  dir: string,
  roots: readonly string[],
): Map<string, string> {
  const claims = new Map<string, Set<string>>();
  for (const root of roots) {
    const seen = new Set<string>([root]);
    const stack = [root];
    let budget = CLOSURE_BUDGET;
    while (stack.length > 0 && budget-- > 0) {
      const from = stack.pop()!;
      let src: string;
      try {
        src = Deno.readTextFileSync(from);
      } catch {
        continue; // an unreadable edge only shrinks this closure — the union then governs, never a wrong module.
      }
      for (const spec of relativeImports(src)) {
        const target = resolveRelative(from, spec);
        if (target === null) continue;
        if (!target.startsWith(`${dir}/`)) continue;
        if (target.endsWith(".module.ts")) continue;
        if (seen.has(target)) continue;
        seen.add(target);
        stack.push(target);
      }
    }
    for (const f of seen) {
      const holders = claims.get(f) ?? new Set<string>();
      holders.add(root);
      claims.set(f, holders);
    }
  }
  const owner = new Map<string, string>();
  for (const [f, holders] of claims) {
    if (holders.size === 1) owner.set(f, [...holders][0]!);
  }
  return owner;
}

function listingStamp(
  dir: string,
  keep: (name: string) => boolean,
): string | null {
  try {
    const parts: string[] = [];
    for (const e of Deno.readDirSync(dir)) {
      if (!e.isFile || !keep(e.name)) continue;
      try {
        const st = Deno.statSync(`${dir}/${e.name}`);
        parts.push(`${e.name}:${st.mtime?.getTime() ?? 0}:${st.size}`);
      } catch {
        parts.push(`${e.name}:gone`);
      }
    }
    return parts.sort().join("|");
  } catch {
    return null;
  }
}

/** `"climb"` = the directory holds no declaration and is not the app root; `null` = one is present but
 *  unreadable. Memoized with a listing stamp (mtime+size) so a rewrite of `*.module.ts` is re-read. */
const modulesByDir = new Map<
  string,
  { stamp: string; value: DirModules | null | "climb" }
>();

/** The emit bound governing one source file. */
export interface EmitGovernance {
  /** The topics the emit is judged against. */
  readonly topics: ReadonlySet<string>;
  /** The owning module's declared name(s), or null when no single declaration claims this file — the
   *  directory-wide union then governs, which is looser but never a false flag. */
  readonly owner: string | null;
}

/**
 * The `emits` bound governing a source file, and the module it belongs to: the nearest ancestor directory
 * holding `*.module.ts` declarations decides, the climb stopping at the app root (the directory with a
 * `deno.json`). Null when no declaration is reachable or one is unreadable — the caller then cannot judge.
 * Memoized per directory: one `deno lint` run reads each module declaration once.
 */
export function emitGovernanceFor(filename: string): EmitGovernance | null {
  const path = filename.replaceAll("\\", "/");
  if (!path.includes("/")) return null;
  let dir = path.slice(0, path.lastIndexOf("/"));
  for (; dir !== "" && dir !== "."; dir = dir.slice(0, dir.lastIndexOf("/"))) {
    const scanned = scanModuleDir(dir);
    if (scanned === "climb") continue; // no declarations here and not the app root — keep climbing.
    if (scanned === null) return null; // a declaration is present but unreadable — cannot judge.
    const root = scanned.ownerOf.get(path);
    const decl = root === undefined ? undefined : scanned.decls.get(root);
    return decl === undefined
      ? { topics: scanned.union, owner: null }
      : { topics: decl.topics, owner: decl.names.join("+") || null };
  }
  return null;
}

/** Scan one directory's `*.module.ts` declarations: `"climb"` when it holds none and is not the app root,
 *  `null` when a declaration is present but unreadable, the parsed set otherwise. Memoizes its own verdict. */
function scanModuleDir(dir: string): DirModules | null | "climb" {
  const stamp = listingStamp(
    dir,
    (n) => n === "deno.json" || n === "deno.jsonc" || n.endsWith(".module.ts"),
  );
  if (stamp === null) return null; // unreadable directory (a synthetic lint filename) — cannot judge.
  const cached = modulesByDir.get(dir);
  if (cached !== undefined && cached.stamp === stamp) return cached.value;
  const files: string[] = [];
  let atAppRoot = false;
  try {
    for (const e of Deno.readDirSync(dir)) {
      if (!e.isFile) continue;
      if (e.name === "deno.json" || e.name === "deno.jsonc") atAppRoot = true;
      if (e.name.endsWith(".module.ts")) files.push(`${dir}/${e.name}`);
    }
  } catch {
    return null;
  }
  if (files.length === 0) {
    // the app root declares no module → nothing owns this file's emits; below it, keep climbing.
    const verdict = atAppRoot ? null : "climb";
    modulesByDir.set(dir, { stamp, value: verdict });
    return verdict;
  }
  const decls = new Map<
    string,
    { names: readonly string[]; topics: ReadonlySet<string> }
  >();
  const union = new Set<string>();
  for (const file of files.sort()) {
    let src: string;
    try {
      src = Deno.readTextFileSync(file);
    } catch {
      modulesByDir.set(dir, { stamp, value: null });
      return null;
    }
    const declared = declaredEmitTopics(src);
    if (declared === null) {
      modulesByDir.set(dir, { stamp, value: null });
      return null; // not statically readable → an incomplete set would flag a legal emit.
    }
    decls.set(file, {
      names: declaredModuleNames(src),
      topics: new Set(declared),
    });
    for (const t of declared) union.add(t);
  }
  const scanned: DirModules = {
    decls,
    union,
    ownerOf: ownershipUnder(dir, files),
  };
  modulesByDir.set(dir, { stamp, value: scanned });
  return scanned;
}

/** True iff a source path is inside the `queries/` raw-SQL seam (the only place raw SQL is allowed).
 *  deno-lint hands Windows paths with `\` separators — normalized before the segment tests. */
export function isQueriesSeam(filename: string): boolean {
  const f = filename.replaceAll("\\", "/");
  return /(?:^|\/)queries\//.test(f) || /(?:^|\/)queries\.ts$/.test(f);
}

/** True iff a source path is inside the `logic/` seam — the home of custom-op handlers. */
export function isLogicSeam(filename: string): boolean {
  // a `*.test.ts` under logic/ is a TEST seam, not a logic seam: assertions throw by nature and probes may
  // touch io/SQL directly, so the logic-purity rules (no-throw, no-external-io, orphan-binding, …) must not
  // fire on it — e.g. the born-RED op-test stub `add resource --ops` emits next to its op.
  if (/\.test\.ts$/.test(filename)) return false;
  const f = filename.replaceAll("\\", "/");
  return /(?:^|\/)logic\//.test(f) || /(?:^|\/)logic\.ts$/.test(f);
}

/**
 * The `define*` constructors that declare a REGISTERABLE thing and therefore have a declaration home
 * (`03-api-shape.md §declaration-homes`). ONE list, THREE readers: the home a verb belongs in, the rule that
 * sends it there, and the registration walk. Held equal to the registration rung's classification
 * of the framework's shipped constructors, so a verb cannot arrive with a placement rule and no home,
 * or a home no rule pushes into.
 */
export const DECLARATION_VERBS = [
  "defineResource",
  "defineModule",
  "defineView",
  "definePrompt",
  "defineJob",
  "defineSubscriber",
  "defineWorker",
  "defineTask",
  "defineWorkflow",
  "defineReadModel",
  "defineWebhook",
  "defineEval",
] as const;

/** A declaration verb's home suffix — its own name, lowercased (`defineReadModel` → `*.readmodel.ts`). */
export function declarationSuffixOf(verb: string): string {
  return verb.slice("define".length).toLowerCase();
}

/** The declaration-file basename suffixes, DERIVED from the verb list — never a parallel literal. */
export const DECLARATION_FILE_SUFFIXES: readonly string[] = DECLARATION_VERBS
  .map(declarationSuffixOf);

/** declaration-file basename shape, derived from the suffix door set. `logic/x.ts` is not one. */
const DECL_FILE = new RegExp(
  `\\.(${DECLARATION_FILE_SUFFIXES.join("|")})\\.ts$`,
);

/** True iff a source path is a DECLARATION file — the basename-suffix convention the framework
 *  discovers by. */
export function isDeclarationFile(filename: string): boolean {
  return DECL_FILE.test(filename);
}

/** The set of declaration constructors keyed by `placement/declaration` — the same list the homes derive
 *  from, so obeying the rule always lands the call in a file the registration walk reads. */
const DEFINE_CALLS: ReadonlySet<string> = new Set(DECLARATION_VERBS);

/** True iff a callee is one of the `define*` declaration constructors as a bare `Identifier` callee
 *  (`defineResource({…})`). A member call like `helpers.defineResource()` does not match. */
export function isDefineCall(callee: Deno.lint.Node): boolean {
  return callee.type === "Identifier" && DEFINE_CALLS.has(callee.name);
}

/** A schema-qualified table reference in TABLE POSITION — `FROM <schema>.<table>` / `JOIN <schema>.<table>`
 *  — schema in capture 1. Keyed to FROM/JOIN so a SELECT-list `alias.column` is not mistaken for a schema. */
const TABLE_SCHEMA = /\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)\.[a-z_][a-z0-9_]*/gi;
/** A SQL JOIN keyword — the cross-module reach happens only inside a JOIN. */
const SQL_JOIN = /\bJOIN\b/i;

/** True iff a raw-SQL string is a CROSS-MODULE join: a `JOIN` plus either two or more DISTINCT
 *  `<schema>.<table>` names in table position, or — when the reading file's `owner` module is known — a single
 *  schema that is not the owner's. Schema-per-module means a join wholly inside ANOTHER module's schema is the
 *  same reach as a two-schema join; a distinct-count gate alone reads it as clean. An unqualified join or an
 *  `alias.column` ref alone is not cross-module. */
export function isCrossSchemaJoin(
  sql: string,
  owner?: string | null,
): boolean {
  if (!RAW_SQL.test(sql) || !SQL_JOIN.test(sql)) return false;
  const schemas = new Set<string>();
  for (const m of sql.matchAll(TABLE_SCHEMA)) schemas.add(m[1]!.toLowerCase());
  if (schemas.size >= 2) return true;
  return schemas.size === 1 && owner != null &&
    !schemas.has(owner.toLowerCase());
}

/** True iff a table-reference NAME is the i18n sidecar `<r>_i18n` (`04-features.md §translatable`, a
 *  deterministic suffix, never the model). The required non-empty `<r>_` prefix keeps `i18n_config` /
 *  `i18nHelper` from being mistaken for the sidecar. */
export function isI18nSidecarName(name: string): boolean {
  return /^[a-z_][a-z0-9_]*_i18n$/i.test(name);
}

/** A table-position reference to an `<r>_i18n` sidecar in raw SQL — `FROM/INTO/UPDATE/JOIN <r>_i18n` — the
 *  direct-touch shape `i18n/no-bypass-resolve` forbids in `logic/`. An `alias.title_i18n` column ref is not a match. */
const I18N_TABLE_REF =
  /\b(?:FROM|INTO|UPDATE|JOIN)\s+"?([a-z_][a-z0-9_]*_i18n)"?/i;

/** True iff a raw-SQL string reads/writes an `<r>_i18n` sidecar table directly (a table-position reference). */
export function touchesI18nSidecar(sql: string): boolean {
  return I18N_TABLE_REF.test(sql);
}

/** True iff `callee` is a TABLE-SEAM method (`.from` / `.into`) — the typed query-layer doors taking a
 *  table reference as their first argument. Gates the i18n-sidecar direct-touch check for read (`.from`) or write (`.into`). */
export function isTableSeamCallee(callee: Deno.lint.Node): boolean {
  return callee.type === "MemberExpression" &&
    callee.property.type === "Identifier" &&
    (callee.property.name === "from" || callee.property.name === "into");
}

/** True iff `callee` is `ctx.data.<resource>.{create,update}` — the write-door subset that can carry a
 *  `status` value (`transition/status-not-bypassed`). Excludes `delete` (no column patch to bypass through). */
export function isCtxDataCreateOrUpdate(callee: Deno.lint.Node): boolean {
  if (
    callee.type !== "MemberExpression" || callee.property.type !== "Identifier"
  ) return false;
  if (callee.property.name !== "create" && callee.property.name !== "update") {
    return false;
  }
  return isCtxDataWrite(callee);
}

/** The NAME of an object-literal property key, for both forms an app can write — `{ status: … }` and the
 *  quoted `{ "status": … }`. An Identifier-only key read is blind to the quoted form, which is legal TS and
 *  the same write. Null for a computed/numeric key. */
export function propKeyName(p: Deno.lint.Node): string | null {
  if (p.type !== "Property") return null;
  if (p.key.type === "Identifier") return p.key.name;
  if (p.key.type === "Literal" && typeof p.key.value === "string") {
    return p.key.value;
  }
  return null;
}

/** True iff an object-expression argument carries a `status` key (the column `ctx.transition` solely owns). */
export function hasStatusKey(arg: Deno.lint.Node | undefined): boolean {
  if (arg?.type !== "ObjectExpression") return false;
  return arg.properties.some((p) => propKeyName(p) === "status");
}

/** The PATCH argument of a repo write call, indexed by the face's REAL signature (`03-api-shape.md §2`):
 *  `create(input)` carries the columns first, `update(id, patch, expectedVersion?)` second. Reading argument 0
 *  for an update sees the id, so a column-patch check on it is blind to every update a typed app can write. */
export function writePatchArg(
  callee: Deno.lint.Node,
  args: readonly Deno.lint.Node[],
): Deno.lint.Node | undefined {
  if (
    callee.type !== "MemberExpression" || callee.property.type !== "Identifier"
  ) return undefined;
  return callee.property.name === "update" ? args[1] : args[0];
}

/** True iff `callee` is `ctx.data.<resource>.<method>` for a mutating `method` (create/update/delete) —
 *  the repo WRITE door (`05-runtime.md §ctx.data`), a 3-deep chain rooted at `ctx.data` so a same-named
 *  `.create` on an unrelated object does not match. */
export function isCtxDataWrite(callee: Deno.lint.Node): boolean {
  if (
    callee.type !== "MemberExpression" || callee.property.type !== "Identifier"
  ) return false;
  if (!["create", "update", "delete"].includes(callee.property.name)) {
    return false;
  }
  const resourceMember = callee.object; // ctx.data.<resource>
  if (resourceMember.type !== "MemberExpression") return false;
  const dataMember = resourceMember.object; // ctx.data
  return dataMember.type === "MemberExpression" &&
    dataMember.object.type === "Identifier" &&
    dataMember.object.name === "ctx" &&
    dataMember.property.type === "Identifier" &&
    dataMember.property.name === "data";
}

/** The `where.ts` Condition-builder callee names (`eq`/`like`/…) whose FIRST argument is a column accessor
 *  (`fields.<col>` / `f.<col>`). Used by `encrypted/no-where` to spot a predicate over an encrypted column. */
export const WHERE_BUILDERS = new Set([
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "inArray",
  "isNull",
]);

/** The `equality` list of an object-form `encrypted` card (04-features.md §encrypted equality) — fields
 *  whose eq/inArray/isNull predicates are legal (rewritten onto the `<f>_bidx` blind index). The list form
 *  declares no equality, so it contributes nothing. */
export function equalityColsOf(obj: Deno.lint.Node): string[] {
  if (obj.type !== "ObjectExpression") return [];
  const prop = obj.properties.find((p) =>
    p.type === "Property" && p.key.type === "Identifier" &&
    p.key.name === "encrypted"
  );
  if (prop?.type !== "Property" || prop.value.type !== "ObjectExpression") {
    return [];
  }
  const eq = prop.value.properties.find((p) =>
    p.type === "Property" && p.key.type === "Identifier" &&
    p.key.name === "equality"
  );
  if (eq?.type !== "Property" || eq.value.type !== "ArrayExpression") return [];
  return eq.value.elements.flatMap((
    e,
  ) => (e?.type === "Literal" && typeof e.value === "string" ? [e.value] : []));
}

/** The string entries of an `encrypted: [...]` array (or object-form `{fields: [...]}`) property on a
 *  declaration object — `encrypted/no-where` reads it self-contained from the same literal. Returns []
 *  when absent / not a plain string-array. */
export function encryptedColsOf(obj: Deno.lint.Node): string[] {
  if (obj.type !== "ObjectExpression") return [];
  const prop = obj.properties.find((p) =>
    p.type === "Property" && p.key.type === "Identifier" &&
    p.key.name === "encrypted"
  );
  if (prop?.type !== "Property") return [];
  // list form `encrypted: ["ssn"]`
  const fromArray = (arr: Deno.lint.Node): string[] =>
    arr.type === "ArrayExpression"
      ? arr.elements.flatMap((
        e,
      ) => (e?.type === "Literal" && typeof e.value === "string"
        ? [e.value]
        : [])
      )
      : [];
  if (prop.value.type === "ArrayExpression") return fromArray(prop.value);
  // object form `encrypted: { fields: ["ssn"], … }`
  if (prop.value.type === "ObjectExpression") {
    const fields = prop.value.properties.find((p) =>
      p.type === "Property" && p.key.type === "Identifier" &&
      p.key.name === "fields"
    );
    if (fields?.type === "Property") return fromArray(fields.value);
  }
  return [];
}

// ── the encrypted set ACROSS the module (`encrypted/no-where`) ────────────────────────────────────────
// The set was file-wide, read off co-located `defineResource` literals. But `placement/declaration` keeps
// every declaration in a `*.resource.ts` and `placement/logic` keeps every handler in `logic/` — so in an
// app that obeys the framework the two are NEVER the same file and the set is always empty. The scope is
// therefore the owning MODULE, which is where a `ctx.data.<r>` face and its columns live anyway. The union
// carries the same imprecision it always did (two resources sharing a column name are not told apart);
// widening it from file to module changes the reach, not that trade-off.

/** The `encrypted` / `equality` column names a declaration SOURCE declares, read from text. Mirrors
 *  `encryptedColsOf`/`equalityColsOf` for files we have no AST for. */
function encryptedColsInSource(
  src: string,
): { encrypted: string[]; equality: string[] } {
  const code = stripComments(src);
  const encrypted: string[] = [];
  const equality: string[] = [];
  const strings = (seg: string): string[] =>
    [...seg.matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]!);
  const re = /\bencrypted\s*:\s*/g;
  for (let m = re.exec(code); m !== null; m = re.exec(code)) {
    const open = m.index + m[0].length;
    if (code[open] === "[") {
      const segs = literalSegments(code, open);
      if (segs !== null) {
        for (const s of segs) encrypted.push(...strings(s));
      }
      continue;
    }
    if (code[open] !== "{") continue;
    const segs = literalSegments(code, open);
    if (segs === null) continue;
    for (const seg of segs) {
      const key = /^\s*["']?([A-Za-z_$][\w$]*)["']?\s*:/.exec(seg)?.[1];
      if (key !== "fields" && key !== "equality") continue;
      const bucket = key === "fields" ? encrypted : equality;
      bucket.push(...strings(seg.slice(seg.indexOf(":") + 1)));
    }
  }
  return { encrypted, equality };
}

/** dir → the encrypted/equality union of every declaration file at or below it, memoized with a listing stamp. */
const encryptedByDir = new Map<
  string,
  {
    stamp: string;
    value: { encrypted: Set<string>; equality: Set<string> } | "climb";
  }
>();

/**
 * The encrypted (and equality-exempt) column names in scope for a source file: the union declared by the
 * declaration files of its OWNING MODULE — the nearest ancestor directory that holds any, stopping at the
 * app root (a directory with a `deno.json`). Empty when nothing is reachable: an unreadable tree must never
 * manufacture a column name, because this rule is ship-blocking.
 */
export function encryptedColsInScope(
  filename: string,
): { encrypted: ReadonlySet<string>; equality: ReadonlySet<string> } {
  const path = filename.replaceAll("\\", "/");
  const empty = { encrypted: new Set<string>(), equality: new Set<string>() };
  if (!path.includes("/")) return empty;
  let dir = path.slice(0, path.lastIndexOf("/"));
  for (; dir !== "" && dir !== "."; dir = dir.slice(0, dir.lastIndexOf("/"))) {
    const scanned = scanEncryptedDir(dir);
    if (scanned === "climb") continue;
    return scanned;
  }
  return empty;
}

/** One directory's declaration union, or `"climb"` when it holds no declaration and is not the app root. */
function scanEncryptedDir(
  dir: string,
): { encrypted: Set<string>; equality: Set<string> } | "climb" {
  const stamp = listingStamp(
    dir,
    (n) => n === "deno.json" || n === "deno.jsonc" || DECL_FILE.test(n),
  );
  if (stamp === null) {
    return "climb"; // unreadable (a synthetic lint filename) — keep climbing, never invent a column
  }
  const memo = encryptedByDir.get(dir);
  if (memo !== undefined && memo.stamp === stamp) return memo.value;
  const files: string[] = [];
  let atAppRoot = false;
  try {
    for (const e of Deno.readDirSync(dir)) {
      if (!e.isFile) continue;
      if (e.name === "deno.json" || e.name === "deno.jsonc") atAppRoot = true;
      if (DECL_FILE.test(e.name)) files.push(`${dir}/${e.name}`);
    }
  } catch {
    return "climb";
  }
  if (files.length === 0 && !atAppRoot) {
    encryptedByDir.set(dir, { stamp, value: "climb" });
    return "climb";
  }
  const out = { encrypted: new Set<string>(), equality: new Set<string>() };
  for (const file of files.sort()) {
    let src: string;
    try {
      src = Deno.readTextFileSync(file);
    } catch {
      continue; // one unreadable declaration only shrinks the set — never a false ship-block
    }
    const cols = encryptedColsInSource(src);
    for (const c of cols.encrypted) out.encrypted.add(c);
    for (const c of cols.equality) out.equality.add(c);
  }
  encryptedByDir.set(dir, { stamp, value: out });
  return out;
}

/** The column an arg references when it is a `fields.<col>` / `f.<col>` accessor (the `where.ts` `Field`), or null. */
export function fieldAccessorCol(
  arg: Deno.lint.Node | undefined,
): string | null {
  if (arg?.type !== "MemberExpression") return null;
  if (arg.property.type !== "Identifier") return null;
  return arg.property.name;
}

// `sql/protected-write`: raw SQL is gated on WHERE it lives (`queries/`), never on WHAT it writes — the
// static floor is a name-based reserved-table check ∪ a model-aware immutable-target check.
