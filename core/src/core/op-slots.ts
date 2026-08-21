/** The op-pipeline slots that run with a ctx and can open a row door — a hook is a door
 *  (`05-runtime.md §op-pipeline`). `replace` substitutes `handler`; both are listed so a scan that
 *  names the slot does not have to know which one `composeOpHandler` picked. A leaf: the door scan
 *  and the lint/structural companions share this list, and homing it in `pipeline-defs` would close
 *  an app.ts ↔ model-guards cycle. */
export const OP_CODE_SLOTS = [
  "before",
  "handler",
  "replace",
  "around",
  "after",
] as const;

export type OpCodeSlot = (typeof OP_CODE_SLOTS)[number];

/** The function values sitting on an op declaration's code slots, in pipeline order. A slot whose
 *  value is not a function is skipped (a string ref is a different seam). */
export function opCodeFns(
  decl: object,
): ReadonlyArray<{ readonly slot: OpCodeSlot; readonly fn: object }> {
  const d = decl as Record<string, unknown>;
  const out: { slot: OpCodeSlot; fn: object }[] = [];
  for (const slot of OP_CODE_SLOTS) {
    const v = d[slot];
    if (typeof v === "function") out.push({ slot, fn: v as object });
  }
  return out;
}
