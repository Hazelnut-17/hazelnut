// The observed-claims probe: which permission keys a policy BODY asks about, for the half of
// `authz/key-resolves` a static read cannot reach.
import type { Actor, PermKey } from "./auth-core.ts";

/** A claim set that records every membership test and answers from a fixed verdict. `Set` is subclassed
 *  rather than faked, because `can()` is `actor.claims.has(key)` and a plain object with a `has` method is
 *  not a `ReadonlySet<PermKey>` — the policy would still type-check, and a future reader (`size`, iteration)
 *  would find nothing. */
class RecordingClaims extends Set<PermKey> {
  readonly asked = new Set<string>();
  constructor(private readonly verdict: (key: string) => boolean) {
    super();
  }
  override has(key: PermKey): boolean {
    this.asked.add(key);
    return this.verdict(key);
  }
}

/**
 * The permission keys a policy BODY asks about that resolve to nothing in the app-wide vocabulary.
 *
 * `staticPermKeys` reads the keys a `requires(...)` slot DECLARES — it can, because that slot is data. A
 * `rowPolicy` is a closure, so its `can(actor, "…")` calls are invisible to every static reader, and a
 * typo there is exactly the silent always-deny `authz/key-resolves` exists to refuse: nobody holds the key,
 * the policy takes its deny branch, and the resource is invisible with every gate green.
 *
 * The keys are OBSERVED instead: the policy runs against an actor whose claim set records each membership
 * test. Twice, with opposite verdicts, because a policy is usually a conditional — one run explores the
 * granted branch, the other the denied one, and a key asked only on the far side is still a key that must
 * resolve. Throwing is not this check's business (the fail-closed guards own it), so a throw contributes
 * whatever was asked before it.
 */
export function unresolvedPermKeys(
  policy: unknown,
  vocab: ReadonlySet<string>,
): string[] {
  if (typeof policy !== "function") return [];
  const asked = new Set<string>();
  for (const verdict of [(k: string) => vocab.has(k), () => false]) {
    const claims = new RecordingClaims(verdict);
    // A plain USER actor, never a system one: a policy that short-circuits on `isSystem` would return
    // before asking anything, and a probe that never enters the region measures nothing.
    const actor: Actor = {
      id: "perm-probe",
      type: "user",
      claims: claims as ReadonlySet<PermKey>,
    };
    try {
      const ret = (policy as (a: Actor | null) => unknown)(actor);
      void Promise.resolve(ret).catch(() => {
        /* an async policy's rejection is not this check's business */
      });
    } catch {
      // the guards that own a throwing policy report it; this one only collects what was asked
    }
    for (const k of claims.asked) asked.add(k);
  }
  return [...asked].filter((k) => !vocab.has(k)).sort();
}

/**
 * The permission keys a function's SOURCE names in a literal `can(…, "<key>")`.
 *
 * The read half of the same door. An op HANDLER cannot be probed by running it: it takes `(input, ctx)` and
 * does the app's real work, so observing its claims would perform that work at boot. Its `can()` literals are
 * still authz decisions, and a typo in one is the same silent always-deny — read out of the source instead.
 * Only literal keys resolve; a key built from a variable is not a claim this can make, and a missed key is a
 * finding not raised, never a finding invented.
 */
export function literalPermKeys(fn: unknown): string[] {
  if (typeof fn !== "function") return [];
  const src = Function.prototype.toString.call(fn);
  return [
    ...src.matchAll(/\bcan\s*\(\s*[^,()]*,\s*["'`]([^"'`\n]+)["'`]\s*\)/g),
  ].map((m) => m[1]!);
}
