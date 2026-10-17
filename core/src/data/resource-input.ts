import { z } from "zod";
import type { ResourceModel } from "../core/app.ts";
import { parsePatch, type PgType, strictify } from "./schema-types.ts";
import { dbDefaultOf, hasApplicationDefault } from "./db-default.ts";
import type { Db } from "./db.ts";
import { PG_DDL } from "./schema-derive.ts";
import { createStatusGuardViolation } from "../features/transition.ts";
import { createSuppliableOf, updateWritableOf } from "./write-plan.ts";
import { int4Input } from "./scalar-bounds.ts";
import { BYTEA_INPUT_PATTERN, textInputCasts } from "./native-cast.ts";

/** The declared resource input plus the framework fields its typed write face admits. Unknown keys
 * stay loud; Zod validation and transforms run before any repository write. */
export function resourceInputSchema(
  model: ResourceModel,
  patch = false,
  wire = false,
  materialized = false,
): z.ZodObject {
  const fields: Record<string, z.ZodType> = {};
  for (const [name, field] of Object.entries(model.schema.shape)) {
    if (model.columns[name]?.pg === "integer") {
      fields[name] = int4Input(field as z.ZodType);
    }
  }
  for (const [name, pg] of textInputCasts(model)) {
    if (!/^(?:bytea|inet\[\])$/i.test(pg)) continue;
    const field = fields[name] ?? model.schema.shape[name] as z.ZodType;
    const prior = field.meta() ?? {};
    const description = pg.toLowerCase() === "bytea"
      ? "PostgreSQL bytea text: prefer \\x plus hex byte pairs; historical escape/plain text is also accepted. Base64-looking text is stored literally, not decoded."
      : "PostgreSQL inet[] array text, for example {10.0.0.1,::1}; {} is empty and array elements may be NULL. This is a string input, not a JSON array.";
    fields[name] = field.meta({
      ...prior,
      description: [prior.description, description].filter(Boolean).join(" "),
      ...(pg.toLowerCase() === "bytea"
        ? {
          allOf: [...(Array.isArray(prior.allOf) ? prior.allOf : []), {
            pattern: BYTEA_INPUT_PATTERN,
          }],
        }
        : {}),
    });
  }
  if (!patch && !materialized) {
    for (const [name, field] of Object.entries(model.schema.shape)) {
      if (dbDefaultOf(field)) {
        fields[name] = (fields[name] ?? field as z.ZodType).optional();
      }
    }
  }
  const lifecycle = patch
    ? updateWritableOf(model).allow
    : createSuppliableOf(model);
  const timestamp = z.union([z.date(), z.iso.datetime({ offset: true })]);
  for (const key of lifecycle) {
    // Per-row expiry remains a ctx.data door; temporal window fields have a wire face too.
    if (wire && key === "expires_at") continue;
    if (key in model.schema.shape) continue;
    fields[key] = key === "valid_from"
      ? timestamp.optional()
      : timestamp.nullable().optional();
  }
  if (!wire && model.parentFk && !(model.parentFk in model.schema.shape)) {
    fields[model.parentFk] = z.string().min(1).optional();
  }
  if (!wire && model.features.tree && !("parent_id" in model.schema.shape)) {
    fields.parent_id = z.string().min(1).nullable().optional();
  }
  return Object.keys(fields).length === 0
    ? model.schema
    : model.schema.safeExtend(fields);
}

export function parseResourceWrite(
  model: ResourceModel,
  raw: unknown,
  patch = false,
): { success: true; data: Record<string, unknown> } | { success: false } {
  if (
    patch && updateWritableOf(model).denyStatus && raw !== null &&
    typeof raw === "object" && Object.hasOwn(raw, "status")
  ) {
    return { success: false };
  }
  const schema = resourceInputSchema(model, patch, false, true);
  if (patch) return parsePatch(schema, raw);
  const parsed = strictify(schema).safeParse(raw);
  return parsed.success
    ? {
      success: true,
      data: parsed.data as Record<string, unknown>,
    }
    : { success: false };
}

/** A structural create plan. Optional pre-auth validation consumes the application parse once. */
export interface ResourceCreatePlan {
  readonly model: ResourceModel;
  readonly schema: z.ZodObject;
  readonly candidate: unknown;
  readonly sqlKeys: readonly string[];
  readonly parsed?: Record<string, unknown>;
}

export function prepareResourceCreate(
  model: ResourceModel,
  raw: unknown,
  opts: {
    readonly wire?: boolean;
    readonly validateBeforeAuth?: boolean;
    readonly validateNow?: boolean;
  } = {},
): { success: true; plan: ResourceCreatePlan } | {
  success: false;
  message: string;
} {
  const schema = resourceInputSchema(model, false, opts.wire, true);
  const candidate =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? { ...raw as Record<string, unknown> }
      : raw;
  const sqlKeys: string[] = [];
  if (
    candidate !== null && typeof candidate === "object" &&
    !Array.isArray(candidate)
  ) {
    const values = candidate as Record<string, unknown>;
    for (const [key, field] of Object.entries(model.schema.shape)) {
      const spec = model.columns[key]?.default;
      if (values[key] !== undefined || !spec || hasApplicationDefault(field)) {
        continue;
      }
      if (spec.kind === "literal") values[key] = spec.value;
      else sqlKeys.push(key);
    }
  }
  if (opts.validateBeforeAuth && sqlKeys.length > 0) {
    return {
      success: false,
      message:
        "an omitted SQL default requires authentication before validation; supply the field or provide an application default",
    };
  }
  const plan: ResourceCreatePlan = { model, schema, candidate, sqlKeys };
  if (opts.validateBeforeAuth || (opts.validateNow && sqlKeys.length === 0)) {
    const result = strictify(schema).safeParse(candidate);
    if (!result.success) {
      return { success: false, message: "body failed validation" };
    }
    const statusError = createStatusGuardViolation(
      model,
      result.data as Record<string, unknown>,
    );
    if (statusError) return { success: false, message: statusError };
    return {
      success: true,
      plan: { ...plan, parsed: result.data as Record<string, unknown> },
    };
  }
  return { success: true, plan };
}

/** Complete a create inside its write transaction, before every storage feature consumes the values. */
export async function finishResourceCreate(
  db: Db,
  plan: ResourceCreatePlan,
): Promise<Record<string, unknown>> {
  let parsed = plan.parsed;
  if (!parsed) {
    const candidate =
      plan.candidate !== null && typeof plan.candidate === "object" &&
        !Array.isArray(plan.candidate)
        ? { ...plan.candidate as Record<string, unknown> }
        : plan.candidate;
    if (plan.sqlKeys.length > 0) {
      const expressions = plan.sqlKeys.map((key, index) => {
        const column = plan.model.columns[key]!;
        const spec = column.default!;
        if (spec.kind !== "raw") {
          throw new Error("database default plan changed");
        }
        const pg = column.pg in PG_DDL
          ? PG_DDL[column.pg as PgType]
          : column.pg;
        return `(${spec.sql})::${pg} AS c${index}`;
      });
      const [row] = (await db.query(`SELECT ${expressions.join(", ")}`)).rows;
      for (const [index, key] of plan.sqlKeys.entries()) {
        const value = row?.[`c${index}`];
        const field = plan.model.schema.shape[key] as z.ZodType;
        let leaf = field;
        while ("innerType" in leaf.def) leaf = leaf.def.innerType as z.ZodType;
        (candidate as Record<string, unknown>)[key] =
          leaf.def.type === "date" && typeof value === "string"
            ? new Date(value)
            : value;
      }
    }
    const result = strictify(plan.schema).safeParse(candidate);
    if (!result.success) {
      throw Object.assign(
        new Error(`${plan.model.name}: create input failed validation`),
        { kind: "validation" },
      );
    }
    parsed = result.data as Record<string, unknown>;
  }
  const statusError = createStatusGuardViolation(plan.model, parsed);
  if (statusError) {
    throw Object.assign(new Error(statusError), { kind: "validation" });
  }
  return { ...parsed };
}
