// Barrel re-exports keep import sites stable.
import { DEFAULT_SERVE_PORT, MCP_GATEWAY_PORT } from "../core/version.ts";

/** One post-write INIT step `hazelnut new` runs in the scaffolded dir (a spawned command). An `optional`
 *  step may fail without aborting the rest of the plan; `failNote` is what the entrypoint prints then. */
export interface ScaffoldStep {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly optional?: boolean;
  readonly failNote?: string;
}

/** The post-write INIT plan `hazelnut new` runs in the scaffolded dir (cli/new.md §run-steps step 4): `deno
 *  cache` first so deno.lock lands in the initial commit, then `git init` + commit, both fail-tolerant; `--no-git` returns `[]`. */
export function scaffoldInitPlan(opts: { noGit: boolean }): ScaffoldStep[] {
  if (opts.noGit) return []; // --no-git → skip git entirely
  return [
    {
      cmd: "deno",
      args: ["cache", "main.ts"],
      optional: true,
      failNote:
        "`deno cache main.ts` failed — run `deno cache main.ts && git add deno.lock && git commit -m 'chore: lock'` so the supply-chain lock is committed",
    },
    { cmd: "git", args: ["init", "-q"] },
    { cmd: "git", args: ["add", "-A"] },
    {
      cmd: "git",
      args: ["commit", "-q", "-m", "chore: initial scaffold (hazelnut new)"],
    },
  ];
}

/** `hazelnut add` (cli/add.md) hands back an already-shaped declaration, not loose code to wire: the pure
 *  core (`nutModule`/`nutResource`) computes the emit map + a `RegistrationEdit` the entrypoint applies. */

/** A name segment that becomes part of the `<module>__<resource>__<op>` tool name + URI axis: `[a-z0-9_]`
 *  only, `__` reserved as the separator (mirrors app.ts's boot legality assertion — caught early, here). */
const NUT_SEGMENT = /^[a-z0-9_]+$/;
/** `notes` → `Notes` — the module-ctx alias name (`<Pascal>Ctx`) both templates must agree on. */
function pascal(name: string): string {
  return name[0]!.toUpperCase() + name.slice(1);
}
function nutSegmentErr(name: string, what: string): string | null {
  if (!NUT_SEGMENT.test(name)) {
    return `illegal ${what} name '${name}' — a name segment is [a-z0-9_] only (the tool-name/URI charset)`;
  }
  if (name.includes("__")) {
    return `illegal ${what} name '${name}' — '__' is reserved as the <module>__<resource>__<op> separator`;
  }
  return null;
}

/** One anchored insert. `mode:"line"` inserts after the last line whose trimmed content starts with the
 *  anchor; `mode:"array"` inserts as an element inside the `[ … ]` on the anchor line. */
export interface RegistrationInsert {
  readonly anchor: string; // the line prefix the array/import is anchored to (matched by startsWith after trim)
  readonly insert: string; // the line (import) or element (array push) to insert
  readonly mode: "line" | "array";
}

/** The in-place wiring `hazelnut add` applies to a committed file (e.g. add the import line + the array push). */
export interface RegistrationEdit {
  readonly file: string; // path relative to the app root (e.g. "src/modules/content/content.module.ts")
  readonly inserts: ReadonlyArray<RegistrationInsert>;
}

/** The result of a `hazelnut add` invocation: new files to write + an in-place registration edit. */
export interface NutPlan {
  readonly emit: Record<string, string>; // new files, by path relative to the app root
  readonly registration: RegistrationEdit; // the wiring edit applied to an existing file
}

/** A pre-existing emit target — `writeNutEmit` throws this before writing anything. */
export class NutCollisionError extends Error {
  constructor(readonly file: string, readonly verb = "add") {
    super(`${verb}: refusing to overwrite existing '${file}'`);
    this.name = "NutCollisionError";
  }
}

/** Emit a `NutPlan`'s files all-or-nothing (06-generators.md §4.6): a pre-flight pass throws `NutCollisionError`
 *  if any target already exists, before writing anything, so a late collision cannot orphan earlier files. */
export async function writeNutEmit(
  emit: Record<string, string>,
): Promise<void> {
  for (const file of Object.keys(emit)) {
    try {
      await Deno.lstat(file);
    } catch {
      continue; // does not exist — safe
    }
    throw new NutCollisionError(file); // a target already exists → refuse the whole emit before touching disk
  }
  for (const [file, content] of Object.entries(emit)) {
    const slash = file.lastIndexOf("/");
    if (slash > 0) await Deno.mkdir(file.slice(0, slash), { recursive: true });
    await Deno.writeTextFile(file, content);
  }
}

/** Raised when a `RegistrationEdit` finds no anchor line to wire against — `applyRegistration` refuses rather
 *  than append a dangling import/array element; the caller maps it to exit 2 with the exact hand-edit line. */
export class RegistrationAnchorError extends Error {
  constructor(
    readonly file: string,
    readonly anchor: string,
    readonly insert: string,
  ) {
    super(
      `add: cannot auto-wire '${file}' — no line starting with anchor '${anchor}'; add this by hand: ${insert.trim()}`,
    );
    this.name = "RegistrationAnchorError";
  }
}

/** Element tokens inside the array whose `[` sits at/after `anchor` on `lines[at]` — bracket-depth aware,
 *  `//` line-comments stripped, so a commented token or suffix-collision (`superuser,` vs `user`) never counts. */
function arrayElements(
  lines: readonly string[],
  at: number,
  anchor: string,
): string[] {
  const openLine = lines[at]!;
  const openIdx = openLine.indexOf("[", openLine.indexOf(anchor));
  if (openIdx === -1) return []; // no `[` on the anchor line — nothing to compare (the splice path handles it)
  let depth = 0;
  let inner = "";
  let done = false;
  for (let i = at; i < lines.length && !done; i++) {
    const code = lines[i]!.replace(/\/\/.*$/, ""); // drop a trailing line comment before counting brackets/elements
    for (let c = i === at ? openIdx : 0; c < code.length; c++) {
      const ch = code[c]!;
      if (ch === "[") {
        depth++;
        if (depth === 1) continue;
      } // skip the outer opener bracket itself
      else if (ch === "]") {
        depth--;
        if (depth === 0) {
          done = true;
          break;
        }
      } // matched close — array end
      if (depth >= 1) inner += ch;
    }
    inner += " "; // separate tokens split across element lines
  }
  return inner.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
}

/** Apply a `RegistrationEdit` to a file's content, idempotent by exact line/element match (never substring).
 *  An absent anchor throws `RegistrationAnchorError` — fail-closed, never a dangling append. */
export function applyRegistration(
  current: string,
  edit: RegistrationEdit,
): string {
  const lines = current.split("\n");
  for (const ins of edit.inserts) {
    // anchor to the last line whose trimmed content starts with the anchor (an import statement / the array
    // opener), never a comment/string that merely contains it — so the splice never lands mid-comment.
    let at = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.trimStart().startsWith(ins.anchor)) at = i;
    }
    if (at === -1) {
      throw new RegistrationAnchorError(edit.file, ins.anchor, ins.insert); // no anchor — refuse, never append
    }
    if (ins.mode === "line") {
      // idempotent by full line, never substring: re-running `hazelnut add` for the same name is a no-op, but
      // a different import that merely contains this one as a substring (or a comment) is not a false "present".
      if (lines.some((l) => l.trim() === ins.insert.trim())) continue;
      lines.splice(at + 1, 0, ins.insert);
      continue;
    }
    // idempotent by exact element: only an element already inside this array's `[ … ]` skips — a suffix-collision
    // element (`superuser,`) or a comment token (`// owns: user, post`) no longer false-skips it.
    const token = ins.insert.trim().replace(/,+$/, "");
    if (arrayElements(lines, at, ins.anchor).includes(token)) continue;

    // array mode: if the matching `]` is also on `lines[at]` (a one-line array, empty or `[a]`), rewrite it
    // multi-line so the element lands unambiguously inside the brackets; else push it after the opener.
    const line = lines[at]!;
    const baseIndent = line.match(/^\s*/)?.[0] ?? "";
    const elem = `${baseIndent}  ${ins.insert.trim()}`;
    const openIdx = line.indexOf("[", line.indexOf(ins.anchor));
    const closeIdx = openIdx === -1 ? -1 : line.indexOf("]", openIdx);
    if (closeIdx !== -1) {
      const inner = line.slice(openIdx + 1, closeIdx).trim();
      const body = inner === ""
        ? [elem]
        : [`${baseIndent}  ${inner}${inner.endsWith(",") ? "" : ","}`, elem];
      lines.splice(
        at,
        1,
        line.slice(0, openIdx + 1),
        ...body,
        `${baseIndent}${line.slice(closeIdx)}`,
      );
    } else {
      lines.splice(at + 1, 0, elem);
    }
  }
  return lines.join("\n");
}

/** `hazelnut add module <name>` — emit a `defineModule` skeleton + register it in `hazelnut.config.ts`. */
export function nutModule(name: string): NutPlan {
  const err = nutSegmentErr(name, "module");
  if (err) throw new Error(err);
  const file = `src/modules/${name}/${name}.module.ts`;
  return {
    emit: {
      [file]: `import { type Ctx, defineModule } from "hazelnut";

export const ${name} = defineModule({
  name: "${name}",
  resources: [],
  exposes: [],
  deps: [],
});

/** The module-typed op ctx: ops \`import type { ${
        pascal(name)
      }Ctx }\` from here —
 *  every \`ctx.data.<r>.*\` call in a handler is face-checked against this module's declarations. */
export type ${pascal(name)}Ctx = Ctx<typeof ${name}>;
`,
    },
    // hazelnut add module registers the module in the config's modules array (cli/add.md §auto-wiring):
    // the import at the top + the push into `modules: [ … ]`.
    registration: {
      file: "hazelnut.config.ts",
      inserts: [
        {
          anchor: "import ",
          insert: `import { ${name} } from "./${file}";`,
          mode: "line",
        },
        { anchor: "modules: [", insert: `${name},`, mode: "array" },
      ],
    },
  };
}

/** The features `hazelnut add resource --features a,b` understands (the DSL boolean feature flags). */
const NUT_FEATURES = new Set([
  "timestamps",
  "softDelete",
  "audit",
  "scope",
  "versioning",
  "sequence",
]);

/** `hazelnut add resource <module>/<name> [--features …] [--ops …]` emits the resource skeleton + registers
 *  it; `--ops X` atomically emits the `defineOp({})` hint, `logic/<r>/X.ts`, and a born-RED test stub. */
export function nutResource(
  ref: string,
  opts: {
    features?: ReadonlyArray<string>;
    ops?: ReadonlyArray<string>;
    /** The scaffolded resource's real-PG floor labels (verify/obligation.ts `REAL_PG_SET` ∩ the declared
     * features), computed by the caller (the verify module loads lazily there — a passes []).
     *  Non-empty ⇒ each `--ops` test stub carries the `test:pg` harness recipe instead of the testCtx one. */
    realPgLabels?: ReadonlyArray<string>;
  } = {},
): NutPlan {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    throw new Error(
      `usage: hazelnut add resource <module>/<name> (got '${ref}')`,
    );
  }
  const module = ref.slice(0, slash);
  const name = ref.slice(slash + 1);
  for (const [seg, what] of [[module, "module"], [name, "resource"]] as const) {
    const e = nutSegmentErr(seg, what);
    if (e) throw new Error(e);
  }
  const features = opts.features ?? [];
  for (const f of features) {
    if (!NUT_FEATURES.has(f)) {
      throw new Error(
        `unknown feature '${f}' — one of ${[...NUT_FEATURES].join(", ")}`,
      );
    }
  }
  const ops = opts.ops ?? [];
  for (const op of ops) {
    const e = nutSegmentErr(op, "op");
    if (e) throw new Error(e);
  }

  // timestamps is the documented default skeleton feature; merge with --features (deduped, declared order).
  const featureFlags = [...new Set(["timestamps", ...features])];
  // The concurrency posture is REQUIRED (`versioning/decision-written`), so the skeleton states one rather
  // than emitting a resource that refuses its own first boot. `--features versioning` supersedes it.
  const featuresBlock = `{ ${
    [
      ...featureFlags.map((f) => `${f}: true`),
      ...(featureFlags.includes("versioning") ? [] : ["versioning: false"]),
    ].join(", ")
  } }`;

  // Each op is authored whole (contract + policy + handler, the typed `OpDecl` posture rundown §6 teaches)
  // in logic/<r>/<op>.ts and referenced here by name — one op-authoring posture, never an untyped twin.
  const opHandlerImports = ops.map((op) =>
    `import { ${op} } from "./logic/${name}/${op}.ts";`
  ).join("\n");
  const opsBlock = ops.length === 0
    ? "  // transitions / owns / relates / operations / policy — add as needed"
    : `  operations: {\n${ops.map((op) => `    ${op},`).join("\n")}\n  },`;
  // `Actor`/`none` are the FRAGMENT form's vocabulary; the emitted rowPolicy is the shorthand, which needs
  // neither. An op's own handler imports what it needs from its own file.
  const frameworkImport = `import { defineResource } from "hazelnut";`;
  const resourceHeader = ops.length === 0
    ? `${frameworkImport}\nimport { z } from "zod";`
    : `${frameworkImport}\nimport { z } from "zod";\n${opHandlerImports}`;

  const dir = `src/modules/${module}`;
  const emit: Record<string, string> = {
    [`${dir}/${name}.resource.ts`]: `${resourceHeader}

export const ${name} = defineResource({
  name: "${name}",
  schema: z.object({
    title: z.string(),
    status: z.enum(["draft", "published"]).default("draft"),
    owner_id: z.string(), // who the row belongs to — the column the row rule narrows on
  }),
  features: ${featuresBlock},
  // WHICH ROWS, per caller — the ownership shorthand: \`<column> = <the caller's id>\`, and the ANONYMOUS
  // caller (who arrives as a NON-NULL actor holding no claim) is denied outright, by construction. Swap
  // \`owner_id\` for the column that carries ownership; anything beyond ownership takes the fragment form
  // (\`none\`/\`owned\`/\`shared\` from "hazelnut/query"), where that denial must be written with \`isAnonymous\`.
  rowPolicy: "owner_id",
  // Nothing is on the wire yet. UNCOMMENT to expose — the rowPolicy above and ${name}.rowpolicy.spec.ts are
  // already written, so the guarded form costs this one line. \`"public"\` serves every row to every caller,
  // agent and crawler alike; write it only for a surface you deliberately publish.
  // http: { list: { policy: "policy", columns: ["id", "title", "owner_id"] }, find: { policy: "policy", columns: ["id", "title", "owner_id"] }, create: "policy" },
${opsBlock}
});
`,
    // The rowPolicy's independent spec sibling: "who SHOULD see the row", stated without importing the impl,
    // so the two are differentialled. It sits at the app root — the path the spec rung resolves.
    [`${name}.rowpolicy.spec.ts`]: `import { type Actor } from "hazelnut";
import { isAnonymous } from "hazelnut/authz/auth.ts";

/**
 * Row-visibility SPEC for \`${name}\` — "who SHOULD see this row", in plain business terms, stated
 * INDEPENDENTLY of the resource's rowPolicy impl (never importing it). Any row the rowPolicy admits that
 * this spec forbids, or the other way round, is a caught leak rather than a silent one.
 *
 * The starter rule: a caller may see a ${name} row they OWN, and no other. Narrow BOTH halves together.
 * \`isAnonymous\`, never \`actor !== null\`: an unauthenticated request reaches here as a NON-NULL actor whose
 * id is the literal "anonymous", so a null test admits it and every row owned by "anonymous" goes on the wire.
 */
export const spec = (
  actor: Actor | null,
  row: { owner_id: string },
): boolean => !isAnonymous(actor) && row.owner_id === actor?.id;
`,
  };

  // --ops emits three per-op limbs atomically: the op entry (above), the whole typed op, and a born-RED test stub.
  for (const op of ops) {
    // A missing handler is a boot-fatal `wiring/op-has-handler` violation; logic returns a `Result`, never
    // throws. `OpDecl<In,Out>` states the contract once, so a resource-name/field typo is a compile error.
    emit[`${dir}/logic/${name}/${op}.ts`] =
      `import { defineOp, err, type OpDecl, type Result, requires } from "hazelnut";
import { z } from "zod";
// The module-typed op ctx — a type-only import, erased at runtime, so no module cycle; every
// \`ctx.data.<r>.*\` call is checked against the faces derived from the module declaration.
import type { ${pascal(module)}Ctx } from "../../${module}.module.ts";

const ${op}Input = z.object({});

// The '${op}' op, whole: contract + policy + handler. logic/ is pure — obtain everything through ctx and
// return a Result, never throw. The \`OpDecl<In, Out>\` annotation terminates the module-type recursion
// (the lint/op-decl-annotated rule) — its input half derives from ${op}Input, never a hand-written twin.
export const ${op}: OpDecl<z.output<typeof ${op}Input>, unknown> = defineOp({
  input: ${op}Input,
  policy: requires("${name}:${op}"),
  tx: "write",
  // a write op must state its retry verdict; flip to true once a retried Idempotency-Key must replay
  // this op's result instead of re-running it.
  idempotent: false,
  handler: (_input, _ctx: ${pascal(module)}Ctx): Promise<Result<unknown>> =>
    Promise.resolve(err("internal", "hazelnut: unimplemented op '${op}'")),
});

// the default-export-at-path binding (wiring/no-orphan-logic): logic/<resource>/<op>.ts IS the op's home
export default ${op};
`;
    // Born RED: an unfilled op-test must fail loudly, not pass silently (cli/add.md §verify-green-is-not-test-
    // green). The body carries the paved op-test recipe the author fills in — the plain testCtx shape, or
    // the `test:pg` harness when the resource declares a real-PG floor (fidelity-derived, 06-generators.md
    // §scaffold: PGlite false-greens concurrency / unique races / NULL semantics on those surfaces).
    const pgLabels = opts.realPgLabels ?? [];
    emit[`${dir}/logic/${name}/${op}.test.ts`] = pgLabels.length === 0
      ? `import { assert } from "@std/assert";
import { ${op} } from "./${op}.ts";

Deno.test("${module}.${name}.${op} — prove the behavior", () => {
  // hazelnut: born RED — replace this stub with a real assertion over \`${op}\` before shipping (wiring/op-untested).
  // Drive ${op} through the FULL pipeline the paved way (no off-barrel 9-arg runOp / opSurfaceFactory) — make the
  // test \`async\` and:
  //
  //   import { createApp, userActor } from "hazelnut";
  //   import { testCtx } from "hazelnut/test.ts";
  //   import { ${module} } from "../../${module}.module.ts";
  //   const t = await testCtx({ app: createApp({ modules: [${module}] }), module: "${module}" });
  //   const r = await t.runOp(${op}, {/* input */}, { actor: userActor("u", ["${name}:${op}"]) });
  //   assert(r.ok); // then assert ${op}'s residual — run: hazelnut explain ${name}.${op}
  //   // real DB semantics (concurrency / unique / NULL)? inject a live pg: testCtx({ app, module, db: postgresDb(sql) })
  //
  void ${op};
  assert(false, "hazelnut: unimplemented op-test");
});
`
      : `import { assert } from "@std/assert";
import { ${op} } from "./${op}.ts";

Deno.test("${module}.${name}.${op} — prove the behavior on REAL PG (floor: ${
        pgLabels.join(", ")
      })", () => {
  // hazelnut: born RED — replace this stub with a real assertion over \`${op}\` before shipping (wiring/op-untested).
  // This resource declares a real-PG floor (${
        pgLabels.join(", ")
      }): PGlite false-greens concurrency, unique
  // races, and NULL semantics there, so drive ${op} against LIVE Postgres (the \`deno task test:pg\` lane) —
  // make the test \`async\` and:
  //
  //   import { createApp, postgresDb, userActor } from "hazelnut";
  //   import { testCtx } from "hazelnut/test.ts";
  //   import postgres from "postgres";
  //   import { ${module} } from "../../${module}.module.ts";
  //   const url = Deno.env.get("DATABASE_URL"); // test:pg supplies it; absent ⇒ skip VISIBLY, never silent-green
  //   if (!url) { console.warn("${module}.${name}.${op} op-test DORMANT: no DATABASE_URL (run deno task test:pg)"); return; }
  //   const sql = postgres(url, { onnotice: () => {} });
  //   const t = await testCtx({ app: createApp({ modules: [${module}] }), module: "${module}", db: postgresDb(sql) });
  //   const r = await t.runOp(${op}, {/* input */}, { actor: userActor("u", ["${name}:${op}"]) });
  //   assert(r.ok); // then assert the FLOOR faces: a 2-connection interleaving for the locking face,
  //   // a duplicate write for unique, an explicit-null write for NULL semantics — hazelnut explain --obligations ${name}
  //
  void ${op};
  assert(false, "hazelnut: unimplemented op-test");
});
`;
  }

  return {
    emit,
    // register the resource in the module file: the import at the top + the push into `resources: [ … ]`
    // (import + push, cli/add.md §auto-wiring) — this is what makes the emit born verify-green.
    registration: {
      file: `${dir}/${module}.module.ts`,
      inserts: [
        {
          anchor: "import ",
          insert: `import { ${name} } from "./${name}.resource.ts";`,
          mode: "line",
        },
        { anchor: "resources: [", insert: `${name},`, mode: "array" },
      ],
    },
  };
}

// ── `hazelnut mcp <stdio|gateway>` — the transport entry emitters (12-mcp.md §transport) ─────────────────

/** The command that RUNS an emitted transport entry. A transport is a production process, so it goes through
 *  the same least-privilege door the app's own `start` does: `launch` derives the grants from the
 *  declarations, and `--entry` moves both the env scan and the listen socket onto this entry. */
export function mcpLaunchCommand(entry: string): string {
  return `hazelnut launch ./app.ts --entry ${entry}`;
}

/** The write-once stdio-transport entry (`mcp-stdio.ts`): the FULL app boot (db seam and all — the stdio
 *  server IS the app process, spoken over stdin/stdout) driving the same served /mcp door. */
export function nutMcpStdio(): Pick<NutPlan, "emit"> {
  const entry = "mcp-stdio.ts";
  return {
    emit: {
      [entry]:
        `// stdio MCP transport — local agents (Claude Code) spawn this command; credentials ride
// the HAZELNUT_MCP_TOKEN env var into the app's ordinary auth seam. Same app, same /mcp door, no HTTP port.
// Point your MCP host at: ${mcpLaunchCommand(entry)}
import { applySchema, createApp, pgliteDb, postgresDb } from "hazelnut";
import { runMcpStdio } from "hazelnut/runtime/mcp-stdio.ts";
import { PGlite } from "@electric-sql/pglite";
import postgres from "postgres";
import { config } from "./hazelnut.config.ts";

// The embedded PGlite substrate is PROVEN by HAZELNUT_DEV, never inferred from an absence a deployment
// can drop. The refusal goes to stderr — stdout is the MCP channel and a stray line corrupts the stream.
const url = Deno.env.get("DATABASE_URL");
if (!url && Deno.env.get("HAZELNUT_DEV") !== "1") {
  console.error(
    "refusing to serve: DATABASE_URL is unset. Set DATABASE_URL to serve against Postgres, or set HAZELNUT_DEV=1 to boot the throwaway embedded PGlite (development only — every write is lost on exit).",
  );
  Deno.exit(1);
}
const db = url ? postgresDb(postgres(url)) : pgliteDb(new PGlite());
const app = createApp(config, { db, relay: "in-process", scheduler: "in-process" });
if (!url) await applySchema(db, app);

await runMcpStdio(app); // loops until the host closes stdin
app.stopInProcessRelay?.();
Deno.exit(0);
`,
    },
  };
}

/** The write-once gateway entry (`gateway.ts`): CREDENTIAL-FREE — it composes the PURE declaration for the
 *  tool catalog (no db, no keys) and forwards validated /mcp traffic to APP_URL over one narrow channel. */
export function nutMcpGateway(): Pick<NutPlan, "emit"> {
  const entry = "gateway.ts";
  return {
    emit: {
      [entry]:
        `// hardened MCP gateway — a separate credential-free deployable terminating agent traffic
// (12-mcp §transport). Deploy it in the agent-facing network; keep the app's port internal. Same image,
// different command: ${mcpLaunchCommand(entry)}
import { createApp } from "hazelnut";
import { mcpGatewayRouter } from "hazelnut/runtime/mcp-gateway.ts";
import { config } from "./hazelnut.config.ts";

const appUrl = Deno.env.get("APP_URL");
if (!appUrl) {
  console.error("gateway: APP_URL is required (the app's internal base URL, e.g. http://app:${DEFAULT_SERVE_PORT})");
  Deno.exit(2);
}
// PURE composition — no db/boot arg: the gateway derives the tool catalog and holds zero credentials.
const app = createApp(config);
Deno.serve(
  { port: Number(Deno.env.get("PORT") ?? "${MCP_GATEWAY_PORT}") },
  mcpGatewayRouter({ app, appUrl }).fetch, // origin allowlist rides app.mcpAllowedOrigins
);
`,
    },
  };
}
