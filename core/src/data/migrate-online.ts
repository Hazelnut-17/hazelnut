// Online authoring passes shared by generated migrations and their replay readers.
import { endOfSqlLiteral, parseCreateTables } from "./ddl-parse.ts";
import { bareName, QUALIFIED_NAME } from "./migrate-safety-names.ts";
import { splitSqlStatements, stripSqlComments } from "./migrate-sql-text.ts";
import { isOutboxScopeIndexUpgrade } from "./migrate-framework-upgrades.ts";

const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`;

export function migrationTableName(
  token: string,
): { schema: string; table: string } {
  const parts = token.match(/"(?:[^"]|"")*"|[A-Za-z_][\w$]*/g) ?? [];
  return {
    schema: parts.length > 1 ? bareName(parts[0]!)! : "public",
    table: bareName(parts.at(-1) ?? "") ?? "",
  };
}

/** Split ALTER's action list without borrowing commas inside expressions or literals. */
export function splitAlterActions(body: string): string[] {
  const out: string[] = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const end = endOfSqlLiteral(body, i);
    if (end > i) {
      i = end - 1;
      continue;
    }
    if (body[i] === "(") depth++;
    else if (body[i] === ")") depth--;
    else if (body[i] === "," && depth === 0) {
      out.push(body.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(body.slice(start).trim());
  return out.filter((action) => action !== "");
}

const alterHead = new RegExp(
  String
    .raw`^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QUALIFIED_NAME})\s+([\s\S]*)$`,
  "i",
);
const constraintAdd = new RegExp(
  String
    .raw`^ADD\s+CONSTRAINT\s+(${QUALIFIED_NAME})\s+((?:CHECK\s*\(|FOREIGN\s+KEY\s*\()[\s\S]*)$`,
  "i",
);

export interface StagedConstraint {
  readonly schema: string;
  readonly table: string;
  readonly constraint: string;
  readonly definition: string;
  readonly statement: string;
}

function validationIdentity(
  schema: string,
  table: string,
  constraint: string,
): string {
  return JSON.stringify([schema, table, constraint]);
}

/** Only a VALIDATE paired with its own preceding NOT VALID ADD is deferred/retried by apply. */
export function stagedConstraintValidations(sql: string): StagedConstraint[] {
  const adds = new Map<string, Omit<StagedConstraint, "statement">>();
  const out: StagedConstraint[] = [];
  for (const statement of splitSqlStatements(stripSqlComments(sql))) {
    const alter = alterHead.exec(statement);
    if (!alter) continue;
    const { schema, table } = migrationTableName(alter[1]!);
    const actions = splitAlterActions(alter[2]!);
    for (const action of actions) {
      const add = constraintAdd.exec(action);
      if (add && /\s+NOT\s+VALID\s*$/i.test(add[2]!)) {
        const constraint = bareName(add[1]!)!;
        adds.set(validationIdentity(schema, table, constraint), {
          schema,
          table,
          constraint,
          definition: add[2]!.replace(/\s+NOT\s+VALID\s*$/i, ""),
        });
      }
      const validate = new RegExp(
        String.raw`^VALIDATE\s+CONSTRAINT\s+(${QUALIFIED_NAME})\s*$`,
        "i",
      )
        .exec(action);
      // Deferring a whole compound ALTER would discard its ADD COLUMN/ADD CONSTRAINT siblings.
      // A hand-authored combined VALIDATE remains ordinary transactional SQL; generated validation
      // is always a standalone statement so ADD can commit before its scan.
      if (!validate || actions.length !== 1) continue;
      const constraint = bareName(validate[1]!)!;
      const staged = adds.get(validationIdentity(schema, table, constraint));
      if (staged) {
        out.push({
          ...staged,
          statement,
        });
      }
    }
  }
  return out;
}

/** Recorded validations whose constraint has not subsequently been dropped or replaced in history. */
export function liveStagedConstraintValidations(
  history: readonly { readonly dir: string; readonly sql: string }[],
): Map<string, { dir: string; validation: StagedConstraint }> {
  const live = new Map<string, { dir: string; validation: StagedConstraint }>();
  for (const entry of history) {
    const validations = new Map(
      stagedConstraintValidations(entry.sql).map((
        v,
      ) => [validationIdentity(v.schema, v.table, v.constraint), v]),
    );
    for (const statement of splitSqlStatements(stripSqlComments(entry.sql))) {
      const droppedTable = new RegExp(
        String.raw`^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(${QUALIFIED_NAME})`,
        "i",
      ).exec(statement);
      if (droppedTable) {
        const target = migrationTableName(droppedTable[1]!);
        for (const [key, current] of live) {
          if (
            current.validation.schema === target.schema &&
            current.validation.table === target.table
          ) live.delete(key);
        }
      }
      const alter = alterHead.exec(statement);
      if (!alter) continue;
      const { schema, table } = migrationTableName(alter[1]!);
      for (const action of splitAlterActions(alter[2]!)) {
        // These already-recorded transformations can rename/recompile or implicitly drop constraints.
        // Their predecessor validation had to finish before apply could advance to this file. Retire
        // that completed obligation on this table (and FK definitions referencing this exact table),
        // rather than compiling the old spelling against the intentionally changed schema forever.
        if (
          /^(?:RENAME\b|SET\s+SCHEMA\b|DROP\s+COLUMN\b|ALTER\s+(?:COLUMN\s+)?(?:"(?:[^"]|"")*"|[A-Za-z_][\w$]*)\s+(?:SET\s+DATA\s+)?TYPE\b)/i
            .test(action)
        ) {
          for (const [key, current] of live) {
            const v = current.validation;
            const owns = v.schema === schema && v.table === table;
            const ref = /^FOREIGN\s+KEY\b/i.test(v.definition)
              ? new RegExp(String.raw`\bREFERENCES\s+(${QUALIFIED_NAME})`, "i")
                .exec(v.definition)
              : null;
            const target = ref ? migrationTableName(ref[1]!) : undefined;
            if (owns || (target?.schema === schema && target.table === table)) {
              live.delete(key);
            }
          }
        }
        const replacement = new RegExp(
          String
            .raw`^(?:ADD\s+CONSTRAINT|DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?)\s*(${QUALIFIED_NAME})`,
          "i",
        ).exec(action);
        if (replacement) {
          live.delete(
            validationIdentity(schema, table, bareName(replacement[1]!)!),
          );
        }
        const validate = new RegExp(
          String.raw`^VALIDATE\s+CONSTRAINT\s+(${QUALIFIED_NAME})\s*$`,
          "i",
        ).exec(action);
        if (!validate) continue;
        const key = validationIdentity(schema, table, bareName(validate[1]!)!);
        const validation = validations.get(key);
        if (validation) live.set(key, { dir: entry.dir, validation });
      }
    }
  }
  return live;
}

function migrationSql(statements: readonly string[]): string {
  return statements.join(";\n--> statement-breakpoint\n") + ";\n";
}

/** CHECK/FK additions to live tables protect new writes immediately, then validate after ADD commits. */
export function stageConstraintAdds(sql: string): string | null {
  const statements = splitSqlStatements(stripSqlComments(sql));
  const created = new Set(
    parseCreateTables(sql).map((t) => JSON.stringify([t.schema, t.table])),
  );
  const validations = new Set<string>();
  for (const staged of stagedConstraintValidations(sql)) {
    validations.add(
      `ALTER TABLE ${quoteIdent(staged.schema)}.${
        quoteIdent(staged.table)
      } VALIDATE CONSTRAINT ${quoteIdent(staged.constraint)}`,
    );
  }
  const appended: string[] = [];
  let changed = false;
  const out = statements.flatMap((stmt) => {
    const alter = alterHead.exec(stmt);
    if (!alter) return [stmt];
    const { schema, table } = migrationTableName(alter[1]!);
    if (created.has(JSON.stringify([schema, table]))) return [stmt];
    const actions = splitAlterActions(alter[2]!);
    let stagedAny = false;
    const rewritten = actions.map((action) => {
      const add = constraintAdd.exec(action);
      if (!add) return action;
      const constraint = bareName(add[1]!)!;
      const validate = `ALTER TABLE ${quoteIdent(schema)}.${
        quoteIdent(table)
      } VALIDATE CONSTRAINT ${quoteIdent(constraint)}`;
      if (!validations.has(validate)) {
        appended.push(validate);
        validations.add(validate);
        changed = true;
      }
      if (/\s+NOT\s+VALID\s*$/i.test(add[2]!)) return action;
      changed = true;
      stagedAny = true;
      return `${action} NOT VALID`;
    });
    return stagedAny
      ? rewritten.map((action) => `ALTER TABLE ${alter[1]} ${action}`)
      : [stmt];
  });
  return changed ? migrationSql([...out, ...appended]) : null;
}

/** Build same-name replacements while the old arbiter still enforces writes; apply checks indisvalid
 * immediately after CREATE, before either DROP or RENAME can execute. Failed builds leave the old index. */
export function stageIndexReplacements(sql: string): string | null {
  const statements = splitSqlStatements(stripSqlComments(sql));
  const outboxUpgrade = isOutboxScopeIndexUpgrade(sql);
  const drops = new Map<string, number[]>();
  const drop = new RegExp(
    String
      .raw`^DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?(${QUALIFIED_NAME})\s*$`,
    "i",
  );
  for (const [i, stmt] of statements.entries()) {
    const found = drop.exec(stmt);
    if (!found) continue;
    const { schema, table: name } = migrationTableName(found[1]!);
    const key = JSON.stringify([schema, name]);
    drops.set(key, [...(drops.get(key) ?? []), i]);
  }
  const replacements = new Map<number, string[]>();
  const omitted = new Set<number>();
  const create = new RegExp(
    String
      .raw`^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${QUALIFIED_NAME})\s+ON\s+(?:ONLY\s+)?(${QUALIFIED_NAME})([\s\S]*)$`,
    "i",
  );
  for (const [i, stmt] of statements.entries()) {
    const found = create.exec(stmt);
    if (!found) continue;
    const name = bareName(found[2]!)!;
    // Framework tables have their own exact, versioned replacement proofs. Do not rewrite the
    // sanctioned outbox transition into different bytes and invalidate its hard-gate exception.
    const { schema, table } = migrationTableName(found[3]!);
    if (
      outboxUpgrade && schema === "public" && table === "_outbox" &&
      (name === "_outbox_cron_once" || name === "_outbox_cron_once_upgrade")
    ) continue;
    const matchedDrops = drops.get(JSON.stringify([schema, name]));
    if (matchedDrops?.length !== 1) continue;
    // Deterministic and below Postgres's 63-byte identifier limit, even for a maximum-length name.
    let hash = 2166136261;
    for (const c of stmt) {
      hash = Math.imul(hash ^ c.charCodeAt(0), 16777619) >>> 0;
    }
    const next = `${name.slice(0, 35)}_hz_next_${
      hash.toString(16).padStart(8, "0")
    }`;
    replacements.set(i, [
      `CREATE ${found[1] ?? ""}INDEX CONCURRENTLY ${quoteIdent(next)} ON ${
        found[3]
      }${found[4]}`,
      `DROP INDEX CONCURRENTLY ${quoteIdent(schema)}.${quoteIdent(name)}`,
      `ALTER INDEX ${quoteIdent(schema)}.${quoteIdent(next)} RENAME TO ${
        quoteIdent(name)
      }`,
    ]);
    omitted.add(matchedDrops[0]!);
  }
  if (replacements.size === 0) return null;
  return migrationSql(
    statements.flatMap((stmt, i) =>
      omitted.has(i) ? [] : (replacements.get(i) ?? [stmt])
    ),
  );
}
