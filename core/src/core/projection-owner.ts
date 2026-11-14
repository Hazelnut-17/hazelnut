/** Preserve method receivers for app-owned declaration copies without wrapping callbacks. */
const owners = new WeakMap<object, object>();

export function rememberProjectionOwner<T extends object>(
  copy: T,
  owner: T,
): T {
  owners.set(copy, owner);
  return copy;
}

export function projectionOwner<T extends object>(copy: T): T {
  return (owners.get(copy) as T | undefined) ?? copy;
}
