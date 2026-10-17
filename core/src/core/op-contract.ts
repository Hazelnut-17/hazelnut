import { z } from "zod";
import { knobError } from "./knobs.ts";

/** Shared operation defaults; declaration checks and direct execution resolve the same window. */
export const OP_DEADLINE_DEFAULT_MS = 30_000;
export const IDEMPOTENCY_LEASE_DEFAULT_MS = 5 * 60 * 1000;

export function opDeadlineMs(op: { readonly deadlineMs?: number }): number {
  return op.deadlineMs ?? OP_DEADLINE_DEFAULT_MS;
}

interface OperationContract {
  readonly input?: unknown;
  readonly before?: unknown;
  readonly beforeOutput?: unknown;
  readonly tx?: unknown;
  readonly readConsistency?: unknown;
  readonly idempotent?: unknown;
  readonly deadlineMs?: unknown;
  readonly idempotencyLeaseMs?: unknown;
}

/** A deliberately narrow view of Zod's immutable schema graph. No default/getter is evaluated. */
interface ValidationDef {
  readonly type?: string;
  readonly coerce?: boolean;
  readonly checks?: readonly {
    readonly _zod?: { readonly def?: { readonly check?: string } };
  }[];
  readonly shape?: Readonly<Record<string, z.ZodType>>;
  readonly element?: z.ZodType;
  readonly keyType?: z.ZodType;
  readonly valueType?: z.ZodType;
  readonly options?: readonly z.ZodType[];
  readonly items?: readonly z.ZodType[];
  readonly rest?: z.ZodType | null;
  readonly innerType?: z.ZodType;
}
const leaves: ReadonlySet<string> = new Set([
  "string",
  "number",
  "bigint",
  "boolean",
  "date",
  "symbol",
  "undefined",
  "null",
  "void",
  "never",
  "any",
  "unknown",
  "literal",
  "enum",
  "nan",
  "custom",
  "file",
  "template_literal",
]);
const guards = new WeakMap<z.ZodType, z.ZodType | null>();

/** Build an exact validation guard only for schemas whose parse cannot decode or manufacture output.
 * Opaque graphs require a separately declared validation-only output schema. In particular, do not
 * rerun transforms/coercion/default thunks, infer their inverse, or freeze arbitrary class instances. */
export function validationOnlyGuard(schema: z.ZodType): z.ZodType | undefined {
  const cached = guards.get(schema);
  if (cached !== undefined) return cached ?? undefined;
  // Cycles/lazy graphs have no statically proven effect-free output contract.
  guards.set(schema, null);
  const def = (schema as unknown as { readonly def: ValidationDef }).def;
  if (
    def.coerce || def.checks?.some((c) => c._zod?.def?.check === "overwrite")
  ) return undefined;
  const clone = (patch: Record<string, unknown>): z.ZodType =>
    (schema as z.ZodType & { clone(def: unknown): z.ZodType }).clone({
      ...def,
      ...patch,
    });
  const child = (value: z.ZodType | undefined): z.ZodType | undefined =>
    value instanceof z.ZodType ? validationOnlyGuard(value) : undefined;
  let result: z.ZodType | undefined;
  if (def.type === "object" && def.shape) {
    const shape: Record<string, z.ZodType> = {};
    for (const [name, field] of Object.entries(def.shape)) {
      const guard = child(field);
      if (guard === undefined) return undefined;
      shape[name] = guard;
    }
    // Clone preserves authored validation refinements while closing unknown keys at every object.
    result = clone({ shape, catchall: z.never() });
  } else if (def.type === "array") {
    const element = child(def.element);
    if (element) result = clone({ element });
  } else if (def.type === "record" || def.type === "map") {
    const keyType = child(def.keyType), valueType = child(def.valueType);
    if (keyType && valueType) result = clone({ keyType, valueType });
  } else if (def.type === "set") {
    const valueType = child(def.valueType);
    if (valueType) result = clone({ valueType });
  } else if (def.type === "union" && def.options) {
    const options = def.options.map(child);
    if (options.every((o): o is z.ZodType => o !== undefined)) {
      result = clone({ options });
    }
  } else if (def.type === "tuple" && def.items) {
    const items = def.items.map(child),
      rest = def.rest ? child(def.rest) : undefined;
    if (
      items.every((i): i is z.ZodType => i !== undefined) && (!def.rest || rest)
    ) {
      result = clone({ items, ...(rest ? { rest } : {}) });
    }
  } else if (
    (def.type === "optional" || def.type === "nullable" ||
      def.type === "nonoptional") && def.innerType
  ) {
    const innerType = child(def.innerType);
    if (innerType) result = clone({ innerType });
  } else if (def.type && leaves.has(def.type)) result = schema;
  guards.set(schema, result ?? null);
  return result;
}

/** The guard runs on the already parsed value after EVERY successful before hook, including observers. */
export function beforeInputGuard(op: OperationContract): z.ZodType | undefined {
  if (op.before === undefined) return undefined;
  const schema = op.beforeOutput ?? op.input;
  return schema instanceof z.ZodType ? validationOnlyGuard(schema) : undefined;
}

/** Shared boot/direct-execution checks: invalid declarations cannot reach admission or claim storage. */
export function operationContractErrors(op: OperationContract): string[] {
  const errors = [
    knobError("op/deadline-ms", "deadlineMs", op.deadlineMs, "off-or-ms"),
    knobError(
      "op/idempotency-lease-ms",
      "idempotencyLeaseMs",
      op.idempotencyLeaseMs,
      "positive-ms",
    ),
  ].filter((e): e is string => e !== undefined);
  if (op.tx !== "read" && op.idempotent === true && errors.length === 0) {
    const deadline = typeof op.deadlineMs === "number"
      ? op.deadlineMs
      : OP_DEADLINE_DEFAULT_MS;
    const lease = typeof op.idempotencyLeaseMs === "number"
      ? op.idempotencyLeaseMs
      : IDEMPOTENCY_LEASE_DEFAULT_MS;
    if (deadline === 0 || lease <= deadline) {
      errors.push(
        "op/idempotency-window: an idempotent write needs a finite deadlineMs and idempotencyLeaseMs strictly greater than that deadline (defaults: 30000 ms deadline, 300000 ms lease)",
      );
    }
  }
  if (
    op.readConsistency !== undefined &&
    (op.tx !== "read" || op.readConsistency !== "statement")
  ) {
    errors.push(
      'op/read-consistency: readConsistency must be "statement" on an explicitly tx:"read" operation',
    );
  }
  if (
    op.beforeOutput !== undefined &&
    (!(op.beforeOutput instanceof z.ZodType) ||
      !validationOnlyGuard(op.beforeOutput))
  ) {
    errors.push(
      "op/before-output: beforeOutput must be a validation-only Zod schema; use an exact output object or explicit class validator without transforms, coercion, defaults, catches, overwrites or opaque wrappers",
    );
  } else if (op.before !== undefined && !beforeInputGuard(op)) {
    errors.push(
      "op/before-output: this input has opaque output; every before hook, including an observer returning ok(undefined), must declare a validation-only beforeOutput schema matching the parsed handler input",
    );
  }
  return errors;
}
