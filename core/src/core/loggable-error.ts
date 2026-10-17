// The shape every framework log line gives a caught error: what an operator needs to triage it, never a
// row value. A driver error carries the statement and its bound parameters, and Postgres data-exception
// messages quote the offending value; neither reaches a log.

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
 *  uuid: "…"`, `value "…" is out of range`. Every other class quotes identifiers only. */
function maskedMessage(message: string, code: string | undefined): string {
  return code?.startsWith("22")
    ? message.replace(/"[^"]*"/g, '"[redacted]"')
    : message;
}

/** A log-safe rendering of `err`: name, masked message, SQLSTATE, the declaration names the driver
 *  attributes (schema/table/column/constraint), the stack, and the same for its `cause`. */
export function loggableError(err: unknown, depth = 0): unknown {
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
