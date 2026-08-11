/**
 * The shared foundation `ApiJudgeProvider` (judge-api.ts), `CliJudgeProvider` (judge/judge-cli.ts), and
 * `PanelJudgeClient` (judge/judge-panel.ts) build on: adapters/helpers over the existing `JudgeClient` Port
 * (judge.ts). Design:
 */
import {
  deriveBlocks,
  fingerprint,
  type Verdict,
  type Violation,
} from "@hazelnut/core/core/module-spi.ts";
import { z } from "zod";
import type { JudgeClient, JudgeRequest } from "./ai-contract.ts";

// ── The structured judge output shape (§3/§4) ──────────────────────────────
// A simple shape an LLM/agent can produce in a strict-JSON fence; the adapter normalizes it into full judge-rung
// `Violation`s. Un-exported (no-slow-types) — `RawJudgeVerdict` below is the public shape.
const judgeFindingSchema = z.object({
  id: z.string(), // the principle id the judge flags (e.g. "hygiene/declare-over-handroll")
  message: z.string(), // one actionable NL line
  file: z.string().optional(),
  line: z.number().int().optional(),
});
const judgeVerdictSchema = z.object({
  verdict: z.enum(["pass", "fail"]),
  findings: z.array(judgeFindingSchema).default([]),
});
/** The parsed simple-judge verdict shape — stated explicitly (not `z.infer`) so the public type carries no
 *  inferred/slow Zod type (no-slow-types); the internal `judgeVerdictSchema` validates into this shape. */
export interface RawJudgeFinding {
  readonly id: string;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
}
export interface RawJudgeVerdict {
  readonly verdict: "pass" | "fail";
  readonly findings: ReadonlyArray<RawJudgeFinding>;
}

/** Normalize a parsed simple judge verdict into a canonical `Verdict` (judge-rung `Violation`s). `blocks` is a
 *  placeholder here — `foldVerdict` re-derives it from the curated-gating set downstream, so a judge cannot self-promote. */
export function normalizeJudgeVerdict(raw: RawJudgeVerdict): Verdict {
  const findings: Violation[] = raw.findings.map((f) => {
    const at = { file: f.file ?? "logic/", startLine: f.line ?? 1 };
    const responsible = {
      kind: "unknown" as const,
      why: `judge flagged ${f.id}`,
    };
    return {
      id: f.id,
      rung: "judge" as const,
      blocks: deriveBlocks("judge", { judgeGating: false }), // placeholder — foldVerdict re-derives via the gating set
      phase: "pre-ship" as const,
      at,
      responsible,
      message: f.message,
      source: "judge" as const,
      fingerprint: fingerprint({ id: f.id, at, responsible }),
    };
  });
  return { verdict: raw.verdict, findings };
}

/** Extract + parse a strict-JSON `Verdict` from a judge's raw text: the FIRST ```json fenced block with only
 *  whitespace after it (or the whole string if unfenced). Returns `null` (abstain) on malformed/missing/
 *  schema-invalid output — never throws. */
export function parseJudgeOutput(text: string): Verdict | null {
  // the first fence, and nothing but whitespace after it — exactly the shape the judge prompt pins. Taking
  // the LAST fence let a verdict echoed after the real one (induced from the graded code) win the parse.
  const first = /```json\s*([\s\S]*?)```/.exec(text);
  if (
    first !== null && text.slice(first.index + first[0].length).trim() !== ""
  ) {
    return null; // content after the verdict fence ⇒ not the pinned shape ⇒ abstain
  }
  const candidate = first !== null ? first[1]! : text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.trim());
  } catch {
    return null;
  }
  const v = judgeVerdictSchema.safeParse(parsed);
  return v.success ? normalizeJudgeVerdict(v.data) : null;
}

// ── Abstain + the JudgeProvider contract (§6) ───────────────────────────────
// A broken / timed-out judge abstains: no finding, not counted toward a panel quorum. Never silently pass —
// it logs. `null` is the abstain sentinel.
export type RawVerdict = Verdict | null;

/** A `JudgeClient` adapter that also exposes `judgeRaw` (returns `null` on abstain, so a panel can drop it from
 *  the quorum). The public `judge` maps an abstain to a vacuous `pass` + a loud log. */
export interface JudgeProvider extends JudgeClient {
  readonly judgeRaw: (req: JudgeRequest) => Promise<RawVerdict>;
  readonly name: string; // the provider label (e.g. "api" / "opencode" / "cursor-agent") — surfaced in the verify summary
}

/** Build a `JudgeProvider` from an abstain-aware `judgeRaw`: abstain (`null`) → a vacuous `pass` + a loud warning. */
export function judgeProviderFromRaw(
  name: string,
  judgeRaw: (req: JudgeRequest) => Promise<RawVerdict>,
): JudgeProvider {
  return {
    name,
    judgeRaw,
    judge: async (req) => {
      const raw = await judgeRaw(req);
      if (raw === null) {
        console.error(
          `[judge] '${name}' ABSTAINED (malformed / timed-out / unreachable) — contributes no finding (a judge that cannot answer never silently passes)`,
        );
        return { verdict: "pass", findings: [] };
      }
      return raw;
    },
  };
}

/** A registry's key guard: the shipped adapters live in two modules split by transport, so one message states
 *  the rule once. Throws at CONSTRUCTION — a key missing at spawn/request time is an abstain, not a config error. */
export function requireJudgeKey(
  name: string,
  key: string | undefined,
): string {
  if (!key) {
    throw new Error(
      `judge provider '${name}' needs config.apiKey (set the deployment's key and pass it in)`,
    );
  }
  return key;
}

/** Read a sub-judge's abstain-aware verdict: a `JudgeProvider` (including a nested panel) exposes `judgeRaw`
 *  directly; a plain `JudgeClient` has no abstain channel, so its `judge` result is a real verdict by construction. */
export function rawVerdictOf(
  j: JudgeClient,
  req: JudgeRequest,
): Promise<RawVerdict> {
  return "judgeRaw" in j ? (j as JudgeProvider).judgeRaw(req) : j.judge(req);
}

/** Wrap an abstain-aware `judgeRaw` to retry on abstain (`null`) up to `retries` extra attempts, returning the
 *  first real `Verdict` — a pass/fail returns immediately. Worst-case wait is `(retries + 1) × deadlineMs`; a
 *  persistent abstain propagates to abstain-aware readers (`rawVerdict`, a panel quorum) — only `judge()` folds it. */
export function withRetry(
  judgeRaw: (req: JudgeRequest) => Promise<RawVerdict>,
  retries: number,
): (req: JudgeRequest) => Promise<RawVerdict> {
  const max = Math.max(0, retries); // a negative `retries` clamps to 0 (a single attempt), never "run zero times"
  return async (req) => {
    let last: RawVerdict = null;
    for (let attempt = 0; attempt <= max; attempt++) {
      last = await judgeRaw(req);
      if (last !== null) return last; // a real verdict → stop retrying
    }
    return last; // still ABSTAIN after every attempt → null (propagates; only the judge() door folds it)
  };
}

// ── Panel aggregation (§5) ──────────────────────────────────────────────────
/** How a panel folds N sub-judge verdicts: a finding gates iff `unanimous` (all flag it), `majority` (≥⌈N/2⌉),
 *  `any` (≥1), or `weighted` (Σ weights of the judges that flagged it ≥ threshold). N excludes abstainers. */
export type AggregationPolicy =
  | "unanimous"
  | "majority"
  | "any"
  | { readonly weighted: ReadonlyArray<number>; readonly threshold: number };

// `withDeadline` + `DEFAULT_JUDGE_DEADLINE_MS` live in `judge-deadline.ts` — both this file and `judge.ts` bound
// a judge call from that one source; `judge.ts` cannot import this file.
