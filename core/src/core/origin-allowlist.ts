/** Reject the serialized opaque-origin token from browser-origin allowlists. It is shared by every
 *  constructor that reflects/checks an Origin string; `null` as an absent allowlist remains a distinct posture. */
export function opaqueOriginAllowlistError(
  surface: string,
  origins: readonly string[] | null | undefined,
): string | undefined {
  return origins?.includes("null")
    ? `origin/opaque-allowlist: ${surface} includes the literal "null"; opaque browser origins share this serialized value, so it cannot identify a trusted origin. Remove it or name a concrete origin.`
    : undefined;
}
