// Barrel re-exports keep import sites stable.
import type { Invariant } from "../core/verifier-contract.ts";
import type { Violation } from "../core/structural-violation.ts";
import { wholeImmutable } from "../data/schema-normalize.ts";
import { withoutComments, withoutCommentsOrStrings } from "./source-view.ts";

/** `timestamps/auto-set` (10-invariants.md §timestamps/auto-set): `timestamps` must mint `created_at`/`updated_at`
 *  with `DEFAULT now()` so they're substrate-stamped, not hand-writable. Distinct from `timestamps/columns-minted`
 *  (checks only the column names appear) — a deriver regression that drops the DEFAULT passes that check but fails this. */
export const timestampsAutoSet: Invariant = {
  id: "timestamps/auto-set",
  check(ctx) {
    const m = ctx.resource;
    if (!m.features.timestamps) return [];
    return ["created_at", "updated_at"]
      .filter((col) =>
        !new RegExp(`\\b${col}\\b[^,\\n]*DEFAULT now\\(\\)`).test(m.ddl)
      )
      .map((col) => ({
        id: "timestamps/auto-set",
        resource: m.name,
        message:
          `timestamps declared but '${col}' is not DEFAULT-stamped (no \`DEFAULT now()\`) — the column would be NULL/hand-writable instead of auto-set`,
      }));
  },
};

/** `affordance/no-instruction-splice`: an MCP tool `describe` string is an instruction the host model reads —
 *  it must be authored, fixed text, never carry a caller-controlled `${…}` interpolation hole (a
 *  prompt-injection vector, or a leaked template literal that never resolved). */
export const affordanceNoInstructionSplice: Invariant = {
  id: "affordance/no-instruction-splice",
  check(ctx) {
    const m = ctx.resource;
    const SPLICE = /\$\{[^}]*\}/; // an unresolved interpolation hole in stored instruction text
    const out: Violation[] = [];
    for (const [tool, entry] of Object.entries(m.mcp)) {
      if (SPLICE.test(entry.describe)) {
        out.push({
          id: "affordance/no-instruction-splice",
          resource: m.name,
          clause: `mcp.${tool}`,
          message:
            `MCP tool '${tool}' describe carries an unresolved \`\${…}\` interpolation hole — a tool describe is agent instruction text and must be fixed authored prose, never a caller-controlled splice (a prompt-injection / instruction-splice vector)`,
        });
      }
    }
    return out;
  },
};

/** `erasure/no-pii-in-immutable`: a resource declaring `sensitive` (PII) and whole-resource `immutable` can
 *  never honor an Art. 17 erasure request — `immutable` removes the delete/update path, so PII written there
 *  is un-erasable for the life of the row. Fires once per sensitive field so a waiver on one never masks another. */
export const erasureNoPiiInImmutable: Invariant = {
  id: "erasure/no-pii-in-immutable",
  check(ctx) {
    const m = ctx.resource;
    // only whole-resource `immutable:true` removes the delete path (faces.ts mech 5) — a field-level
    // `immutable:{fields}` freezes columns but keeps delete, so erasure is still possible there.
    if (!wholeImmutable(m.features) || m.sensitive.length === 0) return [];
    return m.sensitive.map((field) => ({
      id: "erasure/no-pii-in-immutable",
      resource: m.name,
      clause: `sensitive.${field}`,
      message:
        `field '${field}' is marked sensitive (PII) on an immutable resource — immutable removes the delete/update path, so this PII can never be erased; an Art. 17 erasure request becomes impossible by construction. Drop immutable, or move the PII to an erasable resource`,
    }));
  },
};

/** `policy/custom-read-applies-rowpolicy` (13-authz.md §escalation-is-a-ramp / §10-defineView): an escalated
 *  custom read (a `tx:"read"` op reaching for raw SQL) must re-apply the same rowPolicy fragment a derived
 *  `list`/`find` gets automatically via `buildReadWhere` — a raw `FROM` on a protected table that skips this
 *  turns a row-scoped read into a whole-table leak. Fires on a raw read (`ctx.db`/`ctx.query`) naming a
 *  `hasRowPolicy` table without a `buildReadWhere`/`rowPolicy` re-call. Companion to `policy/rowpolicy-meets-spec`
 *  (that proves the rule correct; this proves an escalated read still applies it). The accusing probes run over
 *  source with COMMENTS blanked and the excusing one with comments AND string literals blanked, so prose about
 *  the leak never stands in for a call. Honest limit: `handler.toString()` is a static floor over the handler's
 *  own source, blind to any helper-function indirection or a computed table-name string; the imported and
 *  same-file helper cases are covered by the lint-rung companion `custom-read-applies-rowpolicy`
 *  (lint-plugin.ts), which has the file AST and the import graph. Deeper indirection is a review/golden residual. */
export const customReadAppliesRowPolicy: Invariant = {
  id: "policy/custom-read-applies-rowpolicy",
  check(ctx) {
    const m = ctx.resource;
    // the protected tables across the whole app — every resource that declares a rowPolicy. A custom read
    // anywhere that reaches one of these by raw SQL must re-apply that resource's fragment (cross-model).
    const protectedTables = ctx.model
      .filter((r) => r.hasRowPolicy)
      .map((r) => ({ name: r.name, schema: r.pgSchema }));
    if (protectedTables.length === 0) return [];
    const out: Violation[] = [];
    for (const [opName, decl] of Object.entries(m.operations)) {
      const d = decl as { readonly tx?: unknown; readonly handler?: unknown };
      if (d.tx !== "read") continue; // only the explicit READ-escalation opt-in is in scope (writes are a separate seam)
      if (typeof d.handler !== "function") continue;
      const raw = (d.handler as { toString(): string }).toString();
      // ACCUSE over comment-free source (the SQL stays: it lives in a string literal), EXCUSE over code only.
      const src = withoutComments(raw);
      // a raw read door — bypass of the `buildReadWhere` site (`ctx.data.<r>`/`ctx.reads.<dep>` route through it).
      const RAW_READ = /ctx\s*\.\s*db\b|ctx\s*\.\s*query\b|\.\s*query\s*\(/;
      if (!RAW_READ.test(src)) continue; // no raw read door → read only through the safe surface
      // a CALL in code. `// re-apply rowPolicy( actor )` is the likeliest sentence an author writes ABOUT this
      // leak, so a projection that kept comments would let describing the defect stand in for fixing it.
      const REAPPLIES = /\bbuildReadWhere\s*\(|\browPolic(?:y|ies)\b\s*[.(]/
        .test(withoutCommentsOrStrings(raw));
      if (REAPPLIES) continue;
      for (const t of protectedTables) {
        // qualified or bare table name, plus the drizzle from() shape; word-bounded so `order` != `orders`.
        const FROM_TABLE = new RegExp(
          `from\\s+(?:"?${t.schema}"?\\s*\\.\\s*)?"?${t.name}"?\\b|from\\s*\\(\\s*["'\`]?(?:${t.schema}\\.)?${t.name}\\b|"${t.schema}"\\."${t.name}"`,
          "i",
        );
        if (FROM_TABLE.test(src)) {
          out.push({
            id: "policy/custom-read-applies-rowpolicy",
            resource: m.name,
            clause: `operations.${opName}`,
            message:
              `op '${opName}' is a custom read (tx:"read") that raw-reads protected resource '${t.name}' (it declares a rowPolicy) without re-applying that rowPolicy — an escalated read must REUSE the fragment (route through ctx.data/ctx.reads or re-call buildReadWhere/the rowPolicy), never silently drop it, or the row-scoped read becomes a whole-table leak`,
          });
        }
      }
    }
    return out;
  },
};
