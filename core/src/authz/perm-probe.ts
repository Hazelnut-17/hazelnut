// The observed-claims probe: which permission keys a policy BODY asks about, for the half of
// `authz/key-resolves` a static read cannot reach.
import { type Actor, type PermKey, withTenant } from "./auth-core.ts";
import { SourceAst, sourceNode } from "../invariants/source-ast.ts";

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
 * `rowPolicy` is a closure, so arbitrary runtime keys cannot be read from its syntax. A
 * typo there is exactly the silent always-deny `authz/key-resolves` exists to refuse: nobody holds the key,
 * the policy takes its deny branch, and the resource is invisible with every gate green.
 *
 * Keys are observed over a finite user/agent, tenant and delegation matrix with vocabulary/deny/grant
 * answers, and supplemented by statically proved syntax. Arbitrary branch predicates remain unproved.
 * Throwing belongs to the fail-closed guards; retain whatever was asked before the throw.
 */
export function unresolvedPermKeys(
  policy: unknown,
  vocab: ReadonlySet<string>,
): string[] {
  if (typeof policy !== "function") return [];
  const asked = new Set<string>();
  for (const type of ["user", "agent"] as const) {
    for (const tenant of [false, true]) {
      for (const delegated of [false, true]) {
        for (
          const verdict of [
            (k: string) => vocab.has(k),
            () => false,
            () => true,
          ]
        ) {
          const claims = new RecordingClaims(verdict);
          const actor: Actor = {
            id: type === "agent" ? "agent:perm-probe" : "user:perm-probe",
            type,
            claims,
            ...(delegated ? { onBehalfOf: "user:perm-probe" } : {}),
          };
          if (tenant) withTenant(actor, "perm-probe-tenant");
          try {
            const ret = (policy as (a: Actor | null) => unknown)(actor);
            void Promise.resolve(ret).catch(() => {
              /* asynchronous policy behavior is invalid and belongs to its own guard */
            });
          } catch {
            // The throwing-policy guard owns the error; retain every membership test before it.
          }
          for (const key of claims.asked) asked.add(key);
        }
      }
    }
  }
  // Literal syntax reaches an actor-id branch that this finite observation matrix cannot select.
  for (const key of literalPermKeys(policy)) asked.add(key);
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
const literalCache = new WeakMap<object, readonly string[]>();
export function literalPermKeys(fn: unknown): string[] {
  if (typeof fn !== "function") return [];
  const cached = literalCache.get(fn);
  if (cached) return [...cached];
  const src = Function.prototype.toString.call(fn);
  let ast: SourceAst | undefined;
  // Method declarations serialize without `function`; parse them as an object method instead.
  for (const wrapped of [`(${src})`, `({${src}})`]) {
    try {
      ast = new SourceAst(wrapped);
      break;
    } catch { /* native/bound or unsupported syntax stays unknown */ }
  }
  if (!ast) return [];
  const keys = new Set<string>();
  for (const node of ast.nodes) {
    if (
      node.type !== "CallExpression" && node.type !== "OptionalCallExpression"
    ) continue;
    const name = ast.freeName(node.callee);
    if (
      !name || !["can", "canAny", "canAll"].includes(name) ||
      !Array.isArray(node.arguments)
    ) continue;
    const argument: unknown = node.arguments[1];
    if (name === "can") {
      const value = ast.string(argument);
      if (value !== null) keys.add(value);
    } else if (
      sourceNode(argument) && argument.type === "ArrayExpression" &&
      Array.isArray(argument.elements)
    ) {
      for (const entry of argument.elements) {
        const value = ast.string(entry);
        if (value !== null) keys.add(value);
      }
    }
  }
  const result = [...keys].sort();
  literalCache.set(fn, result);
  return result;
}
