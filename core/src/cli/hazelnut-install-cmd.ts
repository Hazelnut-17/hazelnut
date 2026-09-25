/**
 * `hazelnut install` — put the framework tree back into an app that does not carry one.
 *
 * A vendored app pins the framework at `.hazelnut/modules/`, and that directory is git-ignored: it is
 * framework source, not the app's. So the tree travels with a directory copy, an archive or a container
 * image, and a `git clone` arrives without it. This verb is the door back — the same copy `new --vendor`
 * performs, run against an app that already exists.
 *
 * It fetches NOTHING. `--from` names a framework checkout already on the machine; there is no default, no
 * registry lookup and no network path, so running it can never reach out on the consumer's behalf.
 */
import { atomicWrite, CliRefusal, vendorFrameworkTree } from "./hazelnut-io.ts";
import { isModuleSpecifier, sourceTreeImportMap } from "./scaffold.ts";
import { stripJsoncComments } from "../core/framework-literals.ts";

const VENDOR_PIN = "./.hazelnut/modules";

/** Read `--from <path>` out of the argv tail. */
function fromFlag(rest: readonly string[]): string | undefined {
  const at = rest.lastIndexOf("--from");
  if (at === -1) return undefined;
  const v = rest[at + 1];
  return v === undefined || v.startsWith("--") ? undefined : v;
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await Deno.stat(p)).isDirectory;
  } catch {
    return false;
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await Deno.stat(p)).isFile;
  } catch {
    return false;
  }
}

type DenoJson = {
  imports?: Record<string, string>;
  lint?: { plugins?: string[] };
  tasks?: Record<string, string>;
  [k: string]: unknown;
};

function isAlreadyVendorPin(hazel: string): boolean {
  return hazel === VENDOR_PIN || hazel === `${VENDOR_PIN}/mod-core.ts` ||
    hazel.startsWith(`${VENDOR_PIN}/`);
}

function sourcePinBase(hazel: string): string {
  return hazel.replace(/\/mod-core\.ts$/, "").replace(/\/mod\.ts$/, "");
}

type JsoncBounds = { open: number; close: number };
type JsoncProperty = {
  key: string;
  keyStart: number;
  valueStart: number;
  valueEnd: number;
};

function skipJsoncTrivia(text: string, at: number): number {
  while (at < text.length) {
    if (/\s/.test(text[at]!)) {
      at++;
    } else if (text[at] === "/" && text[at + 1] === "/") {
      while (at < text.length && text[at] !== "\n") at++;
    } else if (text[at] === "/" && text[at + 1] === "*") {
      const end = text.indexOf("*/", at + 2);
      if (end < 0) throw new Error("unterminated JSONC comment");
      at = end + 2;
    } else {
      break;
    }
  }
  return at;
}

function jsoncStringEnd(text: string, start: number): number {
  if (text[start] !== '"') throw new Error("expected a JSON string");
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === '"') return i + 1;
  }
  throw new Error("unterminated JSON string");
}

function jsoncValueEnd(text: string, start: number): number {
  const at = skipJsoncTrivia(text, start);
  const head = text[at];
  if (head === '"') return jsoncStringEnd(text, at);
  if (head === "{" || head === "[") {
    const close = head === "{" ? "}" : "]";
    let i = skipJsoncTrivia(text, at + 1);
    if (text[i] === close) return i + 1;
    while (i < text.length) {
      if (head === "{") {
        i = jsoncStringEnd(text, i);
        i = skipJsoncTrivia(text, i);
        if (text[i] !== ":") throw new Error("expected a JSONC property colon");
        i = jsoncValueEnd(text, i + 1);
      } else {
        i = jsoncValueEnd(text, i);
      }
      i = skipJsoncTrivia(text, i);
      if (text[i] === ",") {
        i = skipJsoncTrivia(text, i + 1);
        if (text[i] === close) return i + 1;
      } else if (text[i] === close) {
        return i + 1;
      } else {
        throw new Error("expected a JSONC comma or closing bracket");
      }
    }
    throw new Error("unterminated JSONC container");
  }
  let i = at;
  while (i < text.length && !/[\s,}\]]/.test(text[i]!)) i++;
  if (i === at) throw new Error("expected a JSONC value");
  return i;
}

function jsoncObjectBounds(text: string, start = 0): JsoncBounds {
  const open = skipJsoncTrivia(text, start);
  if (text[open] !== "{") throw new Error("expected a JSONC object");
  const end = jsoncValueEnd(text, open);
  return { open, close: end - 1 };
}

function jsoncProperties(text: string, bounds: JsoncBounds): JsoncProperty[] {
  const props: JsoncProperty[] = [];
  let i = skipJsoncTrivia(text, bounds.open + 1);
  while (i < bounds.close) {
    const keyStart = i;
    const keyEnd = jsoncStringEnd(text, keyStart);
    const key = JSON.parse(text.slice(keyStart, keyEnd)) as string;
    i = skipJsoncTrivia(text, keyEnd);
    if (text[i] !== ":") throw new Error("expected a JSONC property colon");
    const valueStart = skipJsoncTrivia(text, i + 1);
    const valueEnd = jsoncValueEnd(text, valueStart);
    props.push({ key, keyStart, valueStart, valueEnd });
    i = skipJsoncTrivia(text, valueEnd);
    if (text[i] === ",") i = skipJsoncTrivia(text, i + 1);
    else if (i !== bounds.close) throw new Error("expected a JSONC comma");
  }
  return props;
}

function rewriteJsoncString(
  text: string,
  prop: JsoncProperty,
  rewrite: (value: string) => string,
): { start: number; end: number; replacement: string } | undefined {
  if (text[prop.valueStart] !== '"') return undefined;
  const value = JSON.parse(
    text.slice(prop.valueStart, prop.valueEnd),
  ) as string;
  const rewritten = rewrite(value);
  return rewritten === value ? undefined : {
    start: prop.valueStart,
    end: prop.valueEnd,
    replacement: JSON.stringify(rewritten),
  };
}

function applyTextEdits(
  text: string,
  edits: { start: number; end: number; replacement: string }[],
): string {
  edits.sort((a, b) => b.start - a.start);
  for (const edit of edits) {
    text = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end);
  }
  return text;
}

/** Rewrite a `--local` / host-path pin to the vendored tree `install --from` just copied.
 *  A registry pin is already portable — the copy is an overlay, the specifier stays. */
export function rewritePinsToVendor(denoJsonText: string): {
  text: string;
  changed: boolean;
  reason: "already-vendor" | "registry" | "no-pin" | "rewritten";
} {
  let cfg: DenoJson;
  try {
    cfg = JSON.parse(stripJsoncComments(denoJsonText)) as DenoJson;
  } catch {
    return { text: denoJsonText, changed: false, reason: "no-pin" };
  }
  const old = cfg.imports?.["hazelnut"];
  if (old === undefined) {
    return { text: denoJsonText, changed: false, reason: "no-pin" };
  }
  if (isAlreadyVendorPin(old)) {
    return { text: denoJsonText, changed: false, reason: "already-vendor" };
  }
  if (isModuleSpecifier(old)) {
    return { text: denoJsonText, changed: false, reason: "registry" };
  }
  const oldBase = sourcePinBase(old);
  const wanted = sourceTreeImportMap(VENDOR_PIN);
  try {
    const root = jsoncObjectBounds(denoJsonText);
    const rootProps = jsoncProperties(denoJsonText, root);
    const importsProp = rootProps.find((p) => p.key === "imports");
    if (!importsProp || denoJsonText[importsProp.valueStart] !== "{") {
      return { text: denoJsonText, changed: false, reason: "no-pin" };
    }
    const importsBounds = jsoncObjectBounds(
      denoJsonText,
      importsProp.valueStart,
    );
    const importProps = jsoncProperties(denoJsonText, importsBounds);
    const importKeys = new Set(importProps.map((p) => p.key));
    const edits: { start: number; end: number; replacement: string }[] = [];
    for (const prop of importProps) {
      const canonical = wanted[prop.key];
      const edit = rewriteJsoncString(
        denoJsonText,
        prop,
        canonical === undefined
          ? (s) => s.split(oldBase).join(VENDOR_PIN)
          : () => canonical,
      );
      if (edit) edits.push(edit);
    }

    const missing = Object.entries(wanted).filter(([key]) =>
      !importKeys.has(key)
    );
    if (missing.length > 0) {
      const firstProperty = importProps[0];
      const insertionPoint = firstProperty?.keyStart ?? importsBounds.close;
      const lineStart = denoJsonText.lastIndexOf("\n", insertionPoint - 1) + 1;
      const indent = /^\s*/.exec(
        denoJsonText.slice(lineStart, insertionPoint),
      )?.[0] ?? "";
      const content = missing.map(([key, value]) =>
        `${JSON.stringify(key)}: ${JSON.stringify(value)},`
      ).join(`\n${indent}`);
      edits.push({
        start: insertionPoint,
        end: insertionPoint,
        replacement: `${content}\n${indent}`,
      });
    }

    for (const prop of rootProps) {
      if (prop.key === "tasks" && denoJsonText[prop.valueStart] === "{") {
        const taskProps = jsoncProperties(
          denoJsonText,
          jsoncObjectBounds(denoJsonText, prop.valueStart),
        );
        for (const task of taskProps) {
          const edit = rewriteJsoncString(
            denoJsonText,
            task,
            (s) => s.split(oldBase).join(VENDOR_PIN),
          );
          if (edit) edits.push(edit);
        }
      }
      if (prop.key === "lint" && denoJsonText[prop.valueStart] === "{") {
        const lintProps = jsoncProperties(
          denoJsonText,
          jsoncObjectBounds(denoJsonText, prop.valueStart),
        );
        const plugins = lintProps.find((p) => p.key === "plugins");
        if (plugins && denoJsonText[plugins.valueStart] === "[") {
          const arrayEnd = plugins.valueEnd - 1;
          let at = skipJsoncTrivia(denoJsonText, plugins.valueStart + 1);
          while (at < arrayEnd) {
            const itemEnd = jsoncValueEnd(denoJsonText, at);
            if (denoJsonText[at] === '"') {
              const value = JSON.parse(
                denoJsonText.slice(at, itemEnd),
              ) as string;
              const rewritten = value.split(oldBase).join(VENDOR_PIN);
              if (rewritten !== value) {
                edits.push({
                  start: at,
                  end: itemEnd,
                  replacement: JSON.stringify(rewritten),
                });
              }
            }
            at = skipJsoncTrivia(denoJsonText, itemEnd);
            if (denoJsonText[at] === ",") {
              at = skipJsoncTrivia(denoJsonText, at + 1);
            }
          }
        }
      }
    }
    return {
      text: applyTextEdits(denoJsonText, edits),
      changed: true,
      reason: "rewritten",
    };
  } catch {
    return { text: denoJsonText, changed: false, reason: "no-pin" };
  }
}

/** Rewrite a Dockerfile's checkout pin independently of the config rewrite, so a retry can repair either
 * file after the other one was already published. Without the old config pin, the recovery scan recognizes
 * only an absolute or `file://` framework CLI path; it never guesses at a remote or relative specifier. */
export function rewriteDockerfilePinToVendor(
  dockerfile: string,
  oldBase?: string,
  recoverAlreadyVendored = false,
): { text: string; changed: boolean } {
  const bases = oldBase !== undefined ? [oldBase] : recoverAlreadyVendored
    ? [
      ...dockerfile.matchAll(
        /(?:file:\/\/|(?:^|[\s"'=])\/)[^\s"'\\]+\/src(?=\/cli\/hazelnut\.ts(?:["'\\s]|$))/gm,
      ),
    ].map((m) => {
      const matched = m[0]!;
      // The absolute-path alternative preserves its one preceding delimiter so it cannot match a URL
      // (`https://…`) or a relative path (`../…`). Keep that delimiter in the Dockerfile when replacing.
      return matched.startsWith("file://") || matched.startsWith("/")
        ? matched
        : matched.slice(1);
    })
    : [];
  let text = dockerfile;
  for (const base of bases) text = text.split(base).join(VENDOR_PIN);
  return { text, changed: text !== dockerfile };
}

export async function dispatchInstall(
  cmd: string,
  modPath: string,
  rest: string[],
): Promise<void> {
  if (cmd === "install") await runInstall(modPath, rest);
}

async function runInstall(modPath: string, rest: string[]): Promise<void> {
  const argv = modPath === undefined ? rest : [modPath, ...rest];
  const from = fromFlag(argv);
  if (from === undefined) {
    console.error(
      "usage: hazelnut install --from <framework-checkout>\n\n" +
        "  Copies that checkout's `src/` into ./.hazelnut/modules/ (omits `tests/` directories) — the tree a vendored app runs from.\n" +
        "  A host-path / `file://` pin is rewritten to that path so a container build can resolve it.\n" +
        "  Nothing is fetched: `--from` names a directory already on this machine.",
    );
    Deno.exit(2);
  }

  // The app root is the CWD, and it must actually be one: writing a framework tree into an arbitrary
  // directory would leave a `.hazelnut/` nobody asked for, in a place nothing reads it from.
  const configName = await isFile("deno.json")
    ? "deno.json"
    : await isFile("deno.jsonc")
    ? "deno.jsonc"
    : undefined;
  if (configName === undefined) {
    throw new CliRefusal(
      "install: no deno.json or deno.jsonc here — run it from the app root, the directory holding the app's Deno config.",
    );
  }
  if (!(await isDir(from))) {
    throw new CliRefusal(
      `install: --from '${from}' is not a directory.`,
    );
  }
  // `mod-core.ts` is in EVERY framework tree — the public core artifact deliberately ships no `mod.ts`, so
  // testing for that one would refuse a perfectly good core checkout.
  if (!(await isFile(`${from}/src/mod-core.ts`))) {
    throw new CliRefusal(
      `install: --from '${from}' is not a framework checkout — expected ${from}/src/mod-core.ts.\n` +
        "  Point it at the framework repository root, not at its src/ directory.",
    );
  }

  const copied = await vendorFrameworkTree(from, ".");
  const before = await Deno.readTextFile(configName);
  const pins = rewritePinsToVendor(before);
  if (pins.changed) {
    await atomicWrite(configName, pins.text);
  }
  if (await isFile("Dockerfile")) {
    let oldHazel: string | undefined;
    try {
      oldHazel = (JSON.parse(stripJsoncComments(before)) as DenoJson).imports
        ?.["hazelnut"];
    } catch {
      /* the config rewrite already returned no-pin for malformed input */
    }
    if (
      oldHazel === undefined || isAlreadyVendorPin(oldHazel) ||
      isModuleSpecifier(oldHazel)
    ) {
      oldHazel = undefined;
    }
    const docker = await Deno.readTextFile("Dockerfile");
    const rewrittenDocker = rewriteDockerfilePinToVendor(
      docker,
      oldHazel === undefined ? undefined : sourcePinBase(oldHazel),
      pins.reason === "already-vendor",
    );
    if (rewrittenDocker.changed) {
      await atomicWrite("Dockerfile", rewrittenDocker.text);
    }
  }
  const pinNote = pins.reason === "rewritten"
    ? "  Pins now name ./.hazelnut/modules — the same shape `new --vendor` writes."
    : pins.reason === "already-vendor"
    ? "  The app's existing pins already name that path — nothing else changed."
    : pins.reason === "registry"
    ? "  The app's registry pin is already portable; the copy is an overlay, the specifier stayed."
    : "  No `imports.hazelnut` pin to rewrite.";
  console.log(
    `✓ install: copied ${copied} framework files into ./.hazelnut/modules/\n` +
      pinNote,
  );
  Deno.exit(0);
}
