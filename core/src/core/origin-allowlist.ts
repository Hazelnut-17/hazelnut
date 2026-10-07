/** Boot refusals for a browser-origin allowlist, shared by every constructor that checks an `Origin` header.
 *  An entry must be a serialized browser Origin; `null` as an absent allowlist remains a distinct posture. */
export function originAllowlistErrors(
  surface: string,
  origins: readonly string[] | null | undefined,
  wildcard: "open" | "refused",
): string[] {
  const errs: string[] = [];
  for (const o of origins ?? []) {
    if (o === "null") {
      errs.push(
        `origin/opaque-allowlist: ${surface} includes the literal "null"; opaque browser origins share this serialized value, so it cannot identify a trusted origin. Remove it or name a concrete origin.`,
      );
    } else if (o === "*") {
      if (wildcard === "refused") {
        errs.push(
          `origin/mcp-wildcard: ${surface} lists "*", which no browser sends as an Origin, so every browser is refused. Name the origins that may reach the door, or declare it open on purpose with allowedOrigins: null.`,
        );
      }
    } else {
      const canonical = browserOrigin(o);
      if (canonical !== o) {
        errs.push(
          `origin/non-canonical: ${surface} entry '${o}' is not a browser Origin, so no request will ever match it — ${
            canonical === undefined
              ? "name it as scheme://host[:port]"
              : `a browser sends '${canonical}'`
          } (lowercase, no path or trailing slash, default port omitted).`,
        );
      }
    }
  }
  return errs;
}

/** The `Origin` a browser sends for `entry`, or undefined when `entry` names no tuple origin. */
function browserOrigin(entry: string): string | undefined {
  try {
    const origin = new URL(entry).origin;
    return origin === "null" ? undefined : origin;
  } catch {
    return undefined;
  }
}
