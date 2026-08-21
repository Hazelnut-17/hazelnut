// `hazelnut launch` — the least-privilege permission deriver (cli/launch.md §derivation).
//
// A served Hazelnut app's permission needs are DERIVABLE, because the same declarations that derive the
// routes and the DDL also name every capability the process can reach: `defineWebhook` names each egress
// host, `datasources` names each external DB, `file()` names the on-disk need, and the entry sources name
// the env keys they read. This module turns that into an exact flag set.
//
// The discipline: everything derivable is derived, and everything NOT derivable is REFUSED loudly — never
// widened to `-A`. A blanket grant is the thing this verb exists to delete, so silently falling back to one
// would defeat the whole point (a launcher that quietly re-grants everything is worse than no launcher: it
// reads as least-privilege while being `-A`).
import type { App } from "../core/app-define.ts";
import { drainReasonsOf } from "../core/app.ts";
import { DEFAULT_SERVE_PORT, MCP_GATEWAY_PORT } from "../core/version.ts";
import { withoutComments } from "../invariants/source-view.ts";

/** One derived grant: the flag, the value, and the declaration that forced it (the `--explain` line). */
export interface PermissionGrant {
  readonly flag: "net" | "env" | "read" | "write";
  readonly value: string;
  readonly why: string;
}

/** A capability the app declares but whose grant cannot be derived — refused, never widened to `-A`. */
export interface PermissionRefusal {
  readonly what: string; // the undeliverable grant
  readonly fix: string; // the one action that makes it derivable
}

export interface PermissionPlan {
  readonly grants: readonly PermissionGrant[];
  readonly refusals: readonly PermissionRefusal[];
  /** Virtually every served app is scheduler-dependent (the TTL sweeps + expiry purge ride `Deno.cron`). */
  readonly unstableCron: boolean;
  /** Every app file the env scan actually read, in graph order. `--explain` prints it because a grant set
   *  is only as trustworthy as its coverage: without this, an author cannot tell a genuinely env-free app
   *  from one whose reads the scan never looked at. */
  readonly scanned: readonly string[];
}

export interface LaunchInputs {
  readonly app: App;
  /** Launch-time env — `DATABASE_URL` and `PORT` are read here, not guessed. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The served entry's MODULE GRAPH — every app file reachable from it, keyed by path, scanned for the env
   *  keys they read. The graph (not a fixed list of entry filenames) is what keeps the grant honest as the
   *  app grows: a `Deno.env.get` in a module file is as real as one in `main.ts`. */
  readonly entrySources: Readonly<Record<string, string>>;
  /** The storage root a `file()` app writes through (`localDriver({ dir })`); absent ⇒ a refusal, not a
   *  blanket `--allow-write`. */
  readonly filesDir?: string;
  /** Which served entry this launch runs (`launch --entry`). Absent ⇒ the app's own `main.ts`. */
  readonly entry?: string;
}

/** How a served entry differs from the app's own `main.ts`. The app-tree walk cannot answer this on its own:
 *  a transport's credential is read inside a framework module (a bare specifier, deliberately not walked)
 *  and the gateway binds a socket no app declaration names. */
interface EntryShape {
  /** The socket it binds when `PORT` is unset; absent ⇒ it binds none (stdio speaks over the pipe). */
  readonly listenPort?: string;
  /** Whether the app's DECLARED capabilities are reachable from it — the owned Postgres, the datasources,
   *  webhook egress, local file storage. False for the gateway: it composes the pure declaration for the
   *  tool catalogue only, so granting any of them would contradict its credential-free posture. */
  readonly declaredCapabilities: boolean;
  /** `[key, why]` for each env read inside the framework module this entry drives — invisible to the scan
   *  over the app tree, and a `NotCapable` at the first read if the derivation leaves it out. */
  readonly frameworkEnv: readonly (readonly [string, string])[];
  /** Whether the entry forwards to `APP_URL`. Unset or unparseable is a refusal: the address is the whole
   *  reason this entry opens a socket, and no declaration names it. */
  readonly dialsAppUrl?: boolean;
}

/** An entry no table below names is the app's own served process — `main.ts` and anything an author points
 *  `--entry` at. Only the shapes `hazelnut mcp` emits differ, and each states how. */
const APP_SHAPE: EntryShape = {
  listenPort: DEFAULT_SERVE_PORT,
  declaredCapabilities: true,
  frameworkEnv: [],
};

const ENTRY_SHAPES: Readonly<Record<string, EntryShape>> = {
  // the app process itself, spoken over stdin/stdout: every declared capability is reachable, no socket.
  "mcp-stdio.ts": {
    declaredCapabilities: true,
    frameworkEnv: [[
      "HAZELNUT_MCP_TOKEN",
      "the stdio transport's bearer — a pipe carries no header to put one in",
    ]],
  },
  // the credential-free forwarder: its own socket and the one address it dials, and nothing else.
  "gateway.ts": {
    listenPort: MCP_GATEWAY_PORT,
    declaredCapabilities: false,
    frameworkEnv: [],
    dialsAppUrl: true,
  },
};

/** The scheme→port table for the url forms a declaration can carry. An unlisted scheme yields a
 *  host-only grant (every port on that host) rather than a wrong port. */
const DEFAULT_PORT: Readonly<Record<string, string>> = {
  "https:": "443",
  "http:": "80",
  "postgres:": "5432",
  "postgresql:": "5432",
};

/** `host:port` for a declared url, or null when it does not parse. Falls back to the bare host when the
 *  scheme has no known default — a host-only grant is still bounded, a guessed port would be wrong. */
export function hostPortOf(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname === "") return null;
  const port = u.port !== "" ? u.port : DEFAULT_PORT[u.protocol];
  return port === undefined ? u.hostname : `${u.hostname}:${port}`;
}

// A literal `Deno.env.get("KEY")` read. Only the LITERAL form is scannable — a computed key
// (`Deno.env.get(name)`) is invisible to a static scan and surfaces as a refusal, not a silent widening.
const ENV_READ = /Deno\.env\.get\(\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\)/g;
const ENV_READ_COMPUTED = /Deno\.env\.get\(\s*(?!["'`])/;

/** The env keys a source literally reads, in first-seen order. Comments and regex literals are projected
 *  first, so a `Deno.env.get` in a comment is not a grant and `return /x\//` does not eat the rest of the
 *  line. */
export function scanEnvKeys(source: string): string[] {
  const keys: string[] = [];
  for (const m of withoutComments(source).matchAll(ENV_READ)) {
    if (m[1] !== undefined && !keys.includes(m[1])) keys.push(m[1]);
  }
  return keys;
}

// The relative specifiers a source imports — the edges of the app's own module graph. Deno requires an
// explicit extension, so a relative specifier is always a complete path. Bare specifiers (`hono`,
// `hazelnut`, `npm:`/`jsr:`) are DEPENDENCIES, deliberately not walked: their env needs are the
// framework's or the driver's business and are granted explicitly (the `PG*` namespace is exactly that).
const IMPORT_FROM = /\bfrom\s*["'`](\.\.?\/[^"'`]+)["'`]/g;
const IMPORT_BARE = /\bimport\s*\(?\s*["'`](\.\.?\/[^"'`]+)["'`]/g;
// `import(someVar)` — a specifier a static walk cannot resolve, so the graph beyond it is invisible.
const IMPORT_COMPUTED = /\bimport\s*\(\s*(?!["'`])[A-Za-z_$]/;

/** The relative specifiers a source imports, de-duped, in first-seen order.
 *
 *  Type-only imports are NOT excluded. Telling `import type {X} from "./m.ts"` (erased at runtime) from
 *  `import {type X, y} from "./m.ts"` (not erased) needs real statement parsing, and the two failure modes
 *  are not symmetric: over-reading a file grants an env key the process may never read — bounded, still
 *  never `-A` — while a parser bug that drops a live module reproduces the exact under-grant this walk
 *  exists to delete (a boot-time `NotCapable`, whose fix under pressure is the blanket grant). Coverage
 *  wins the tie. */
export function scanRelativeImports(source: string): string[] {
  const src = withoutComments(source);
  const specs: string[] = [];
  for (const re of [IMPORT_FROM, IMPORT_BARE]) {
    for (const m of src.matchAll(re)) {
      if (m[1] !== undefined && !specs.includes(m[1])) specs.push(m[1]);
    }
  }
  return specs;
}

/** True when a source imports through a computed specifier — the walk cannot see past it. */
export function hasComputedImport(source: string): boolean {
  const src = withoutComments(source);
  return IMPORT_COMPUTED.test(src) ||
    scanRelativeImports(source).some((s) => s.includes("${"));
}

/** True when a PORT value names one fixed TCP port. A leading zero is out: the child binds `Number(v)`, so
 *  granting the spelling would name a different socket than the one it binds. */
function isFixedPort(value: string): boolean {
  return /^[1-9][0-9]{0,4}$/.test(value) && Number(value) <= 65535;
}

/**
 * Whether the served entry's graph WRITES `key` as a boot-bundle key.
 *
 * Deliberately graph-wide rather than scoped to the `createApp(` call: `createApp(config, seams)` over a
 * bundle built a few lines up is a legal shape, and a call-scoped scan would refuse it for declaring the
 * choice in the wrong place. The two error directions are not symmetric here — a false refusal blocks a
 * deploy that is already correct, which is the whole reason this question is asked by the launcher instead
 * of by `createApp`. Comments come out first: a comment naming a key is not a declaration of it, and the
 * scaffold's own `main.ts` explains both arms of the choice directly above the call that makes it.
 */
export function bootDeclares(
  sources: Readonly<Record<string, string>>,
  key: string,
): boolean {
  return bootBundleKeys(sources).has(key);
}

/** Comments removed AND every string/template body blanked to spaces, offsets preserved. A scanner that
 *  reads source text has to be blind to what the text SAYS, or a sentence about the code reads as the code:
 *  measured, `const _todo = "scheduler: decide later";` satisfied the old regex and launched the app. */
export function inertSource(text: string): string {
  const text0 = withoutComments(text);
  const out = text0.split("");
  let i = 0;
  while (i < out.length) {
    const c = out[i]!;
    if (c !== '"' && c !== "'" && c !== "`") {
      i++;
      continue;
    }
    const quote = c;
    let j = i + 1;
    while (j < out.length) {
      if (out[j] === "\\") {
        j += 2;
        continue;
      }
      if (out[j] === quote) break;
      // a template's ${…} is CODE, not text — leave it readable so a key there is still a key
      if (quote === "`" && out[j] === "$" && out[j + 1] === "{") {
        let depth = 1;
        j += 2;
        while (j < out.length && depth > 0) {
          if (out[j] === "{") depth++;
          else if (out[j] === "}") depth--;
          j++;
        }
        continue;
      }
      if (out[j] !== "\n") out[j] = " ";
      j++;
    }
    // A quoted OBJECT KEY is a declaration, not text: `{ "scheduler": … }` says exactly what
    // `{ scheduler: … }` says. Restore the body when the closing quote is followed by a `:`.
    let k = j + 1;
    while (k < out.length && (out[k] === " " || out[k] === "\n")) k++;
    if (out[k] === ":" && quote !== "`") {
      for (let b = i + 1; b < j; b++) out[b] = text0[b]!;
    }
    i = j + 1;
  }
  return out.join("");
}

/**
 * The keys the served entry's `createApp(config, { … })` boot bundle DECLARES.
 *
 * Structural, not textual. The question is "does the SECOND argument to `createApp` carry this property",
 * and the old reader asked "does this file contain the characters `scheduler:`" — a regex cannot tell a
 * declaration from a mention, so a string constant, a comment or an unrelated object all answered yes and
 * the app served with the decision still unmade. Here the string bodies are blanked first, then the call's
 * argument list is walked by bracket depth: only a property at the bundle's own top level counts.
 *
 * A SPREAD in the bundle contributes keys this reader cannot name, so it yields `*` — the caller treats an
 * underivable bundle as undeclared rather than as satisfied.
 */
export function bootBundleKeys(
  sources: Readonly<Record<string, string>>,
): Set<string> {
  const found = new Set<string>();
  for (const source of Object.values(sources)) {
    const text = inertSource(source);
    for (
      let at = text.indexOf("createApp(");
      at !== -1;
      at = text.indexOf("createApp(", at + 1)
    ) {
      // walk the argument list by depth; remember where each top-level argument began
      let depth = 0, argStart = -1, argIndex = 0, bundleAt = -1;
      for (let i = at + "createApp".length; i < text.length; i++) {
        const c = text[i]!;
        if (c === "(" || c === "{" || c === "[") {
          depth++;
          if (depth === 1) argStart = i + 1;
          continue;
        }
        if (c === ")" || c === "}" || c === "]") {
          depth--;
          if (depth === 0) break;
          continue;
        }
        if (c === "," && depth === 1) {
          argIndex++;
          if (argIndex === 1) argStart = i + 1;
          else break;
        }
        if (argIndex === 1 && bundleAt === -1 && c === "{" as string) {
          bundleAt = i;
        }
      }
      if (argIndex < 1 || argStart === -1) continue;
      let rest = text.slice(argStart);
      let open = rest.search(/\S/);
      // A HOISTED bundle (`const seams = { … }; createApp(config, seams)`) declares exactly as well as an
      // inline one, and refusing it would refuse an already-correct deploy. Resolve the binding to its own
      // object literal — a NAME is followed, a string is not, which is what keeps the mention out.
      if (open !== -1 && /^[A-Za-z_$]/.test(rest[open] ?? "")) {
        const ident = /^([A-Za-z_$][\w$]*)\s*[),]/.exec(rest.slice(open));
        if (ident === null) continue;
        const bind = new RegExp(
          `\\b(?:const|let|var)\\s+${ident[1]}\\s*(?::[^=]*)?=\\s*\\{`,
        ).exec(text);
        if (bind === null) continue;
        rest = text.slice(bind.index + bind[0].length - 1);
        open = 0;
      }
      if (open === -1 || rest[open] !== "{") continue; // the bundle is not an object literal here
      // top-level properties of that object: an identifier or quoted name at depth 1 followed by `:`
      let d = 0;
      for (let i = open; i < rest.length; i++) {
        const c = rest[i]!;
        if (c === "{" || c === "(" || c === "[") d++;
        else if (c === "}" || c === ")" || c === "]") {
          d--;
          if (d === 0) break;
        } else if (d === 1) {
          if (c === "." && rest.slice(i, i + 3) === "...") found.add("*");
          // an identifier key (`db,` / `relay:`) or a quoted one (`"relay":`) — both DECLARE the property
          const m =
            /^(?:([A-Za-z_$][\w$]*)\s*[:,}]|["']([A-Za-z_$][\w$]*)["']\s*:)/
              .exec(rest.slice(i));
          if (m && !/[\w$."']/.test(rest[i - 1] ?? " ")) {
            // `key,` (shorthand) and `key:` both DECLARE it; `key` inside a value position does not,
            // which the preceding-character test excludes.
            const key = m[1] ?? m[2]!;
            found.add(key);
            i += m[0]!.length - 1;
          }
        }
      }
    }
  }
  return found;
}

/** Derives the exact permission set a served app needs from its declarations + launch-time env. */
export function derivePermissions(inputs: LaunchInputs): PermissionPlan {
  const grants: PermissionGrant[] = [];
  const refusals: PermissionRefusal[] = [];
  const add = (
    flag: PermissionGrant["flag"],
    value: string,
    why: string,
  ): void => {
    if (!grants.some((g) => g.flag === flag && g.value === value)) {
      grants.push({ flag, value, why });
    }
  };

  // ── posture: the ungated API document ─────────────────────────────────────────────────────────────
  // `openapi: { public: true }` is a DEV posture, never a production one: the document names every route,
  // field, filter and validation rule the app has. This is the production door, so the refusal belongs HERE —
  // a comment telling the author to delete a line is not a check.
  if (inputs.app.openapi?.public === true) {
    refusals.push({
      what:
        "GET /openapi.json is served to ANYONE (`openapi: { public: true }`) — the document names every route, field and filter",
      fix:
        "gate it — `openapi: { gate: <perm> }` — or delete the `openapi` line; `deno task dev` is unaffected either way",
    });
  }

  const shape = ENTRY_SHAPES[inputs.entry ?? ""] ?? APP_SHAPE;

  // ── net: the listen socket ────────────────────────────────────────────────────────────────────────
  // `Deno.serve` binds every interface, so the grant is the wildcard host at the served port — narrowing
  // the host here would refuse the app's own bind, not harden it. An entry that binds nothing (the stdio
  // transport) earns no socket at all, and PORT is not its business either way.
  //
  // A set-but-unusable PORT is REFUSED, never read as unset: the entry binds `Number(PORT)`, so a blank or
  // `0` value binds an OS-assigned socket while a defaulted grant would name the default — `NotCapable` on
  // the first bind, in production only.
  const defaultPort = shape.listenPort;
  if (defaultPort !== undefined) {
    const rawPort = inputs.env.PORT;
    if (rawPort === undefined) {
      add(
        "net",
        `0.0.0.0:${defaultPort}`,
        `Deno.serve listens on PORT=${defaultPort}`,
      );
    } else if (isFixedPort(rawPort)) {
      add("net", `0.0.0.0:${rawPort}`, `Deno.serve listens on PORT=${rawPort}`);
    } else {
      refusals.push({
        what:
          `the listen socket (PORT='${rawPort}' names no fixed port, so the socket the app binds is unknowable)`,
        fix:
          `unset PORT for the default ${defaultPort}, or set it to a port in 1-65535 — an empty or '0' PORT makes Deno.serve bind an OS-assigned socket, which no grant derived before the process starts can name`,
      });
    }
  }

  // ── the entry's own needs ─────────────────────────────────────────────────────────────────────────
  // A framework-emitted transport drives a framework module through a BARE specifier, which the app-tree
  // walk deliberately does not enter — so the keys that module reads are stated here or they are missing,
  // and a missing one is a `NotCapable` on the transport's first request.
  for (const [key, why] of shape.frameworkEnv) add("env", key, why);
  if (shape.dialsAppUrl === true) {
    // read literally, never through the shape record: the launcher's own environment reads are held equal to
    // the deployment page's table, and an index that scan cannot see leaves an operator provisioning blind.
    const appUrl = inputs.env.APP_URL;
    const hp = appUrl === undefined || appUrl === ""
      ? null
      : hostPortOf(appUrl);
    if (hp === null) {
      refusals.push({
        what: `the app's internal /mcp door (APP_URL='${
          appUrl ?? ""
        }' names no reachable address)`,
        fix:
          `set APP_URL to the absolute internal base url this entry forwards to, e.g. http://app:${DEFAULT_SERVE_PORT}`,
      });
    } else add("net", hp, "APP_URL — the app's internal /mcp door");
  }

  // ── net: the owned substrate ──────────────────────────────────────────────────────────────────────
  // No DATABASE_URL is the sanctioned dev shape (embedded PGlite, in-process) — it opens no socket, so it
  // earns no grant. That asymmetry is the point: the dev shape is ALREADY least-privilege.
  //
  // An entry that reaches none of the app's declared capabilities (the credential-free gateway) skips this
  // and the two blocks after it: a socket its process never opens is a grant that only weakens the posture.
  const dbUrl = shape.declaredCapabilities
    ? inputs.env.DATABASE_URL
    : undefined;
  if (dbUrl !== undefined && dbUrl !== "") {
    const hp = hostPortOf(dbUrl);
    if (hp === null) {
      refusals.push({
        what: "the Postgres socket (DATABASE_URL does not parse as a url)",
        fix:
          "fix DATABASE_URL to the postgres://user:pass@host:port/db form, or unset it for the embedded-PGlite dev shape",
      });
    } else {
      add("net", hp, "DATABASE_URL — the owned Postgres substrate");
      // The postgres.js driver resolves its own options from the `PG*` env namespace at CLIENT CONSTRUCTION
      // (PGMAX, PGSSL, PGCONNECT_TIMEOUT, PGAPPNAME, …), before any query runs. Without this grant a real-
      // Postgres boot dies on `NotCapable: Requires env access to "PGMAX"` — the app would serve fine in the
      // PGlite dev shape and crash only in production, which is the worst possible place to find it.
      //
      // Granted as the PREFIX rather than the ~22 literal keys: the exact set is the driver's business and
      // moves between versions, and an enumeration that silently falls one key behind a bump reproduces the
      // same production-only crash. The prefix is still bounded — `PG*`, not every env var.
      add(
        "env",
        "PG*",
        "the postgres.js driver's option namespace, read at client construction",
      );
      // A url with no user sends the driver down its `os.userInfo()` → `USERNAME`/`USER`/`LOGNAME` fallback,
      // which would cost a `--allow-sys` grant plus three more env keys to satisfy a value the connection
      // string should simply state. Refused, because naming the user is the smaller and clearer change.
      if (!/^[a-z+]+:\/\/[^/@]*@/i.test(dbUrl)) {
        refusals.push({
          what:
            "the Postgres user (DATABASE_URL names no user, so the driver falls back to the OS account)",
          fix:
            "put the user in DATABASE_URL (postgres://USER:PASS@host:port/db) — the fallback needs --allow-sys plus USERNAME/USER/LOGNAME, to supply what the url can state directly",
        });
      }
    }
  }

  // ── net: the telemetry collector ──────────────────────────────────────────────────────────────────
  // `OTEL_EXPORTER_OTLP_ENDPOINT` is the OTel-standard name, so the launcher knows it without the project
  // declaring anything. Without this grant, opting into `installOtlp` would break the launch on a denied
  // connect — and the fastest fix under pressure is always `-A`, which is what this verb exists to prevent.
  const otlp = inputs.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (otlp !== undefined && otlp !== "") {
    const hp = hostPortOf(otlp);
    if (hp === null) {
      refusals.push({
        what:
          `the OTLP collector socket (OTEL_EXPORTER_OTLP_ENDPOINT '${otlp}' does not parse)`,
        fix:
          "set OTEL_EXPORTER_OTLP_ENDPOINT to an absolute url, e.g. http://otel-collector:4318",
      });
    } else {
      add("net", hp, "OTEL_EXPORTER_OTLP_ENDPOINT — the telemetry collector");
    }
  }

  // ── net: declared egress ──────────────────────────────────────────────────────────────────────────
  // Each `defineWebhook` url is a literal in the declaration, so every outbound host the relay can reach
  // is known before the process starts. This is the grant a hand-written `--allow-net` always gets wrong.
  for (const w of shape.declaredCapabilities ? inputs.app.webhooks ?? [] : []) {
    const hp = hostPortOf(w.url);
    if (hp === null) {
      refusals.push({
        what:
          `the egress host for webhook '${w.name}' (url '${w.url}' does not parse)`,
        fix: "fix the webhook url to an absolute https:// endpoint",
      });
    } else {
      add("net", hp, `webhook '${w.name}' delivers to ${w.url}`);
    }
  }

  // ── net: external datasources ─────────────────────────────────────────────────────────────────────
  // `url` on a datasource decl is documentary (the live connection rides `boot`), which is exactly why an
  // absent one is a refusal: the launcher cannot see the host, and guessing it would be a blanket grant.
  for (
    const [name, ds] of shape.declaredCapabilities
      ? Object.entries(inputs.app.datasources ?? {})
      : []
  ) {
    if (ds.url === undefined) {
      refusals.push({
        what: `the socket for datasource '${name}' (its decl carries no url)`,
        fix:
          `add \`url\` to the '${name}' datasource decl (documentary — the live connection still rides boot), or pass --allow-net=<host:port> for it explicitly`,
      });
      continue;
    }
    const hp = hostPortOf(ds.url);
    if (hp === null) {
      refusals.push({
        what:
          `the socket for datasource '${name}' (url '${ds.url}' does not parse)`,
        fix: `fix the '${name}' datasource url to an absolute connection url`,
      });
    } else {
      add("net", hp, `datasource '${name}' (${ds.access})`);
      // Same driver, same construction-time read: a postgres datasource builds the postgres.js client the
      // DATABASE_URL branch above grants `PG*` for, so without it the served process dies NotCapable before
      // its first query. `add` dedupes, so an app with both still carries one grant.
      if (/^postgres(ql)?:\/\//i.test(ds.url)) {
        add(
          "env",
          "PG*",
          "the postgres.js driver's option namespace, read at client construction",
        );
      }
    }
  }

  // ── env: what the served entry's MODULE GRAPH literally reads ─────────────────────────────────────
  // Scanned from the REAL sources rather than a framework-owned key list, so the grant tracks the app: a
  // new `Deno.env.get("STRIPE_KEY")` anywhere the entry can reach widens the grant by exactly one key,
  // automatically. The graph is the unit, not a fixed set of entry filenames — a key read in a
  // `*.module.ts` is as real to the running process as one read in `main.ts`, and a scan that could not
  // see it produced a grant set that looked complete and died at boot.
  for (const [path, source] of Object.entries(inputs.entrySources)) {
    const src = withoutComments(source);
    for (const key of scanEnvKeys(source)) {
      add("env", key, `${path} reads it`);
    }
    if (ENV_READ_COMPUTED.test(src)) {
      refusals.push({
        what: `the env keys ${path} reads through a computed name`,
        fix:
          `use a literal \`Deno.env.get("KEY")\` in ${path} so the key is derivable, or pass --allow-env=<keys> explicitly`,
      });
    }
    // A computed specifier ends the walk: everything that module imports is invisible, so the grant set
    // can no longer claim to cover the graph. Refused for the same reason a computed env key is — an
    // unknowable region of the graph must break the launch, not silently shrink the derived set.
    if (hasComputedImport(source)) {
      refusals.push({
        what:
          `the module graph beyond ${path} (it imports through a computed specifier)`,
        fix:
          `use a literal import specifier in ${path} so the graph is walkable, or pass --allow-env=<keys> explicitly for whatever that branch reads`,
      });
    }
  }

  // ── the drain / scheduler choice ──────────────────────────────────────────────────────────────────
  // Served `createApp` already REFUSES an undeclared `scheduler` (every app is scheduler-dependent). `launch`
  // re-asks from the entry source so a comment / string cannot fake the answer, and asks `relay` when the
  // composed app has something to drain — `relay: "external"` changes nothing this process runs, so boot
  // stays WARN for that arm while launch still requires the word.
  if (shape.declaredCapabilities) {
    // unconditional: the born-on `_idempotency`/`_outbox`/`_processed`/`_rate_limit` sweeps derive for EVERY
    // app (runtime/scheduler-jobs.ts), so no app is exempt from answering this one.
    if (!bootDeclares(inputs.entrySources, "scheduler")) {
      refusals.push({
        what:
          "who runs the feature scheduler (the served entry declares no `scheduler`)",
        fix:
          'add `scheduler: "in-process"` to the boot bundle (this process rides Deno.cron), or `scheduler: "external"` if a separate process runs `startFeatureScheduler` — undeclared, the born-on TTL sweeps over _idempotency/_outbox/_processed/_rate_limit never run and those tables grow without bound',
      });
    }
    const drains = drainReasonsOf(inputs.app);
    if (drains.length > 0 && !bootDeclares(inputs.entrySources, "relay")) {
      refusals.push({
        what: `who drains the outbox for ${
          drains.join(", ")
        } (the served entry declares no \`relay\`)`,
        fix:
          'add `relay: "in-process"` to the boot bundle (this process drains its own outbox), or `relay: "external"` if a separate `hazelnut relay` process owns it — undeclared, the outbox fills and none of these ever fire',
      });
    }
  }

  // ── read: the app's own tree ──────────────────────────────────────────────────────────────────────
  // The module graph, `node_modules` (npm deps resolve at runtime under nodeModulesDir:"auto"), and the
  // deno.json/lock pair all live under the app root — one bounded subtree, never the filesystem.
  add("read", ".", "the app tree — module graph, node_modules, deno.json/lock");

  // ── write: only what a declaration forces ─────────────────────────────────────────────────────────
  // A served app writes nothing on disk unless it stores file bytes locally. No `file()` field ⇒ no write
  // grant at all, which is the common case and the strongest result this deriver produces.
  const fileFields = shape.declaredCapabilities
    ? inputs.app.model.flatMap((m) =>
      m.files.map((f) => `${m.module}.${m.name}.${f}`)
    )
    : [];
  if (fileFields.length > 0) {
    if (inputs.filesDir === undefined || inputs.filesDir === "") {
      refusals.push({
        what: `the storage root for file() field(s) ${fileFields.join(", ")}`,
        fix:
          "set FILES_DIR (the localDriver root) so the write grant is bounded to it — or move the bytes to an off-box StorageDriver (S3/GCS), which needs no local write grant at all",
      });
    } else {
      add(
        "write",
        inputs.filesDir,
        `local storage root for file() field(s): ${fileFields.join(", ")}`,
      );
    }
  }

  return {
    grants,
    refusals,
    unstableCron: true,
    scanned: Object.keys(inputs.entrySources),
  };
}

/** Groups the plan's grants into the `--allow-<flag>=<csv>` argv form Deno consumes. */
export function renderPermissionFlags(plan: PermissionPlan): string[] {
  const flags: string[] = [];
  for (const flag of ["net", "env", "read", "write"] as const) {
    const values = plan.grants.filter((g) => g.flag === flag).map((g) =>
      g.value
    );
    if (values.length > 0) flags.push(`--allow-${flag}=${values.join(",")}`);
  }
  if (plan.unstableCron) flags.push("--unstable-cron");
  // Not derived from the app — a posture the launcher owns for every served process. Under Deno's legacy
  // behaviour `request.signal` aborts on a SUCCESSFUL response too, and `serve.ts` builds `ctx.signal` from
  // exactly that signal as the client-DISCONNECT input (merged with `http.requestTimeoutMs`). So the flag
  // buys the semantics the framework already documents, and silences the deprecation notice Deno otherwise
  // writes into every consumer's production log — a line about a framework internal they cannot act on.
  flags.push("--unstable-no-legacy-abort");
  return flags;
}

/** The full `deno run …` argv for the derived plan — the command `launch` execs and `--print` emits. */
export function renderLaunchCommand(
  plan: PermissionPlan,
  entry: string,
): string[] {
  return ["deno", "run", ...renderPermissionFlags(plan), entry];
}

/** The `--explain` rendering: every grant with the declaration that forced it, then any refusal. Exit 1
 *  on a refusal — an underivable capability must break the launch, not silently downgrade it to `-A`. */
export function renderPermissionPlan(
  plan: PermissionPlan,
  entry: string,
): { lines: string[]; exit: 0 | 1 } {
  const lines = plan.grants.map((g) =>
    `  --allow-${g.flag}=${g.value.padEnd(28)} ${g.why}`
  );
  if (plan.unstableCron) {
    lines.push(
      `  ${
        "--unstable-cron".padEnd(38)
      } feature TTL sweeps + expiry purge ride Deno.cron`,
    );
  }
  // `--explain` is the answer to "what will this process run as", so every flag it will carry belongs here —
  // one the reader cannot see is one they cannot audit.
  lines.push(
    `  ${
      "--unstable-no-legacy-abort".padEnd(38)
    } request.signal means client-disconnect, not response-complete`,
  );
  lines.unshift("derived least-privilege grants:");
  // The coverage line is part of the answer, not decoration: an empty env grant means "this graph reads no
  // env" only if the reader can see which files were walked. Stating it turns a silent miss into a visible
  // one — the author who spots a missing file here catches what the scan could not.
  lines.push(
    "",
    `env scanned across ${plan.scanned.length} app file(s) reachable from ${entry}: ${
      plan.scanned.join(", ")
    }`,
  );
  if (plan.refusals.length > 0) {
    // ONE refusal list, not two: an underivable grant and an unsafe production posture both mean "this app
    // does not launch until you act", and splitting them would mint a second exit path for the same outcome.
    // The wording is therefore neutral — an earlier "underivable grant(s)" summary described only half of it.
    lines.push(
      "",
      "REFUSED — launch will not start this app (a grant is never widened to -A):",
    );
    for (const r of plan.refusals) {
      lines.push(`  ✗ ${r.what}`, `    fix: ${r.fix}`);
    }
    lines.push(
      "",
      `launch refused: ${plan.refusals.length} unresolved item(s) — resolve them, or run the app with your own explicit flags`,
    );
    return { lines, exit: 1 };
  }
  lines.push("", `→ ${renderLaunchCommand(plan, entry).join(" ")}`);
  return { lines, exit: 0 };
}
