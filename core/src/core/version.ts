/** The CORE / product version (the `V_now` of `version/projection-fresh`). Capability modules have
 *  their own numbers — `src/core/module-pins.ts`. A `v${FRAMEWORK_VERSION}` tag publishes core. */
export const FRAMEWORK_VERSION = "0.12.0";

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

/** Version identity: the AGENTS.md header carries a projection-input digest (frameworkVersion · principles ·
 * declaration-view(model)) that `version/projection-fresh` recomputes and compares — a mismatch means the
 * committed projection is stale. FNV-1a, deterministic (no clock/RNG) so a stamped projection stays
 * byte-reproducible; not anti-tamper.
 */

/** The third-party pins an emitted app carries in its OWN import map. A duplicate of this framework's
 * `deno.json` by necessity — the app resolves these for its own source, and a framework file pinned into
 * that map resolves THROUGH it — so the two must not drift: two hono copies in one process is two Hono
 * contexts. `doctor`'s `pin/dependencies` reports a skew to the app that has one.
 */
export const APP_DEPENDENCY_PINS: Readonly<Record<string, string>> = {
  "zod": "npm:zod@4.4.3",
  "hono": "npm:hono@4.12.34",
  // the slash form resolves hono subpath imports (e.g. "hono/body-limit"); a pinned framework file
  // resolves through the CONSUMER map, so it must carry both forms (see drizzle-orm/ below).
  "hono/": "npm:/hono@4.12.34/",
  // Drizzle + drizzle-kit pinned exact to v1.0.0 RC (cli/migrate.md §drizzle-kit-pin — prevIds[] DAG + snapshot
  // v8 are native to v1). `nodeModulesDir:"auto"` lets drizzle-kit's Node loader resolve the bare import.
  "drizzle-orm": "npm:drizzle-orm@1.0.0-rc.4",
  "drizzle-orm/": "npm:/drizzle-orm@1.0.0-rc.4/",
  "drizzle-kit": "npm:drizzle-kit@1.0.0-rc.4",
  "@electric-sql/pglite": "npm:@electric-sql/pglite@0.5.4",
  // pgvector split out of pglite 0.5 core; not on the runtime public graph.
  // Emitted preemptively so declaring a `vector:` field later needs no import-map edit.
  "@electric-sql/pglite-pgvector": "npm:@electric-sql/pglite-pgvector@0.0.5",
  // the Argon2id the framework's `password()` write path derives with — a fresh app resolves the SAME
  // pin, so a stored hash written here and read there is byte-identical (scaffold-boot value-for-value).
  "@noble/hashes/": "jsr:/@noble/hashes@2.2.0/",
  // the postgres.js driver the serve entry's DATABASE_URL branch constructs (`postgresDb(postgres(url))`);
  // the PGlite import covers the zero-infra dev branch. Both are boot-seam substrates, never config fields.
  "postgres": "npm:postgres@3.4.9",
  // @std/assert backs the emitted `app.test.ts` smoke test so a fresh scaffold's `deno task test` is green.
  "@std/assert": "jsr:@std/assert@1.0.19",
  // These back CLI tasks (verify/migrate), not the main.ts runtime graph — mod.ts stays fast-check-free
  // for cold-start. Kept in lock-step with the framework deno.json (drift → RED).
  "fast-check": "npm:fast-check@4.9.0",
  "pgsql-ast-parser": "npm:pgsql-ast-parser@12.0.2",
};

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
  return cmpPreRelease(pa.pre, pb.pre);
}

/** Semver's pre-release ordering, which is NOT a string compare: dot-separated identifiers, numeric ones
 *  compared as NUMBERS. Lexically `rc.2 > rc.10` because `2 > 1` — so a plain `<` put the second release
 *  candidate ahead of the tenth, and every caller that sorts versions (the acquire gate picks the newest
 *  eligible by `.at(-1)`) would have taken the wrong one. No pre-release has shipped yet; the first will
 *  be a 1.0 candidate, which is the worst moment to find this. */
function cmpPreRelease(a: string, b: string): number {
  if (a === b) return 0;
  if (a === "") return 1; // a release outranks any pre-release of the same core
  if (b === "") return -1;
  const A = a.split("."), B = b.split(".");
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i], y = B[i];
    if (x === undefined) return -1; // fewer identifiers ranks lower
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
      continue;
    }
    if (nx !== ny) return nx ? -1 : 1; // numeric identifiers rank below alphanumeric
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
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
