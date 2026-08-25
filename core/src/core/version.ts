/** The CORE / product version (the `V_now` of `version/projection-fresh`). Capability modules have
 *  their own numbers — `src/core/module-pins.ts`. A `v${FRAMEWORK_VERSION}` tag publishes core. */
export const FRAMEWORK_VERSION = "0.5.1";

/** The Deno minor line the framework is TESTED against (CI pins `v${DENO_TESTED_LINE}.x`; the scaffold
 *  Dockerfile pins a version on it). `hazelnut doctor` warns off-line, boot only refuses below 2.x —
 *  tested ≠ floor. A drift tooth ties CI/Dockerfile to this constant. */
export const DENO_TESTED_LINE = "2.9";

/** The base image EVERY shipped container rides — tag AND digest, in that order, because they answer
 *  different questions: the tag says which Deno a reader is on, the digest is what the daemon actually
 *  resolves. A tag alone is re-pushable, so a tag-only build is neither reproducible nor tamper-evident.
 *  NEVER hand-edit the digest — `deno task pin:base` resolves and rewrites it, because a well-formed hash
 *  naming the wrong image is the one failure no offline gate can see. A drift tooth holds every
 *  `FROM` in the tree — emitter and committed alike — equal to this string. */
export const DENO_BASE_IMAGE =
  "denoland/deno:2.9.4@sha256:c777b4b225501a61074837e90a826a58f99124837824023cd60334b1e2374498";

/** The port `Deno.serve` binds when `PORT` is UNSET (a set-but-unusable one is refused, not defaulted). The
 *  scaffold's emitted `main.ts`, its `EXPOSE`, the derived `--allow-net`, the committed examples and the
 *  handbook are ONE claim: a split dies `NotCapable` on first bind, in production only. */
export const DEFAULT_SERVE_PORT = "8000";

/** The port the emitted MCP gateway binds when `PORT` is UNSET. A SECOND port on purpose: the gateway and
 *  the app it forwards to are two processes of the same image, and a shared default would collide the moment
 *  someone runs both on one host. The emitted entry, the derived `--allow-net` and the handbook row are ONE
 *  claim — a split dies `NotCapable` on the gateway's first bind. */
export const MCP_GATEWAY_PORT = "8100";

/** Version identity: the AGENTS.md header carries a projection-input
 *  digest (frameworkVersion · principles · declaration-view(model)) that `version/projection-fresh`
 *  recomputes and compares — a mismatch means the committed projection is stale. FNV-1a, deterministic
 *  (no clock/RNG) so a stamped projection stays byte-reproducible; not anti-tamper. */

/** Deterministic JSON: object keys sorted recursively, arrays in order. Pure. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${
    Object.keys(obj).sort().map((k) =>
      `${JSON.stringify(k)}:${stableStringify(obj[k])}`
    ).join(",")
  }}`;
}

/** Compare two dotted version strings numerically (semver-ish): <0 / 0 / >0.
 *  A pre-release (`1.0.0-beta`) is less than the same core without one (`1.0.0`). */
export function cmpVersion(a: string, b: string): number {
  const parse = (v: string): { nums: number[]; pre: string } => {
    const dash = v.indexOf("-");
    const core = dash === -1 ? v : v.slice(0, dash);
    const pre = dash === -1 ? "" : v.slice(dash + 1);
    return {
      nums: core.split(".").map((n) => Number(n) || 0),
      pre,
    };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === "") return 1;
  if (pb.pre === "") return -1;
  return pa.pre < pb.pre ? -1 : pa.pre > pb.pre ? 1 : 0;
}

/** FNV-1a 64-bit → 16-hex. Deterministic content hash for change-detection (not security). */
export function fnv1a(s: string): string {
  const mask = 0xffffffffffffffffn;
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) {
    h = (h ^ BigInt(s.charCodeAt(i))) & mask;
    h = (h * 0x100000001b3n) & mask;
  }
  return h.toString(16).padStart(16, "0");
}
