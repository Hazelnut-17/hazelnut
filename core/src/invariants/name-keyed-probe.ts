// Literal-name extraction over every handler-bearing declaration's own source text, mirroring
// `authz/perm-probe.ts §literalPermKeys` for the name-keyed ctx doors (`tasks`/`workflows`/`config`/
// `datasource`) `cross-module-face.type-test.ts` proves compile clean on an invented name.
import type { App } from "../core/app.ts";

/** One function in the composed app that receives a `ctx` — a candidate site for a name-keyed door call.
 *  `label` identifies it for a violation's message, never parsed. */
export interface HandlerSite {
  readonly label: string;
  readonly fn: unknown;
}

/**
 * Every handler-bearing declaration the composed `App` carries: op handler slots (`handler`/`before`/
 * `after`/`around`/`replace` — all five run with the same `ctx: OpCtx`), task/workflow `run` bodies,
 * scheduled `defineJob` handlers (`AppConfig.jobs` → `app.jobs`), and subscriber/worker handlers.
 */
export function ctxHandlerSites(app: App): readonly HandlerSite[] {
  const out: HandlerSite[] = [];
  for (const m of app.model) {
    for (const [opName, decl] of Object.entries(m.operations)) {
      const d = decl as Readonly<Record<string, unknown>>;
      for (
        const slot of [
          "handler",
          "before",
          "after",
          "around",
          "replace",
        ] as const
      ) {
        if (typeof d[slot] === "function") {
          out.push({
            label: `${m.name}.operations.${opName}.${slot}`,
            fn: d[slot],
          });
        }
      }
    }
  }
  for (const t of app.tasks ?? []) {
    out.push({ label: `tasks.${t.name}.run`, fn: t.run });
  }
  for (const wf of app.workflows ?? []) {
    out.push({ label: `workflows.${wf.name}.run`, fn: wf.run });
  }
  for (const j of app.jobs ?? []) {
    out.push({ label: `jobs.${j.name}.handler`, fn: j.handler });
  }
  for (const sub of app.relay?.subscribers ?? []) {
    out.push({
      label: `subscribers.${sub.name ?? sub.topic}.handler`,
      fn: sub.handler,
    });
  }
  for (const w of app.relay?.workers ?? []) {
    out.push({ label: `workers.${w.name ?? w.topic}.handler`, fn: w.handler });
  }
  return out;
}

/**
 * Literal names read at `<expr>.<door>.<name>`, immediately followed by one of the door's sanctioned
 * methods. Never anchored on the receiver's own identifier — a handler's ctx parameter is `ctx` in most
 * signatures but `stepCtx` inside a workflow step closure, and this must catch both the way `literalPermKeys`
 * catches `can(...)` regardless of what its first argument is named. Only a literal property name resolves;
 * a name built from a variable is not a claim this can make — a missed key is a finding not raised, never a
 * finding invented.
 */
export function literalDoorPropertyNames(
  fn: unknown,
  door: string,
  methods: readonly string[],
): string[] {
  if (typeof fn !== "function") return [];
  const src = Function.prototype.toString.call(fn);
  const re = new RegExp(
    `\\.${door}\\.([A-Za-z_$][\\w$]*)\\s*\\??\\.\\s*(?:${
      methods.join("|")
    })\\s*\\(`,
    "g",
  );
  return [...src.matchAll(re)].map((m) => m[1]!);
}

/** Literal names passed to `ctx.datasource("<name>")` — the door's one call-form, not property-keyed. */
export function literalDatasourceNames(fn: unknown): string[] {
  if (typeof fn !== "function") return [];
  const src = Function.prototype.toString.call(fn);
  return [
    ...src.matchAll(/\.datasource\s*\(\s*["'`]([^"'`\n]+)["'`]/g),
  ].map((m) => m[1]!);
}
