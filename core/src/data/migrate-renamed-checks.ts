import { bareName, QUALIFIED_NAME } from "./migrate-safety-names.ts";
import { migrationTableName, splitAlterActions } from "./migrate-online.ts";
import { splitSqlStatements, stripSqlComments } from "./migrate-sql-text.ts";

const ident = String.raw`"(?:[^" ]|""| )*"|[A-Za-z_][\w$]*`;
const enumCheck = new RegExp(
  String
    .raw`^\s*(?:CHECK\s*\()?\s*(${ident})\s+IN\s*\(\s*((?:'(?:[^']|'')*'\s*,\s*)*'(?:[^']|'')*')\s*\)\s*\)?\s*$`,
  "i",
);
/** Only the framework's one-column literal enum form. No inferred equivalence of arbitrary CHECK code. */
export function enumCheckParts(
  value: string,
): { column: string; values: string } | undefined {
  const match = enumCheck.exec(value);
  if (!match) return undefined;
  return {
    column: bareName(match[1]!)!,
    values: JSON.stringify(match[2]!.match(/'(?:[^']|'')*'/g)),
  };
}

/** Drizzle renames a CHECK, then redundantly drops/re-adds it because its snapshot expression retains
 * the old column spelling. PostgreSQL already updates that reference during RENAME COLUMN. Retain the
 * existing constraint only when its old literal enum and emitted replacement are exactly equal. */
export function preserveRenamedEnumChecks(
  sql: string,
  snapshot: unknown,
): string | null {
  const entries = (snapshot as {
    ddl?: {
      entityType?: string;
      schema?: string;
      table?: string;
      name?: string;
      value?: string;
    }[];
  })?.ddl;
  if (!Array.isArray(entries)) return null;
  const checks = new Map(
    entries.filter((e) =>
      e.entityType === "checks" && typeof e.value === "string"
    ).map((
      e,
    ) => [JSON.stringify([e.schema ?? "public", e.table, e.name]), {
      expression: e.value!,
      renamed: false,
    }]),
  );
  const alter = new RegExp(
    String.raw`^ALTER\s+TABLE\s+(${QUALIFIED_NAME})\s+([\s\S]*)$`,
    "i",
  );
  // Drizzle authors DROP+ADD as comma-separated actions in one ALTER. Normalize those actions before
  // proving adjacency, while retaining every unrelated action in the original execution order.
  const statements = splitSqlStatements(stripSqlComments(sql)).flatMap(
    (statement) => {
      const head = alter.exec(statement);
      return head
        ? splitAlterActions(head[2]!).map((action) =>
          `ALTER TABLE ${head[1]} ${action}`
        )
        : [statement];
    },
  );
  const column = new RegExp(
    String.raw`^RENAME\s+COLUMN\s+(${ident})\s+TO\s+(${ident})$`,
    "i",
  );
  const constraint = new RegExp(
    String.raw`^RENAME\s+CONSTRAINT\s+(${ident})\s+TO\s+(${ident})$`,
    "i",
  );
  const dropped = new RegExp(String.raw`^DROP\s+CONSTRAINT\s+(${ident})$`, "i");
  const added = new RegExp(
    String
      .raw`^ADD\s+CONSTRAINT\s+(${ident})\s+(CHECK\s*\([\s\S]*\))(?:\s+NOT\s+VALID)?$`,
    "i",
  );
  const omit = new Set<number>();
  for (let i = 0; i < statements.length; i++) {
    const head = alter.exec(statements[i]!);
    if (!head) continue;
    const table = migrationTableName(head[1]!);
    const key = (name: string) =>
      JSON.stringify([table.schema, table.table, name]);
    const renamedColumn = column.exec(head[2]!);
    if (renamedColumn) {
      for (const [id, state] of checks) {
        const [schema, name] = JSON.parse(id);
        const parsed = enumCheckParts(state.expression);
        if (
          schema === table.schema && name === table.table &&
          parsed?.column === bareName(renamedColumn[1]!)
        ) {
          state.expression = state.expression.replace(
            new RegExp(String.raw`^\s*(${ident})`),
            renamedColumn[2]!,
          );
        }
      }
    }
    const renamed = constraint.exec(head[2]!);
    if (renamed) {
      const state = checks.get(key(bareName(renamed[1]!)!));
      if (state) {
        checks.delete(key(bareName(renamed[1]!)!));
        state.renamed = true;
        checks.set(key(bareName(renamed[2]!)!), state);
      }
    }
    const drop = dropped.exec(head[2]!);
    const next = alter.exec(statements[i + 1] ?? "");
    const add = next ? added.exec(next[2]!) : null;
    if (
      !drop || !next || !add ||
      JSON.stringify(migrationTableName(next[1]!)) !== JSON.stringify(table) ||
      bareName(drop[1]!) !== bareName(add[1]!)
    ) continue;
    const state = checks.get(key(bareName(drop[1]!)!));
    const old = state ? enumCheckParts(state.expression) : undefined,
      replacement = enumCheckParts(add[2]!);
    if (
      state?.renamed && old && replacement &&
      old.column === replacement.column && old.values === replacement.values
    ) {
      omit.add(i);
      omit.add(i + 1);
      const validate = alter.exec(statements[i + 2] ?? "");
      const validationName = validate
        ? new RegExp(String.raw`^VALIDATE\s+CONSTRAINT\s+(${ident})$`, "i")
          .exec(validate[2]!)
        : null;
      if (
        validate && validationName &&
        JSON.stringify(migrationTableName(validate[1]!)) ===
          JSON.stringify(table) &&
        bareName(validationName[1]!) === bareName(add[1]!)
      ) omit.add(i + 2);
    }
  }
  return omit.size === 0
    ? null
    : statements.filter((_, i) => !omit.has(i)).join(
      ";\n--> statement-breakpoint\n",
    ) + ";\n";
}
