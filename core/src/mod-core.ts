// @hazelnut/core — the curated derivation-engine base (mod-base.ts) and nothing
// else: the verify/judge module rides only mod.ts. A core build pins "hazelnut" here; a carved tree
// (src minus verify/) loads it whole. Pins: barrel-module.test.ts (core === full − verify module),
// carve-teeth.test.ts (zero static verify/ reach). Design:
export * from "./mod-base.ts";
