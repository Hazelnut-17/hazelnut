# `hazelnut mcp`

> **Reference** — for exposing your app's MCP surface over a transport other
> than the one the served app already mounts. Two doors, what each holds, and
> what each does not.

`hazelnut mcp <stdio|gateway>` emits a **write-once** entry file that exposes
your app's MCP surface over a transport other than the in-app `POST /mcp` the
served app already mounts. Same declaration, same tools, same auth seam — a
different door. Like `hazelnut add`, it declares (never overwrites): a
pre-existing target file is refused.

The in-app HTTP transport needs no emit — `main.ts` already serves `/mcp`. Reach
for these two only when a consumer needs a different door.

## `hazelnut mcp stdio` → `mcp-stdio.ts`

A local stdio MCP server: an MCP host (Claude Code, Claude Desktop) spawns it by
command and speaks newline-delimited JSON-RPC over stdin/stdout — no HTTP port.
The emitted entry boots the **full app** (it IS the app process, just spoken
over stdio) and forwards each line to the same served `/mcp` door in-process, so
capability filtering, strict-input, and the `tools/list_changed` stamp all ride
along — one dispatch, no twin.

```sh
hazelnut mcp stdio           # emits mcp-stdio.ts
# point your MCP host at:
hazelnut launch ./app.ts --entry mcp-stdio.ts
```

A transport is a production process, so it starts the same way the app does —
through `hazelnut launch`, which derives the grants from your declarations
instead of handing the process everything. `--entry` moves the derivation onto
this file: it reads no `PORT`, so it is granted no listen socket.

**Credentials are transport-level:** stdio carries the `HAZELNUT_MCP_TOKEN` env
var as the bearer the app's ordinary `defineAuth` seam resolves. Absent ⇒
anonymous ⇒ deny-by-default (fail-closed). Point your host's server config at
the command with the token in its `env`.

The emitted entry wires **no** seam — you add one. Until you do, it **refuses to
start** with the token set, rather than accept a credential nothing would
resolve and serve every caller as anonymous while you believe the door is
closed. Wire `auth` on `createApp` in that file, delete the guard the refusal
names, and the token means what this page says.

| Env                  | Meaning                                                                 |
| -------------------- | ----------------------------------------------------------------------- |
| `HAZELNUT_MCP_TOKEN` | the bearer this transport authenticates with — stdio carries no headers |

It is the one framework-named credential, and it exists because the transport
leaves no other place to put one. Provision it wherever your host stores the
server's environment; it never appears in the served app's own configuration.

## `hazelnut mcp gateway` → `gateway.ts`

A **hardened, credential-free** gateway: a separate deployable that terminates
agent traffic in its own network segment and forwards validated `/mcp` calls to
the app's internal URL. Deploy it in the agent-facing network and keep the app's
port internal. `HAZELNUT_MCP_TOKEN` has no effect here — that variable is the
stdio transport's bearer; authenticate a gateway caller on the app seam behind
`APP_URL`.

```sh
hazelnut mcp gateway         # emits gateway.ts
# run in the agent-facing network:
APP_URL=http://app:8000 hazelnut launch ./app.ts --entry gateway.ts
```

`launch` derives this entry's grants too, and derives them narrower than the
app's: the gateway holds no database, no keys and no webhook egress, so its
whole set is its own listen port, the one `APP_URL` host it forwards to, and the
app tree it reads. An unset or unparseable `APP_URL` refuses the launch rather
than starting a gateway that cannot reach anything.

What it holds: **nothing sensitive.** It composes the _pure_ declaration
(`createApp(config)` — no db, no KMS key) only to derive the tool catalog, drops
a `tools/call` naming an unknown tool before it crosses the channel, enforces
the `config.mcp.allowedOrigins` DNS-rebinding allowlist **at the gateway** (the
trust boundary — the app never sees the forwarded `Origin`), and forwards the
rest to `APP_URL/mcp`. A compromised gateway can do only what the exposed op
surface already allows — the app's capability filter and deny-by-default policy
still run behind it (defense-in-depth, never a policy replacement).

| Env                   | Meaning                                             |
| --------------------- | --------------------------------------------------- |
| `APP_URL` (required)  | the app's internal base URL the gateway forwards to |
| `PORT` (default 8100) | the gateway's own listen port                       |

The catalogue it drops unknown tools against is derived, not transcribed:
`mcpToolDefs(app)` returns the tool definitions the app's declarations project —
name, description and JSON-schema input per tool. The emitted gateway calls it,
and so can you, if you build a transport of your own rather than using either
door above. It reads a **pure** `createApp(config)`, so deriving the catalogue
needs no database and no keys.

**Body cap:** the gateway enforces a fixed 1 MiB request cap and offers no knob
to raise it. `http.maxBodyBytes` is the app's own setting; the gateway never
reads it, so an MCP op whose request exceeds 1 MiB gets a 413 at the gateway —
route that op off the gateway.

## Deploy topology

Same container image, different command: `main.ts` (app, internal) +
`gateway.ts` (agent-facing). See [`DEPLOY.md`](../DEPLOY.md) for the compose
shape.
