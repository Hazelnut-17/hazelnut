/**
 * `ValueProvenance` — the model-origin record stamped onto a value produced through `ctx.llm.call`; the only
 * place the framework learns a value is model-produced. `source:"model"` can never be laundered as `"human"`
 * (a raw SDK call under a human actor would read that way, with no signal it was model-produced). The stamp
 * threads into the audit layer via `ctx.log` under the reserved `valueProvenance` key, not a parallel system.
 */
export type ValueSource = "model" | "human" | "system";

export interface ValueProvenance {
  readonly source: ValueSource;
  readonly model: string; // which model produced the value (the answering model, gateway-resolved when present)
  readonly call: string; // the defineLLMCall name (which declared call minted it)
  readonly at: string; // ISO wall-clock instant the value was produced (from ctx.now())
  readonly actor?: string; // the attributing principal (ctx.actor.id), when present
  readonly onBehalfOf?: string; // the agent-acting-for-user provenance (ctx.actor.onBehalfOf), when present
}

/** The reserved `ctx.log` key under which the model-origin stamp lands in the op's `ProvenanceRecord.attrs`
 *  (so the audit trail / oversight layer reads it without a parallel provenance store). */
export const VALUE_PROVENANCE_KEY = "valueProvenance" as const;

/** Build the model-origin `ValueProvenance` for an LLM call. `source` is always `"model"` — no parameter can
 *  make it anything else, so a value produced through this path can never be minted `source:"human"`. */
export function modelProvenance(args: {
  readonly call: string;
  readonly model: string;
  readonly at: Date;
  readonly actor?: string;
  readonly onBehalfOf?: string;
}): ValueProvenance {
  return {
    source: "model",
    model: args.model,
    call: args.call,
    at: args.at.toISOString(),
    ...(args.actor !== undefined ? { actor: args.actor } : {}),
    ...(args.onBehalfOf !== undefined ? { onBehalfOf: args.onBehalfOf } : {}),
  };
}

/** Serialize a `ValueProvenance` into a `ctx.log`-droppable JSON-scalar string (`ProvenanceRecord.attrs`'
 *  leaf type). The inverse `readValueProvenance` recovers it. A value with no such attr key reads, by the
 *  framework's lens, as not model-produced — the absence is exactly the laundering the stamp closes. */
export function encodeValueProvenance(p: ValueProvenance): string {
  return JSON.stringify(p);
}

/** Decode one encoded stamp into a `ValueProvenance`, or `undefined` if it is not a valid model-origin stamp.
 *  Shared by both the single-read and the accumulated-read paths. */
function decodeOneProvenance(raw: unknown): ValueProvenance | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const p = JSON.parse(raw) as ValueProvenance;
    return p.source === "model" ? p : undefined; // only a model-origin stamp is a valid model-provenance read
  } catch {
    return undefined;
  }
}

/** Accumulate a new stamp onto an op's existing `valueProvenance` attr value: each `ctx.llm.call` appends
 *  under the one reserved key, so N calls in one op yield N stamps, none lost to overwrite. Returns a single
 *  string for the first call (shape stays byte-identical) or an array once a second stamp accumulates. */
export function accumulateValueProvenance(
  existing: unknown,
  p: ValueProvenance,
): string | string[] {
  const encoded = encodeValueProvenance(p);
  if (existing === undefined) return encoded; // first stamp — keep the single-string shape
  if (Array.isArray(existing)) return [...(existing as string[]), encoded];
  return [existing as string, encoded]; // promote the first single-string stamp into an accumulating list
}

/** Read every accumulated model-origin stamp off an op's drained `attrs`. Accepts both the single-string
 *  shape and the accumulated array, returning all valid model stamps in call order. */
export function readValueProvenances(
  attrs: Readonly<Record<string, unknown>> | undefined,
): ValueProvenance[] {
  const raw = attrs?.[VALUE_PROVENANCE_KEY];
  if (raw === undefined) return [];
  const encoded = Array.isArray(raw) ? raw : [raw];
  const out: ValueProvenance[] = [];
  for (const e of encoded) {
    const p = decodeOneProvenance(e);
    if (p !== undefined) out.push(p);
  }
  return out;
}

/** Read the model-origin stamp back off an op's drained `attrs`. Returns the decoded `ValueProvenance` when
 *  the op produced a model value, or `undefined` when it did not (an un-stamped value reads as the acting
 *  actor's origin, not model). For a multi-call op the first accumulated stamp is returned — use
 *  `readValueProvenances` for the full set. */
export function readValueProvenance(
  attrs: Readonly<Record<string, unknown>> | undefined,
): ValueProvenance | undefined {
  return readValueProvenances(attrs)[0];
}

/** The framework's lens on a value's source given a stamp (or its absence) and the acting actor, as one pure
 *  predicate: a `source:"model"` stamp reads `"model"`; an un-stamped value reads the actor's own source. */
export function valueSource(
  stamp: ValueProvenance | undefined,
  actorType: "user" | "agent" | "system" | null,
): ValueSource {
  if (stamp?.source === "model") return "model";
  return actorType === "system" ? "system" : "human"; // un-stamped ⇒ the human/system actor's own origin
}

// ── (1) cost/token budget — the per-actor accumulator ───────────────────────────────────────────────────

/** `LLMBudget` — the cost/token accumulator attributed to `ctx.actor` / `ctx.onBehalfOf`. `ctx.llm.call`
 *  feeds it, since the op-pipeline cannot otherwise see a handler's LLM spend; keyed by the attribution
 *  principal, it accumulates `{ calls, tokens }` per op. A ceiling/cost-model is app-side policy — this owns
 *  the honest accumulator, not enforcement (same posture as `valueProvenance`: stamps, does not block). */
export interface LLMSpend {
  readonly calls: number;
  readonly tokens: number;
}

export interface LLMBudget {
  /** Take a call slot for a principal, SYNCHRONOUSLY. The ceiling is a check-then-act unless the slot is
   *  claimed in the same synchronous block as the check — N concurrent calls all read the pre-call count
   *  and all pass otherwise. It is taken BEFORE the Port because the egress is what the ceiling bounds:
   *  a call that reaches the provider and then fails still spent the thing being capped. */
  reserve(principal: string): void;
  /** Attribute a call's token spend to a principal (accumulates; 0 tokens when the client gave no usage).
   *  The call itself was already counted by `reserve` — this adds tokens only. */
  charge(principal: string, tokens: number): void;
  /** This principal's accumulated spend across the op (calls + tokens); the zero spend when never charged. */
  spentBy(principal: string): LLMSpend;
  /** The total spend across all principals in this op — the op-level roll-up the provenance drain can read. */
  total(): LLMSpend;
}

/**
 * `LLMCap` — the per-op, per-principal ceiling on `ctx.llm` spend (`defineConfig({ llm: { cap } })`), the
 * containment family `schedulingCap` belongs to, and BORN-ON like that sibling: an undeclared knob takes its
 * floor, so an app composes with a finite ceiling it raises deliberately. `cap: false` is the one uncapped
 * door, and it is a declaration — absence is not, and a handler loop billed against it.
 */
export interface LLMCap {
  /** At most this many `ctx.llm.call`s per op for one principal. `0` refuses every call. */
  readonly maxCalls?: number;
  /** Refuse once this principal's accumulated token spend has REACHED the ceiling — the pending call's own
   *  count is unknowable before the model answers, so the reached ceiling is the last honest refusal point. */
  readonly maxTokens?: number;
}

/** One ceiling: its born-on floor, the spend it reads off the op's budget, and the noun it denies in. */
interface LLMCapKnob {
  readonly floor: number;
  readonly spent: (s: LLMSpend) => number;
  readonly unit: string;
}

/**
 * Every ceiling an `LLMCap` carries, as data — the floor, the boot validity guard and the breach check all
 * fold this one roster. A knob added to `LLMCap` without an entry here is a compile error, so no ceiling can
 * exist that is neither floored nor enforced. The floors bound ONE op's handler for ONE principal: generous
 * for a real handler, immediate for the runaway loop that has nothing else stopping it.
 */
export const LLM_CAP_KNOBS = {
  maxCalls: {
    floor: 20,
    spent: (s: LLMSpend) => s.calls,
    unit: "ctx.llm.call per op",
  },
  maxTokens: {
    floor: 200_000,
    spent: (s: LLMSpend) => s.tokens,
    unit: "model tokens per op",
  },
} satisfies Record<keyof Required<LLMCap>, LLMCapKnob>;

/**
 * Complete a declared cap against the born-on floors, or `undefined` for the deliberate `false` opt-out.
 * Every knob comes back SET, which is what makes `cap: {}` the floor rather than a ceiling that caps nothing
 * while satisfying a presence check. Applied at the call core, so no layer above can leave a call uncapped by
 * omitting the key.
 */
export function resolveLLMCap(
  cap: LLMCap | false | undefined,
): Required<LLMCap> | undefined {
  if (cap === false) return undefined;
  const resolved: Record<string, number> = {};
  for (const [knob, spec] of Object.entries(LLM_CAP_KNOBS)) {
    resolved[knob] = cap?.[knob as keyof LLMCap] ?? spec.floor;
  }
  return resolved as Required<LLMCap>;
}

/** Why charging one more call would breach `cap`, or `null` when it fits. Read before the model is reached:
 *  a charge after the fact records spend, it cannot prevent it. */
export function capBreach(cap: LLMCap, spent: LLMSpend): string | null {
  for (const [knob, spec] of Object.entries(LLM_CAP_KNOBS)) {
    const limit = cap[knob as keyof LLMCap];
    if (limit !== undefined && spec.spent(spent) >= limit) {
      return `llm budget exceeded: at most ${limit} ${spec.unit} for this principal (already ${
        spec.spent(spent)
      }) — raise defineConfig({ llm: { cap: { ${knob} } } })`;
    }
  }
  return null;
}

/** Construct a fresh per-op `LLMBudget`. One instance threads onto the op's ctx so every `ctx.llm.call` in
 *  the handler accumulates into the same op-level budget, drained with the record. */
export function makeLLMBudget(): LLMBudget {
  const byPrincipal = new Map<string, { calls: number; tokens: number }>();
  return {
    reserve(principal) {
      const cur = byPrincipal.get(principal) ?? { calls: 0, tokens: 0 };
      byPrincipal.set(principal, { calls: cur.calls + 1, tokens: cur.tokens });
    },
    charge(principal, tokens) {
      // a non-finite count from a BYO client charges 0: `Math.max(0, NaN)` is NaN, and one NaN would poison
      // this principal's running total (and the op roll-up) for every later read.
      const charged = Number.isFinite(tokens) ? Math.max(0, tokens) : 0;
      const cur = byPrincipal.get(principal) ?? { calls: 0, tokens: 0 };
      byPrincipal.set(principal, {
        calls: cur.calls,
        tokens: cur.tokens + charged,
      });
    },
    spentBy(principal) {
      return byPrincipal.get(principal) ?? { calls: 0, tokens: 0 };
    },
    total() {
      let calls = 0, tokens = 0;
      for (const s of byPrincipal.values()) {
        calls += s.calls;
        tokens += s.tokens;
      }
      return { calls, tokens };
    },
  };
}

/** The attribution principal for budget + provenance: the agent-acting-for-user `onBehalfOf` when present,
 *  else the actor id, else `"anonymous"` (a public/no-actor call is fine — the actor rides along only for
 *  attribution). */
export function attributionPrincipal(
  actor: { readonly id: string; readonly onBehalfOf?: string } | null,
): string {
  if (actor === null) return "anonymous";
  return actor.onBehalfOf ?? actor.id;
}

// ── (3)+(4) the call core — validate → render → Port → validate, with the four concerns attached ────────
