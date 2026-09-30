/** Restricted child used only by `hazelnut launch` to compose the pure model before deriving serve grants. */
import { derivePermissions } from "./permissions.ts";
import type { PermissionPlan } from "./permissions.ts";
import { readAppGraph } from "./launch.ts";
import { CliRefusal, importAppModule } from "./hazelnut-io.ts";
import type { App } from "../core/app-define.ts";

const [appSpecifier, entry, envKeysJson] = Deno.args;
// Capture the trusted output primitives before importing app code. A consumer shares this process and can
// monkey-patch globals; the planner must not route its private response through app-controlled methods.
const plannerStdout = Deno.stdout;
const writePlannerStdout = plannerStdout.write.bind(plannerStdout);
const plannerEncoder = new TextEncoder();
const encodePlannerText = plannerEncoder.encode.bind(plannerEncoder);
const stringifyPlannerString = JSON.stringify.bind(JSON);
const RUNTIME_SURFACE_CHANGED = Symbol(
  "launch planner runtime surface changed",
);
// Parent sends this one-shot challenge over stdin and closes it before app import. Do not put it in argv or
// env: app code runs in this process, can inspect both, and shares stdout with the planner response.
const marker = (await new Response(Deno.stdin.readable).text()).trimEnd();
if (!/^HAZELNUT_LAUNCH_PLAN:[0-9a-f-]{36}:$/.test(marker)) {
  throw new Error(
    "restricted planner did not receive its private response challenge",
  );
}
const PLANNER_NOT_CAPABLE = Deno.errors.NotCapable;

type RuntimeProperty = readonly [
  PropertyKey,
  unknown,
  (() => unknown) | undefined,
  ((value: unknown) => void) | undefined,
  boolean | undefined,
  boolean,
  boolean,
  boolean,
];

interface RuntimeObjectSnapshot {
  readonly value: object;
  readonly prototype: object | null;
  readonly properties: readonly RuntimeProperty[];
}

interface RuntimeSurfaceGuard {
  readonly intact: () => boolean;
  readonly lock: () => boolean;
}

/**
 * Application modules load in this restricted process, but they share its JavaScript realm. A model entry
 * that changes `Array.prototype.push` can otherwise inject a grant into `derivePermissions` after import.
 * Snapshot and freeze the JS objects reachable from global bindings before importing the app. The derived
 * plan is security-sensitive, so consumer initialization must not share mutable intrinsics with its deriver.
 * Traversal and locking use captured primordials and indexed loops so the mutation being blocked cannot
 * disable its own guard.
 */
function captureRuntimeSurface(): RuntimeSurfaceGuard {
  const ownKeys = Reflect.ownKeys;
  const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const getPrototypeOf = Object.getPrototypeOf;
  const objectIs = Object.is;
  const freezeObject = Object.freeze;
  const defineProperty = Object.defineProperty;
  const global = globalThis;
  const denoNamespace = Deno;
  const seen = new WeakSet<object>();
  const seenHas = WeakSet.prototype.has.bind(seen);
  const seenAdd = WeakSet.prototype.add.bind(seen);
  const pending: object[] = [global];
  const snapshots: RuntimeObjectSnapshot[] = [];

  for (let cursor = 0; cursor < pending.length; cursor++) {
    const value = pending[cursor]!;
    if (seenHas(value)) continue;
    seenAdd(value);

    const prototype = getPrototypeOf(value);
    const keys = ownKeys(value);
    const properties: RuntimeProperty[] = [];
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      const descriptor = getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) continue;
      let hasValue = false;
      const descriptorKeys = ownKeys(descriptor);
      for (let j = 0; j < descriptorKeys.length; j++) {
        if (descriptorKeys[j] === "value") hasValue = true;
      }
      properties[properties.length] = [
        key,
        descriptor.value,
        descriptor.get,
        descriptor.set,
        descriptor.writable,
        descriptor.enumerable === true,
        descriptor.configurable === true,
        hasValue,
      ];
      if (
        hasValue && descriptor.value !== null &&
        (typeof descriptor.value === "object" ||
          typeof descriptor.value === "function")
      ) {
        // Deno's host namespace has lazy internal properties that can change as a consequence of an
        // ordinary capability refusal. It is not used by the deriver after this point (source reads happen
        // before app import; stdout/encoder are captured above), so keep its global binding but exclude its
        // host object graph from the JS-intrinsic snapshot and lock.
        if (descriptor.value !== denoNamespace) {
          pending[pending.length] = descriptor.value;
        }
      }
      if (descriptor.get !== undefined) {
        pending[pending.length] = descriptor.get;
      }
      if (descriptor.set !== undefined) {
        pending[pending.length] = descriptor.set;
      }
    }
    if (prototype !== null && prototype !== denoNamespace) {
      pending[pending.length] = prototype;
    }
    snapshots[snapshots.length] = { value, prototype, properties };
  }

  const intact = (): boolean => {
    try {
      for (let i = 0; i < snapshots.length; i++) {
        const snapshot = snapshots[i]!;
        if (!objectIs(getPrototypeOf(snapshot.value), snapshot.prototype)) {
          return false;
        }
        const keys = ownKeys(snapshot.value);
        if (keys.length !== snapshot.properties.length) return false;
        for (let j = 0; j < snapshot.properties.length; j++) {
          const [
            key,
            expectedValue,
            expectedGet,
            expectedSet,
            expectedWritable,
            expectedEnumerable,
            expectedConfigurable,
            expectedHasValue,
          ] = snapshot.properties[j]!;
          if (!objectIs(keys[j], key)) return false;
          const descriptor = getOwnPropertyDescriptor(snapshot.value, key);
          if (descriptor === undefined) return false;
          let hasValue = false;
          const descriptorKeys = ownKeys(descriptor);
          for (let k = 0; k < descriptorKeys.length; k++) {
            if (descriptorKeys[k] === "value") hasValue = true;
          }
          if (
            hasValue !== expectedHasValue ||
            !objectIs(descriptor.value, expectedValue) ||
            !objectIs(descriptor.get, expectedGet) ||
            !objectIs(descriptor.set, expectedSet) ||
            !objectIs(descriptor.writable, expectedWritable) ||
            !objectIs(descriptor.enumerable === true, expectedEnumerable) ||
            !objectIs(descriptor.configurable === true, expectedConfigurable)
          ) return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  };

  const lock = (): boolean => {
    try {
      // Lock before model import; this lock lasts only in the disposable planner process while the
      // app initializes and the pure grant deriver reads its composed model. Never freeze globalThis itself: Deno adds an unload
      // marker there during shutdown. Freeze each ordinary global object/prototype and lock each global
      // binding, leaving only Deno's host namespace mutable for the captured exit-status setter.
      for (let i = 0; i < snapshots.length; i++) {
        const value = snapshots[i]!.value;
        if (value !== global && value !== denoNamespace) freezeObject(value);
      }

      const globalSnapshot = snapshots[0]!;
      for (let i = 0; i < globalSnapshot.properties.length; i++) {
        const [
          key,
          value,
          get,
          _set,
          _writable,
          enumerable,
          _configurable,
          hasValue,
        ] = globalSnapshot.properties[i]!;
        if (key === "globalThis") continue;
        if (hasValue) {
          defineProperty(global, key, {
            value,
            writable: false,
            enumerable,
            configurable: false,
          });
        } else {
          defineProperty(global, key, {
            get,
            set: undefined,
            enumerable,
            configurable: false,
          });
        }
      }
      return true;
    } catch {
      return false;
    }
  };

  return { intact, lock };
}

function quoted(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("planner response contains a non-string diagnostic");
  }
  return stringifyPlannerString(value)!;
}

function serializePlan(plan: PermissionPlan): string {
  let grants = "[";
  for (let i = 0; i < plan.grants.length; i++) {
    const grant = plan.grants[i]!;
    if (i > 0) grants += ",";
    grants += `{"flag":${quoted(grant.flag)},"value":${
      quoted(grant.value)
    },"why":${quoted(grant.why)}}`;
  }
  grants += "]";

  let refusals = "[";
  for (let i = 0; i < plan.refusals.length; i++) {
    const refusal = plan.refusals[i]!;
    if (i > 0) refusals += ",";
    refusals += `{"what":${quoted(refusal.what)},"fix":${quoted(refusal.fix)}}`;
  }
  refusals += "]";

  let scanned = "[";
  for (let i = 0; i < plan.scanned.length; i++) {
    if (i > 0) scanned += ",";
    scanned += quoted(plan.scanned[i]);
  }
  scanned += "]";

  return `{"grants":${grants},"refusals":${refusals},"unstableCron":${
    plan.unstableCron ? "true" : "false"
  },"scanned":${scanned}}`;
}

function serializeResponse(
  value:
    | { readonly ok: true; readonly plan: PermissionPlan }
    | { readonly ok: false; readonly reason: string; readonly fix: string },
): string {
  return value.ok
    ? `{"ok":true,"plan":${serializePlan(value.plan)}}`
    : `{"ok":false,"reason":${quoted(value.reason)},"fix":${
      quoted(value.fix)
    }}`;
}

async function report(
  value:
    | { readonly ok: true; readonly plan: PermissionPlan }
    | { readonly ok: false; readonly reason: string; readonly fix: string },
): Promise<void> {
  await writePlannerStdout(
    encodePlannerText(`${marker}${serializeResponse(value)}\n`),
  );
}

let runtimeSurfaceIsIntact: (() => boolean) | undefined;
let runtimeSurfaceGuard: RuntimeSurfaceGuard | undefined;
let runtimeSurfaceLocked = false;

try {
  if (
    appSpecifier === undefined || entry === undefined ||
    envKeysJson === undefined
  ) {
    throw new Error("planner arguments are incomplete");
  }
  const envKeys: unknown = JSON.parse(envKeysJson);
  if (
    !Array.isArray(envKeys) || !envKeys.every((key) => typeof key === "string")
  ) {
    throw new Error("planner environment roster is invalid");
  }
  const env = Object.fromEntries(
    envKeys.map((key: string) => [key, Deno.env.get(key)]),
  );
  // Read/scanning the app's source graph is framework work, not model initialization; finish it before
  // importing consumer code so it cannot replace Deno.readTextFile or the source scanner's intrinsics.
  const entrySources = await readAppGraph(".", entry);
  runtimeSurfaceGuard = captureRuntimeSurface();
  runtimeSurfaceIsIntact = runtimeSurfaceGuard.intact;
  if (!runtimeSurfaceIsIntact() || !runtimeSurfaceGuard.lock()) {
    throw RUNTIME_SURFACE_CHANGED;
  }
  runtimeSurfaceLocked = true;
  const mod = await importAppModule(appSpecifier);
  const app = mod.app ?? mod.default;
  if (!app || typeof app !== "object") {
    throw new Error("the model entry does not export app");
  }
  const plan = derivePermissions({
    app: app as App,
    env,
    entrySources,
    entry,
    ...(env.FILES_DIR !== undefined ? { filesDir: env.FILES_DIR } : {}),
  });
  await report({ ok: true, plan });
} catch (error) {
  const runtimeSurfaceChanged = error === RUNTIME_SURFACE_CHANGED ||
    (!runtimeSurfaceLocked && typeof runtimeSurfaceIsIntact === "function" &&
      !runtimeSurfaceIsIntact());
  if (runtimeSurfaceChanged) {
    await report({
      ok: false,
      reason:
        "the app model modified shared JavaScript runtime globals or prototypes during initialization",
      fix:
        "remove global/prototype monkey-patching from model initialization; launch refuses to derive grants after shared runtime state changes",
    });
    Deno.exitCode = 1;
    // Do not inspect the thrown value or any global Error/string helpers after detecting mutation.
  } else {
    const message = error instanceof Error
      ? error.message
      : typeof error === "string"
      ? error
      : "";
    const firstLine = message.split(/\r?\n/, 1)[0] ?? "";
    const isCapabilityRefusal = error instanceof PLANNER_NOT_CAPABLE ||
      (typeof error === "string" &&
        /^Requires (?:read|write|net|env|run|ffi|sys|import|hrtime) access\b/i
          .test(error));
    const result = error instanceof CliRefusal
      ? {
        reason: error.message,
        fix:
          "resolve the app or CLI refusal above; do not widen Deno grants unless the refusal explicitly names an undeclared capability",
      }
      : isCapabilityRefusal
      ? {
        reason:
          `the model entry attempted an undeclared planner capability: ${firstLine}`,
        fix:
          "keep the model entry's module initialization pure: move file writes, network calls, and subprocess work to the served runtime entry",
      }
      : error instanceof TypeError &&
          firstLine.startsWith("Module not found ")
      ? {
        reason: `the app model imports an unresolved module: ${firstLine}`,
        fix:
          "correct the import or add the dependency to the app's import map, then run `deno check` with the app's config",
      }
      : {
        reason:
          "the app model failed while importing or composing; this is not a planner permission refusal",
        fix:
          "run `deno check` with the app's config and correct the reported app import or initialization error before retrying launch",
      };
    await report({ ok: false, ...result });
    Deno.exitCode = 1;
  }
}
