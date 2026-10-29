/** Internal origin of framework permission closures; never inferred from public function properties. */
const permissionPolicies = new WeakMap<
  object,
  { readonly keys?: readonly string[] }
>();

export function rememberPermissionPolicy<T extends object>(
  policy: T,
  keys?: readonly string[],
): T {
  permissionPolicies.set(policy, Object.freeze({ keys }));
  return policy;
}

export function permissionPolicyOrigin(
  policy: unknown,
): { readonly keys?: readonly string[] } | undefined {
  return typeof policy === "function"
    ? permissionPolicies.get(policy)
    : undefined;
}
