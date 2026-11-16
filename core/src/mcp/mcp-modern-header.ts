/** MCP routing-header encoding; invalid UTF-8 and malformed base64 fail closed. */
export function decodeMcpName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!value.startsWith("=?base64?")) return value;
  if (!value.endsWith("?=")) return undefined;
  const encoded = value.slice(9, -2);
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    )
  ) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)),
    );
  } catch {
    return undefined;
  }
}

export function encodeMcpName(value: string): string {
  if (
    /^[\x20-\x7e]*$/.test(value) && value === value.trim() &&
    !(value.startsWith("=?base64?") && value.endsWith("?="))
  ) return value;
  return `=?base64?${
    btoa(
      Array.from(new TextEncoder().encode(value), (b) => String.fromCharCode(b))
        .join(""),
    )
  }?=`;
}
