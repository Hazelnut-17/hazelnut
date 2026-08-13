// The SQL-name helpers the destructive-change classifier and the safety roster BOTH read. A leaf: they
// name nothing about either policy, and homing them in one of the two made the pair a cycle.

/** A single qualified-name token: an optional schema qualifier then the table, each either a bare
 *  identifier (`_audit`) or a double-quoted identifier (`"_audit"`) that may contain non-word chars. */
export const QUALIFIED_NAME: string = String
  .raw`(?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$]*))?`;

/** Normalize a qualified name token to its bare table name: take the last `.`-segment (drops the schema
 *  qualifier) and strip surrounding double-quotes from that segment, in that order — stripping quotes
 *  first would break a quoted-qualified name like `"blog"."_audit"`. */
export function bareName(token: string): string | null {
  const seg = token.includes(".")
    ? token.slice(token.lastIndexOf(".") + 1)
    : token;
  const bare = seg.trim().replace(/^"|"$/g, "");
  return bare.length > 0 ? bare : null;
}
