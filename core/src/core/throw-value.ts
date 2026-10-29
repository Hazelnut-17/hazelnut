/** Best-effort diagnostics: inspecting an arbitrary thrown value must not throw a replacement error. */
export function thrownField(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

export function thrownText(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "unreadable failure";
  }
}

export function thrownMessage(value: unknown, fallback: string): string {
  try {
    const message: unknown = value instanceof Error ? value.message : undefined;
    return typeof message === "string" ? message : fallback;
  } catch {
    return fallback;
  }
}

/** The historical Error.message / String(other) diagnostic spelling, without a second failure. */
export function thrownDiagnostic(value: unknown): string {
  try {
    const text: unknown = value instanceof Error
      ? value.message
      : String(value);
    return typeof text === "string" ? text : "unreadable failure";
  } catch {
    return "unreadable failure";
  }
}
