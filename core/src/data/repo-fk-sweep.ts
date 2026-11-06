// Private capability for an exact FK edge observed by a framework-owned delete sweep.
// It is intentionally absent from the public repo barrel.

export interface ObservedFkSweep {
  readonly fk: string;
  readonly parentId: string;
  /** Tree self-FKs retain their established cross-scope maintenance behavior. */
  readonly allowCrossScope: boolean;
}

const observed = new WeakMap<object, ObservedFkSweep>();

function mark(
  value: object,
  fk: string,
  parentId: string,
  allowCrossScope: boolean,
): void {
  observed.set(value, { fk, parentId, allowCrossScope });
}

/** Marks a set-null patch with the exact FK edge it must still hold. */
export function fkSweepPatch(
  patch: Record<string, unknown>,
  fk: string,
  parentId: string,
): Record<string, unknown> {
  mark(patch, fk, parentId, false);
  return patch;
}

/** Marks a cascade removal with the exact FK edge it must still hold. */
export function fkSweepMark(fk: string, parentId: string): object {
  const token = {};
  mark(token, fk, parentId, false);
  return token;
}

/** Tree self-FK set-null may intentionally cross scope, as before this capability was generalized. */
export function treeFkSweepPatch(
  patch: Record<string, unknown>,
  parentId: string,
): Record<string, unknown> {
  mark(patch, "parent_id", parentId, true);
  return patch;
}

/** Tree self-FK cascade may intentionally cross scope, as before this capability was generalized. */
export function treeFkSweepMark(parentId: string): object {
  const token = {};
  mark(token, "parent_id", parentId, true);
  return token;
}

/** The exact FK edge, when this token came from a framework-owned sweep. */
export function observedFkSweep(token: object): ObservedFkSweep | undefined {
  return observed.get(token);
}
