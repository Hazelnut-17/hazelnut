// Numeric declaration knobs: one domain vocabulary and one refusal shape, so a knob that reaches a timer,
// a SQL interval, a loop bound or a cap is refused where it is declared instead of misbehaving where it lands.

/** Deno wraps a timer delay at or past 2^31 ms — like 0, a negative, NaN or Infinity — to about 1 ms. */
export const TIMER_MAX_MS = 2_147_483_647;

export type KnobDomain =
  | "positive-ms"
  | "off-or-ms"
  | "positive-int"
  | "non-negative-int"
  | "integer"
  | "port"
  | "positive-seconds";

const DESCRIBE: Record<KnobDomain, string> = {
  "positive-ms":
    `a finite number of milliseconds between 1 and ${TIMER_MAX_MS}`,
  "off-or-ms":
    `0 (off) or an integer number of milliseconds between 1 and ${TIMER_MAX_MS}`,
  "positive-int": "a positive integer",
  "non-negative-int": "a non-negative integer",
  "integer": "a safe integer",
  "port": "an integer port between 1 and 65535",
  "positive-seconds": `a finite number of seconds between 1 and ${
    Math.floor(TIMER_MAX_MS / 1000)
  }`,
};

function admits(domain: KnobDomain, v: number): boolean {
  switch (domain) {
    case "positive-ms":
      return Number.isFinite(v) && v >= 1 && v <= TIMER_MAX_MS;
    case "off-or-ms":
      return v === 0 || (Number.isInteger(v) && v >= 1 && v <= TIMER_MAX_MS);
    case "positive-int":
      return Number.isSafeInteger(v) && v >= 1;
    case "non-negative-int":
      return Number.isSafeInteger(v) && v >= 0;
    case "integer":
      return Number.isSafeInteger(v);
    case "port":
      return Number.isInteger(v) && v >= 1 && v <= 65535;
    case "positive-seconds":
      return Number.isFinite(v) && v >= 1 && v <= TIMER_MAX_MS / 1000;
  }
}

/** The refusal line for a present knob outside its domain; `undefined` when it is absent or admitted. */
export function knobError(
  id: string,
  knob: string,
  value: unknown,
  domain: KnobDomain,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && admits(domain, value)) return undefined;
  return `${id}: ${knob} must be ${DESCRIBE[domain]} — got ${
    typeof value === "number" ? String(value) : typeof value
  }`;
}

/** Throws the `knobError` line — for knobs a public constructor takes rather than a boot roster. */
export function assertKnob(
  id: string,
  knob: string,
  value: unknown,
  domain: KnobDomain,
): void {
  const e = knobError(id, knob, value, domain);
  if (e !== undefined) {
    throw Object.assign(new Error(e), { kind: "validation" as const });
  }
}
