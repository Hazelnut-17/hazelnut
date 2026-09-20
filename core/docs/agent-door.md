# The agent door

> **How-to** — for a developer putting their app in front of an agent. One path,
> end to end: curate the tools, declare the posture, confirm what destroys, and
> know what the door does not promise. If you have never booted the framework,
> follow the [Quickstart](./QUICKSTART.md) first.

A served app mounts `POST /mcp` already. This page is about what it hands out
and who may reach it. The declarations here are the same ones HTTP derives from
— there is no second stack, and nothing here moves a route.

## 1. Curate the tools

Nothing is a tool until you say so. Opening a route under `http:` publishes no
tool; the `mcp:` key is a separate, deliberate opt-in, and an op you leave out
is unexposed.

<!-- @conformance:skip reason=the mcp fragment of a declaration, not a standalone module -->

```ts
mcp: {
  list: { describe: "List widgets the caller may see." },
  create: { describe: "Create a widget owned by the caller." },
},
```

`describe` is required on every tool — it is the agent's only selection signal,
so a vague one is a tool the agent picks wrongly. `shape` narrows which fields
the tool returns; it may only name fields the read already returns, never widen
them.

Run your app and ask the door what it carries:

```sh
curl -s localhost:8000/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Tools are named `<module>__<resource>__<op>`, so a curated `list` on a top-level
`widget` is `app__widget__list`.

What comes back is narrowed to the caller you authenticated as, which is the
next section's subject: an anonymous call sees the read tools, and does not see
`app__widget__create` at all. A write tool you may not call is omitted from the
list rather than refused on use — a refusal would answer "does this exist?" for
anyone who asked.

If you get a JSON-RPC error saying the batch is not supported, you sent an
array: this door takes one request object per call.

## 2. Declare the posture

Two questions, and they are not the same one. A served app refuses to boot until
both are answered, because silence used to read as permission.

<!-- @conformance:skip reason=one key of the app config, not a standalone module -->

```ts
mcp: { allowedOrigins: [], gate: "widget:list" },
```

- **`allowedOrigins`** — WHICH BROWSER may reach the door. An empty list closes
  it to every page. A headless agent sends no `Origin` at all, so the empty list
  does not touch it. `null` is the open door, said out loud.
- **`gate`** — WHO may reach the door. The permission is checked before the
  request body is read, so it answers for the whole door, handshake included: a
  caller without it is refused everything, not merely the catalogue. `null` is
  the open catalogue, said out loud — the right choice for an app that serves
  anonymous agents, and the one to copy when you are adding this to an app that
  already has them.

Absence is what refuses, not falsity. Writing `null` IS the declaration, and the
app boots; omitting the key is what `mcp/origin-declared` and
`mcp/gate-declared` name when boot stops. Gating the catalogue is worth it
because `tools/list` returns every tool with its whole input schema — the same
shape `/openapi.json` is never served ungated.

### The gate is not the filter

These are two mechanisms and both run. Reading one as the other is the most
expensive mistake on this page.

| Mechanism         | Answers                                     | Fails as                         |
| ----------------- | ------------------------------------------- | -------------------------------- |
| `gate`            | may this caller reach the door at all       | 403, before the body is read     |
| capability filter | which tools does THIS identity see and call | the tool is absent from the list |
| `rowPolicy`       | which rows come back from a tool that ran   | fewer rows, never an error       |

`tools/list` is answered per identity: two callers hitting the same door get
different lists, because each tool's own policy decides whether that caller sees
it. So an open `gate: null` does not hand out your whole surface — it hands out
what that caller was already allowed to call. And a closed gate does not replace
per-tool policy: it stops the knock, not the reach.

An Origin allowlist stops a browser page. It never stops a client, and an agent
is a client by definition, so the two checks do not substitute for each other.

## 3. Guard the reads, guide the host on destructive writes

A curated `list` or `find` must be narrowed by a `rowPolicy`, or declared
deliberately public. Boot refuses the third case (`mcp/read-protected`): a read
tool with no row rule hands the whole table to a remote, untrusted, injectable
caller.

A curated destructive tool can carry `confirm: true`:

<!-- @conformance:skip reason=the mcp fragment of a declaration, not a standalone module -->

```ts
mcp: {
  delete: { describe: "Delete a widget you own.", confirm: true },
},
```

`confirm` adds `confirmHint` and `destructiveHint` to the tool definition. A
cooperative host can show a human prompt before it calls the tool. The server
does not receive an unforgeable approval receipt, so this annotation is neither
a permission nor a security boundary and cannot guarantee a human was involved.

The enforcement boundary is the tool's `policy` and `rowPolicy`. If a product
requires an approval by a different authenticated principal, model it as an
app-owned two-stage act or use the off-machine approval seam; a client-supplied
`confirmed:true` field would not establish that fact.

For a custom write declared `idempotent: true`, `tools/list` also offers the
optional `_idempotencyKey`. An agent mints one key before its first call and
resends the same key only after a transient failure; the first result then
replays instead of applying the operation twice. `_idempotencyKey` belongs to
the framework transport and cannot be a field in that operation's business
input. CRUD writes and custom writes without `idempotent: true` have no replay
claim, so use their documented uniqueness and version preconditions instead. For
a versioned CRUD write, the MCP `version` is that precondition; an agent cannot
choose the framework-only `NO_CAS` exception or omit the version.

## 4. Know the rate floor, and what it rests on

Every served app is throttled out of the box, per credential rather than per IP,
so one runaway caller cannot starve the others. The floor is **120 requests per
minute for an agent** and **600 for a human**, over a 60-second window. An
unauthenticated caller shares one bucket at the human ceiling — deliberately, a
shared bucket is a cap nobody can escape by rotating a forged header.

**The framework takes your resolver's word for which one a caller is.** Whether
an actor is an agent or a human is carried on the credential your `auth` seam
resolves; no static property of your code can attest a runtime credential. So
the agent floor is exactly as strong as the classification you feed it. If your
seam labels an agent's credential as a human's, it gets the human budget and
nothing will say so. Classify from the verified credential, not from a header
the caller sent.

## 5. Reach the door another way

`POST /mcp` needs no emit — a served app already mounts it. When a host must
spawn your app over stdio, or when the door belongs in a different network,
[`hazelnut mcp`](./cli/mcp.md) emits an entry for each. Same declarations, same
tools, same auth seam; a different transport.

### Live changes are a separate SSE door

`tools/list` never advertises a stream, and an MCP tool call never subscribes
the host to future changes. When an agent host also needs a live screen, declare
`push.topics` separately and connect its authenticated streaming client to
`GET /events/<topic>`. The topic's `observe(ctx, db)` policy answers whether the
caller may learn that **any** event in its scope happened; ordinary read policy
still controls the subsequent refetch. An `invalidate` frame carries `{}` and
means refetch. A declared `rows` projection carries the same gated list as the
read API. Streams have no replay or exactly-once delivery guarantee, so
reconnect and replace/refetch current state rather than treating an event as a
durable command. See
[the Rundown's push section](./rundown.md#notify-a-live-screen-when-a-topic-changes)
for the declaration and browser/bearer-client details.

## What this door does not do

- **It does not mirror HTTP.** No route becomes a tool by existing. A surface
  worth handing an agent is curated, and coarse operations you author on purpose
  beat a dump of every CRUD verb.
- **It does not demote HTTP.** The same declarations serve both. A human client
  keeps every route it had.
- **It does not run the agent.** Hazelnut serves the door; planning, tool
  selection and the conversation belong to the host on the other side.

See the [Glossary](./GLOSSARY.md) for each term used here, and the
[Rundown](./rundown.md) for the declaration vocabulary these keys belong to.
