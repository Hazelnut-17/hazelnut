/**
 * The surface a CAPABILITY MODULE composes against — core's module-facing seam, curated and public.
 *
 * Not the consumer barrel. Everything here is a name only a module author needs: the entry it wraps, the
 * config-exactness type, the ctx seams a request stamps through, the finding contract. Putting them on
 * `mod-core.ts` would charge every consumer for concepts they never use; leaving them unexported meant a
 * runtime-phase module could not resolve as a package at all, because a package pinning `@hazelnut/core`
 * reaches it through the export map and nothing else — and thirteen of these names were on neither.
 *
 * Two things deliberately NOT here, and they are the reason this seam is not the whole answer: `App` and
 * `CtxExtras` are also DECLARATION-MERGE targets. A merge binds to the module that declares the interface,
 * so a module widening `App` must name `core/app-define.ts` itself; a re-export cannot stand in for it.
 * Those two paths are exported on their own for exactly that reason.
 */
export { groupDeclErrors } from "./app-boot.ts";
export { type BootSeams, segmentErr } from "./app-define.ts";
export { createApp, type CreateAppConfig } from "./app.ts";
export type { NoUnknownKeys, OnlyKnownKeys } from "./config.ts";
export type { Clock, OpLog } from "./ctx-provenance.ts";
export { err, ok, type Result } from "./result.ts";
export {
  deriveBlocks,
  fingerprint,
  type Verdict,
  type Violation,
} from "./verifier-contract.ts";
