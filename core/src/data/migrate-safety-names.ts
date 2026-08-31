// The SQL-name helpers the destructive-change classifier and the safety roster BOTH read. A leaf: they
// name nothing about either policy, and homing them in one of the two made the pair a cycle.

/** A single qualified-name token: an optional schema qualifier then the table, each either a bare
 *  identifier (`_audit`) or a double-quoted identifier (`"_audit"`) that may contain non-word chars. */
export const QUALIFIED_NAME: string = String
  .raw`(?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$]*))?`;

/**
 * Normalize a qualified name token to its bare table name: the last identifier, quotes stripped.
 * Dots inside a quoted identifier (`"my.table"`) stay in the name — splitting on every `.` first
 * would return `table` and miss the object. `"blog"."_audit"` still resolves to `_audit`.
 *
 * CASE-FOLDED the way Postgres folds: an UNQUOTED identifier is lowered, a quoted one is kept verbatim.
 * Without this the protected-table sets were matched case-SENSITIVELY against a server that is not, so
 * `DROP TABLE _AUDIT` named the very same table as `_audit` and passed every WORM gate — an append-only
 * guarantee defeated by the shift key.
 */
export function bareName(token: string): string | null {
  const t = token.trim();
  if (t.length === 0) return null;
  const segs: string[] = [];
  let i = 0;
  while (i < t.length) {
    while (i < t.length && /\s/.test(t[i]!)) i++;
    if (i >= t.length) break;
    if (t[i] === '"') {
      i++;
      let s = "";
      while (i < t.length) {
        if (t[i] === '"') {
          if (t[i + 1] === '"') {
            s += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        s += t[i]!;
        i++;
      }
      segs.push(s); // quoted: Postgres preserves it exactly, so this must too
    } else {
      const start = i;
      while (i < t.length && t[i] !== "." && !/\s/.test(t[i]!)) i++;
      segs.push(t.slice(start, i).toLowerCase()); // unquoted: Postgres folds down
    }
    while (i < t.length && /\s/.test(t[i]!)) i++;
    if (t[i] === ".") {
      i++;
      continue;
    }
    break;
  }
  const last = segs.at(-1) ?? "";
  return last.length > 0 ? last : null;
}
