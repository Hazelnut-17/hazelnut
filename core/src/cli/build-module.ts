// CLI verb seam — the single source of the verbs THIS build serves. The entry refuses anything else before
// a dispatcher runs, so an unrecognised verb never reaches a handler. Pinned by equality in.

/** The verbs a CORE build OFFERS — the other half of the same partition, and the roster the published
 *  README advertises from. It exists because the README used to hand-list a subset of these, which meant
 *  the package's own advertisement had nothing to check it: it under-sold the CLI while, separately, the
 *  `exports` map made none of it reachable at all. A claim about shipped capability has to derive from the
 *  capability.
 *
 * holds this EQUAL to the `cmd === "…"` dispatch points scanned out of `src/cli/`,
 *  both directions, so a new verb cannot be dispatched without landing on a declared side. */
export const CORE_VERBS = [
  "help", // list the verbs THIS build serves (never the withheld ones)
  "new", // scaffold an app
  "add", // add a module / resource
  "install", // put a vendored framework tree back into an existing app
  "doctor", // environment checkup
  "verify", // the STRUCTURAL rung over the composed model (the rungs that read outside it are a module's)
  "migrate", // schema migration verbs
  "launch", // least-privilege supervised serve
  "mcp", // emit an MCP transport entry
  "relay", // outbox relay
  "ops", // operator levers: hold the relay drain, cap a rate-limit key
  "redrive", // DLQ redrive
  "rotate-key", // encryption key rotation
  "run-workflow", // run a declared workflow
  "unstick-workflow", // force-reclaim a stuck _workflow_journal step claim before its lease expires
] as const;
