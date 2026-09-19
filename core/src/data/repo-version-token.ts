/** The PostgreSQL `integer` domain every caller-supplied version token must inhabit. Kept outside the
 * write verbs so composite write doors can share it without creating a repo-module import cycle. */
const VERSION_MAX = 2_147_483_647;

/** Refuse an impossible optimistic-lock token before it reaches any write SQL. */
export function assertVersionToken(v: number): void {
  if (!Number.isInteger(v) || v < 0 || v > VERSION_MAX) {
    throw Object.assign(
      new Error(
        `version/token-invalid: expected version ${v} is not an integer between 0 and ${VERSION_MAX}`,
      ),
      { kind: "validation" as const },
    );
  }
}
