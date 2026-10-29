// Driver-aware diagnostics: omit driver statements/bound parameters and mask the quoted values in
// Postgres data-exception messages. Application-authored Error messages/stacks and non-Error values
// remain diagnostic input; this helper is not a general secret sanitizer.

const DRIVER_NAME_FIELDS = [
  ["schema", "schema_name"],
  ["table", "table_name"],
  ["column", "column_name"],
  ["constraint", "constraint_name"],
  ["routine", "routine"],
] as const;

function stringField(
  e: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = e[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** Postgres class 22 (data exception) messages quote the rejected value: `invalid input syntax for type
 *  uuid: "…"`, `value "…" is out of range`. Other classes keep their messages; this is not content scanning. */
function maskedMessage(message: string, code: string | undefined): string {
  return code?.startsWith("22")
    ? message.replace(/"[^"]*"/g, '"[redacted]"')
    : message;
}

/** Render `err` with driver-specific redaction: name, message, SQLSTATE, driver declaration names,
 * stack, and cause. Arbitrary application message text and non-Error values are retained. */
export function loggableError(err: unknown, depth = 0): unknown {
  try {
    return inspectLoggableError(err, depth);
  } catch {
    // An incomplete driver diagnostic must not bypass the value masking above via Error.toString().
    return { message: "unreadable failure" };
  }
}

function inspectLoggableError(err: unknown, depth: number): unknown {
  if (!(err instanceof Error)) return err;
  const fields = err as unknown as Record<string, unknown>;
  const code = stringField(fields, "code");
  const message = maskedMessage(err.message, code);
  const out: Record<string, unknown> = { name: err.name, message };
  if (code !== undefined) out.code = code;
  for (const [name, alias] of DRIVER_NAME_FIELDS) {
    const v = stringField(fields, name) ?? stringField(fields, alias);
    if (v !== undefined) out[name] = v;
  }
  if (err.stack !== undefined) {
    out.stack = message === err.message
      ? err.stack
      : err.stack.split(err.message).join(message);
  }
  if (err.cause !== undefined && depth < 4) {
    out.cause = loggableError(err.cause, depth + 1);
  }
  return out;
}

/** A url as a message may print it: no userinfo, query or fragment, and with `origin` no path either
 *  (a webhook path is often the secret). An unparseable value loses the same parts by pattern. */
export function displayUrl(
  raw: string,
  opts: { readonly origin?: boolean } = {},
): string {
  let u: URL | undefined;
  try {
    u = new URL(raw);
  } catch {
    u = undefined;
  }
  if (u !== undefined && u.host !== "") {
    const path = opts.origin === true || u.pathname === "/" ? "" : u.pathname; // windows-portability:allow-http (a configured url, not an fs path)
    return `${u.protocol}//${u.host}${path}`;
  }
  const bare = raw.replace(/[?#][\s\S]*$/, "");
  return bare.replace(/^([a-z][a-z0-9+.-]*:\/\/)?[^/]*@/i, "$1");
}
