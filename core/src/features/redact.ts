import type { ResourceModel } from "../core/app.ts";
import {
  wireColumnsOf,
  type WireReadVerb,
  withheldFromOpsOf,
} from "../core/app-refs.ts";
import { blindIndexCol } from "./encrypt.ts";

/**
 * `sensitive` marks PII fields that must never be casually exposed (08-principles-recommended.md).
 * `redact` returns a copy of a row with those fields masked, for any sink outside the read stack
 * (a logger, an error body) — it does not change what an authorized API caller receives.
 */
const MASK = "[redacted]"; // the MCP/agent channel mask (12-mcp §6) — a remote agent sees the shape, not the value

/**
 * The log mask style (04-features.md §sensitive). Distinct from the MCP `[redacted]` mask above: this
 * governs the audit-diff / `ctx.log` / OTel write path, where `partial` keeps a trailing 4 chars so a
 * debugger can correlate a value without learning it. `full` is the default; `partial` opts in per resource.
 */
export type MaskStyle = "full" | "partial";

const FULL_MASK = "****"; // fixed-width — never length-revealing

const PARTIAL_TAIL = 4; // `partial` retains the trailing 4 chars (`***-1234`)

/**
 * The output redaction set: `model.encrypted ∪ model.sensitive` (04-features.md §encrypted / §sensitive),
 * PLUS the columns those declarations MINT. An `encrypted` field decrypts to plaintext on a default read,
 * so the serializer must drop/mask it — and `encrypted: { equality }` also mints `<f>_bidx`, the keyed
 * HMAC of that same plaintext. Naming only the declared field left the index on the wire: a cross-row
 * equality and frequency oracle over the value the declaration exists to hide, and a confirm-the-value
 * oracle for anyone who can `create`. A denylist keyed on what the AUTHOR wrote can never cover what the
 * DERIVER adds, so the minted names are derived here from the same source the deriver reads.
 */
export function outputRedactSet(model: ResourceModel): Set<string> {
  const declared = [...(model.sensitive ?? []), ...(model.encrypted ?? [])];
  const minted = (model.encryptedConfig?.equality ?? []).map(blindIndexCol);
  return new Set<string>([...declared, ...minted]);
}

/**
 * The canonical `sensitive ∪ encrypted` redaction set, shared by the output serializer (this file) and the
 * `_audit` diff/snapshot write path (repo.ts `computeDiff`/`auditWrite`) — one set, never reimplemented.
 */
export const redactionSet = outputRedactSet;

/**
 * The columns a read route actually serializes (03-api-shape.md §wire-projection): the declared projection
 * minus what this chokepoint drops. The ONE derivation the serve layer, the OpenAPI document and the
 * surface lock read — the documented shape cannot drift from the served one.
 */
export function servedColumnsOf(
  model: ResourceModel,
  verb: WireReadVerb,
): readonly string[] {
  const dropped = outputRedactSet(model);
  return wireColumnsOf(model, verb).filter((c) => !dropped.has(c));
}

/**
 * Columns an `http` route may NEVER name in its wire projection (03-api-shape.md §wire-projection): the
 * redaction set plus each equality-encrypted field's `<f>_bidx` — the blind index is the equality/frequency
 * oracle the encryption exists to deny, and it is a real column, so nothing else would refuse it.
 */
export function unprojectableColumns(model: ResourceModel): Set<string> {
  const out = outputRedactSet(model);
  for (const f of model.encryptedConfig?.equality ?? []) {
    out.add(blindIndexCol(f));
  }
  return out;
}

/**
 * Mask one value by log style (04-features.md §sensitive). `full` → fixed `****`. `partial` → `***-` + the
 * last 4 chars, unless the value is that short or shorter, in which case it masks fully.
 */
export function maskValue(value: unknown, style: MaskStyle = "full"): string {
  if (style === "full") return FULL_MASK;
  const s = String(value);
  if (s.length <= PARTIAL_TAIL) return FULL_MASK; // too short to reveal a tail without revealing the whole value
  return `***-${s.slice(-PARTIAL_TAIL)}`;
}

/**
 * A shallow copy of `row` with the resource's `sensitive` fields masked (present, non-null values only).
 * `style` selects the log mask; `undefined` keeps the MCP/agent `[redacted]` mask (12-mcp §6).
 */
export function redact<Row extends Record<string, unknown>>(
  model: ResourceModel,
  row: Row,
  style?: MaskStyle,
): Row {
  const fields = outputRedactSet(model); // encrypted ∪ sensitive
  if (fields.size === 0) return { ...row };
  const out: Record<string, unknown> = { ...row };
  const mask = (v: unknown) => style === undefined ? MASK : maskValue(v, style);
  for (const f of fields) if (f in out && out[f] != null) out[f] = mask(out[f]);
  return out as Row;
}

/** Redact a list of rows. `style` selects the log mask (04-features.md §sensitive); omitted ⇒ the `[redacted]` mask. */
export function redactAll<Row extends Record<string, unknown>>(
  model: ResourceModel,
  rows: readonly Row[],
  style?: MaskStyle,
): Row[] {
  return rows.map((r) => redact(model, r, style));
}

/**
 * The output projection (04-features.md §sensitive; 05-runtime.md op-pipeline step 14). Distinct from
 * `redact`: this drops each key entirely rather than masking it. Returns a shallow copy; the original
 * row is untouched. The dropped set is `encrypted ∪ sensitive`.
 */
export function dropSensitive<Row extends Record<string, unknown>>(
  model: ResourceModel,
  row: Row,
): Partial<Row> {
  const fields = outputRedactSet(model); // encrypted ∪ sensitive
  if (fields.size === 0) return { ...row };
  const out: Record<string, unknown> = { ...row };
  for (const f of fields) delete out[f]; // drop — the key is absent, not masked
  return out as Partial<Row>;
}

/** Drop every resource `sensitive` field from each row of a list (the list-read output projection). */
export function dropSensitiveAll<Row extends Record<string, unknown>>(
  model: ResourceModel,
  rows: readonly Row[],
): Partial<Row>[] {
  return rows.map((r) => dropSensitive(model, r));
}

/**
 * A true leaf carries its state outside own-enumerable keys, so walking it would rebuild it as `{}` —
 * Date/Map/Set/RegExp/typed-array are returned as-is. A plain class instance is NOT a leaf: its
 * own-enumerable named fields serialize to JSON, so a redaction-set field name on it must still be projected.
 */
const isLeaf = (v: object): boolean =>
  v instanceof Date || v instanceof Map || v instanceof Set ||
  v instanceof RegExp ||
  v instanceof ArrayBuffer || ArrayBuffer.isView(v); // Uint8Array (bytea) / DataView / typed-array views

/**
 * Mask a `redactionSet` (04-features.md §sensitive) field-name match anywhere in an event payload, at any
 * depth, before it lands in `_outbox` — the handler's `row` is already decrypted, so a raw serialize would
 * persist both `sensitive` and `encrypted` plaintext. Mirrors `computeDiff`'s set and mask style; cycle-safe
 * and unbounded in depth, because nothing may escape redaction by being nested deeply.
 */
export function redactEventPayload(
  model: ResourceModel,
  payload: unknown,
): unknown {
  const fields = redactionSet(model); // sensitive ∪ encrypted — the same set the audit diff masks
  if (fields.size === 0) return payload;
  // Cycle-safe by registering each copy BEFORE filling it, exactly like `projectOut`. NO depth cap: the cap
  // this walk used to carry returned the subtree UNWALKED past its limit, so a `sensitive` field nested one
  // level too deep reached `_outbox` in plaintext — a redaction that fails OPEN on the input an attacker
  // chooses the shape of. Cycles are what the cap was defending against, and the WeakMap defends them exactly.
  const done = new WeakMap<object, unknown>();
  const walk = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") return value;
    const node = value as object;
    if (done.has(node)) return done.get(node);
    if (isLeaf(node)) return value; // Date/Map/Set/typed-array (bytea) — state lives off own-enumerable keys
    if (Array.isArray(value)) {
      const arr: unknown[] = [];
      done.set(node, arr);
      for (const el of value) arr.push(walk(el));
      return arr;
    }
    const out: Record<string, unknown> = {};
    done.set(node, out);
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = fields.has(k) && v != null
        ? maskValue(v, model.maskStyle)
        : walk(v); // mask, mirroring computeDiff
    }
    return out;
  };
  return walk(payload);
}

/**
 * Apply a per-level projection to a result before it is serialized (05-runtime.md op-pipeline step 14).
 *
 * The rule: the projection applies at EVERY object level, keyed by field name — the same "a name match at
 * any depth" rule `redactEventPayload` applies to the outbox. A custom op is free to return `{ wrapper: row }`
 * or `{ items: [{ row }] }`, so a top-level-only drop would ship the field the chokepoint exists to strip;
 * a nested name collision costs one dropped field, not recursing costs a leak. Primitives and leaf objects
 * (Date/Map/typed-array) pass through unchanged.
 */
function projectOut<V>(
  value: V,
  level: (row: Record<string, unknown>) => Record<string, unknown>,
): V {
  // each copy is registered BEFORE its keys are filled, so a cycle (or a shared subtree) resolves to the
  // projected copy rather than the raw object. No depth cap: nothing may escape by being deep.
  const done = new WeakMap<object, unknown>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    const node = v as object;
    if (done.has(node)) return done.get(node);
    if (isLeaf(node)) return v;
    if (Array.isArray(v)) {
      const arr: unknown[] = [];
      done.set(node, arr);
      for (const el of v) arr.push(walk(el));
      return arr;
    }
    const out: Record<string, unknown> = {};
    done.set(node, out);
    const projected = level(v as Record<string, unknown>); // drop/mask this level's own field names
    for (const [k, child] of Object.entries(projected)) out[k] = walk(child);
    return out;
  };
  return walk(value) as V;
}

/** Project one object level against a redaction set: `mask` replaces each present non-null value with the
 *  agent-channel mask, else the key is dropped outright. The one place the two treatments are spelled. */
function projectLevel(
  fields: ReadonlySet<string>,
  row: Record<string, unknown>,
  mask: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const f of fields) {
    if (!(f in out)) continue;
    if (!mask) delete out[f];
    else if (out[f] != null) out[f] = MASK;
  }
  return out;
}

/** The single output-redaction chokepoint: every read result a surface returns to the wire flows through
 *  here, at every object level of that result. `mask:false` (default, HTTP + cross-module) drops the
 *  `sensitive ∪ encrypted` set; `mask:true` (MCP, 12-mcp §6) masks it to `[redacted]` — shape, not value.
 *  Keyed on ONE model, because a read response is minted from that model's projection; the op door, whose
 *  value is the handler's own, keys on the whole app instead (`egressOp`). */
export function egress<V>(
  model: ResourceModel,
  value: V,
  opts: { readonly mask?: boolean } = {},
): V {
  // encrypted ∪ sensitive — an op returning an encrypted-only row would otherwise leak the plaintext field
  const fields = outputRedactSet(model);
  if (fields.size === 0) return value;
  return projectOut(value, (row) => projectLevel(fields, row, !!opts.mask));
}

/** The columns a resource declares as numbers — the only ones a non-finite can hide in. Derived from the
 *  model's own Zod schema, so a new numeric column is covered without an edit. */
export function numericColumnsOf(model: ResourceModel): Set<string> {
  const out = new Set<string>();
  for (const [key, def] of Object.entries(model.schema.shape)) {
    let t: unknown = def;
    // unwrap optional/nullable/default so `z.number().optional()` still reads as a number column
    while (
      t && typeof t === "object" &&
      "unwrap" in (t as Record<string, unknown>) &&
      typeof (t as { unwrap?: unknown }).unwrap === "function"
    ) t = (t as { unwrap: () => unknown }).unwrap();
    const name =
      (t as { _def?: { typeName?: string }; def?: { type?: string } })
        ?.def?.type ??
        (t as { _def?: { typeName?: string } })?._def?.typeName;
    if (name === "number" || name === "ZodNumber") out.add(key);
  }
  return out;
}

/**
 * A NON-FINITE NUMBER NEVER REACHES THE WIRE AS `null`.
 *
 * `JSON.stringify` renders `NaN` / `Infinity` as `null`, so a client cannot tell "no measurement" from
 * "infinite measurement". `z.number()` refuses all three on the way IN, so a column holding one was written
 * outside the declared contract — a migration, an import, another writer, or a Postgres computation. That is
 * a contract violation, and serving corrupted data silently is the degrade this framework refuses.
 *
 * Bounded: only the model's own numeric columns are read, never a blind walk of every value.
 */
export function assertFiniteEgress<V>(model: ResourceModel, value: V): V {
  const cols = numericColumnsOf(model);
  if (cols.size === 0) return value;
  const rows: unknown[] = Array.isArray(value) ? value : [value];
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    for (const col of cols) {
      const v = r[col];
      if (typeof v === "number" && !Number.isFinite(v)) {
        throw new NonFiniteEgressError(
          `resource '${model.name}' column '${col}' holds ${
            Number.isNaN(v) ? "NaN" : v > 0 ? "Infinity" : "-Infinity"
          }${
            typeof r.id === "string" ? ` on row '${r.id}'` : ""
          } — \`JSON.stringify\` would serve it as \`null\`, which a client cannot tell from an absent value. \`z.number()\` refuses a non-finite on the way in, so this was written outside the declared contract: fix the row, or widen the column's declaration to say what it really holds`,
        );
      }
    }
  }
  return value;
}

/** Thrown by `assertFiniteEgress`; the served boundary maps it to a 500 with no row content on the wire. */
export class NonFiniteEgressError extends Error {
  override readonly name = "NonFiniteEgressError";
}

/**
 * The CUSTOM-OP door's chokepoint (03-api-shape.md §wire-projection): the app's redaction set plus the
 * columns the deriver minted that no read route of the app projects. A CRUD read response is MINTED from
 * the projection, so a DDL-grown column is unconstructible there; an op returns the handler's own value,
 * which the framework cannot mint — so at this door it SUBTRACTS instead.
 *
 * It subtracts over the WHOLE model list, never the op's owner alone. A handler reaches every resource of
 * the app — `ctx.data.<r>`, `ctx.modules.<dep>`, raw `ctx.query` — so an owner-keyed set shipped a sibling
 * resource's declared `sensitive` column in plaintext through a one-line "dashboard" op. The cost of the
 * union is a name collision (a field of A dropped because B declares that name sensitive); the cost of
 * keying it narrowly is a leak, and the door exists to trade the first for the second.
 *
 * The withheld set is DROPPED on both doors, never masked: masking would advertise a column the op's
 * contract does not have. Depth and cycle behaviour are `egress`'s — a name match at any object level.
 */
export function egressOp<V>(
  models: readonly ResourceModel[],
  value: V,
  opts: { readonly mask?: boolean } = {},
): V {
  const { value: out, lost } = egressOpWithLoss(models, value, opts);
  reportOpDoorLoss(lost);
  return out;
}

/**
 * `egressOp` plus the EFFECT it had: which withheld names it actually removed from this handler's value.
 * The boot notice (`app-refs.ts §opDoorWithheldNotice`) can only name the risk — the fold's domain is every
 * key of every object a handler returns, which no boot-time read of the declarations can see. This is the
 * measurement at the moment of the loss, so the majority class (a DTO key the handler invented) is witnessed.
 *
 * Only the WITHHELD half is counted. A `sensitive`/`encrypted` drop is the author's own declaration doing
 * what it says, and on the unmasked path it has already left the row before this loop reads it.
 */
export function egressOpWithLoss<V>(
  models: readonly ResourceModel[],
  value: V,
  opts: { readonly mask?: boolean } = {},
): { readonly value: V; readonly lost: readonly string[] } {
  const fields = new Set<string>();
  for (const m of models) for (const f of outputRedactSet(m)) fields.add(f);
  const withheld = withheldFromOpsOf(models);
  if (fields.size === 0 && withheld.size === 0) return { value, lost: [] };
  const lost = new Set<string>();
  const projected = projectOut(value, (row) => {
    const out = projectLevel(fields, row, !!opts.mask);
    for (const f of withheld) {
      if (!(f in out)) continue;
      delete out[f];
      lost.add(f);
    }
    return out;
  });
  return { value: projected, lost: [...lost].sort() };
}

/** Names already reported this process — the loss is a standing property of the app's shape, so repeating
 *  it per request would bury it. Reset only by `__resetOpDoorLossReport` (tests). */
const REPORTED_OP_DOOR_LOSS = new Set<string>();

/** Clears the once-per-process dedupe so a tooth can assert the line the FIRST loss of a name prints. */
export function __resetOpDoorLossReport(): void {
  REPORTED_OP_DOOR_LOSS.clear();
}

/** The op door's loss report: the withheld fold removed a key a handler actually returned. Never silent —
 *  canon promises this door says its cost out loud, and the boot notice alone cannot see a handler literal. */
function reportOpDoorLoss(lost: readonly string[]): void {
  const fresh = lost.filter((f) => !REPORTED_OP_DOOR_LOSS.has(f));
  if (fresh.length === 0) return;
  for (const f of fresh) REPORTED_OP_DOOR_LOSS.add(f);
  console.warn(
    `[hazelnut] the custom-op door DROPPED ${
      fresh.join(", ")
    } from an op's returned value — ${
      fresh.length === 1 ? "that name is" : "those names are"
    } framework-minted somewhere in this app and no read verb of the minting resource projects ${
      fresh.length === 1 ? "it" : "them"
    }, so the caller received the rest of the value without ${
      fresh.length === 1 ? "it" : "them"
    }. Rename the response field, or name the column in the minting resource's \`columns:\`. Reported once per name per process.`,
  );
}
