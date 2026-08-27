// hazelnut scaffold command group: new, add, steer, explain, migrate --safe-ddl.
import { fileURLToPath } from "node:url";
import type { App, ResourceModel } from "../core/app.ts";
import { EXPLAIN_SERVICEABLE_FLAGS } from "../core/contract.ts";
import { postgresDb } from "../data/db.ts";
import {
  applyRegistration,
  childFailureReason,
  frameworkTreeModule,
  isModuleSpecifier,
  mcpInvokeCommand,
  mcpLaunchCommand,
  nutMcpGateway,
  nutMcpStdio,
  nutModule,
  type NutPlan,
  nutResource,
  pinRefusal,
  registryPinFromModuleUrl,
  scaffoldFiles,
  scaffoldInitPlan,
  verifyModuleFlagRefusal,
  wireDeepImports,
  writeNutEmit,
} from "./cli.ts";
import { flagValue } from "./flag-roster.ts";
import { NutCollisionError } from "./scaffold-nut.ts";
import {
  explainError,
  importAppModule,
  moduleSpec,
  parseEnvFile,
  readSourceTree,
  vendorFrameworkTree,
} from "./hazelnut-io.ts";
import {
  classifyMigrateTarget,
  explainOnTarget,
  predictReservedActs,
} from "../authz/trust.ts";

import type { BuildModule } from "./dispatch.ts";

/** The value-taking flags in `new`'s tail — their next token is a value, not a stray name. Both spellings
 *  exist (`--pin X` and `--pin=X`); only the separated form consumes a following token. */
const NEW_VALUED_FLAGS = new Set(["--local", "--vendor", "--pin"]);

/** The first tail argument that is neither a flag nor a valued flag's value — a second app name the shell
 *  split off. `new` refuses it rather than scaffolding the first word and dropping the rest. */
function strayPositional(rest: readonly string[]): string | undefined {
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("-")) return a;
    if (NEW_VALUED_FLAGS.has(a)) i++; // skip its value
  }
  return undefined;
}

export async function dispatchScaffold(
  cmd: string,
  modPath: string,
  rest: string[],
  /** Which build this is — REQUIRED, and stated by the entrypoint. A core build scaffolds a core app on
   *  every pin door; the filesystem probe below only answers "which module set is the tree you POINTED AT". */
  buildModule: BuildModule,
): Promise<void> {
  if (cmd === "mcp") {
    // `hazelnut mcp <stdio|gateway>` — emit the write-once transport entry (12-mcp.md §transport); the
    // collision refuse is writeNutEmit's (emit-then-forget, `add`-style: declares, never overwrites).
    const which = modPath;
    if (which !== "stdio" && which !== "gateway") {
      console.error("usage: hazelnut mcp <stdio|gateway>");
      Deno.exit(2);
    }
    const cliEntry = buildModule === "core" ? "hazelnut-core" : "hazelnut";
    const file = which === "stdio" ? "mcp-stdio.ts" : "gateway.ts";
    let run = mcpLaunchCommand(file);
    const registryPin = registryPinFromModuleUrl(import.meta.url);
    if (registryPin !== null) {
      run = mcpInvokeCommand(file, registryPin, cliEntry, true);
    } else {
      try {
        const root = Deno.realPathSync(
          fileURLToPath(new URL("../..", import.meta.url)),
        );
        run = mcpInvokeCommand(
          file,
          `file://${root.replaceAll("\\", "/")}/src`,
          cliEntry,
          false,
        );
      } catch {
        // compiled binary / embedded VFS — PATH form is the honest fallback
      }
    }
    const plan = which === "stdio" ? nutMcpStdio(run) : nutMcpGateway(run);
    // WIRE FIRST. The emitted entry imports a DEEP path, and a registry pin resolves one only through an
    // EXACT import-map key — leaving that key to the reader made a PATCH ask an app to edit its own
    // deno.json. Wiring AFTER the emit put it behind the overwrite refusal, so the one population the
    // wiring exists for — an app that already ran this verb — could never reach it. The keys are the same
    // whether or not a file gets written, so they are written first and unconditionally.
    const wired = await wireDeepImports(plan.emit);
    for (const k of wired) console.log(`  wired: imports["${k}"]`);
    try {
      await writeNutEmit(plan.emit);
    } catch (e) {
      // An entry that already exists is not a failure: the verb's outcome — a working transport entry
      // with a resolvable import — is what the caller asked for, and it now holds.
      if (e instanceof NutCollisionError) {
        console.log(
          `✓ mcp ${which}: ${file} already present${
            wired.length > 0 ? " — its import key is now wired" : ""
          }`,
        );
        Deno.exit(0);
      }
      console.error(explainError(e));
      Deno.exit(2);
    }
    console.log(
      which === "stdio"
        ? `✓ mcp stdio: ${file} — point your MCP host at \`${run}\` (credentials: HAZELNUT_MCP_TOKEN env)`
        : `✓ mcp gateway: ${file} — run \`APP_URL=<internal-app-url> ${run}\` in the agent-facing network`,
    );
    Deno.exit(0);
  }
  if (cmd === "doctor") {
    // environment checkup (cli/doctor.md): real probes assembled here, checks stay pure/testable.
    const { lockStateFromPorcelain, renderDoctor, runDoctorChecks } =
      await import(
        "./doctor.ts"
      );
    const read = (f: string): string | null => {
      try {
        return Deno.readTextFileSync(f);
      } catch {
        return null;
      }
    };
    const exists = (f: string): boolean => {
      try {
        Deno.lstatSync(f);
        return true;
      } catch {
        return false;
      }
    };
    let lockTracked: import("./doctor.ts").LockState;
    try {
      // `--untracked-files=all --ignored=matching` so the three ways a lock is NOT committed each answer
      // separately: `??` untracked, `!!` gitignored, any other code tracked-but-changed. The old probe
      // (`ls-files --error-unmatch`) read the index entry, which a delete and a rewrite both survive.
      const git = new Deno.Command("git", {
        args: [
          "status",
          "--porcelain",
          "--untracked-files=all",
          "--ignored=matching",
          "--",
          "deno.lock",
        ],
        stdout: "piped",
        stderr: "null",
      }).outputSync();
      lockTracked = lockStateFromPorcelain(
        git.code,
        new TextDecoder().decode(git.stdout),
      );
    } catch (e) {
      // A denied spawn is NOT "no repo": collapsing the two reported every consumer's lock as fine,
      // because the emitted task's own least-privilege grant excludes git.
      lockTracked = e instanceof Deno.errors.NotCapable ? "denied" : "no-git";
    }
    const url = Deno.env.get("DATABASE_URL");
    let pg:
      | { serverVersion: string; hasVector: boolean }
      | { error: string }
      | null = null;
    if (url) {
      try {
        const { default: postgres } = await import("postgres");
        const sql = postgres(url, { max: 1, connect_timeout: 5 });
        try {
          const [{ server_version }] =
            await sql`show server_version` as unknown as [
              { server_version: string },
            ];
          const vec =
            await sql`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`;
          pg = { serverVersion: server_version, hasVector: vec.length > 0 };
        } finally {
          await sql.end({ timeout: 2 });
        }
      } catch (e) {
        pg = { error: explainError(e) };
      }
    }
    const { lines, exit } = renderDoctor(runDoctorChecks({
      denoVersion: Deno.version.deno,
      pathEnv: Deno.env.get("PATH") ?? "",
      denoJson: read("deno.json"),
      lockExists: exists("deno.lock"),
      lockTracked,
      databaseUrl: url,
      pg,
    }, exists));
    for (const l of lines) console.log(l);
    Deno.exit(exit);
  }
  if (cmd === "new") {
    if (!modPath) {
      console.error(
        "usage: hazelnut new <app-name> [--example] [--no-git] [--rules=<profile>] [--steer=full|index] [--core] [--local <framework-repo-path> | --vendor <framework-repo-path> | --pin <registry-specifier>]",
      );
      Deno.exit(2);
    }
    // `new` is the ONE verb whose positional is a NAME, not a path, so `moduleSpec`'s leading-dash guard never
    // sees it: `hazelnut new --help` created a directory called `--help` and exited 0. A flag in the name slot
    // is a missing argument, and `..` in a name would write the project outside the directory you ran from.
    if (modPath.startsWith("-")) {
      console.error(
        `hazelnut new: '${modPath}' is a flag, not an app name.\n\n` +
          `  The name comes FIRST: \`hazelnut new <app-name> [flags]\`.\n` +
          `  For the verb list, run \`hazelnut help\`.`,
      );
      Deno.exit(2);
    }
    // On Windows the user (and Deno.makeTempDir) hand us `\` separators, so the segment split and the
    // `..` scan must read both; on POSIX `\` stays a plain (charset-refused) character.
    const segs = modPath.split(Deno.build.os === "windows" ? /[\\/]/ : "/");
    if (segs.includes("..")) {
      console.error(
        `hazelnut new: '${modPath}' escapes the current directory.\n\n` +
          `  Pass a name (\`my-app\`) or a path under it (\`apps/api\`), then cd to where you want it.`,
      );
      Deno.exit(2);
    }
    // The name becomes a DIRECTORY and a `cd` in the next-step line this command prints. A space or a shell
    // metacharacter in it makes that printed instruction unpastable, so the charset is checked per segment.
    // A LEADING empty segment is the absolute form (`/tmp/app`), which this verb has always accepted; the
    // drive-absolute form (`C:\apps\api`) is the same exemption. An empty segment anywhere else is a `//`.
    const badSeg = segs
      .filter((seg, i) =>
        !(i === 0 &&
          ((seg === "" && modPath.startsWith("/")) || /^[A-Za-z]:$/.test(seg)))
      )
      .find((seg) =>
        seg === "" || seg === "." || !/^[A-Za-z0-9._-]+$/.test(seg)
      );
    if (badSeg !== undefined) {
      console.error(
        `hazelnut new: '${modPath}' is not a usable app name.\n\n` +
          `  A name segment is letters, digits, '.', '_' and '-' — no spaces, no shell metacharacters.\n` +
          `  The name becomes a directory and a \`cd\` in the next step printed here.\n` +
          `  Try \`my-app\`, or a path under this one like \`apps/api\`.`,
      );
      Deno.exit(2);
    }
    // A second positional is a name the shell split, never a flag: `hazelnut new My App` scaffolded `My/`
    // and dropped `App` on the floor. Silently discarding an argument is worse than refusing it.
    const stray = strayPositional(rest);
    if (stray !== undefined) {
      console.error(
        `hazelnut new: unexpected argument '${stray}' after the app name '${modPath}'.\n\n` +
          `  \`new\` takes exactly ONE name. If the name was meant to contain a space, it cannot —\n` +
          `  join it with '-' instead (\`${modPath}-${stray}\`).`,
      );
      Deno.exit(2);
    }
    // The module is read BEFORE the pin doors: each door's probe is module-aware, because a public core
    // checkout has no `src/mod.ts` and must still be pinnable (scaffold.ts §frameworkTreeModule).
    const wantCore = rest.includes("--core");
    // Whether this run emits a core app, as far as the BUILD and the flags can say — known before any door
    // is probed. A core build never wants a full app, so it must never be refused for asking for one.
    const coreScaffold = buildModule === "core" || wantCore;
    /** Probe one pin door and exit(2) with its own message when the checkout cannot serve this module. */
    const resolvePinRoot = (arg: string, door: string): string => {
      let root: string;
      try {
        root = Deno.realPathSync(arg);
      } catch {
        console.error(
          `hazelnut new ${door}: '${arg}' does not exist — pass the framework REPO ROOT`,
        );
        Deno.exit(2);
      }
      const refusal = pinRefusal(
        frameworkTreeModule((rel) => {
          try {
            Deno.statSync(`${root}/${rel}`);
            return true;
          } catch {
            return false;
          }
        }),
        coreScaffold,
        arg,
        door,
      );
      if (refusal !== null) {
        console.error(refusal);
        Deno.exit(2);
      }
      return root;
    };
    // `--local <path>` pins the framework at an explicit checkout (overriding the auto-derived one).
    // `<path>` is the framework repo root, resolved to a `file://…/src` URL and validated — bad path = loud exit.
    const local = flagValue(rest, "--local");
    if (local.present && "error" in local) {
      console.error(`hazelnut new: ${local.error}`);
      Deno.exit(2);
    }
    let localPin: string | undefined;
    if (local.present && "value" in local) {
      const root = resolvePinRoot(local.value, "--local");
      localPin = `file://${root}/src`; // e.g. file:///Users/.../hazelnut/src — a Deno-resolvable import base
    }
    // `--vendor <path>` copies the framework `src/` into `.hazelnut/modules/` and pins it relatively —
    // unlike `--local`'s machine-absolute pin, a vendored app is self-contained and portable.
    const vendor = flagValue(rest, "--vendor");
    if (vendor.present && "error" in vendor) {
      console.error(`hazelnut new: ${vendor.error}`);
      Deno.exit(2);
    }
    let vendorRoot: string | undefined;
    if (vendor.present && "value" in vendor) {
      vendorRoot = resolvePinRoot(vendor.value, "--vendor");
      if (localPin) {
        console.error(
          "hazelnut new: --vendor and --local are mutually exclusive (vendor COPIES the src in; local POINTS at it)",
        );
        Deno.exit(2);
      }
    }
    // `--pin <specifier>` — the binary-mode door: `imports.hazelnut` gets the specifier verbatim, CLI
    // tasks call this binary by name, and no ambient lint plugin is emitted (the verify verbs run the
    // same rules). The public core release names the official registry value.
    const pin = flagValue(rest, "--pin");
    if (pin.present && "error" in pin) {
      console.error(`hazelnut new: ${pin.error}`);
      Deno.exit(2);
    }
    let binaryPin = pin.present && "value" in pin ? pin.value : undefined;
    if (binaryPin !== undefined && (localPin || vendorRoot)) {
      console.error(
        "hazelnut new: --pin is mutually exclusive with --local/--vendor (pin NAMES a published specifier; local/vendor point at source)",
      );
      Deno.exit(2);
    }
    // No pin flag → derive the checkout the CLI itself runs from (src/cli/ → repo root). There is no
    // remote-git acquisition path — a checkout IS the acquisition path until the registry lands, so
    // `hazelnut new <app>` from one needs no flag at all. A compiled binary has no on-disk src tree —
    // refuse loudly and name the three doors.
    // The DERIVED door differs from the explicit ones on purpose: here the user named no tree, so the module
    // is a property of the install rather than a claim they made. A core-only checkout (the public core
    // artifact) therefore DERIVES a core app and says so — where `--local <core-tree>` without `--core`
    // refuses, because there the user did name a tree and a full app was the claim.
    let derivedCore = false;
    if (!localPin && !vendorRoot && binaryPin === undefined) {
      // The resolution itself must not throw. When this CLI runs from the REGISTRY its own module URL is
      // `https://…`, and `fileURLToPath` rejects a non-file scheme — so an unguarded call crashes with a
      // stack trace on the very first command a published consumer types. Any failure to locate a checkout
      // is the same answer: there is none, say so actionably.
      let root: string | null = null;
      try {
        root = Deno.realPathSync(
          fileURLToPath(new URL("../..", import.meta.url)),
        );
      } catch {
        root = null; // not running from a file:// tree (registry / compiled binary / embedded VFS)
      }
      const treeModule = root === null ? null : frameworkTreeModule((rel) => {
        try {
          Deno.statSync(`${root}/${rel}`);
          return true;
        } catch {
          return false;
        }
      });
      if (treeModule === null) {
        // No tree beside us — but a CLI running FROM THE REGISTRY still knows what it is: derive the pin
        // from its own module URL, the same "pin where I run from" rule the checkout door follows. Without
        // this the published package's first command would demand `--pin <the thing you just ran>`.
        const registryPin = registryPinFromModuleUrl(import.meta.url);
        if (registryPin !== null) {
          binaryPin = registryPin;
          console.log(
            `hazelnut new: pinning ${registryPin} (derived from this CLI's own package).`,
          );
        } else {
          console.error(
            "hazelnut new: no framework checkout found (the CLI is not running from one) — pass --local <framework-repo-path>, --vendor <framework-repo-path>, or --pin <registry-specifier>",
          );
          Deno.exit(2);
        }
      }
      if (treeModule !== null) {
        localPin = `file://${root}/src`;
        derivedCore = treeModule === "core";
      }
      if (derivedCore && !wantCore) {
        console.log(
          "hazelnut new: this checkout is the CORE module — scaffolding a core app (no verify envelope).",
        );
      }
    }
    // `--core` emits a core app — pins the `mod-core.ts` barrel + `hazelnut-core.ts` CLI, drops the
    // ambient lint plugin. Orthogonal to --local/--vendor. A CORE build always emits a core app — that
    // is a fact about this binary, not about what is on disk. `--core` and the pointed-at tree's module
    // set can only ADD to it, never override it back to full.
    const emitCore = coreScaffold || derivedCore;
    // A flag this module cannot act on is refused BY NAME rather than accepted and dropped. Every refusal
    // below runs before the target directory exists, so a rejected invocation leaves nothing on disk.
    const moduleRefusal = verifyModuleFlagRefusal(emitCore, rest);
    if (moduleRefusal !== null) {
      console.error(moduleRefusal);
      Deno.exit(2);
    }
    // Empty by default (cli/new.md §design-decisions); `--example` seeds a `widget` declaration.
    const rulesArg = rest.find((a) =>
      a.startsWith("--rules=")
    )?.slice("--rules=".length) ?? "recommended";
    // The registry that validates a profile NAME is verify-module, so it must never be a STATIC edge from this
    // core dispatcher: LAZY with a DECLARED shape, inside the branch that can act on the answer. The core
    // core does not arrive here at all — it refused the flag above rather than resolving a profile it cannot run.
    if (!emitCore) {
      const { knownProfiles } = await import("../principles/principles.ts") as {
        knownProfiles: () => readonly string[];
      };
      if (!knownProfiles().includes(`@hazelnut/${rulesArg}`)) {
        console.error(
          `hazelnut new: unknown --rules profile '${rulesArg}' — known: ${
            knownProfiles().map((n) => n.replace("@hazelnut/", "")).join(", ")
          }`,
        );
        Deno.exit(2);
      }
    }
    // `--steer=full|index` selects the AGENTS.md universal-steer render mode. `full` (default) loads all
    // principles full-body every session; `index` renders one-line stubs, trading always-visible bodies for a fetch.
    const steerArg = rest.find((a) =>
      a.startsWith("--steer=")
    )?.slice("--steer=".length) ?? "full";
    if (steerArg !== "full" && steerArg !== "index") {
      console.error(
        `hazelnut new: unknown --steer '${steerArg}' — one of: full, index`,
      );
      Deno.exit(2);
    }
    // The two committed projections are FULL-MODULE only, and they are loaded here rather than imported by
    // `scaffoldFiles`: that emitter is synchronous and ships in the core artifact, so its static import of
    // the projectors is what published the principle bodies. A core scaffold never reaches this line, so the
    // roster is not in the core CLI's module graph at all.
    const project = emitCore ? undefined : await (async () => {
      const { cliProjectAgents } = await import("./project-agents.ts") as {
        cliProjectAgents: (
          app: App,
          principles: ReadonlyArray<object>,
        ) => { content: string };
      };
      const { projectArchitectureMd } = await import(
        "./project-architecture.ts"
      ) as { projectArchitectureMd: (app: App) => string };
      // the union (universal + the app's own), never the universal roster alone: the AGENTS.md INDEX tier
      // filters `scope:"project"`, so a universal-only argument can never render a project principle.
      const { principlesForApp } = await import(
        "../principles/principles-roster.ts"
      ) as {
        principlesForApp: (a: App) => ReadonlyArray<object>;
      };
      // the render mode is stamped onto the app HERE, on the module that owns it — `steer` is not a core
      // config key, so the core-composed seed app cannot carry it in.
      return (app: App, steer?: "index") => ({
        agents: cliProjectAgents(
          { ...app, ...(steer ? { steer } : {}) },
          principlesForApp(app),
        ).content,
        architecture: projectArchitectureMd(app),
      });
    })();
    const files = scaffoldFiles(modPath, {
      example: rest.includes("--example"),
      rules: rulesArg,
      steer: steerArg,
      ...(localPin ? { local: localPin } : {}),
      ...(vendorRoot ? { vendor: true } : {}),
      ...(binaryPin !== undefined ? { binaryPin } : {}),
      ...(emitCore ? { core: true } : {}),
      ...(project ? { project } : {}),
    });
    // `add`-style all-or-nothing preflight: `new` on a directory that already holds an app must refuse
    // BEFORE the first write — the unconditional overwrite plus the first-commit below is tree destruction.
    const exists = async (p: string): Promise<boolean> => {
      try {
        await Deno.lstat(p);
        return true;
      } catch {
        return false;
      }
    };
    const colliding: string[] = [];
    for (const file of Object.keys(files)) {
      if (await exists(`${modPath}/${file}`)) colliding.push(file);
    }
    if (vendorRoot && await exists(`${modPath}/.hazelnut`)) {
      colliding.push(".hazelnut");
    }
    if (colliding.length > 0) {
      throw new NutCollisionError(colliding.join(", "), "new");
    }
    await Deno.mkdir(modPath, { recursive: true });
    for (const [file, content] of Object.entries(files)) {
      await Deno.writeTextFile(`${modPath}/${file}`, content);
    }
    // --vendor copies the shipped framework src (everything except src/tests/, the same set
    // `scripts/build-hash.ts` hashes); bare specifiers resolve via the app's import map, so no deno.json is needed.
    if (vendorRoot) {
      const copied = await vendorFrameworkTree(vendorRoot, modPath);
      console.log(
        `  vendored: copied ${copied} framework files into ${modPath}/.hazelnut/modules/ (self-contained, portable)`,
      );
    }
    console.log(
      `✓ new: scaffolded '${modPath}/' (${
        Object.keys(files).sort().join(", ")
      })`,
    );
    // cli/new.md §run-steps step 4: `deno cache` → lock, then `git init` + initial commit (skipped with
    // --no-git). Best-effort — a failed optional step never fails the scaffold (exit 0 either way).
    for (const step of scaffoldInitPlan({ noGit: rest.includes("--no-git") })) {
      try {
        // the plan names `deno` the way the printed note spells it; the SPAWN needs the concrete binary.
        // (backticked so the cli verb scan does not read this comparison as a dispatch point)
        const bin = step.cmd === `deno` ? Deno.execPath() : step.cmd;
        const { code, stderr } = await new Deno.Command(bin, {
          args: [...step.args],
          cwd: modPath,
          stdout: "null",
          stderr: "piped",
        }).output();
        if (code !== 0) {
          const why = childFailureReason(new TextDecoder().decode(stderr));
          if (step.optional) {
            console.log(
              `  note: ${
                step.failNote ??
                  `\`${step.cmd} ${step.args.join(" ")}\` exited ${code}`
              }`,
            );
            if (why) console.log(`        ${why.slice(0, 200)}`);
            continue;
          }
          console.log(
            `  note: \`${step.cmd} ${
              step.args.join(" ")
            }\` exited ${code} — left untracked; init git yourself`,
          );
          break;
        }
      } catch {
        if (step.optional) {
          console.log(
            `  note: ${step.failNote ?? `\`${step.cmd}\` not found — skipped`}`,
          );
          continue;
        }
        console.log(
          `  note: \`${step.cmd}\` not found — skipped git init (run it yourself, or pass --no-git to silence)`,
        );
        break;
      }
    }
    // A checkout pin resolves on THIS machine only, and a container build cannot reach outside its context —
    // so the `Dockerfile` written above cannot build until the pin travels with the app. `doctor` says the
    // same thing (`pin/portable`), but only if you think to run it; the scaffold that emitted the dead
    // artifact is where the reader actually is.
    if (localPin !== undefined) {
      console.log(
        `  note: this app pins the framework at a path on THIS machine, so the Dockerfile it just got cannot build yet.\n` +
          `        Re-scaffold self-contained with \`--vendor <framework-repo>\` (or run \`deno task doctor\`) before you containerise; dev is unaffected.`,
      );
    }
    // A bare PATH-binary pin has no module URL, so `lint.plugins` cannot name the floor and the emitter
    // leaves the app rung-less — which the structural gate then SHIP-BLOCKS (`lint/floor-rung-narrowed`):
    // the nine floor rules genuinely run nowhere. Said here because the scaffold is where the reader is,
    // and an app that fails its own gate on the first `deno task ci` reads as a broken framework otherwise.
    if (
      binaryPin !== undefined && localPin === undefined &&
      vendorRoot === undefined && !isModuleSpecifier(binaryPin)
    ) {
      console.log(
        `  note: '${binaryPin}' is a PATH binary, which has no module URL — so this app wires no lint plugin, and its ship gate refuses with \`lint/floor-rung-narrowed\`.\n` +
          `        Wire the floor from a resolvable source to clear it: \`"lint": { "plugins": ["jsr:@hazelnut/core@<version>/lint"] }\` in this app's deno.json.`,
      );
    }
    const envHint = "cp .env.example .env";
    console.log(
      `  next: cd ${modPath} && ${envHint}, then \`deno task add module <name>\` and \`deno task add resource <module>/<name>\``,
    );
    Deno.exit(0);
  }

  // `hazelnut add module <name>` | `hazelnut add resource <module>/<name> [--features a,b] [--ops x,y]`
  // — declares (not generates): emits an already-registered, ready-to-fill skeleton (cli/add.md).
  if (cmd === "add") {
    // `modPath` is the kind ("module" | "resource"); `rest[0]` is the name/ref; the flags follow.
    const kind = modPath;
    const arg = rest[0];
    if ((kind !== "module" && kind !== "resource") || !arg) {
      console.error(
        "usage: hazelnut add module <name> | hazelnut add resource <module>/<name> [--features a,b] [--ops x,y]",
      );
      Deno.exit(2);
    }
    // Accept both `--features a,b` (space then value, per cli/add.md) and `--features=a,b`.
    const flagVal = (flag: string): string[] => {
      const eq = rest.find((a) => a.startsWith(`${flag}=`));
      const at = rest.indexOf(flag); // -1 when the flag is absent — do not read rest[-1+1]=rest[0]
      const next = at !== -1 ? rest[at + 1] : undefined;
      const raw = eq
        ? eq.slice(flag.length + 1)
        : (next && !next.startsWith("--") ? next : undefined);
      return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
    };
    let plan: NutPlan;
    const realPgLabels = await (async () => {
      const declared = flagVal("--features");
      if (declared.length === 0) return [];
      try {
        const { REAL_PG_SET } = await import("../verify/obligation.ts");
        return declared.filter((f) =>
          (REAL_PG_SET.features as readonly string[]).includes(f)
        ).sort();
      } catch (e) {
        // ONLY the module being absent is expected (a core build ships no `verify/`), and only that degrades
        // to the plain stub. A bare `catch` here made every other failure look identical: a renamed export, a
        // throw inside the module, a typo in the specifier — each silently produced an empty label set and a
        // quietly less accurate stub, with nothing to notice. Re-throw anything that is not the absence.
        const absent = e instanceof TypeError &&
          /Module not found|Cannot find module/i.test(e.message);
        if (!absent) throw e;
        return []; // verify module absent — the plain stub still steers to a live pg in its comment
      }
    })();
    try {
      plan = kind === "module" ? nutModule(arg) : nutResource(arg, {
        features: flagVal("--features"),
        ops: flagVal("--ops"),
        realPgLabels,
      });
    } catch (e) {
      console.error(`add: ${explainError(e)}`);
      Deno.exit(2);
    }
    // Pre-flight: the declaration must have somewhere to be REGISTERED, or it reaches `createApp` from
    // nowhere. An orphan is invisible to every gate — `deno task ci` (lint, check, verify, migrate drift,
    // test) is green over it — so an absent target is a refusal BEFORE any emit, not a warning after one.
    const regFile = plan.registration.file;
    if (!(await Deno.stat(regFile).then(() => true).catch(() => false))) {
      const mod = /modules\/([^/]+)\/\1\.module\.ts$/.exec(regFile)?.[1];
      console.error(
        `add: '${regFile}' does not exist, so this declaration would be registered nowhere and reach ` +
          `\`createApp\` from nothing — every gate would pass over it.\n` +
          (mod !== undefined
            ? `  run \`hazelnut add module ${mod}\` first, then re-run this.`
            : `  create it (or re-run from the app directory) and try again.`),
      );
      Deno.exit(2);
    }
    // Emits the new files all-or-nothing — a pre-flight collision check refuses the whole set if any target
    // exists (06-generators.md §4.6), so a late collision never orphans earlier limbs. `add` declares, never overwrites.
    try {
      await writeNutEmit(plan.emit);
    } catch (e) {
      console.error(explainError(e));
      Deno.exit(2);
    }
    // Applies the registration edit in-place (idempotent). The target's existence was settled pre-flight
    // above; a target that exists with no anchor to wire against refuses loudly (exit 2) — fail-closed.
    const reg = plan.registration;
    console.log(
      `✓ add: emitted ${Object.keys(plan.emit).length} file(s) — ${
        Object.keys(plan.emit).join(", ")
      }`,
    );
    let before: string;
    try {
      before = await Deno.readTextFile(reg.file);
    } catch (e) {
      console.error(
        `  ✗ '${reg.file}' became unreadable after the emit — ${
          explainError(e)
        }`,
      );
      Deno.exit(2);
    }
    try {
      await Deno.writeTextFile(reg.file, applyRegistration(before, reg));
      console.log(`  registered in ${reg.file}`);
      // The next step DEPENDS ON THE BUILD. `verify` re-projects AGENTS.md, but a core build serves no such
      // verb and its scaffold emits no such file, so naming it there sends the reader to `Task not found`.
      console.log(
        buildModule === "core"
          ? `  next: deno task ci — type-check and test the new declaration`
          : `  next: deno task verify — it re-projects AGENTS.md for the new declaration; commit the refreshed file`,
      );
      Deno.exit(0);
    } catch (e) {
      console.error(`  ✗ ${explainError(e)}`);
      Deno.exit(2);
    }
  }

  // `hazelnut steer [<id>] [--json] [--for <feature>] [--layer <layer>]` — L0-projected steer (read-mode, no
  // app, no write; 06-generators.md §5.1). All forms exit 0; an unknown id is a loud not-found (exit 2).
  if (cmd === "steer") {
    // LAZY on purpose, all of it: `steer` is verify-module and `hazelnut-core.ts` refuses the verb before
    // dispatch, so nothing here belongs in the core artifact. Statically imported, these three modules put
    // the 20 authored principle bodies AND the 421-line AGENTS.md projector in a public core package.
    // The DECLARED roster shape: this dispatcher FORWARDS the value and reads `id` for the not-found
    // hint, nothing more — so it names that much and never the module's own record type.
    type Ps = ReadonlyArray<{ readonly id: string }>;
    const { universalPrinciples } = await import(
      "../principles/principles-roster.ts"
    ) as { universalPrinciples: Ps };
    const {
      projectAgentsMd,
      projectSteer,
      projectSteerJson,
      projectSteerResourceSlice,
      projectSteerSlice,
    } = await import("../verify/project.ts") as {
      // METHOD signatures, not function properties: parameter checking is bivariant here, so a projector
      // whose real parameter is the module's own wider roster record still matches this narrower declared
      // shape. The narrowing is the point — a core dispatcher must not carry a type edge to that record.
      projectAgentsMd(ps: Ps): string;
      projectSteer(ps: Ps, id: string): string | null;
      projectSteerJson(ps: Ps): string;
      projectSteerResourceSlice(
        ps: Ps,
        opts: {
          resource: string;
          features: string[];
          layer?: "logic" | "declaration" | "queries";
        },
      ): string;
      projectSteerSlice(
        ps: Ps,
        opts: {
          feature?: string;
          layer?: "logic" | "declaration" | "queries";
        },
      ): string;
    };
    const { featuresOfResource } = await import("./project-agents.ts") as {
      featuresOfResource: (m: ResourceModel) => string[];
    };
    const flags = [modPath, ...rest].filter((a): a is string =>
      a !== undefined
    );
    const flagAfter = (flag: string): string | undefined => {
      const at = flags.indexOf(flag);
      const next = at !== -1 ? flags[at + 1] : undefined;
      return next && !next.startsWith("--") ? next : undefined;
    };
    // `hazelnut steer --reserved` (14-trust-gradient.md §off-machine-gate) — pure prediction of which acts
    // the gradient will gate and how each routes; target keys on `--env` exactly like migrate.
    if (flags.includes("--reserved")) {
      const envName = flagAfter("--env");
      let fileEnv: Record<string, string> = {};
      try {
        fileEnv = parseEnvFile(
          await Deno.readTextFile(
            envName !== undefined ? `.env.${envName}` : ".env",
          ),
        );
      } catch { /* no file / no URL → classify from --env alone */ }
      const target = classifyMigrateTarget({
        envName,
        fileSuppliedUrl: fileEnv.DATABASE_URL !== undefined,
      });
      const acts = predictReservedActs(target, {
        hasSecondPrincipalGate: false,
      });
      if (flags.includes("--json")) {
        console.log(JSON.stringify(acts, null, 2));
        Deno.exit(0);
      }
      const label = envName ??
        (target === "prod" ? "an ambient/unset DATABASE_URL" : "default .env");
      console.log(`# reserved acts — target ${target} (${label})`);
      for (const a of acts) {
        console.log(`- ${a.act}`);
        console.log(
          `    consequence: ${a.consequence} · routing: ${a.routing} · home: ${a.home}`,
        );
      }
      Deno.exit(0);
    }
    // `--json` — the machine projection (no id, no slice): the full {id,title,body,appliesTo,verifierTag}[].
    if (flags.includes("--json")) {
      console.log(projectSteerJson(universalPrinciples));
      Deno.exit(0);
    }
    // `--for <feature>` / `--layer <layer>` — the scoped steer slice (at least one filter present).
    const feature = flagAfter("--for");
    const layerRaw = flagAfter("--layer");
    if (feature !== undefined || layerRaw !== undefined) {
      const LAYERS = ["logic", "declaration", "queries"] as const;
      if (
        layerRaw !== undefined &&
        !LAYERS.includes(layerRaw as typeof LAYERS[number])
      ) {
        console.error(
          `✗ steer: '--layer ${layerRaw}' is not a layer — one of: ${
            LAYERS.join(", ")
          }`,
        );
        Deno.exit(2);
      }
      const layer = layerRaw as typeof LAYERS[number] | undefined;
      // `--for <resource> <app>` (06-generators.md §5.1) — the model-driven resource slice: the app-path
      // positional disambiguates it from the appless `--for <X>` feature slice.
      const consumed = new Set<number>();
      flags.forEach((f, i) => {
        if (f === "--for" || f === "--layer") {
          consumed.add(i);
          consumed.add(i + 1);
        }
      });
      const appArg = flags.find((f, i) =>
        !consumed.has(i) && !f.startsWith("--")
      );
      if (feature !== undefined && appArg !== undefined) {
        const spec = moduleSpec(appArg);
        const mod = await importAppModule(spec) as { app?: App; default?: App };
        const loaded = mod.app ?? mod.default;
        if (!loaded) {
          console.error(`✗ steer: module '${appArg}' does not export 'app'`);
          Deno.exit(2);
        }
        const m = loaded.model.find((x) => x.name === feature);
        if (!m) {
          console.error(
            `✗ steer: '${feature}' is not a resource in '${appArg}' — one of: ${
              loaded.model.map((x) => x.name).sort().join(", ")
            }`,
          );
          Deno.exit(2);
        }
        console.log(
          projectSteerResourceSlice(universalPrinciples, {
            resource: feature,
            features: featuresOfResource(m),
            layer,
          }),
        );
        Deno.exit(0);
      }
      console.log(projectSteerSlice(universalPrinciples, { feature, layer }));
      Deno.exit(0);
    }
    const id = modPath; // the optional principle id (the first positional after `steer`)
    if (id === undefined) {
      console.log(projectAgentsMd(universalPrinciples));
      Deno.exit(0);
    }
    const body = projectSteer(universalPrinciples, id);
    if (body === null) {
      const ids = universalPrinciples.map((p) => p.id).sort();
      console.error(
        `✗ steer: '${id}' is not a known principle — one of: ${ids.join(", ")}`,
      );
      Deno.exit(2);
    }
    console.log(body);
    Deno.exit(0);
  }

  // `hazelnut explain` modes (09-verifier.md §15): read-mode only. `--residual`/`--obligations` re-derive
  // the model (they take the app path); every mode exits 0 (rendered) / 2 (un-composable/not-found), never 1.
  if (cmd === "explain") {
    // explain is a verify-module verb — every module it needs loads inside the branch, so the core entry
    // (which refuses verify-module verbs before dispatch) never touches the verify tree.
    const {
      cliExplain,
      cliExplainFeature,
      cliExplainObligations,
      cliExplainResidualStubs,
      scanEscalatedMarkers,
      scanWaiverMarkers,
    } = await import("./explain.ts");
    const { cliExplainAs, cliExplainAsRow, cliExplainResidual } = await import(
      "./explain-residual.ts"
    );
    const { cliExplainDiagram } = await import("./explain-diagram.ts");
    const { cliConsumers } = await import("../verify/consumers.ts");
    const { featureCatalog } = await import("../verify/explain.ts");
    const json = rest.includes("--json");
    const loadApp = async (appArg: string): Promise<App> => {
      const spec = moduleSpec(appArg);
      const mod = await importAppModule(spec) as { app?: App; default?: App };
      const a = mod.app ?? mod.default;
      if (!a) {
        console.error(`module '${appArg}' does not export 'app'`);
        Deno.exit(2);
      }
      return a;
    };
    // Rejects any `--flag` the dispatcher cannot service before the positional fall-through, so an
    // advertised-but-unwired flag is never silently swallowed (`--semantics` is the positional mode instead).
    const EXPLAIN_MODIFIER_FLAGS = [
      "--json",
      "--anon",
      "--claim",
      "--row",
      "--scope",
      "--env",
    ]; // --row/--scope/--env modify the --as mode (per-row attribution + prod-target collapse) — not standalone modes
    /** The flags that CONSUME the next token. Declared once, because every positional slot in this verb has
     *  to subtract them: a value and an app path are the same shape, so a slot found by "first non-flag" is
     *  found wrong the moment a value-taking modifier precedes it. */
    const EXPLAIN_VALUE_FLAGS = new Set<string>([
      "--as",
      "--claim",
      "--row",
      "--scope",
      "--env",
    ]);
    const explainAllowed = new Set<string>([
      ...EXPLAIN_SERVICEABLE_FLAGS,
      ...EXPLAIN_MODIFIER_FLAGS,
    ]);
    const unknownFlag = [modPath, ...rest].find((a) =>
      a !== undefined && a.startsWith("--") && !explainAllowed.has(a)
    );
    if (unknownFlag) {
      console.error(
        `✗ explain: unknown flag '${unknownFlag}' — serviceable: ${
          EXPLAIN_SERVICEABLE_FLAGS.join(", ")
        } (note: semantics is a positional mode, \`hazelnut explain semantics <id|feature>\`, not a flag)`,
      );
      Deno.exit(2);
    }
    if (modPath === "--residual") {
      // Scans the app's source tree for the `// hazelnut-*` waived-red marker family and the
      // `// hazelnut-escalated` standing items, so committed waivers and third-exit escalates surface live.
      const appArg = rest.find((a) => !a.startsWith("--"));
      if (!appArg) {
        console.error("usage: hazelnut explain --residual <app> [--json]");
        Deno.exit(2);
      }
      const dir = appArg.includes("/")
        ? appArg.slice(0, appArg.lastIndexOf("/"))
        : ".";
      const tree = await readSourceTree(dir);
      const escalated = scanEscalatedMarkers(tree);
      const waivers = scanWaiverMarkers(tree); // the `// hazelnut-*` waived-red family incl. test-waived/trivial-op
      // the residual reaches the configured judge (app.verify.judge via runVerifyJudged) — async.
      const r = await cliExplainResidual(await loadApp(appArg), {
        json,
        escalated,
        waivers,
      });
      console.log(r.stdout);
      Deno.exit(r.code);
    }
    if (modPath === "--obligations") {
      // `rest[0]` is the <resource>, `rest[1]` is the <app> path (skipping flags).
      const positional = rest.filter((a) => !a.startsWith("--"));
      const [resource, appArg] = positional;
      if (!resource || !appArg) {
        console.error(
          "usage: hazelnut explain --obligations <resource> <app> [--json]",
        );
        Deno.exit(2);
      }
      const r = cliExplainObligations(await loadApp(appArg), resource, {
        json,
      });
      console.log(r.stdout);
      Deno.exit(r.code);
    }
    if (modPath === "--diagram") {
      // `hazelnut explain --diagram <app>` — projects the composed model as deterministic mermaid (module
      // subgraphs + parent/reference + emits→subscriber edges). No --json — stdout mermaid is the artifact.
      const appArg = rest.find((a) => !a.startsWith("--"));
      if (!appArg) {
        console.error("usage: hazelnut explain --diagram <app>");
        Deno.exit(2);
      }
      const r = cliExplainDiagram(await loadApp(appArg));
      console.log(r.stdout);
      Deno.exit(r.code);
    }
    if (modPath === "--stubs") {
      // `hazelnut explain --stubs <resource> <app>` — the born-RED per-residual test stubs (finer grain of
      // --obligations). Same positional shape; no --json — the output is paste-ready test source.
      const positional = rest.filter((a) => !a.startsWith("--"));
      const [resource, appArg] = positional;
      if (!resource || !appArg) {
        console.error("usage: hazelnut explain --stubs <resource> <app>");
        Deno.exit(2);
      }
      const r = cliExplainResidualStubs(await loadApp(appArg), resource);
      console.log(r.stdout);
      Deno.exit(r.code);
    }
    // `hazelnut explain <module.resource>[#member] --consumers <app> [--json]` — re-derives the boot import graph
    // and lists the cross-module consumers an edit here would reach.
    if (modPath && rest.includes("--consumers")) {
      const hashAt = modPath.indexOf("#");
      const refPart = hashAt === -1 ? modPath : modPath.slice(0, hashAt);
      const member = hashAt === -1 ? undefined : modPath.slice(hashAt + 1);
      const dot = refPart.lastIndexOf(".");
      const producerResource = dot === -1 ? refPart : refPart.slice(dot + 1);
      const appArg = rest.find((a) => !a.startsWith("--"));
      if (!appArg) {
        console.error(
          "usage: hazelnut explain <module.resource>[#member] --consumers <app> [--json]",
        );
        Deno.exit(2);
      }
      const r = cliConsumers(await loadApp(appArg), producerResource, {
        member,
        json,
      });
      console.log(r.stdout);
      Deno.exit(r.code);
    }
    // `hazelnut explain <resource> --as <archetype> <app> [--claim k]… [--anon] [--json]` (13-authz.md §11)
    // — the read-stack explanation. `--claim k` seeds typed perms; `--anon` makes the rowPolicy see `null`.
    const asAt = rest.indexOf("--as");
    if (modPath && asAt !== -1) {
      const archetypeName = rest[asAt + 1];
      if (archetypeName === undefined || archetypeName.startsWith("--")) {
        console.error(
          "usage: hazelnut explain <resource> --as <archetype> <app> [--claim k]… [--anon] [--json]",
        );
        Deno.exit(2);
      }
      // The app path is a POSITIONAL, and a value-taking flag's value has the same shape, so the slot has to
      // be found by excluding every consumed token — not just the archetype after `--as`. Excluding that one
      // alone, `--claim license:issue ./app.ts` resolved the app to `license:issue` and the dynamic import
      // threw an UNCAUGHT TypeError (exit 1, stack trace) where every other form error here is a named exit 2.
      // Both orders now resolve; a genuinely absent app still falls to the usage banner below.
      const consumed = new Set<number>();
      rest.forEach((a, i) => {
        const next = rest[i + 1];
        if (
          EXPLAIN_VALUE_FLAGS.has(a) && next !== undefined &&
          !next.startsWith("--")
        ) {
          consumed.add(i + 1);
        }
      });
      const appArg = rest.find((a, i) =>
        !a.startsWith("--") && !consumed.has(i)
      );
      if (!appArg) {
        console.error(
          "usage: hazelnut explain <resource> --as <archetype> <app> [--claim k]… [--anon] [--json]",
        );
        Deno.exit(2);
      }
      const claims = rest.flatMap((
        a,
        i,
      ) => (a === "--claim" && rest[i + 1] && !rest[i + 1]!.startsWith("--")
        ? [rest[i + 1]!]
        : [])
      );
      const archetype = {
        name: archetypeName,
        claims,
        anonymous: rest.includes("--anon"),
      };
      // `--row <id>` evaluates the stack conjunct-by-conjunct for one id against the live database —
      // SELECT-1 probes only, never row content. `--scope <value>` tests the partition conjunct.
      const rowAt = rest.indexOf("--row");
      if (rowAt !== -1) {
        const rowId = rest[rowAt + 1];
        if (rowId === undefined || rowId.startsWith("--")) {
          console.error(
            "usage: hazelnut explain <resource> --as <archetype> --row <id> <app> [--env <name>] [--scope v] [--json]",
          );
          Deno.exit(2);
        }
        // Target classification mirrors the migrate env-guard: only a default-`.env`-supplied URL is dev.
        // On a prod target `explainOnTarget` collapses output to a bare `forbidden` — else an id-enumeration oracle.
        const envAt = rest.indexOf("--env");
        const envName =
          envAt !== -1 && rest[envAt + 1] && !rest[envAt + 1]!.startsWith("--")
            ? rest[envAt + 1]
            : undefined;
        let fileEnv: Record<string, string> = {};
        try {
          fileEnv = parseEnvFile(
            await Deno.readTextFile(
              envName !== undefined ? `.env.${envName}` : ".env",
            ),
          );
        } catch { /* ambient/CI supplies DATABASE_URL */ }
        const url = fileEnv.DATABASE_URL ?? Deno.env.get("DATABASE_URL");
        if (!url) {
          console.error(
            "explain --row: DATABASE_URL is not set (the per-row probe reads the live database)",
          );
          Deno.exit(2);
        }
        const target = classifyMigrateTarget({
          envName,
          fileSuppliedUrl: fileEnv.DATABASE_URL !== undefined,
        });
        const scopeAt = rest.indexOf("--scope");
        const scope = scopeAt !== -1 && rest[scopeAt + 1] &&
            !rest[scopeAt + 1]!.startsWith("--")
          ? rest[scopeAt + 1]
          : undefined;
        // app path: the first non-flag token that isn't the archetype name, row id, scope value, or env name.
        const appArg2 = rest.find((a, i) =>
          !a.startsWith("--") && i !== asAt + 1 && i !== rowAt + 1 &&
          (scopeAt === -1 || i !== scopeAt + 1) &&
          (envAt === -1 || i !== envAt + 1)
        );
        if (!appArg2) {
          console.error(
            "usage: hazelnut explain <resource> --as <archetype> --row <id> <app> [--env <name>] [--scope v] [--json]",
          );
          Deno.exit(2);
        }
        const postgres = (await import("postgres")).default;
        const sql = postgres(url, { onnotice: () => {} });
        try {
          const r = await cliExplainAsRow(
            await loadApp(appArg2),
            modPath,
            archetype,
            rowId,
            postgresDb(sql),
            { scope, json },
          );
          console.log(explainOnTarget(target, r.stdout));
          Deno.exit(r.code);
        } finally {
          await sql.end();
        }
      }
      const r = cliExplainAs(await loadApp(appArg), modPath, archetype, {
        json,
      });
      console.log(r.stdout);
      Deno.exit(r.code);
    }
    if (!modPath) {
      console.error(
        "usage: hazelnut explain <invariant-id> | <feature> | --residual <app> | --obligations <resource> <app> | <resource> --as <archetype> <app>",
      );
      Deno.exit(2);
    }
    // `hazelnut explain <feature>` (04-features.md) — a positional naming a known feature renders its card;
    // `explain semantics <id|feature>` is the explicit form for a name colliding with an invariant id.
    if (modPath === "semantics") {
      const target = rest.find((a) => !a.startsWith("--"));
      if (!target) {
        console.error("usage: hazelnut explain semantics <id|feature>");
        Deno.exit(2);
      }
      // an id first (the existing semantics mode), else a feature card (the loud not-found rides cliExplainFeature)
      const fromId = cliExplain(target);
      const r = fromId.code === 0 ? fromId : cliExplainFeature(target);
      console.log(r.stdout);
      Deno.exit(r.code);
    }
    if (featureCatalog[modPath]) {
      const r = cliExplainFeature(modPath);
      console.log(r.stdout);
      Deno.exit(r.code);
    }
    // A known id renders its block + exits 0; an unknown id is a loud not-found + non-zero (cli §explain).
    const r = cliExplain(modPath);
    console.log(r.stdout);
    Deno.exit(r.code);
  }

  // `hazelnut migrate --safe-ddl [<sql-file> | -]` (cli/migrate.md §safe-ddl) — runs the file-pure migrate
  // sub-roster over a migration SQL string, exiting non-zero on a build-error-level finding. No app, no DB.
}
