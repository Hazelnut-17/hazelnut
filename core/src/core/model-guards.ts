import { httpPolicyMode, isPublicRoute, WIRE_READ_VERBS } from "./app-refs.ts";
import { opCodeFns } from "./op-slots.ts";
import type { ResourceModel } from "./app-types.ts";
import { resolveBare } from "./slot.ts";
import {
  CONFIG_ROW_READ_VERBS,
  CONFIG_ROW_WRITE_VERBS,
  DATA_ROW_READ_VERBS,
  DATA_ROW_WRITE_VERBS,
} from "../data/data-verbs.ts";
import {
  withoutComments,
  withoutCommentsOrStrings,
} from "../invariants/source-view.ts";
import type { CoreOpCtx } from "./ctx-surface.ts";
import {
  all,
  declaredRampKey,
  declaresShared,
  isMatchAll,
  isMatchNone,
  type Node,
  toNode,
  type Where,
} from "./where.ts";
import { type Actor, ANON, can, userActor } from "../authz/auth.ts";
import { actorGateDenies } from "../data/actor-gate.ts";
import { tamperEvidentOn, wholeImmutable } from "../data/schema-normalize.ts";
import {
  httpVisibleViews,
  mcpVisibleViews,
  type ViewDecl,
} from "../features/view.ts";
import {
  READMODEL_ROW_READ_VERBS,
  READMODEL_ROW_WRITE_VERBS,
} from "../features/readmodel.ts";

/**
 * The single owner of the model-derived fail-closed boot guards: every composition door iterates this same
 * list — `createApp(config, boot)`, `createApp(config)`, and `createRouter` refuse on a violation — so the
 * doors can never drift. What separates them is the SEAM ATTESTATION they present, never the guard set.
 * `scope/resolver-required` stays createApp-only — it needs `resolveCtx`, which createRouter may leave `""`.
 */
export type ModelGuardId =
  | "encrypted/key-source"
  | "tamper/key-source"
  | "file/storage-required"
  | "vector/embed-required"
  | "audit/sensitive-declared"
  | "policy/read-protected"
  | "policy/write-protected"
  | "op/decisions-written"
  | "versioning/decision-written";

type _AssertTrue<T extends true> = T;
/** The guard roster at runtime, compile-bound to `ModelGuardId` both directions — `satisfies` pins one side,
 *  `_GuardIdsComplete` the other, so a minted guard cannot ship un-enumerated. */
export const MODEL_GUARD_IDS = [
  "encrypted/key-source",
  "tamper/key-source",
  "file/storage-required",
  "vector/embed-required",
  "audit/sensitive-declared",
  "policy/read-protected",
  "policy/write-protected",
  "op/decisions-written",
  "versioning/decision-written",
] as const satisfies readonly ModelGuardId[];
type _GuardIdsComplete = _AssertTrue<
  Exclude<ModelGuardId, (typeof MODEL_GUARD_IDS)[number]> extends never ? true
    : false
>;

export interface ModelGuardViolation {
  readonly id: ModelGuardId;
  readonly resources: readonly string[];
  /** the fail-closed refuse message (thrown by createApp and createRouter). */
  readonly refuse: string;
  /** retained for the collector's one construction site; createRouter now throws `refuse` too. */
  readonly warn: string;
}

/** The wired-seam attestations each entry supplies (createApp from resolved defaults, createRouter from raw
 *  `cfg`). `rowPolicyOf` differs by caller only in WHERE the injection comes from: createApp reads
 *  `boot.rowPolicies`, createRouter reads `cfg.rowPolicies`. */
export interface GuardSeams {
  readonly hasKms: boolean;
  readonly hasStorage: boolean;
  readonly hasEmbed: boolean;
  /** The row policy in EFFECT for this resource — the declared one, or the boot/cfg injection when the
   *  declaration has none. Returns the policy itself, not a boolean: presence never was the property worth
   *  checking (a match-all narrows nothing), and an injected policy has to face the same test as a declared
   *  one or the injection lane becomes the way around the guard. */
  readonly rowPolicyOf: (m: ResourceModel) => unknown;
}

/**
 * The attestation a composition holding NO boot bundle presents — every seam credited. `createApp(config)`
 * (the CLI verbs' pure-model path) has nowhere to wire a seam, so crediting them leaves exactly the
 * violations no wiring could ever clear: declaration defects, which then refuse on EVERY door. The
 * `rowPolicyOf` stub stands in for the `boot.rowPolicies` lane, which by `authz/rowpolicy-single-source`
 * seeds only resources declaring none — so a DECLARED policy still faces its own test here. An unattested
 * missing policy is `all()`, the runtime default (`serve-routes` / `runView`): a fake `none()` made the
 * guard credit protection the wire would not apply.
 */
export const EVERY_SEAM_ATTESTED: GuardSeams = {
  hasKms: true,
  hasStorage: true,
  hasEmbed: true,
  rowPolicyOf: (m) => m.rowPolicy ?? (() => all()),
};

/** Is this named surface entry a door a remote caller reaches under the framework's own policy gate? The
 *  one test both the CRUD verbs and the custom ops face: a `"policy"`-mode http route, or an mcp tool whose
 *  http twin isn't the author's written `"public"`. */
function exposedUnderPolicy(m: ResourceModel, name: string): boolean {
  // Through the NORMALIZER, never a raw string compare: `HttpRoute` has two legal forms and the object one
  // (`{ external: true }` / `{ authnFirst: … }`) defaults `policy` to "policy". A `=== "policy"` test misses
  // every object-form read, so the guard boots clean and the whole table goes on the wire anonymously.
  const route = m.http[name];
  if (route !== undefined && httpPolicyMode(route) === "policy") return true;
  return name in m.mcp && !isPublicRoute(route);
}

/**
 * What one `ctx` member IS, as a door onto rows — the classification the op-door scan walks. Compile-bound to
 * `CoreOpCtx` by `Record<keyof CoreOpCtx, …>`, so a NEW ctx member is a `deno check` error until it is
 * classified: the door set is derived from the ctx surface the framework ships, never a list written here
 * (a hand-carried facade list is how `ctx.transition` stayed outside the door set).
 *
 *  - `keyed-row`  the row facades keyed by resource/projection name — the key hop names the door.
 *  - `row-write`  `ctx.transition`, a row-addressed write onto a pre-existing row (its CAS UPDATE carries the
 *                 rowPolicy conjunct, so a vacuous policy makes the op's grant authority over every row).
 *  - `raw-sql`    the raw doors, defended in depth instead (13-authz.md §rowpolicy (raw ctx.query scope is defended)):
 *                 a WHERE-stack obligation is one raw SQL cannot honour.
 *  - `callee-gated` the cross-module doors — each runs the CALLEE's own gate (the dep op's policy pipeline,
 *                 the producer view's own rowPolicy, which §5b below tests on the view's own account).
 *  - `not-row`    reaches no row by resource name.
 */
type CtxMemberDoor =
  | "keyed-row"
  | "row-write"
  | "raw-sql"
  | "callee-gated"
  | "not-row";

export const CTX_MEMBER_DOOR: Record<keyof CoreOpCtx, CtxMemberDoor> = {
  data: "keyed-row",
  config: "keyed-row",
  readModels: "keyed-row",
  transition: "row-write",
  query: "raw-sql",
  db: "raw-sql",
  datasource: "raw-sql",
  modules: "callee-gated",
  reads: "callee-gated",
  tasks: "not-row",
  workflows: "not-row",
  emit: "not-row",
  i18n: "not-row",
  ctxExtras: "not-row",
  schedulingCap: "not-row",
  outboxBackpressure: "not-row",
  actor: "not-row",
  scope: "not-row",
  version: "not-row",
  signal: "not-row",
  now: "not-row",
  log: "not-row",
  queue: "not-row",
  code: "not-row",
  schedule: "not-row",
};

/** The op-door verdict, per exposed op. `lost` is the point of the whole scan: a handler that puts a
 *  ctx-derived value where this analysis cannot follow it (a helper call, a computed key, a spread) has NOT
 *  been shown to open no door — it has been shown to be unreadable, and the two used to be the same answer. */
interface OpDoorScan {
  /** facade → key → the verbs called through it. */
  readonly keyed: Map<string, Map<string, Set<string>>>;
  /** `ctx.transition` subjects: a resource name for the 3-arg escape, `""` for the op's own subject row. */
  readonly transitions: Set<string>;
  /** How the handler put a ctx-derived value beyond this analysis; absent when the source resolves whole. */
  lost?: string;
}

/** Where one tainted local name sits on a ctx path: the ctx itself, a member off it (`const d = ctx.data`),
 *  or one facade key (`const { widget } = ctx.data`). */
type CtxLevel =
  | { readonly kind: "ctx" }
  | { readonly kind: "member"; readonly member: string }
  | { readonly kind: "key"; readonly facade: string; readonly key: string };

const IDENT = /^[A-Za-z_$][\w$]*/;
const KEY_LITERAL = /^\s*(["'`])([A-Za-z_$][\w$]*)\1\s*$/;

/** One member hop off a ctx path, in every punctuation that reaches the same binding — `.x`, `?.x`, `["x"]`,
 *  `?.["x"]`, with the newline a formatter puts in a long chain. `name` absent = the hop is COMPUTED, which
 *  is a door this analysis cannot name rather than no door at all. Structure is read from the string-blanked
 *  projection and the key from the literal one; the two projections share offsets by construction. */
function readHop(
  lit: string,
  blank: string,
  pos: number,
): { readonly name?: string; readonly end: number } | undefined {
  let i = pos;
  while (i < blank.length && /\s/.test(blank[i]!)) i++;
  if (blank.startsWith("?.", i)) {
    i += 2;
    while (i < blank.length && /\s/.test(blank[i]!)) i++;
  } else if (blank[i] !== "." && blank[i] !== "[") return undefined;
  if (blank[i] === ".") {
    i++;
    while (i < blank.length && /\s/.test(blank[i]!)) i++;
  }
  if (blank[i] === "[") {
    const close = blank.indexOf("]", i);
    if (close < 0) return { end: blank.length };
    const inner = lit.slice(i + 1, close);
    const m = KEY_LITERAL.exec(inner);
    return m ? { name: m[2]!, end: close + 1 } : { end: close + 1 };
  }
  const id = IDENT.exec(blank.slice(i));
  return id ? { name: id[0], end: i + id[0].length } : undefined;
}

/** The top-level commas of `src` — parameter and destructure splitting, bracket-aware. */
function splitTop(src: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      out.push(src.slice(start, i));
      start = i + 1;
    }
  }
  out.push(src.slice(start));
  return out;
}

/** The handler's parameter list span, or `undefined` when the source is not one this analysis can open
 *  (a native/bound function has no readable body at all). */
function paramSpan(
  blank: string,
): { readonly text: string; readonly end: number } | undefined {
  const open = blank.indexOf("(");
  if (open < 0) return undefined;
  let depth = 0;
  for (let i = open; i < blank.length; i++) {
    const c = blank[i]!;
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return { text: blank.slice(open + 1, i), end: i + 1 };
    }
  }
  return undefined;
}

/** The `{ a, b: c }` entries of a destructure pattern → the local name each binds and the property it reads.
 *  `undefined` for a pattern this analysis cannot follow (nested, rest, computed). */
function destructureEntries(
  pattern: string,
):
  | ReadonlyArray<{ readonly prop: string; readonly local: string }>
  | undefined {
  const inner = pattern.trim().replace(/^\{/, "").replace(/\}$/, "");
  if (inner.trim() === "") return [];
  const out: { prop: string; local: string }[] = [];
  for (const part of splitTop(inner)) {
    const p = part.split("=")[0]!.trim();
    if (p === "") continue;
    const m = /^([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*))?$/.exec(p);
    if (!m) return undefined;
    out.push({ prop: m[1]!, local: m[2] ?? m[1]! });
  }
  return out;
}

/**
 * THE OP DOOR SET, read off the handler's own source with a THIRD verdict.
 *
 * Two verdicts (`a door here` / `no door here`) is what made this checker narrower than its promise: the
 * whole class of spellings the regex could not follow — a helper call, `Object.values(ctx.data)`, a computed
 * resource name, an alias of an alias — answered `no door` and booted a whole table onto the wire. This scan
 * answers `lost` instead: every ctx-derived local name is tracked, every occurrence of one must be a hop this
 * analysis can name, and the first that is not sets `lost`. The caller then treats every resource of the op's
 * OWN MODULE as a door (`ctx.data` is module-scoped — `data-verbs.ts §dataOf`), which is the sound
 * over-approximation of what such a handler can reach.
 */
function scanOpDoors(handlerSrc: string): OpDoorScan {
  const scan: OpDoorScan = { keyed: new Map(), transitions: new Set() };
  const lit = withoutComments(handlerSrc);
  const blank = withoutCommentsOrStrings(handlerSrc);
  const lose = (why: string) => {
    scan.lost ??= why;
  };
  if (/\[\s*native code\s*\]/.test(blank)) {
    lose("is a native or bound function, so it has no readable source");
    return scan;
  }
  const params = paramSpan(blank);
  if (params === undefined) {
    lose("has no readable parameter list");
    return scan;
  }
  const taint = new Map<string, CtxLevel>();
  // consumed spans: the parameter list and every binding pattern already accounted for, so the NAMES in them
  // are not re-read as uses of themselves.
  const consumed: Array<[number, number]> = [[0, params.end]];
  const isConsumed = (i: number) => consumed.some(([a, b]) => i >= a && i < b);

  const ctxParam = splitTop(params.text)[1]?.split("=")[0]?.trim();
  if (ctxParam !== undefined && ctxParam !== "") {
    if (ctxParam.startsWith("...") || ctxParam.startsWith("[")) {
      lose(
        `binds its ctx parameter as '${ctxParam}', a form this analysis cannot follow`,
      );
      return scan;
    }
    if (ctxParam.startsWith("{")) {
      const entries = destructureEntries(ctxParam);
      if (entries === undefined) {
        lose(
          "destructures its ctx parameter in a form this analysis cannot follow",
        );
        return scan;
      }
      for (const e of entries) {
        taint.set(e.local, { kind: "member", member: e.prop });
      }
    } else if (IDENT.test(ctxParam)) taint.set(ctxParam, { kind: "ctx" });
  }

  const recordDoor = (facade: string, key: string, verb: string) => {
    const byKey = scan.keyed.get(facade) ?? new Map<string, Set<string>>();
    const verbs = byKey.get(key) ?? new Set<string>();
    verbs.add(verb);
    byKey.set(key, verbs);
    scan.keyed.set(facade, byKey);
  };

  /** Is this occurrence the RHS of a binding, and what target does the binding bind? The target is read by
   *  walking BACKWARD from the `=` — an identifier, or a `{…}` pattern to its matching brace. Taking the
   *  whole prefix instead read every alias as unfollowable, which is a refusal for the wrong reason. */
  const bindingLhs = (
    start: number,
  ): { readonly text: string; readonly at: number } | undefined => {
    const before = blank.slice(0, start).replace(/\s+$/, "");
    if (!before.endsWith("=") || /[=!<>+\-*/%&|^]=$/.test(before)) {
      return undefined;
    }
    let i = before.length - 1; // the `=`
    while (i > 0 && /\s/.test(before[i - 1]!)) i--;
    const stop = i; // one past the target
    i--;
    if (before[i] === "}") {
      let depth = 0;
      for (; i >= 0; i--) {
        if (before[i] === "}") depth++;
        else if (before[i] === "{") {
          depth--;
          if (depth === 0) break;
        }
      }
      if (i < 0) return undefined;
    } else {
      while (i >= 0 && /[\w$]/.test(before[i]!)) i--;
      i++;
      if (i >= stop) return undefined;
    }
    const text = before.slice(i, stop).trim();
    return text === "" ? undefined : { text, at: i };
  };

  // FIXPOINT: an alias of an alias binds on a later round, so the pass repeats until no name is added.
  for (let round = 0; round < 8; round++) {
    const before = taint.size;
    for (const [name, level] of [...taint]) {
      const re = new RegExp(`\\b${name}\\b`, "g");
      for (let m = re.exec(blank); m !== null; m = re.exec(blank)) {
        const start = m.index;
        if (isConsumed(start)) continue;
        // a property position (`ctx.data` when `data` is itself a taint name) is that path's hop, not a use.
        // The dot must be a MEMBER dot: `...ctx` also ends in one, and reading the spread as a hop is what
        // let `{ ...ctx.data }` out.
        const prev = blank.slice(0, start).replace(/\s+$/, "");
        if (/(?:^|[^.])\.$/.test(prev)) continue;
        let cur: CtxLevel = level;
        let pos = start + name.length;
        let settled = false;
        for (let hopN = 0; hopN < 8 && !settled; hopN++) {
          if (cur.kind === "member") {
            const kind = CTX_MEMBER_DOOR[cur.member as keyof CoreOpCtx];
            if (kind === undefined) {
              lose(
                `reaches ctx.${cur.member}, which is not a ctx member this build composes`,
              );
              settled = true;
              break;
            }
            if (kind !== "keyed-row") {
              settled = true; // raw-sql / callee-gated / not-row all carry their obligation elsewhere
              break;
            }
          }
          const hop = readHop(lit, blank, pos);
          if (hop === undefined) break; // no further hop — the terminator rules below decide
          if (hop.name === undefined) {
            lose(
              cur.kind === "member"
                ? `reaches ctx.${cur.member} with a COMPUTED key, so the resource it names is not readable here`
                : "reaches a ctx facade through a computed member, which is not readable here",
            );
            settled = true;
            break;
          }
          pos = hop.end;
          if (cur.kind === "ctx") {
            cur = { kind: "member", member: hop.name };
            // the row-addressed WRITE METHOD class is dispatched off the classification, never off the
            // member's name: a name test would leave the table decoration, true whatever it said.
            if (CTX_MEMBER_DOOR[hop.name as keyof CoreOpCtx] === "row-write") {
              readTransition(blank, lit, pos, scan, lose);
              settled = true;
            }
            continue;
          }
          if (cur.kind === "member") {
            cur = { kind: "key", facade: cur.member, key: hop.name };
            continue;
          }
          recordDoor(cur.facade, cur.key, hop.name);
          settled = true;
        }
        if (settled) continue;
        // The path ENDED without reaching a verb: either it is bound to a name (which then carries the same
        // door), or the ctx-derived value went somewhere this analysis does not see.
        const lhs = bindingLhs(start);
        if (lhs === undefined) {
          lose(
            cur.kind === "ctx"
              ? "passes its ctx to something outside the handler"
              : cur.kind === "member"
              ? `passes ctx.${cur.member} to something outside the handler`
              : `passes ctx.${cur.facade}.${cur.key} to something outside the handler`,
          );
          continue;
        }
        consumed.push([lhs.at, lhs.at + lhs.text.length]);
        if (lhs.text.startsWith("{")) {
          const entries = destructureEntries(lhs.text);
          if (entries === undefined) {
            lose(
              "destructures a ctx-derived value in a form this analysis cannot follow",
            );
            continue;
          }
          for (const e of entries) {
            if (cur.kind === "ctx") {
              taint.set(e.local, { kind: "member", member: e.prop });
            } else if (cur.kind === "member") {
              taint.set(e.local, {
                kind: "key",
                facade: cur.member,
                key: e.prop,
              });
            } else recordDoor(cur.facade, cur.key, e.prop);
          }
        } else if (lhs.text === IDENT.exec(lhs.text)?.[0]) {
          if (!taint.has(lhs.text)) taint.set(lhs.text, cur);
        } else {
          lose(
            "binds a ctx-derived value to a pattern this analysis cannot follow",
          );
        }
      }
    }
    if (taint.size === before) break;
  }
  return scan;
}

/** `ctx.transition(to)` binds the op's OWN subject row (`""`); `ctx.transition(resource, id, to)` is the
 *  cross-resource escape and names its subject in the first argument. Either is a row-addressed WRITE. */
function readTransition(
  blank: string,
  lit: string,
  pos: number,
  scan: OpDoorScan,
  lose: (why: string) => void,
): void {
  let i = pos;
  while (i < blank.length && /\s/.test(blank[i]!)) i++;
  if (blank[i] !== "(") {
    lose("passes ctx.transition itself outside the handler");
    return;
  }
  let depth = 0;
  let end = -1;
  for (let j = i; j < blank.length; j++) {
    if (blank[j] === "(") depth++;
    else if (blank[j] === ")") {
      depth--;
      if (depth === 0) {
        end = j;
        break;
      }
    }
  }
  if (end < 0) {
    lose("calls ctx.transition with an unreadable argument list");
    return;
  }
  const args = splitTop(blank.slice(i + 1, end));
  if (args.length === 1) {
    scan.transitions.add("");
    return;
  }
  const first = lit.slice(i + 1, end).split(",")[0] ?? "";
  const named = KEY_LITERAL.exec(first);
  if (named === null) {
    lose(
      "calls ctx.transition on a resource named by an expression, not a literal",
    );
    return;
  }
  scan.transitions.add(named[2]!);
}

const SCAN_MEMO = new WeakMap<object, OpDoorScan>();
function doorScanOf(handler: object): OpDoorScan {
  const hit = SCAN_MEMO.get(handler);
  if (hit) return hit;
  const scan = scanOpDoors((handler as { toString(): string }).toString());
  SCAN_MEMO.set(handler, scan);
  return scan;
}

/** One op door: which op opened it, and the door in prose (the call found, or why the handler is unreadable). */
interface OpDoor {
  readonly owner: string;
  readonly op: string;
  readonly face: string;
}

/** The facade × verb-set pairs one door kind is spelled through — `ctx.data` for an ordinary resource,
 *  `ctx.config` for the `singleton` face onto the same table. */
type Facades = readonly (readonly [facade: string, verbs: readonly string[]])[];
const READ_FACADES: Facades = [
  ["data", DATA_ROW_READ_VERBS],
  ["config", CONFIG_ROW_READ_VERBS],
];
const WRITE_FACADES: Facades = [
  ["data", DATA_ROW_WRITE_VERBS],
  ["config", CONFIG_ROW_WRITE_VERBS],
];

/** An EXPOSED op — anywhere in the app — whose handler reaches the rows behind `key` through one of `facades`.
 *  `key` is the facade's own KEY, which is the resource name on `ctx.data`/`ctx.config` and the projection
 *  name on `ctx.readModels` — the three facades are keyed by different things, so the door predicate takes
 *  the key rather than a model. `keyModule` bounds the UNREADABLE verdict to the ops that could reach this
 *  key at all (`ctx.data`/`ctx.config` are the op module's own resources); `undefined` means app-wide, which
 *  is what `ctx.readModels` is. */
function opRowDoor(
  key: string,
  keyModule: string | undefined,
  model: readonly ResourceModel[],
  facades: Facades,
  direction: "reads" | "writes",
): OpDoor | undefined {
  for (const owner of model) {
    for (const [op, decl] of Object.entries(owner.operations)) {
      if (!exposedUnderPolicy(owner, op)) continue;
      // A hook is a door: the pipeline runs before/around/after/replace with the same ctx the handler
      // gets (`05-runtime.md §op-pipeline`). Scanning only `handler` let an exposed op hide its row
      // reach in a hook and boot with no attested rowPolicy.
      for (const { slot, fn } of opCodeFns(decl as object)) {
        const scan = doorScanOf(fn);
        const at = `a custom op '${owner.name}.${op}' whose ${slot}`;
        for (const [facade, verbs] of facades) {
          const called = scan.keyed.get(facade)?.get(key);
          const verb = called && verbs.find((v) => called.has(v));
          if (verb !== undefined) {
            return {
              owner: owner.name,
              op,
              face: `${at} ${direction} ctx.${facade}.${key}.${verb}()`,
            };
          }
        }
        // `ctx.transition` is a row-addressed write onto a pre-existing row — the CAS UPDATE carries the same
        // rowPolicy conjunct `ctx.data.<r>.update` does, so the same obligation follows it.
        if (
          direction === "writes" &&
          (scan.transitions.has(key) ||
            (scan.transitions.has("") && owner.name === key))
        ) {
          return {
            owner: owner.name,
            op,
            face: `${at} writes ctx.transition(…) onto '${key}'`,
          };
        }
        // The module bound holds for `ctx.data`/`ctx.config` (module-scoped on an op ctx — `data-ctx.ts
        // §opSurfaceFactory` passes `selfModule`), NOT for writes: `ctx.transition` resolves against the whole
        // composed model, so an unreadable handler's reachable WRITE set is every resource in the app.
        if (
          scan.lost !== undefined &&
          (direction === "writes" || keyModule === undefined ||
            owner.module === keyModule)
        ) {
          return {
            owner: owner.name,
            op,
            face:
              `${at} ${scan.lost}, so which rows it ${direction} is not readable from the declaration — every resource this op's ctx reaches is a door`,
          };
        }
      }
    }
  }
  return undefined;
}

/**
 * The custom-op READ DOOR into one resource's rows, or `undefined` when no op opens one.
 *
 * It is not a courtesy face. `ctx.data.<r>.list()` serves the same rows `http.list` does, through a
 * framework-materialized route AND an MCP tool, and the CRUD verb tuple cannot see it — so a resource whose
 * only read door is an op used to boot with no rowPolicy at all and default its conjunct to `all()`.
 * The boot guard and the structural rung (`inv-schema-mint.ts §readProtected`) read this ONE predicate: a
 * door list written twice is a door list that drifts.
 */
export function opRowReadDoor(
  m: ResourceModel,
  model: readonly ResourceModel[],
): OpDoor | undefined {
  return opRowDoor(m.name, m.module, model, READ_FACADES, "reads");
}

/**
 * The custom-op WRITE DOOR onto one resource's pre-existing rows — the write twin, verb-for-verb.
 *
 * `http.update`/`delete` are not the only ways a remote caller patches a row: an exposed op calling
 * `ctx.data.<r>.update(id, …)` reaches the same repo door with the same WHERE, so a resource whose only write
 * door is an op declared no rowPolicy, booted clean, and handed every holder of that op's own claim authority
 * over every other caller's rows.
 */
export function opRowWriteDoor(
  m: ResourceModel,
  model: readonly ResourceModel[],
): OpDoor | undefined {
  return opRowDoor(m.name, m.module, model, WRITE_FACADES, "writes");
}

/** The THIRD row-reaching facade, beside `ctx.data` and `ctx.config`: `ctx.readModels.<projection>`. Its verb
 *  sets are the projection surface's own (`features/readmodel.ts`), and READ ∪ WRITE is ONE door set here —
 *  the gate a projection carries is all-or-nothing (`data/actor-gate.ts`), so a door onto it obliges the same
 *  gate whichever way it points. Today the write half is empty and the partition tooth holds it so. */
const READMODEL_FACADES: Facades = [[
  "readModels",
  [...READMODEL_ROW_READ_VERBS, ...READMODEL_ROW_WRITE_VERBS],
]];

/**
 * The custom-op door onto ONE materialized projection's rows, or `undefined` when no exposed op opens one.
 *
 * `ctx.readModels.<rm>.read()` puts the WHOLE projection on the wire through a framework-materialized route
 * and an MCP tool alike, and neither the CRUD verb tuple nor the `ctx.data`/`ctx.config` op doors can see it:
 * the projection is a table of its own, keyed by its own name.
 */
export function opReadModelDoor(
  readModelName: string,
  model: readonly ResourceModel[],
): OpDoor | undefined {
  // no module bound: `ctx.readModels` carries EVERY projection the app declares (`data-ctx.ts`), unlike
  // `ctx.data`, so an unreadable handler anywhere in the app can reach this one.
  return opRowDoor(readModelName, undefined, model, READMODEL_FACADES, "reads");
}

/**
 * The `policy/read-protected` leak face: an http.list/find="policy" read, an mcp read whose http twin isn't
 * public, or a custom op reading this resource's rows (`opRowReadDoor`). A public http twin (`"public"`) opts
 * a door out; no http twin at all stays a leak.
 */
function policyReadLeak(
  m: ResourceModel,
  model: readonly ResourceModel[],
): { face: string } | undefined {
  const httpLeak = WIRE_READ_VERBS.find((r) =>
    m.http[r] !== undefined && httpPolicyMode(m.http[r]!) === "policy"
  );
  if (httpLeak) return { face: `an http.${httpLeak}="policy" read` };
  const mcpLeak = WIRE_READ_VERBS.find((r) =>
    r in m.mcp && !isPublicRoute(m.http[r])
  );
  if (mcpLeak) return { face: `an mcp '${mcpLeak}' read` };
  const opDoor = opRowReadDoor(m, model);
  return opDoor === undefined ? undefined : { face: opDoor.face };
}

/** The ROW-ADDRESSED write verbs, and the reason the set is not "the write verbs". `create` mints a row:
 *  there is no pre-existing row for a WHERE to narrow and the insert path never reaches
 *  `appendRowPolicyConjunct`, so demanding a rowPolicy of a create-only resource would be an obligation the
 *  mechanism cannot honour — protection that reads as satisfied and enforces nothing. */
const ROW_ADDRESSED_WRITES = ["update", "delete"] as const;

/** The `policy/write-protected` leak face — the write twin of `policyReadLeak`, door for door: a
 *  `policy`-mode http update/delete, an mcp update/delete whose http twin isn't public, or a custom op
 *  writing this resource's pre-existing rows (`opRowWriteDoor`). `"public"` stays an escape on both faces for
 *  the same reason it does on a read: the guard's subject is the SILENT gap, and overruling a declaration the
 *  author wrote out loud is a different (larger) claim than this one. */
function policyWriteLeak(
  m: ResourceModel,
  model: readonly ResourceModel[],
): { face: string; grant: string } | undefined {
  const httpLeak = ROW_ADDRESSED_WRITES.find((w) => {
    const route = m.http[w];
    return route !== undefined && httpPolicyMode(route) === "policy";
  });
  if (httpLeak) {
    return {
      face: `an http.${httpLeak}="policy" write`,
      grant: `${m.name}:${httpLeak}`,
    };
  }
  const mcpLeak = ROW_ADDRESSED_WRITES.find((w) =>
    w in m.mcp && !isPublicRoute(m.http[w])
  );
  if (mcpLeak) {
    return { face: `an mcp '${mcpLeak}' write`, grant: `${m.name}:${mcpLeak}` };
  }
  const opDoor = opRowWriteDoor(m, model);
  // the grant is the OP's own claim, not `<resource>:update` — the op is what the caller invokes, and its
  // `<owner>:<op>` perm is auto-derived exactly like a CRUD verb's.
  return opDoor === undefined ? undefined : {
    face: opDoor.face,
    grant: `${opDoor.owner}:${opDoor.op}`,
  };
}

/**
 * The pipeline decisions one op value leaves unmade, as slot names — `[]` when all three are written.
 * `policy` is required of EVERY op (`null` is the deliberate public door); `tx` of every op, because an
 * omitted one lands `write` and a read-only op then holds locks it does not need and cannot be served from
 * a read replica; `idempotent` of every write, since a read never reaches the idempotency store. Read off
 * the value, never off its authoring form: `defineOp` and a bare object literal both arrive here as the
 * same erased `unknown`, and only one of them has a type.
 */
export function unwrittenOpDecisions(decl: unknown): string[] {
  if (typeof decl !== "object" || decl === null) {
    return ["input", "policy", "tx"];
  }
  const d = decl as {
    input?: unknown;
    policy?: unknown;
    tx?: unknown;
    idempotent?: unknown;
  };
  const missing: string[] = [];
  // `input` is the decision whose absence was not a refusal: the pipeline reaches into the schema to validate
  // the body, so an op without one mounted its route and answered the first caller with an `internal` error
  // raised inside validation. The other three are unsafe when unmade; this one is simply broken when unmade.
  if (d.input === undefined) missing.push("input");
  // `undefined`, not absence: `{ policy: undefined }` is the same unmade decision spelled longer.
  if (d.policy === undefined) missing.push("policy");
  // `tx` was the one decision this guard let default. The default is the SAFE direction, so nothing was
  // unsafe — what failed is the rule that a decision whose wrong answer costs something is WRITTEN.
  if (d.tx !== "read" && d.tx !== "write") missing.push("tx");
  if (d.tx !== "read" && typeof d.idempotent !== "boolean") {
    missing.push("idempotent");
  }
  return missing;
}

/** The weakest callers a "policy" read must survive — the two shapes the runtime actually presents, probed in
 *  refuse-report order. `ANON` is what the served path hands a rowPolicy whenever the auth seam resolves
 *  nobody; `null` is what an app wiring no auth seam presents. BOTH, because a policy may legitimately branch
 *  on the difference — narrowing for one and opening for the other still leaks the table through that door. */
const WEAKEST_CALLERS: readonly (readonly [string, Actor | null])[] = [
  ["an anonymous caller", ANON],
  ["a caller with no actor at all", null],
];

/** Why a declared rowPolicy protects NOTHING for one weakest caller, or `undefined` when it narrows for them.
 *  Lowered exactly as the read path lowers it; fail-closed — a policy that throws or hands back something
 *  un-lowerable is a gap, never protection. */
function openForCaller(
  policy: (actor: Actor | null) => unknown,
  actor: Actor | null,
  who: string,
): string | undefined {
  try {
    const where = policy(actor);
    if (where === null || typeof where !== "object") {
      return `its rowPolicy returns a non-Where value for ${who}, so no conjunct can be lowered from it`;
    }
    const node = toNode(where as Where<Record<string, unknown>>);
    // `shared()` lowers exactly as `all()` does; the marker is the author saying they meant it.
    if (declaresShared(node)) return undefined;
    return isMatchAll(node)
      ? `its rowPolicy lowers to match-all (TRUE) for ${who}, so every row goes on the wire`
      : undefined;
  } catch {
    return `its rowPolicy throws for ${who}, so no conjunct can be lowered from it`;
  }
}

/** Two DISTINCT principals, each holding every ORDINARY claim this resource derives. The anonymous pair
 *  above asks "is the door shut"; this pair asks the only question that separates two authenticated
 *  callers — and it is the question a claim gate (`can(actor, "<r>:list") ? all() : none()`) answers with
 *  a non-answer. `id` differs, so a policy reading the actor at all answers them differently. */
function claimHolders(m: ResourceModel): readonly [Actor, Actor] {
  // ORDINARY = the whole derived vocabulary MINUS the declared escalation capabilities, read off the model
  // rather than restated: `derivePerms` unions CRUD ∪ operations ∪ capabilities, so a hard-coded five-verb
  // allowlist walks one of those three sources and leaves a custom op's `<r>:<op>` — auto-derived and held
  // by every caller who may invoke it, exactly like a CRUD verb — unprobed, so a policy gated on it gates
  // nothing between two grantees and boots. `capabilities` is the one deliberate exclusion: a declared
  // `<r>:viewAll` exists to WIDEN the read, so handing both synthetic callers that claim would probe the
  // escalation branch and report every correctly-narrowed policy as uniform.
  // `m.perms` is a flat `"<resource>:<verb>"` LIST, not a verb-keyed record — reading it with
  // `Object.entries` yields array INDICES as keys, every filter misses, and both synthetic callers end up
  // holding nothing, which routes a `can()`-gated policy down its `none()` branch and out as "exposes
  // nobody". The probe then never fires on the exact shape it was built for.
  const escalation = new Set(m.capabilities ?? []);
  const claims = (m.perms ?? []).filter((p) =>
    !escalation.has(p.slice(p.lastIndexOf(":") + 1))
  );
  return [
    userActor("weakest-caller-a", claims),
    userActor("weakest-caller-b", claims),
  ];
}

/** The sentinel answer for a policy that yields no lowerable Where at all — its own value, so "unlowerable
 *  for every caller" reads as one answer and "unlowerable for one of them" as a difference. */
const NO_ANSWER = "\u0000unlowerable";

/** One probe answer as a comparable string: the lowered node, or `NO_ANSWER` when the policy throws or
 *  returns something un-lowerable. */
function answerFor(
  policy: (actor: Actor | null) => unknown,
  actor: Actor | null,
): string {
  try {
    return JSON.stringify(
      toNode(policy(actor) as Where<Record<string, unknown>>),
    );
  } catch {
    return NO_ANSWER;
  }
}

/**
 * Why a rowPolicy hands two DISTINCT claim-holders the same rows, or `undefined` when it separates them.
 *
 * ONE rule, no exemption: the answer the two ordinary grantees get either differs between them, exposes
 * nobody, or is DECLARED uniform. `features:{ scope:true }` earns nothing here — the canon
 * (`13-authz.md §scope-vs-rowpolicy`) is explicit that `scope` partitions the TENANT boundary and
 * `rowPolicy` is "which rows within, for this actor", so two grantees of one scope share every conjunct
 * scope contributes and it separates them by exactly nothing. Neither does `ramp()`: when the grantees do
 * not hold its key they get the FLOOR, and the floor is precisely what has to face this question.
 */
function uniformForHolders(
  policy: (actor: Actor | null) => unknown,
  m: ResourceModel,
): string | undefined {
  const [a, b] = claimHolders(m);
  const ansA = answerFor(policy, a);
  if (ansA === NO_ANSWER) return undefined; // already reported by the anonymous probe
  // Caller-separation is PROBED, never read off `Function.length`: `length` stops counting at the first
  // default parameter and ignores rest, so `(a = null) => can(a, k)`, `function(){ arguments[0] }` and
  // `(...args) => args[0]` all report 0 and all read the actor. A CONSTANT filter is not exempt for being
  // constant — handing every grantee the same non-empty rows is the `shared()` EFFECT, and the point of
  // the marker is that the author pays for it with the DECISION.
  if (ansA !== answerFor(policy, b)) return undefined;
  const na = JSON.parse(ansA) as Node;
  if (declaresShared(na)) return undefined;
  // An empty answer separates nobody and exposes nobody — the tightest answer, not a gap. Read through
  // `isMatchNone`, so `inArray([])` and the empty `or` count as the deny they lower to.
  if (isMatchNone(na)) return undefined;
  // A ramp reaches here having ALREADY been measured — name which of its two branches the grantees got, so
  // the author reads the verdict about the branch they hold rather than the one they wrote it for.
  const key = declaredRampKey(policy);
  const via = key === undefined
    ? ""
    : can(a, key)
    ? ` — its ramp raises on '${key}', a claim both ordinary grantees already hold, so the raise IS their ordinary answer`
    : ` — its ramp raises on '${key}', which neither ordinary grantee holds, so its FLOOR is what they both get and the raise never runs for them`;
  return `its rowPolicy hands two DIFFERENT callers holding the same claims the same rows${via}, so the claim is the whole gate and every grantee reads, patches and deletes every other grantee's rows`;
}

/** The projection-declaration slice this rule reads — kept structural so `model-guards` never imports the
 *  read-model type (whose own module reaches back into `data/repo-read.ts`). */
interface ReadModelGateSource {
  readonly name: string;
  readonly source: string;
  readonly rowPolicy?: unknown;
}

/**
 * Why a read-model's OWN actor gate protects nothing, or `undefined` when it shuts for every weakest caller.
 *
 * A materialized row carries no actor, so there is no per-row conjunct to narrow and the gate is
 * all-or-nothing (`data/actor-gate.ts`): open for the anonymous caller means the WHOLE projection is on the
 * wire. That is also why the resource face's SEPARATION probe has no twin here — two grantees of one
 * projection necessarily read the same rows, so demanding they differ would demand what the mechanism cannot
 * honour (the `create` exclusion's reasoning, verb for verb). A gate that denies EVERYONE — uncallable,
 * throwing — is shut, not a gap: this guard's subject is the open door.
 */
function openReadModelGate(policy: unknown): string | undefined {
  for (const [who, actor] of WEAKEST_CALLERS) {
    if (!actorGateDenies(policy, actor)) {
      return `its rowPolicy admits ${who}`;
    }
  }
  return undefined;
}

/**
 * `readmodel/rowpolicy-required` — the projection's own actor gate, over BOTH firing conditions.
 *
 * A `defineReadModel` projection is a read door of its OWN, on a table of its own, and the obligation belongs
 * on ITS gate rather than on its source's: a stamped row is actor-independent, so demanding a rowPolicy of the
 * source would protect the projection by exactly nothing. Two conditions open the door, and either alone
 * obliges the gate (13-authz.md §authz-seam):
 *
 *  - the SOURCE's rows are narrowed by a rowPolicy (declared or injected) — the projection is a stored copy
 *    of rows the source itself withholds, and it cannot re-run that policy; and
 *  - an EXPOSED op reaches the projection through `ctx.readModels` (`opReadModelDoor`) — the projection is on
 *    the wire on its own account, whatever the source's posture is. This is the arm that used to be missing:
 *    `readmodel/rowpolicy-required` armed only on the first condition and `policy/read-protected` reads
 *    `ctx.data`/`ctx.config`, so an unprotected source's projection shipped whole through an exposed op.
 *
 * The test is EFFECT, not presence: a declared gate that admits an anonymous caller opens the same door an
 * absent one does.
 */
export function readModelGateViolations(
  readModels: readonly ReadModelGateSource[],
  model: readonly ResourceModel[],
  sourceRowPolicy: (name: string) => unknown,
): string[] {
  const out: string[] = [];
  for (const rm of readModels) {
    if (!model.some((m) => m.name === rm.source)) continue; // unknown source — `readmodel/source-exists` owns it
    const door = opReadModelDoor(rm.name, model);
    const sourceProtected = sourceRowPolicy(rm.source) !== undefined;
    if (!sourceProtected && door === undefined) continue;
    const gap = rm.rowPolicy === undefined
      ? "declares no rowPolicy of its own"
      : openReadModelGate(rm.rowPolicy);
    if (gap === undefined) continue;
    const why = sourceProtected
      ? `projects source '${rm.source}', whose rows a rowPolicy narrows, but ${gap} — the projection is a second read door and a materialized row cannot re-run a per-actor policy, so every caller of ctx.readModels.${rm.name}.read() would see rows the source itself would have withheld`
      : `is reached by ${
        door!.face
      }, but ${gap} — the projection is a read door of its own, on a table of its own, so the source's posture gates it by nothing and the WHOLE projection goes on the wire to any caller that op admits`;
    out.push(
      `readmodel/rowpolicy-required: read-model '${rm.name}' ${why}. Declare the projection's own actor gate — rowPolicy: (actor) => can(actor, "…") ? all() : none() (none/all on "hazelnut/query") — or drop the projection. The gate is all-or-nothing: a materialized row is actor-independent, so it must SHUT for an anonymous caller. There is no default: the framework cannot tell which of the source's callers the denormalized shape was built for.`,
    );
  }
  return out;
}

/**
 * Is this table-form (`over`) view published cross-module through its owning module's `exposesRead` — the
 * same surface `readsOf` consults to wire `ctx.reads.<dep>.<view>`? One source for every rung that asks, so
 * the column-narrowing check and the row-visibility check can never disagree about which views cross.
 */
export function viewExposedCrossModule(
  model: readonly ResourceModel[],
): (v: ViewDecl) => boolean {
  const exposedReadByModule = new Map<string, Set<string>>();
  for (const m of model) {
    const set = exposedReadByModule.get(m.module) ?? new Set<string>();
    for (const name of m.moduleExposesRead) set.add(name);
    exposedReadByModule.set(m.module, set);
  }
  return (v) => {
    if (v.over === undefined) return false;
    const overHit = resolveBare(model, v.over);
    if (overHit.kind !== "hit") return false;
    return exposedReadByModule.get(overHit.value.module)?.has(v.name) ?? false;
  };
}

/**
 * Every view a REMOTE caller reaches, and the door that reaches it. TWO doors carry one obligation: the
 * `mcp` card publishes an agent tool, and `exposesRead` publishes the view to every module declaring this one
 * as a dep (`ctx.reads.<dep>.<view>`). Gating the EFFECT test on the mcp card alone left the second door
 * answering to `policy/required` — a presence test — so one card decided whether the framework refused a
 * vacuous gate or served the producer's rows through it.
 *
 * A run-form view is reachable through the mcp card only: `readsOf` wires an `exposesRead` name only when the
 * view resolves to a single `over` source, so a run-form name in `exposesRead` is inert.
 */
function remotelyReachableViews(
  views: readonly ViewDecl[],
  model: readonly ResourceModel[],
): Array<{ readonly view: ViewDecl; readonly door: string }> {
  const crossModule = viewExposedCrossModule(model);
  const out: Array<{ view: ViewDecl; door: string }> = [];
  const seen = new Set<ViewDecl>();
  for (const v of mcpVisibleViews(views)) {
    seen.add(v);
    out.push({ view: v, door: "published as an MCP read tool" });
  }
  for (const v of httpVisibleViews(views)) {
    if (seen.has(v) || v.http.policy === "public") continue;
    seen.add(v);
    out.push({
      view: v,
      door: "published as an HTTP GET /views/<name> route",
    });
  }
  for (const v of views) {
    if (seen.has(v) || !crossModule(v)) continue;
    out.push({
      view: v,
      door:
        "published cross-module through its module's exposesRead (ctx.reads.<dep>." +
        v.name + ")",
    });
  }
  return out;
}

/** Why a declared rowPolicy protects NOTHING, or `undefined` when it narrows for every weakest caller. */
function openPolicyReason(policy: unknown): string | undefined {
  if (typeof policy !== "function") {
    return "its rowPolicy is not callable, so no conjunct can be lowered from it";
  }
  const fn = policy as (actor: Actor | null) => unknown;
  for (const [who, actor] of WEAKEST_CALLERS) {
    const reason = openForCaller(fn, actor, who);
    if (reason !== undefined) return reason;
  }
  return undefined;
}

/**
 * The model-derived fail-closed guard violations, in refuse order (encrypted → file → audit → policy). Empty
 * means clean. `createApp` and `createRouter` both throw every violation's `refuse`.
 *
 * `views` is REQUIRED, not defaulted: `defineView` is a read door of its own (`policy/read-protected` fires
 * on it — `10-invariants.md §static-conformance`), and a call site that could omit the argument would
 * silently opt that door out of every guard below.
 */
export function collectModelGuardViolations(
  model: readonly ResourceModel[],
  seams: GuardSeams,
  views: readonly ViewDecl[],
): ModelGuardViolation[] {
  const out: ModelGuardViolation[] = [];

  // 1. encrypted/key-source — an `encrypted` field needs a usable key (app-key floor or an injected KMS).
  const enc = seams.hasKms
    ? []
    : model.filter((m) => m.encrypted.length > 0).map((m) => m.name);
  if (enc.length > 0) {
    out.push({
      id: "encrypted/key-source",
      resources: enc,
      refuse:
        `encrypted/key-source: a resource declares 'encrypted' but no app master key is configured — supply defineConfig({ encryptionKey }) (base64, 32 bytes, sourced at the config site from a project-named env / secret store), or inject an external boot.kms. Refusing to boot: an unkeyed encrypted app cannot seal/read its fields, and the framework never auto-generates a key (a regenerated key orphans all existing ciphertext).`,
      warn: `[hazelnut] createRouter: resource(s) ${
        enc.join(", ")
      } declare 'encrypted' but no cfg.kms seam is wired — encrypted reads/writes will throw at first use. Pass cfg.kms (appKeyKms(...) or an external Kms), or use createApp for the guarded (fail-closed) path.`,
    });
  }

  // 1b. tamper/key-source — the HMAC chain is keyed; an unkeyed ledger used to verify as SHA-256.
  const te = seams.hasKms
    ? []
    : model.filter((m) => tamperEvidentOn(m.features)).map((m) => m.name);
  if (te.length > 0) {
    out.push({
      id: "tamper/key-source",
      resources: te,
      refuse: `tamper/key-source: resource(s) ${
        te.join(", ")
      } declare immutable:{ tamperEvident } but no app master key is configured — the chain is HMAC-SHA-256 under HKDF (chain-version v1). Supply defineConfig({ encryptionKey }) (base64, 32 bytes, sourced at the config site from a project-named env / secret store), or inject an external boot.kms with equalityMacs. Refusing to boot: an unkeyed chain cannot detect a rewrite by anyone who can recompute SHA-256. Existing unkeyed ledgers must re-baseline or re-anchor (tamper/chain-version).`,
      warn: `[hazelnut] createRouter: resource(s) ${
        te.join(", ")
      } declare tamperEvident but no cfg.kms seam is wired — hash-chain stamps will throw at first append. Pass cfg.kms (appKeyKms(...) or an external Kms with equalityMacs), or use createApp for the guarded (fail-closed) path.`,
    });
  }

  // 2. file/storage-required — a `file()` field stores bytes off-box; no default floor (must opt into a driver).
  const file = seams.hasStorage
    ? []
    : model.filter((m) => m.files.length > 0).map((m) => m.name);
  if (file.length > 0) {
    out.push({
      id: "file/storage-required",
      resources: file,
      refuse:
        `file/storage-required: a resource declares a file() field but no storage driver is configured — pass createApp(config, { ..., storage }) with localDriver({ dir }) (self-host) or stubStorage() from \"hazelnut/test.ts\" (tests). For cloud object storage the framework ships NO built-in driver — StorageDriver is the Port you fill. Refusing to boot: file() keeps only the opaque key in-row and the bytes live off-box, so a file app with no driver cannot read or write its files. Unlike 'encrypted' there is NO default — the framework never silently writes bytes to local disk (a hidden second store would orphan on a fresh box).`,
      warn: `[hazelnut] createRouter: resource(s) ${
        file.join(", ")
      } declare a file() field but no cfg.storage driver is wired — file reads/writes will throw at first use. Pass cfg.storage (localDriver, stubStorage from \"hazelnut/test.ts\", or your own StorageDriver), or use createApp for the guarded (fail-closed) path.`,
    });
  }

  // 3. vector/embed-required — a `vector` field needs the embed provider to populate rows on write and to
  //    embed query text for similarity search; no default floor (unlike kms's app-key) — fails closed at boot.
  const vec = seams.hasEmbed
    ? []
    : model.filter((m) => m.vector !== null).map((m) => m.name);
  if (vec.length > 0) {
    out.push({
      id: "vector/embed-required",
      resources: vec,
      refuse: `vector/embed-required: resource(s) ${
        vec.join(", ")
      } declare a vector field but no embedding provider is configured — pass createApp(config, { ..., embed }) with openaiEmbed({ ... }) (a real provider) or stubEmbed() from \"hazelnut/test.ts\" (tests). Refusing to boot: a vector field needs the embed seam to embed new rows on write AND to embed the query text for similarity search, so a vector app with no embed can neither populate nor query its vectors — there is NO default (the framework never invents an embedding).`,
      warn: `[hazelnut] createRouter: resource(s) ${
        vec.join(", ")
      } declare a vector field but no cfg.embed provider is wired — re-embed + vector search will throw at first use. Pass cfg.embed (openaiEmbed, or stubEmbed from \"hazelnut/test.ts\"), or use createApp for the guarded (fail-closed) path.`,
    });
  }

  // 4. audit/sensitive-declared — the `_audit` diff/snapshot masks exactly `sensitive ∪ encrypted`
  //    (features/redact.ts §redactionSet), so an undeclared card masks NOTHING and writes plaintext PII to a
  //    table that outlives the row a delete removes. Truthiness, never `=== true`: the `{fields,snapshot}`
  //    card audits just as hard, and a literal compare would let the richest form through unasked.
  const unanswered = model
    .filter((m) => Boolean(m.features.audit) && !m.sensitiveDeclared)
    .map((m) => m.name);
  if (unanswered.length > 0) {
    out.push({
      id: "audit/sensitive-declared",
      resources: unanswered,
      refuse: `audit/sensitive-declared: resource(s) ${
        unanswered.join(", ")
      } declare features:{ audit } but no 'sensitive' — the _audit diff/snapshot persists every changed column's before/after value and masks only the 'sensitive ∪ encrypted' set, so an unwritten card writes PII to an append-only table that outlives the row itself. Refusing to boot: declare sensitive:["email", ...] to mask those columns, or sensitive:[] to state that nothing on this row is PII. There is no default — the framework cannot tell a free-text 'body' holding a customer's address from one holding a build log.`,
      warn: `[hazelnut] createRouter: resource(s) ${
        unanswered.join(", ")
      } declare features:{ audit } but no 'sensitive' — the _audit diff/snapshot will persist every changed column in the clear. Declare sensitive:[...] (or sensitive:[] to state nothing here is PII), or use createApp for the guarded (fail-closed) path.`,
    });
  }

  // 5. policy/read-protected — a "policy" read (http list/find or an mcp read) is only ever as narrow as the
  //    rowPolicy conjunct it is served with, so this checks EFFECT, not presence: a declared policy lowering
  //    to all() for a weakest caller leaks the whole table exactly as a missing one does. Per-resource for
  //    a precise refuse message.
  for (const m of model) {
    const leak = policyReadLeak(m, model);
    if (!leak) continue;
    let gap: string | undefined;
    const policy = seams.rowPolicyOf(m);
    if (policy == null) {
      gap = "no rowPolicy narrows it, so every row goes on the wire";
    } else {
      // Every declared policy faces this — INJECTED or declared, scoped or not. `features:{ scope:true }`
      // used to skip it; it is not a rowPolicy substitute (see `uniformForHolders`).
      gap = openPolicyReason(policy);
    }
    // …and separately from whether the door is SHUT, whether it SEPARATES. A claim gate answers the
    // anonymous probe correctly and hands every grantee the same rows.
    gap ??= uniformForHolders(
      policy as (a: Actor | null) => unknown,
      m,
    );
    if (gap === undefined) continue;
    out.push({
      id: "policy/read-protected",
      resources: [m.name],
      refuse:
        `policy/read-protected: resource '${m.name}' exposes ${leak.face} but ${gap} — a "policy" read is served to any authenticated/remote caller with exactly the rowPolicy conjunct the declaration yields. Refusing to boot: narrow the read. If the rule is OWNERSHIP, name the column and stop — rowPolicy: "owner_id", one line and no import, and it denies the anonymous caller for you. Anything more than ownership takes the fragment form: rowPolicy: (actor: Actor | null) => actor ? { owner_id: actor.id } : none(), with none/owned/withinScope/relate on "hazelnut/query". If every caller who gets this far is MEANT to see the same rows (a catalogue, a directory, a tenant's shared table), say so: rowPolicy: () => shared() from "hazelnut/query" instead of all(), or () => shared(<condition>) for the same decision over a fixed subset — each lowers identically to the un-marked form and is the written decision. features:{ scope:true } does NOT discharge this: scope partitions the tenant boundary, never two callers within it. An anonymous caller reaches the policy as a NON-NULL actor holding no claim, so a null-check guarding all() narrows nobody; test it with isAnonymous(actor) ("hazelnut/authz/auth.ts"). Rewriting the read to '"public"' is not that fix: it declares the rows are meant for every caller, agent and crawler, and drops the narrowing this is asking for.`,
      warn:
        `[hazelnut] createRouter: resource '${m.name}' exposes ${leak.face} but ${gap} — a "policy" read is served to any authenticated/remote caller with exactly the rowPolicy conjunct the declaration yields. Narrow the read: rowPolicy: (actor: Actor | null) => actor ? { owner_id: actor.id } : none() (or an owned / withinScope / relate fragment), rowPolicy: () => shared() / () => shared(<condition>) when a uniform read is the intent, wire cfg.rowPolicies, or use createApp for the guarded (fail-closed) path. features:{ scope:true } does NOT discharge this: scope partitions the tenant boundary, never two callers within it. An anonymous caller reaches the policy as a NON-NULL actor holding no claim — test for it with isAnonymous(actor), never a null-check.`,
    });
  }

  // 5b. policy/read-protected, VIEW face — `defineView.mcp` is a firing condition of the same id
  //     (10-invariants.md §static-conformance), and it is a SECOND read door, not a projection of the
  //     resource's: `runView`/`runViewQuery` pass the view's own rowPolicy to `buildReadWhere` and the
  //     source's is never re-applied (13-authz.md §defineView-cross-source-row-visibility), so a protected
  //     source buys the view nothing. Same EFFECT test as the resource face, same weakest callers.
  for (const { view: v, door } of remotelyReachableViews(views, model)) {
    // A run-form view has no table, so its rowPolicy is the dispatch-time ACTOR GATE (`runFormActorDenied`)
    // rather than a row filter — all-or-nothing, exactly the shape a read-model projection carries, and the
    // probe that face already runs answers it. Skipping it here left `policy/required`'s presence test as
    // the whole gate, and an allow-everyone gate satisfies presence.
    if (typeof v.run === "function" || v.over === undefined) {
      const gap = v.rowPolicy === undefined || v.rowPolicy === null
        ? "declares no rowPolicy, so its dispatch-time actor gate admits every caller"
        : openReadModelGate(v.rowPolicy);
      if (gap === undefined) continue;
      out.push({
        id: "policy/read-protected",
        resources: [],
        refuse:
          `policy/read-protected: view '${v.name}' is a run-form view ${door} but ${gap} — a run-form view's rowPolicy is not a row filter, it is the dispatch-time ALLOW/DENY gate, and it is the whole gate: the view's own 'run' body reaches its sources without re-applying their rowPolicies. Refusing to boot: make the gate SHUT for a caller holding nothing — rowPolicy: (actor) => can(actor, "<r>:<claim>") ? all() : none() (none/all on "hazelnut/query"). A top-level answer that is not none() admits everyone, anonymous callers included. Dropping the view's 'mcp' card also closes it — a view with no mcp card is invisible to agents.`,
        warn:
          `[hazelnut] createRouter: view '${v.name}' is a run-form view ${door} but ${gap} — its rowPolicy is the dispatch-time allow/deny gate and the run body does not re-apply its sources' rowPolicies. Give it a gate that shuts for a claimless caller — rowPolicy: (actor) => can(actor, "<r>:<claim>") ? all() : none() — drop the 'mcp' card, or use createApp for the guarded (fail-closed) path.`,
      });
      continue;
    }
    const src = model.find((m) => m.name === v.over);
    if (src === undefined) continue; // unknown source — `runView` raises its own loud error
    let gap = v.rowPolicy === undefined || v.rowPolicy === null
      ? "declares no rowPolicy, so the read-tool defaults to all() and every row of the source goes on the wire"
      : openPolicyReason(v.rowPolicy);
    // …and the SEPARATION question, the same one the resource faces answer. A view tool carries no perm gate
    // of its own — the view's rowPolicy IS the whole gate — so a claim gate here hands every caller the
    // source's whole table. The claim vocabulary is the SOURCE's: it is the source's rows on the wire.
    gap ??= uniformForHolders(
      v.rowPolicy as (a: Actor | null) => unknown,
      src,
    );
    if (gap === undefined) continue;
    out.push({
      id: "policy/read-protected",
      resources: [src.name],
      refuse:
        `policy/read-protected: view '${v.name}' (over '${src.name}') is ${door} but ${gap} — a view is its OWN read door: the source resource's rowPolicy is NOT re-applied to it, so a narrowed resource read and a wide-open view over the same table are served side by side to the same agent. Refusing to boot: give the view a rowPolicy that yields no rows for an anonymous caller and an ownership / scope-value / grant fragment for the rest — rowPolicy: (actor: Actor | null) => actor ? { owner_id: actor.id } : none(), with none/owned/withinScope/relate on "hazelnut/query". If every caller who reaches this tool is MEANT to see the same rows, say so with rowPolicy: () => shared() / () => shared(<condition>) from "hazelnut/query" — it lowers identically and is the written decision. features:{ scope:true } does NOT discharge this: scope partitions the tenant boundary, never two callers within it. An anonymous caller reaches the policy as a NON-NULL actor holding no claim, so a null-check guarding all() narrows nobody; test it with isAnonymous(actor) ("hazelnut/authz/auth.ts"). Dropping the view's 'mcp' card also closes it — a view with no mcp card is invisible to agents.`,
      warn:
        `[hazelnut] createRouter: view '${v.name}' (over '${src.name}') is ${door} but ${gap} — the source's rowPolicy is NOT re-applied to a view, so this tool serves rows the resource read hides. Give the view a rowPolicy: (actor: Actor | null) => actor ? { owner_id: actor.id } : none(), rowPolicy: () => shared() / () => shared(<condition>) when a uniform read is the intent, drop the view's 'mcp' card, or use createApp for the guarded (fail-closed) path.`,
    });
  }

  // 5c. policy/write-protected — the row-addressed WRITE doors. Not the read tuple widened: a write needs the
  //     SAME guarantee (a per-row narrowing conjunct on a row-addressed door) over a DIFFERENT door set.
  //     `update`/`delete` already AND the rowPolicy into their WHERE (repo-read.ts §appendRowPolicyConjunct)
  //     at the same single composition site the read stack uses; what they lack is the boot obligation to
  //     make that conjunct non-vacuous AND caller-separating, so one per-RESOURCE grant ('widget:update')
  //     authorizes mutating every row. The door set is those verbs AND the exposed ops that write the rows
  //     (`opRowWriteDoor`). `create` is excluded — see ROW_ADDRESSED_WRITES.
  for (const m of model) {
    const leak = policyWriteLeak(m, model);
    if (!leak) continue;
    let gap: string | undefined;
    const policy = seams.rowPolicyOf(m);
    if (policy == null) {
      gap = "no rowPolicy narrows it, so every row is writable";
    } else {
      gap = openPolicyReason(policy);
    }
    // …and separately from whether the door is SHUT, whether it SEPARATES — the same probe the read face
    // runs, because the write WHERE carries the SAME conjunct: a claim gate hands every grantee every row.
    gap ??= uniformForHolders(policy as (a: Actor | null) => unknown, m);
    if (gap === undefined) continue;
    out.push({
      id: "policy/write-protected",
      resources: [m.name],
      refuse:
        `policy/write-protected: resource '${m.name}' exposes ${leak.face} but ${gap} — the write WHERE is 'id = $1 AND (<rowPolicy>)', so a vacuous policy makes the grant '${leak.grant}' authority over EVERY row, not the caller's. A row id is not an authorization: ids travel in URLs, webhook payloads, foreign keys and audit exports. Refusing to boot: give the resource a rowPolicy that yields no rows for an anonymous caller and an ownership / scope-value / grant fragment for the rest — rowPolicy: (actor: Actor | null) => actor ? { owner_id: actor.id } : none(), with none/owned/withinScope/relate on "hazelnut/query". If every caller who holds the grant is MEANT to write the same rows (a shared queue, a team wiki), rowPolicy: () => shared() from "hazelnut/query" instead of all(), or () => shared(<condition>) for the same decision over a fixed subset — each lowers identically and is the written decision. features:{ scope:true } does NOT discharge this: scope partitions the tenant boundary, never two callers within it. An anonymous caller reaches the policy as a NON-NULL actor holding no claim, so a null-check guarding all() narrows nobody; test it with isAnonymous(actor) ("hazelnut/authz/auth.ts"). The same rowPolicy governs the read faces; there is no write-only slot. A hidden row matches 0 rows and returns the ordinary not-found, never a cross-owner mutation.`,
      warn:
        `[hazelnut] createRouter: resource '${m.name}' exposes ${leak.face} but ${gap} — the write WHERE is 'id = $1 AND (<rowPolicy>)', so the grant '${leak.grant}' authorizes mutating every row. Narrow it: rowPolicy: (actor: Actor | null) => actor ? { owner_id: actor.id } : none() (or an owned / withinScope / relate fragment), rowPolicy: () => shared() / () => shared(<condition>) when a uniform write is the intent, wire cfg.rowPolicies, or use createApp for the guarded (fail-closed) path. features:{ scope:true } does NOT discharge this: scope partitions the tenant boundary, never two callers within it.`,
    });
  }

  // 6. op/decisions-written — the floor under BOTH op-authoring doors. `defineOp`'s slot type refuses an
  //    unmade decision, but `operations` is typed `Record<string, unknown>` at the dispatch layer, so an
  //    inline object literal reaches `runOp` having skipped it: `op.policy` undefined serves the handler to
  //    anonymous callers, and `op.idempotent` undefined is falsy, so a retried Idempotency-Key re-runs it.
  //    This runs on the composed model, the one layer every spelling passes through.
  for (const m of model) {
    const unwritten = Object.entries(m.operations).flatMap(([name, decl]) =>
      unwrittenOpDecisions(decl).map((slot) => `${name}.${slot}`)
    );
    if (unwritten.length === 0) continue;
    out.push({
      id: "op/decisions-written",
      resources: [m.name],
      refuse:
        `op/decisions-written: resource '${m.name}' declares op(s) leaving a pipeline decision unmade — ${
          unwritten.join(", ")
        }. Refusing to boot: an op with no 'input' schema mounts its route and then fails inside validation on the first caller, an op with no 'policy' runs for ANY caller the route admits, including an anonymous one (null is how you say the door is deliberately public), an op with no 'tx' used to fall through to a write transaction, so a read-only handler held locks it never needed and no read replica could serve it, and a write with no 'idempotent' verdict re-runs its handler on a retried Idempotency-Key instead of replaying the first result — a charge twice, a mail sent twice. Write all four on the declaration: input: z.object({ ... }), tx: "read" | "write", policy: requires("${m.name}:<op>") | null, and idempotent: true | false on every op that is not tx:"read". Authoring the op through defineOp({ ... }) makes the same omission a compile error.`,
      warn:
        `[hazelnut] createRouter: resource '${m.name}' declares op(s) leaving a pipeline decision unmade — ${
          unwritten.join(", ")
        }. A missing 'policy' runs the op for any caller the route admits; a missing 'idempotent' re-runs the handler on a retried Idempotency-Key. Write both on the declaration, or use createApp for the guarded (fail-closed) path.`,
    });
  }

  // 7. versioning/decision-written — a resource with an update face is written by a read-modify-write the
  //    framework never sees, so the posture is the DECLARATION's to state: `versioning: true` mints `version`
  //    and makes the CAS argument required, `versioning: false` says last-write-wins is correct for this row.
  //    Absent, the runtime silently picks last-write-wins — the shorter, racier answer, chosen for the author.
  //    Whole-immutable resources are exempt by construction: `update`/`delete` are removed, so nothing races.
  const undecided = model
    .filter((m) =>
      !wholeImmutable(m.features) && m.features.versioning === undefined
    )
    .map((m) => m.name);
  if (undecided.length > 0) {
    out.push({
      id: "versioning/decision-written",
      resources: undecided,
      refuse: `versioning/decision-written: resource(s) ${
        undecided.join(", ")
      } carry a mutable write face but state no concurrency posture — with 'versioning' unwritten, ctx.data.<r>.update issues a blind UPDATE, so of two callers who read the same row and each write it back, the second silently erases the first (a decremented balance restored, a resolved ticket re-opened). Refusing to boot: declare features:{ versioning: true } — the row gets a 'version' column, update REQUIRES the expected version, and a stale write is rejected rather than applied (read the row with findForUpdate to hold it) — or features:{ versioning: false } to state that last-write-wins is correct for this row. There is no default: the framework cannot tell a counter whose value is derived from what it just read from a row every writer overwrites whole.`,
      warn: `[hazelnut] createRouter: resource(s) ${
        undecided.join(", ")
      } carry a mutable write face but state no concurrency posture — update is a blind write, so a concurrent writer's update is silently erased. Declare features:{ versioning: true } (compare-and-swap) or features:{ versioning: false } (last-write-wins is correct here), or use createApp for the guarded (fail-closed) path.`,
    });
  }

  return out;
}
