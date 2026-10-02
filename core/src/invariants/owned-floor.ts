/** Framework-owned safety-floor execution, independent of app lint config/tasks. */
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readSourceTreeChecked } from "../cli/hazelnut-io.ts";
import {
  deriveBlocks,
  fingerprint,
  type Violation,
} from "../core/verifier-contract.ts";
import plugin, { FLOOR_RULE_CANONICAL_IDS } from "./lint-floor.ts";
import { appSourceFiles } from "./source-reach.ts";
import { withoutComments } from "./source-view.ts";

const slash = (path: string) => path.replaceAll("\\", "/");
const RULES = Object.keys(FLOOR_RULE_CANONICAL_IDS).map((key) =>
  `hazelnut/${key}`
);
const POPULATION_ID = "hazelnut-owned-floor-population/program";

function violation(
  id: string,
  file: string,
  line: number,
  message: string,
): Violation {
  const at = { file, startLine: line };
  const responsible = {
    kind: "unknown" as const,
    why: "framework-owned safety floor",
  };
  return {
    id,
    at,
    responsible,
    message,
    rung: "static",
    blocks: deriveBlocks("static", { concern: "lint" }),
    phase: "pre-ship",
    source: "verify",
    fingerprint: fingerprint({ id, at, responsible }),
  };
}

/** The same checked corpus may be supplied by the full verifier's existing walk. */
export async function ownedFloorViolations(
  appDir: string,
  corpus?: Awaited<ReturnType<typeof readSourceTreeChecked>>,
): Promise<Violation[]> {
  let container: string | undefined;
  let findings: Violation[] = [];
  const unavailable = (error: unknown) =>
    violation(
      "lint/floor-unavailable",
      "deno.json",
      1,
      `framework-owned safety floor did not run completely: ${
        error instanceof Error ? error.message : String(error)
      }. Restore the source corpus and Deno lint/plugin execution; this verdict cannot credit floor coverage.`,
    );
  try {
    const root = resolve(appDir);
    const { sources, errors } = corpus ?? await readSourceTreeChecked(root);
    if (errors.length > 0) throw new Error("app source corpus is incomplete");
    const normalized: Record<string, string> = {};
    for (const [path, source] of Object.entries(sources)) {
      const file = slash(
        relative(root, isAbsolute(path) ? path : resolve(root, path)),
      );
      if (file === ".." || file.startsWith("../") || isAbsolute(file)) {
        throw new Error("source path is outside the app root");
      }
      normalized[file] = source;
    }
    const expected = Object.keys(normalized).sort();
    if (expected.length === 0) throw new Error("app source corpus is empty");
    const appSources = appSourceFiles(normalized);
    // The scaffold grants write only to the app root. Never use the host TMPDIR.
    container = await Deno.makeTempDir({
      dir: root,
      prefix: "hazelnut-owned-floor-",
    });
    await Deno.mkdir(join(container, "app"));
    const lintRoot = await Deno.realPath(join(container, "app"));
    await Deno.writeTextFile(join(container, ".gitignore"), "!app/\n");
    await Deno.writeTextFile(join(lintRoot, ".gitignore"), "!**\n");
    const populationPath = join(container, "population.ts");
    await Deno.writeTextFile(
      populationPath,
      `export default {
  name: "hazelnut-owned-floor-population",
  rules: { program: { create(context) { return { Program(node) {
    context.report({ node, message: "owned floor population" });
  } }; } } },
};\n`,
    );
    const configPath = join(lintRoot, "deno.json");
    await Deno.writeTextFile(
      configPath,
      JSON.stringify({
        lint: {
          plugins: [
            new URL("./lint-floor.ts", import.meta.url).href,
            pathToFileURL(populationPath).href,
          ],
          rules: {
            tags: [],
            include: [...RULES, POPULATION_ID],
            exclude: Object.keys(plugin.rules).filter((key) =>
              !(key in FLOOR_RULE_CANONICAL_IDS)
            )
              .map((key) => `hazelnut/${key}`),
          },
        },
      }),
    );
    for (const file of expected) {
      const target = join(lintRoot, file);
      await Deno.mkdir(dirname(target), { recursive: true });
      // Neutralize only the directive token, preserving offsets and strings.
      // Unreachable fixtures retain their existing named-floor waiver; app
      // sources cannot silence this run with an app-owned lint directive.
      const original = normalized[file]!;
      const commentsBlanked = withoutComments(original);
      const source = appSources.has(file)
        ? original.replace(
          /deno-lint-ignore(?:-file)?/g,
          (token, offset: number) =>
            commentsBlanked.slice(offset, offset + token.length).trim() === ""
              ? " ".repeat(token.length)
              : token,
        )
        : original;
      await Deno.writeTextFile(target, source);
    }
    const child = new Deno.Command(Deno.execPath(), {
      args: ["lint", "--config", configPath, "--json"],
      cwd: lintRoot,
      env: { TMPDIR: container },
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    let output: Deno.CommandOutput;
    try {
      output = await child.output();
    } finally {
      clearTimeout(timer);
    }
    const report: unknown = JSON.parse(new TextDecoder().decode(output.stdout));
    if (
      !report || typeof report !== "object" ||
      !("checked_files" in report) || !Array.isArray(report.checked_files) ||
      !("errors" in report) || !Array.isArray(report.errors) ||
      report.errors.length > 0 ||
      !("diagnostics" in report) || !Array.isArray(report.diagnostics)
    ) {
      throw new Error(
        `floor runner returned an incomplete report (exit ${output.code})`,
      );
    }
    const mirrorFile = (raw: unknown) => {
      if (typeof raw !== "string") {
        throw new Error("floor runner returned an invalid file");
      }
      const path = raw.startsWith("file:") ? fileURLToPath(raw) : raw;
      const file = slash(
        relative(lintRoot, isAbsolute(path) ? path : resolve(lintRoot, path)),
      );
      if (!Object.hasOwn(normalized, file)) {
        throw new Error("floor runner checked an unexpected file");
      }
      return file;
    };
    const checked = report.checked_files.map(mirrorFile).sort();
    if (JSON.stringify(checked) !== JSON.stringify(expected)) {
      throw new Error(
        `floor population is incomplete (expected ${expected.length}, checked ${checked.length})`,
      );
    }
    const population: string[] = [];
    findings = report.diagnostics.flatMap((raw: unknown) => {
      if (
        !raw || typeof raw !== "object" ||
        !("code" in raw) || typeof raw.code !== "string" ||
        !("message" in raw) || typeof raw.message !== "string" ||
        !("filename" in raw) || !("range" in raw) || !raw.range ||
        typeof raw.range !== "object" || !("start" in raw.range) ||
        !raw.range.start || typeof raw.range.start !== "object" ||
        !("line" in raw.range.start) || typeof raw.range.start.line !== "number"
      ) {
        throw new Error("floor runner returned an invalid diagnostic");
      }
      if (raw.code === POPULATION_ID) {
        population.push(mirrorFile(raw.filename));
        return [];
      }
      const id = FLOOR_RULE_CANONICAL_IDS[raw.code.replace(/^hazelnut\//, "")];
      if (!id) {
        throw new Error(`floor runner emitted an unexpected rule ${raw.code}`);
      }
      return [violation(
        id,
        mirrorFile(raw.filename),
        raw.range.start.line,
        raw.message,
      )];
    });
    if (JSON.stringify(population.sort()) !== JSON.stringify(expected)) {
      throw new Error(
        "floor Program population did not equal the complete corpus",
      );
    }
    // The coverage rule deliberately reports once per file. Deno therefore
    // exits 1 even on a floor-clean corpus; errors and population are checked
    // independently above, so that intentional status cannot swallow failure.
    if (output.code !== 1) {
      throw new Error(
        `floor runner exit ${output.code} disagrees with its diagnostics`,
      );
    }
    return findings;
  } catch (error) {
    findings.push(unavailable(error));
    return findings;
  } finally {
    if (container !== undefined) {
      try {
        await Deno.remove(container, { recursive: true });
      } catch (error) {
        findings.push(unavailable(
          new Error(
            `temporary source mirror cleanup failed at ${container}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        ));
      }
    }
  }
}
