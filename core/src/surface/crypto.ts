// `hazelnut/crypto` — secrets at rest and the identities that unlock them — KMS, the password recipe, embeddings, throttling.
//
// A CONCERN BARREL, and its membership is not written here: `scripts/surface-groups.ts` declares which
// symbols belong to this group as an equality, so a symbol
// cannot be reachable from two paths or from none. Re-exports point at the CONCRETE home, never at the
// root barrel — that is what keeps the group importable without pulling the whole surface in.

export { openaiEmbed } from "../features/embed.ts";
export type { EmbeddingProvider, VectorConfig } from "../features/embed.ts";
export { appKeyKms, decodeMasterKey } from "../features/encrypt-kms.ts";
export type { Kms } from "../features/encrypt.ts";
export { awsKms } from "../features/kms-aws.ts";
export type { AwsKmsConfig } from "../features/kms-aws.ts";
export {
  passwordAuthResolver,
  passwordLogin,
  passwordLogout,
  passwordRefresh,
  verifyRefreshToken,
} from "../features/password-auth.ts";
// The PG floor ships alongside the dev opt-down on purpose: canon calls `pgRateLimitStore` the default
// (13-authz.md §rate-limit) and for one release the only importable store was the single-process one.
export {
  memoryRateLimitStore,
  pgRateLimitStore,
} from "../features/throttle.ts";
export type { RateLimitStore } from "../features/throttle.ts";
