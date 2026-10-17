/** Key-service failures carry only a fixed safe category across wire/provenance boundaries.
 * Provider response text can contain account, principal and key identities and is never retained. */
export class KmsError extends Error {
  readonly kind = "internal" as const;
  readonly retryAfter?: number;
  constructor(
    readonly code: "kms/denied" | "kms/unavailable" | "kms/invalid-response",
  ) {
    super(
      code === "kms/denied"
        ? "key service denied the operation"
        : code === "kms/unavailable"
        ? "key service is temporarily unavailable"
        : "key service returned an invalid response",
    );
    this.name = "KmsError";
    if (code === "kms/unavailable") this.retryAfter = 1;
  }
}
