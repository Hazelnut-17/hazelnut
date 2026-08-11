/**
 * The per-call judge deadline leaf — a pure Promise-race util with no dependency on the judge graph, so both
 * `judge.ts` and `judge-providers.ts`/`eval.ts`/`judge/judge-cli.ts`/`judge-panel.ts`/`llm-surface.ts` bound a judge
 * call from the same source: a hung BYO `JudgeClient` times out to `null` = abstain = fail-closed everywhere.
 */

/** The default per-call judge deadline (ms), shared by every abstain-aware judge site (eval residual, verify
 *  judge, runtime guardrail) so they all fail-closed to abstain on the same timeout. */
export const DEFAULT_JUDGE_DEADLINE_MS = 120000;

/** Race a promise against a deadline; on timeout resolves to `null` (abstain). This only stops waiting — it
 *  does not cancel the underlying work, so a subprocess judge must separately kill its child on timeout. */
export function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([p.then((v) => v as T | null), deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
