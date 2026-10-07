// Which KMS `hazelnut rotate-key --execute` re-wraps with: two named app keys, or the KMS the app serves with.
import {
  decodeMasterKey,
  type Kms,
  RotatingAppKeyKms,
} from "../features/encrypt.ts";

/**
 * An app-key rotation names both keys by env var (`--old-key-env`, `--new-key-env`). A custody move — onto
 * an external KMS, or off an old one — uses the KMS the app serves with, read from its `relaySeams` factory
 * (a `keyIdRoutingKms` that unwraps the old keyIds and wraps under the new adapter). A key that does not decode
 * throws, for the caller to report.
 */
export function rotateKeyKms(input: {
  readonly from: string;
  readonly to: string;
  readonly oldKeyEnv?: string;
  readonly newKeyEnv?: string;
  readonly env: (name: string) => string | undefined;
  readonly servedKms?: Kms;
}): { readonly kms: Kms } | { readonly error: string } {
  if (input.oldKeyEnv === undefined && input.newKeyEnv === undefined) {
    return input.servedKms !== undefined ? { kms: input.servedKms } : {
      error:
        "rotate-key --execute needs the keys it moves between: name two app keys with --old-key-env <VAR> --new-key-env <VAR>, or export `relaySeams = () => ({ kms })` from the app module with the KMS the app serves with (keyIdRoutingKms for a custody move)",
    };
  }
  if (!input.newKeyEnv) {
    return {
      error:
        "rotate-key: --new-key-env <VAR> (name of the env var holding the NEW/current base64-32 master key) is required, e.g. --new-key-env ENCRYPTION_KEY",
    };
  }
  if (!input.oldKeyEnv) {
    return {
      error:
        "rotate-key: --old-key-env <VAR> (name of the env var holding the OLD base64-32 master key) is required, e.g. --old-key-env ENCRYPTION_KEY_PREVIOUS",
    };
  }
  const newB64 = input.env(input.newKeyEnv);
  const oldB64 = input.env(input.oldKeyEnv);
  if (!newB64) {
    return {
      error:
        `rotate-key: env var ${input.newKeyEnv} (named by --new-key-env) is not set or empty`,
    };
  }
  if (!oldB64) {
    return {
      error:
        `rotate-key: env var ${input.oldKeyEnv} (named by --old-key-env) is not set or empty`,
    };
  }
  return {
    kms: new RotatingAppKeyKms({
      [input.from]: decodeMasterKey(oldB64),
      [input.to]: decodeMasterKey(newB64),
    }, input.to),
  };
}
