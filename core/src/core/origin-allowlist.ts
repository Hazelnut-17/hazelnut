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

/** The same CORS posture checks on guided app boot and directly composed routers. */
export function corsPostureErrors(
  cors:
    | { readonly origins: readonly string[]; readonly credentials?: boolean }
    | undefined,
  surface = "config.http.cors",
): string[] {
  if (cors === undefined) return [];
  const errors = originAllowlistErrors(
    `${surface}.origins`,
    cors.origins,
    "open",
  );
  if (cors.origins.length === 0) {
    errors.push(
      `cors/origins-required: ${surface} declares an empty origins list; omit the card for a closed door or name the allowed browser origins`,
    );
  }
  if (cors.origins.includes("*") && cors.credentials === true) {
    errors.push(
      `cors/wildcard-credentials: ${surface} pairs origins:["*"] with credentials:true; name concrete origins for credentialed browser callers`,
    );
  }
  if (cors.origins.includes("*") && cors.origins.length > 1) {
    errors.push(
      `cors/wildcard-with-list: ${surface} lists "*" beside named origins; keep the wildcard alone or remove it and keep the names`,
    );
  }
  return errors;
}

/** The `Origin` a browser sends for `entry`, or undefined when `entry` names no tuple origin. */
function browserOrigin(entry: string): string | undefined {
  // A named entry is a concrete origin, never a wildcard host pattern.
  if (entry.includes("*")) return undefined;
  try {
    const origin = new URL(entry).origin;
    return origin === "null" ? undefined : origin;
  } catch {
    return undefined;
  }
}
