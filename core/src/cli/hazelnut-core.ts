/**
 * The CORE-module `hazelnut` CLI entrypoint. It states its module and its served verbs; `dispatch.ts` holds the
 * one dispatch body. Library mirror: `mod-core.ts`.
 *
 * It must NOT import the verify-module verb roster: a roster of withheld verbs shipped in a public package is
 * a table of contents for the module that holds them.
 */
// Resolve the CLI's native database dependency before its lazy verb graph.
// No client is constructed; serving still selects and opens the declared adapter.
import "postgres";
export * from "./hazelnut-io.ts";
import { CORE_FLAGS } from "./flag-roster.ts";
import { runCli } from "./dispatch.ts";

if (import.meta.main) await runCli("core", CORE_FLAGS);
