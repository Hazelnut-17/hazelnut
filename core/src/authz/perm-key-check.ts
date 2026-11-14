import { z } from "zod";

/** Internal marker follows Zod check objects through schema clones. */
export const PERMKEY_CHECK = Symbol.for("hazelnut.permKey.check");
export const PERMKEY_SEAL = Symbol.for("hazelnut.permKey.seal");
export interface PermKeySeal {
  vocab: ReadonlySet<string> | null;
}

export function hasPermKeyChecks(checks: readonly unknown[]): boolean {
  return checks.some((check) =>
    check !== null && typeof check === "object" && PERMKEY_CHECK in check
  );
}

/** Replace only framework permission checks; other authored refinements survive. */
export function bindPermKeyChecks(
  checks: readonly unknown[],
  seal: PermKeySeal,
): readonly unknown[] {
  return checks.map((check) => {
    if (
      check === null || typeof check !== "object" || !(PERMKEY_CHECK in check)
    ) return check;
    const bound = z.string().superRefine((value, ctx) => {
      if (seal.vocab !== null && !seal.vocab.has(value)) {
        ctx.addIssue({
          code: "custom",
          message:
            `unknown permission key '${value}' — not in this app's derived perms vocabulary (a granted scope must name a real permission)`,
        });
      }
    });
    const replacement = bound.def.checks!.at(-1)!;
    Object.defineProperty(replacement, PERMKEY_CHECK, { value: true });
    Object.defineProperty(replacement, PERMKEY_SEAL, { value: seal });
    return replacement;
  });
}
