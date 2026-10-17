import type { ResourceModel } from "../core/app.ts";
import { ok, type Result } from "../core/result.ts";
import { egressOpWithLoss } from "../features/redact.ts";
import { onRowGate, timestampsGate } from "./repo-audit.ts";

/** A built-in module call has the custom-op privacy boundary plus explicit row-address/CAS capabilities.
 * Only the outer returned row receives these capabilities; a nested authored object cannot mint them. */
export function crossModuleCrudResult(
  models: readonly ResourceModel[],
  target: ResourceModel,
  result: Result<unknown>,
): Result<unknown> {
  if (!result.ok) return result;
  const vectors = new Set(
    models.flatMap((model) =>
      model.vector
        ? [
          model.vector.field,
          `${model.vector.field}_embedded_at`,
          `${model.vector.field}_source_hash`,
          `${model.vector.field}_model`,
        ]
        : []
    ),
  );
  const stripVectors = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stripVectors);
    if (
      value === null || typeof value !== "object" || value instanceof Date ||
      value instanceof Uint8Array
    ) return value;
    return Object.fromEntries(
      Object.entries(value).filter(([key]) => !vectors.has(key)).map((
        [key, child],
      ) => [key, stripVectors(child)]),
    );
  };
  // This is an in-process call. Reconstitute native leaf values only where the safe snapshot retained
  // the same value; the privacy projection controls every object key before a native value is copied.
  const nativeLeaves = (source: unknown, projected: unknown): unknown => {
    if (typeof source === "bigint" && projected === String(source)) {
      return source;
    }
    if (
      source instanceof Date && Number.isFinite(source.getTime()) &&
      projected === source.toISOString()
    ) return new Date(source.getTime());
    if (source instanceof Uint8Array && typeof projected === "string") {
      return source.slice();
    }
    if (Array.isArray(source) && Array.isArray(projected)) {
      return projected.map((child, index) =>
        nativeLeaves(source[index], child)
      );
    }
    if (
      source !== null && projected !== null && typeof source === "object" &&
      typeof projected === "object"
    ) {
      return Object.fromEntries(
        Object.entries(projected).map((
          [name, child],
        ) => [
          name,
          nativeLeaves((source as Record<string, unknown>)[name], child),
        ]),
      );
    }
    return projected;
  };
  const safe = nativeLeaves(
    result.value,
    stripVectors(egressOpWithLoss(models, result.value).value),
  );
  const capabilities = (source: unknown, projected: unknown): unknown => {
    if (Array.isArray(source) && Array.isArray(projected)) {
      return source.map((row, index) => capabilities(row, projected[index]));
    }
    if (
      source === null || projected === null || typeof source !== "object" ||
      typeof projected !== "object" || source instanceof Date ||
      source instanceof Uint8Array
    ) return projected;
    const row = source as Record<string, unknown>,
      out = { ...projected as Record<string, unknown> };
    // Raw CRUD rows carry more lifecycle state than their module contract publishes. No declaration can
    // reopen a shadow by adding it to another resource's HTTP projection.
    for (const key of Object.keys(out)) {
      if (!Object.hasOwn(target.schema.shape, key)) delete out[key];
    }
    if (
      Object.hasOwn(row, "id") &&
      (typeof row.id === "string" || typeof row.id === "number")
    ) out.id = row.id;
    if (
      target.features.versioning && typeof row.version === "number" &&
      Number.isSafeInteger(row.version)
    ) out.version = row.version;
    if (timestampsGate(target)?.updated && Object.hasOwn(row, "updated_at")) {
      out.updated_at = row.updated_at;
    }
    if (onRowGate(target)?.updated) {
      for (const name of ["updated_by_type", "updated_by_id"]) {
        if (Object.hasOwn(row, name)) out[name] = row[name];
      }
    }
    return out;
  };
  return ok(capabilities(result.value, safe));
}
