/** Test fixtures lose their lint exemption when quoted source references reach them. */
import { LINTED_EXTENSIONS } from "../cli/hazelnut-io.ts";

const isTestFile = (file: string) =>
  LINTED_EXTENSIONS.some((ext) => file.endsWith(`.test${ext}`));

/**
 * Conservative corpus reach, not a TypeScript module resolver. Non-test sources
 * are roots; quoted basename references are edges, transitively, including a
 * test importing another test. Ambiguous names withhold the exemption rather
 * than silently grant it. This is shared by both source shields and the owned
 * floor runner, so no sibling can exempt served code solely by its filename.
 */
export function appSourceFiles(
  sources: Readonly<Record<string, string>>,
): ReadonlySet<string> {
  const files = Object.keys(sources);
  const reached = new Set(files.filter((file) => !isTestFile(file)));
  const pending = [...reached];
  const edges = files.filter(isTestFile).map((file) => {
    const base = file.slice(file.replaceAll("\\", "/").lastIndexOf("/") + 1);
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return { file, quoted: new RegExp(`["'\`][^"'\`]*${escaped}["'\`]`) };
  });
  for (let i = 0; i < pending.length; i++) {
    const text = sources[pending[i]!]!;
    for (const { file, quoted } of edges) {
      if (reached.has(file) || !quoted.test(text)) continue;
      reached.add(file);
      pending.push(file);
    }
  }
  return reached;
}
