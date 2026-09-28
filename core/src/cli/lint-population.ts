/** Read-only-effect probe for the file set `deno lint` actually selects from a config. */
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rethrowAsNamedRunGrantFailure } from "../core/run-grant.ts";
import {
  gitignoreDarkened,
  type IgnoreUnknown,
  readGitignoreChain,
} from "./hazelnut-io.ts";

export interface LintSelectors {
  readonly exclude?: unknown;
  readonly lint?: {
    readonly include?: unknown;
    readonly exclude?: unknown;
  };
}

export interface LintPopulationResult {
  /** App-relative paths in the verifier's source corpus. */
  readonly sourceFiles: readonly string[];
  /** Paths relative to the app root that Deno selected, independent of their real lint diagnostics. */
  readonly linted: readonly string[];
  /** Actual app sources Deno's inherited `.gitignore` rules darken. */
  readonly gitignored: ReadonlyArray<
    { readonly path: string; readonly by: string }
  >;
  /** Ignore patterns this implementation cannot faithfully evaluate. */
  readonly unknownGitignore: readonly IgnoreUnknown[];
}

const POPULATION_PLUGIN = `export default {
  name: "hazelnut-lint-population-probe",
  rules: {
    population: {
      create(context) {
        return {
          Program(node) {
            context.report({ node, message: "lint population probe" });
          },
        };
      },
    },
  },
};
`;

const relativeSlash = (root: string, path: string): string =>
  relative(root, path).replaceAll("\\", "/").replace(/^\.\//, "");

/**
 * Measure Deno's selector effect, rather than approximating globs. The temporary
 * mirror has the same app-relative source paths and only the real top-level
 * `exclude`, `lint.include`, and `lint.exclude` values. A probe rule reports on
 * every visited program, so JSON `checked_files` is the actual selected set,
 * including clean files. The real app's `.gitignore` remains a separate part of
 * the returned effect result; the mirror neutralizes inherited ignores so the
 * config selectors are measured independently.
 */
export async function probeDenoLintPopulation(
  appDir: string,
  selectors: LintSelectors,
  sourceFiles: readonly string[],
): Promise<LintPopulationResult> {
  if (sourceFiles.length === 0) {
    return {
      sourceFiles: [],
      linted: [],
      gitignored: [],
      unknownGitignore: [],
    };
  }
  const root = await Deno.realPath(appDir);
  const gitignore = await readGitignoreChain(root);
  const appPath = resolve(appDir);
  const source = [...new Set(sourceFiles)].map((file) => {
    const absolute = isAbsolute(file) ? file : resolve(appPath, file);
    const rel = relative(appPath, absolute).replaceAll("\\", "/");
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
      throw new Error(`source path is not app-relative: ${file}`);
    }
    return rel.replace(/^\.\//, "");
  }).sort();
  const gitignored = gitignoreDarkened(source, gitignore.rules);
  const unknownGitignore = gitignore.unknown;
  if (source.length === 0) {
    return { sourceFiles: [], linted: [], gitignored, unknownGitignore };
  }

  let container: string | undefined;
  // Stay inside the app's granted write root. The scaffold runs `verify` with
  // `--allow-write=.`; letting the child Deno process use the host TMPDIR would
  // trigger a new permission prompt during every CI boot. Pick a directory the
  // real ignore chain leaves traversable, then remove it in `finally`.
  for (
    const prefix of [
      "hazelnut-lint-population-",
      "deno-lint-population-",
      "framework-lint-probe-",
    ]
  ) {
    const candidate = await Deno.makeTempDir({ dir: root, prefix });
    const rel = relativeSlash(root, candidate);
    if (
      gitignoreDarkened([`${rel}/app/probe.ts`], gitignore.rules).length === 0
    ) {
      container = candidate;
      break;
    }
    await Deno.remove(candidate, { recursive: true });
  }
  if (container === undefined) {
    throw new Error(
      "cannot create a lint-population probe directory visible through the app's .gitignore",
    );
  }

  try {
    const lintRoot = join(container, "app");
    const pluginPath = join(container, "population-probe.ts");
    const configPath = join(lintRoot, "deno.json");
    await Deno.mkdir(lintRoot, { recursive: true });
    // The container itself is known visible; explicitly reopen its child and
    // all mirror files even when the real app has broad unanchored ignore rules.
    await Deno.writeTextFile(join(container, ".gitignore"), "!app/\n");
    await Deno.writeTextFile(join(lintRoot, ".gitignore"), "!**\n");
    await Deno.writeTextFile(pluginPath, POPULATION_PLUGIN);

    const lint: Record<string, unknown> = {
      plugins: [pathToFileURL(pluginPath).href],
    };
    if (selectors.lint?.include !== undefined) {
      lint.include = selectors.lint.include;
    }
    if (selectors.lint?.exclude !== undefined) {
      lint.exclude = selectors.lint.exclude;
    }
    const config: Record<string, unknown> = { lint };
    if (selectors.exclude !== undefined) config.exclude = selectors.exclude;
    await Deno.writeTextFile(configPath, JSON.stringify(config));

    for (const sourcePath of source) {
      const target = join(lintRoot, sourcePath);
      await Deno.mkdir(dirname(target), { recursive: true });
      await Deno.writeTextFile(target, "export {};\n");
    }

    const result = await new Deno.Command(Deno.execPath(), {
      args: ["lint", "--config", configPath, "--json"],
      cwd: lintRoot,
      env: { TMPDIR: container },
      stdout: "piped",
      stderr: "piped",
    }).output().catch((e: unknown) =>
      rethrowAsNamedRunGrantFailure(e, "hazelnut verify lint-population")
    );
    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr).trim();
    let report: unknown;
    try {
      report = JSON.parse(stdout);
    } catch {
      if (/No target files found/i.test(stderr)) {
        return {
          sourceFiles: source,
          linted: [],
          gitignored,
          unknownGitignore,
        };
      }
      throw new Error(
        `deno lint did not return its JSON population report (exit ${result.code})${
          stderr ? `: ${stderr}` : stdout.trim() ? `: ${stdout.trim()}` : ""
        }`,
      );
    }
    if (
      report === null || typeof report !== "object" ||
      !Array.isArray((report as { checked_files?: unknown }).checked_files) ||
      !Array.isArray((report as { errors?: unknown }).errors) ||
      (report as { errors: unknown[] }).errors.length > 0
    ) {
      throw new Error(
        `deno lint returned an incomplete JSON population report (exit ${result.code})`,
      );
    }

    const realLintRoot = await Deno.realPath(lintRoot);
    const linted = await Promise.all(
      (report as { checked_files: unknown[] }).checked_files.map(
        async (raw) => {
          if (typeof raw !== "string") {
            throw new Error("deno lint returned a non-string checked file");
          }
          const file = raw.startsWith("file:")
            ? fileURLToPath(new URL(raw))
            : raw;
          const realFile = await Deno.realPath(file);
          const rel = relativeSlash(realLintRoot, realFile);
          if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
            throw new Error(
              `deno lint checked a file outside the app source mirror: ${raw}`,
            );
          }
          return rel;
        },
      ),
    );
    return {
      sourceFiles: source,
      linted: [...new Set(linted)].sort(),
      gitignored,
      unknownGitignore,
    };
  } finally {
    await Deno.remove(container, { recursive: true }).catch(() => {});
  }
}
