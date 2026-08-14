// @hazelnut/core — the curated derivation-engine base (mod-base.ts) and nothing
// else: the verify/judge module rides only mod.ts. A core build pins "hazelnut" here; a
// (src minus verify/) loads it whole. Pins: (core === full − verify module),
// (zero static verify/ reach). Design:
export * from "./mod-base.ts";
