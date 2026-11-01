// Token for the tree self-FK sweep. Not on the repo barrel.
// Only a marked write may touch an expiry-hidden or other-scope child.

const observed = new WeakMap<object, string>();

/** Marks a set-null patch with the parent id the row must still hold. */
export function treeFkSweepPatch(
  patch: Record<string, unknown>,
  parentId: string,
): Record<string, unknown> {
  observed.set(patch, parentId);
  return patch;
}

/** Marks a cascade removal with the parent id the row must still hold. */
export function treeFkSweepMark(parentId: string): object {
  const mark = {};
  observed.set(mark, parentId);
  return mark;
}

/** The dying parent id, when this patch object was marked for the sweep. */
export function observedTreeParent(patch: object): string | undefined {
  return observed.get(patch);
}
