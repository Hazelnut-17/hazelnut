# Refusals

> **Reference** — for anyone reading a runtime refusal line. Every runtime
> refusal the core emits starts with an id; this page lists its message.

A refusal stops something before it can misbehave: `createApp` at boot, a
constructor such as `passwordLogin`, a request that cannot be served, or a verb.
Its message names what is wrong and what to change, so read the message first.
This page puts those runtime refusals in one place, grouped by the part of
Hazelnut they guard, so you can find their siblings. `‹name›` marks a part of
the message that is filled in from your declaration or the request; an id with
several messages lists each one. `hazelnut verify` findings are a different
channel: that command presents their canonical roster and repair pointers,
rather than this page copying a second runtime-message map.

<!-- refusals:begin -->

## audit

- `audit/sensitive-declared` — resource(s) ‹join› declare features:{ audit } but
  no 'sensitive' — the _audit diff/snapshot persists every changed column's
  before/after value and masks only the 'sensitive ∪ encrypted' set, so an
  unwritten card writes PII to an append-only table that outlives the row
  itself. Refusing to boot: declare sensitive:["email", ...] to mask those
  columns, or sensitive:[] to state that nothing on this row is PII. There is no
  default — the framework cannot tell a free-text 'body' holding a customer's
  address from one holding a build log.

## authz

- `authz/rowpolicy-column-type`
  - resource '‹name›' declares `rowPolicy: "‹col›"` but its schema has no
    '‹col›' — the ownership shorthand names a column of THIS resource, and a
    name the table lacks is a rule that matches no row
  - resource '‹name›' declares `rowPolicy: "‹col›"` but '‹col›' is a ‹string›
    column — the shorthand lowers to `‹col› = <actor.id>` and an actor id is a
    string, so every authenticated read would fail in the database rather than
    narrow. Name a string column that carries ownership, or write the rule as a
    fragment.
- `authz/rowpolicy-key` — boot.rowPolicies names '‹key›', which is declared in
  ‹length› places (‹candidates›) — a bare name cannot pick between same-named
  resources in different schemas. Qualify as `module:name`.
- `authz/rowpolicy-single-source`
  - boot.rowPolicies['‹name›'] would SHADOW the rowPolicy the '‹name›'
    declaration already carries — the declaration is the single authoritative
    source. Move the logic into the declared rowPolicy (it can close over module
    state), or drop the injection; the injection lane exists only for
    boot-state-dependent policies on resources that declare none.
  - boot.rowPolicies names '‹key›', but no resource '‹name›' in module '‹mod›'
    exists — a typo'd injection would silently protect nothing. Known resources:
    ‹join›.
  - boot.rowPolicies names '‹key›', but no resource with that name exists — a
    typo'd injection would silently protect nothing. Known resources: ‹join›.

## config

- `config/unknown-key`
  - 'auth' is not a defineConfig key — pass it on the boot seam:
    createApp(config, { auth })
  - unknown config key '‹k›' — a typo'd knob silently keeps its default; the
    legal keys are the defineConfig surface
  - unknown key '‹k›' on config.‹parent› — the card is { ‹join› }

## cors

- `cors/origins-required` — config.http.cors declares an empty origins list — a
  card that allows nothing is the same wire behaviour as no card at all, reached
  by a longer route. Drop the card to keep the closed door, or name the origins
  a browser may read this app from.
- `cors/wildcard-credentials` — config.http.cors pairs origins: ["*"] with
  credentials: true — a browser DROPS the credentials on a wildcard origin, so
  this declares an exchange that never happens. Name the origins a credentialed
  caller may come from: origins: ["https://app.example"]. If this app has no
  credentialed cross-origin caller, the wildcard alone already describes it —
  the credentials line is the one that does not.
- `cors/wildcard-with-list` — config.http.cors lists "*" beside ‹length› named
  origin(s) — the wildcard already admits them, so the list reads as a
  restriction it does not impose. Keep the wildcard alone, or drop it and keep
  the names.

## cursor

- `cursor/malformed` — a `cursor` page token that this app did not issue, or
  that no longer matches the query it came from

## datasource

- `datasource/one-statement` — ctx.datasource('‹name›') refuses a
  multi-statement query — one statement per query

## datasources

- `datasources/missing-connection` — datasource '‹name›' is declared in
  config.datasources but has no live connection in boot.datasources — provide
  boot.datasources['‹name›'] (a Db built from ‹url›), or remove the declaration.

## decl

- `decl/path-invalid`
  - resource '‹resource›' path must be a non-empty segment (e.g. path:
    "entries"), not empty
  - resource '‹resource›' path '‹path›' must be a bare segment — write path:
    "entries", not "/entries"
  - resource '‹resource›' path '‹path›' — ‹name›
  - resource '‹resource›' path '‹path›' is a framework route segment (reserved:
    ‹join›) — pick another path so CRUD does not share a URL with /‹path›
  - resource '‹name›' path must be a string segment (e.g. path: "entries")
- `decl/shape-required`
  - a resource declaration has no `name` — every derived face (table, route,
    tool, invariant) is keyed by it, so nothing can be composed without one
  - resource '‹unnamed›' has no `schema` — declare one with
    `schema: z.object({ … })`; the columns, the wire shapes and the fixtures all
    derive from it
- `decl/unknown-key`
  - resource '‹resource›' declares the transition '‹from›' → '‹e›' twice — one
    edge per (from, to); use the edge object form if the second listing carries
    a guard
  - unknown key '‹k›' on resource '‹resource›' transitions edge '‹from›' — the
    edge card is { to, guard, onExit, onEnter }
  - resource '‹resource›' transitions edge from '‹from›' carries no string 'to'
    — an edge object must name its target state
  - resource '‹resource›' declares the transition '‹from›' → '‹to›' twice — one
    edge per (from, to)
  - resource '‹name›' mcp tool '‹tool›' shape picks output field '‹field›',
    which is not part of the read shape — the pick is applied by name, so the
    tool would advertise a projection that resolves to nothing. Available
    fields: ‹join›
  - resource '‹name›' http route '‹verb›' declares 'columns', but only the read
    verbs (‹join›) return a row — a write returns an id/updated envelope and a
    custom op's return is the handler's own contract
  - resource '‹name›' http '‹verb›' columns names '‹col›', which is not a column
    of the read shape. Available fields: ‹join›
  - unknown declaration key '‹k›' on view '‹name›'‹steer›

## declaration

- `declaration/resource-schema` — '‹name›' declares no schema — every column,
  DDL, and read face derives from it

## deps

- `deps/module-exists` — module '‹name›' declares dep '‹dep›', which is not a
  declared module — add defineModule({ name: '‹dep›', … }) or fix the typo

## encrypted

- `encrypted/equality-cutover`
  - resource '‹name›' has no unique equality field to cut over
  - pageSize must be a positive safe integer
- `encrypted/equality-cutover-cas` — resource '‹name›' row '‹id›' changed during
  the cutover
- `encrypted/equality-cutover-duplicate` — resource '‹name›' still has a
  duplicate canonical unique tuple (‹join›)
- `encrypted/equality-cutover-kms`
  - resource '‹name›' needs a KMS that reports its canonical equality key
    identity so the durable canonical token can be identified
  - resource '‹table›' field '‹field›' was cut over to '‹canonicalKeyId›', but
    its KMS does not report a canonical equality key identity to prove the
    configured key
  - resource '‹table›' field '‹field›' was cut over to '‹canonicalKeyId›', but
    the configured KMS reports '‹actual›'
- `encrypted/equality-cutover-transaction` — resource '‹name›' needs a
  transaction-capable Db for equality-index writes so its cutover lock spans the
  write
- `encrypted/equality-macs` — resource(s) ‹join› declare equality-searchable
  encrypted fields but no KMS with equalityMacs is wired. Supply defineConfig({
  encryptionKey }) (the app-key KMS floor), or inject an external KMS that
  implements equalityMacs. Refusing to boot: the <field>_bidx blind index needs
  a keyed MAC on both writes and equality queries; accepting this app would
  defer a deterministic configuration defect until its first use.
- `encrypted/equality-macs-empty`
  - resource '‹name›' equality field '‹field›' received no equality MAC from its
    KMS adapter
  - resource '‹table›' equality field '‹f›' received no equality MAC from its
    KMS adapter
- `encrypted/equality-not-encrypted` — resource '‹name›' declares
  equality-searchable '‹f›' but it is not an encrypted field — equality is the
  blind-index face OF an encrypted field
- `encrypted/id-app-minted` — resource '‹name›' declares encrypted fields with
  id: '‹idStrategy›' — a DB-allocated id is unknown at encrypt time, so the
  ciphertext cannot be sealed to its row position. Use the app-minted default
  (uuidv7) or drop the id override on this resource.
- `encrypted/key-source` — a resource declares 'encrypted' but no app master key
  is configured — supply defineConfig({ encryptionKey }) (base64, 32 bytes,
  sourced at the config site from a project-named env / secret store), or inject
  an external boot.kms. Refusing to boot: an unkeyed encrypted app cannot
  seal/read its fields, and the framework never auto-generates a key (a
  regenerated key orphans all existing ciphertext).
- `encrypted/no-rectifiable` — resource '‹name›' declares encrypted fields and
  immutable.rectifiable — rectify rebuilds the row from SELECT * and would
  persist ciphertext as if it were plaintext. Drop encrypted, or drop
  rectifiable.
- `encrypted/not-unique` — resource '‹name›' unique tuple includes encrypted
  column '‹col›' — an encrypted field is a per-value-DEK bytea envelope (a
  random nonce makes duplicate plaintexts always distinct), so a unique index
  over it never fires; declare '‹col›' in encrypted.equality (the unique index
  then rides its blind-index sidecar) or drop it from the unique tuple
- `encrypted/unique-rotation` — resource '‹table›' equality field '‹f›'
  participates in a unique constraint, but its KMS exposes ‹length› equality MAC
  versions — refusing this write because one blind-index column cannot enforce
  plaintext uniqueness across key versions

## event

- `event/consumer-named`
  - a ‹kind› on topic '‹topic›' declares no `name` — the durable cursor is keyed
    on it, so an unnamed consumer has no identity that survives a reformat, a
    minifier or a Deno upgrade. Give it a stable name.
  - a ‹kind› on topic '‹topic›' declares `name: "‹name›"` — the `webhook:` and
    `task:` prefixes belong to the consumers this framework derives from
    `webhooks` and `tasks`, and sharing one means sharing their cursor. Pick
    another name.
  - two `‹defineWebhook›` declarations both name '‹value›', so both derive the
    consumer '‹name›' on topic '‹topic›' — the fence is `(consumer, msg_id)`, so
    they share one cursor and every message reaches only one of them while the
    other is permanently fenced out. Rename one.
  - two consumers on topic '‹topic›' both declare `name: "‹name›"` — the fence
    is `(consumer, msg_id)`, so they share one cursor and each message reaches
    only one of them. Rename one.
- `event/emit-topic-unique` — topic '‹topic›' carries a typed payload
  declaration in more than one module — one topic, one producer contract

## file

- `file/id-app-minted` — resource '‹name›' declares file() fields with id:
  '‹idStrategy›' — a DB-allocated id is unknown when the storage key is minted,
  so the key cannot be scoped to its row. Use the app-minted default (uuidv7) or
  drop the id override on this resource.
- `file/not-encrypted` — resource '‹name›' declares file() field '‹f›' as
  encrypted — a storage key is an opaque handle (encrypting it buys nothing),
  and on hard-delete the GC cannot read the bytea envelope to reclaim the
  off-box bytes (they orphan); drop 'encrypted' on '‹f›'
- `file/storage-required` — a resource declares a file() field but no storage
  driver is configured — pass createApp(config, { ..., storage }) with
  localDriver({ dir, serveBase }) (self-host — 'serveBase' names the route YOUR
  app serves the bytes on) or stubStorage() from "hazelnut/test.ts" (tests). For
  cloud object storage the framework ships NO built-in driver — StorageDriver is
  the Port you fill. Refusing to boot: file() keeps only the opaque key in-row
  and the bytes live off-box, so a file app with no driver cannot read or write
  its files. Unlike 'encrypted' there is NO default — the framework never
  silently writes bytes to local disk (a hidden second store would orphan on a
  fresh box).

## http

- `http/columns-not-redacted` — resource '‹name›' http '‹verb›' columns names
  '‹col›', which the output chokepoint drops (sensitive ∪ encrypted ∪ the minted
  <f>_bidx) — the projection would promise a field every response omits; remove
  it from columns, or remove it from sensitive/encrypted
- `http/columns-required`
  - resource '‹name›' exposes mcp '‹verb›' with no http twin and no `shape` —
    the projection falls back to id + schema keys, which is the default this
    rule refuses on every other read door. Name the WHOLE response: mcp: {
    ‹verb›: { shape: ["id", …] } }, or declare the http twin's columns for both
    doors to ride.
  - resource '‹name›' ‹via› — a missing positive wire projection defaults to
    id + schema keys and is refused. Name the WHOLE response: { policy:
    "‹mode›", columns: ["id", …] }
  - view '‹name›' is exposed (‹join›) with no `columns` — the projection
    defaults to every column of '‹over›', which is the default this rule refuses
    on every other read door. Name the WHOLE response: columns: ["id", …]
- `http/max-body-bytes` — http.maxBodyBytes must be a positive integer
- `http/request-timeout-ms` — http.requestTimeoutMs must be 0 (off) or an
  integer number of milliseconds between 1 and 2147483647

## job

- `job/name-duplicated` — ‹join› all sanitize to the same Deno.cron registration
  name ('‹safe›') — Deno.cron permits one registration, so ‹job›.

## mcp

- `mcp/gate-declared` — the served MCP tool catalogue has no declared reader
  posture — state who may reach the door with `mcp.gate: "<perm>"`, or say the
  catalogue is open with `mcp.gate: null`
- `mcp/origin-declared` — the served MCP tool door has no declared
  browser-Origin posture — state the allowed origins with
  `mcp.allowedOrigins: […]`, or say the door is open with
  `mcp.allowedOrigins: null`
- `mcp/reserved-input`
  - resource '‹name›' tool '‹opName›' declares mcp version.echo:"required" AND
    an input field '_toolVersion' — that name is the reserved version-echo
    channel (peeled before input validation), so the field would be silently
    masked; rename it
  - resource '‹name›' idempotent MCP tool '‹opName›' declares an input field
    '_idempotencyKey' — that name is the framework replay-key channel (peeled
    before input validation), so the field would be silently masked; rename it
- `mcp/runtime-gate-required` — defineConfig({ mcp: { runtime } }) declares the
  runtime projection with an empty gate — the operator read floor (relay/dlq) is
  never ungated. Name the perm a caller must hold — and one the vocabulary
  carries, since authz/gate-resolves refuses a dangling one: either a derived
  <resource>:<verb> key, or an operator key declared with perms: definePerms({
  system: ["ops"] }) and gated as { runtime: { gate: "system:ops" } }. Or remove
  the runtime block.
- `mcp/shape-array`
  - resource '‹name›' mcp tool '‹tool›' declares a non-array shape — resource
    mcp shapes are field-pick arrays only. Use defineView({ shape: (row) => ({ …
    }), mcp: { describe: "…" } }) for a pure compute/rename read view; it is a
    separate, post-redaction tool surface.
  - resource '‹name›' mcp tool '‹tool›' declares a shape with a non-string field
    — resource mcp shapes are arrays of output-field names. Use defineView for a
    compute/rename read view.
- `mcp/tool-name-collision` — MCP tool name(s) minted more than once: ‹join› —
  the <module>**<name>**<op> FQN must be unique across resource ops AND
  defineView tools (a view projects <module>__<view>**view; a cross-source
  run-form view projects app**<view>__view). Rename the colliding declaration.
- `mcp/version-in-shape` — resource '‹name›' mcp tool '‹tool›' declares a shape
  that omits 'version' — '‹name›' is versioning:true and MCP carries no If-Match
  header, so 'version' in the shape is the only way an agent can supply the
  update/delete CAS precondition; add 'version' to the shape

## migrate

- `migrate/hash-stable`
  - applied migration '‹dir›' changed hash (‹prev› → ‹hash›) — restore the file
    or re-baseline
  - applied migration '‹dir›' changed hash (‹recorded› → ‹sql›) — restore the
    file before rebasing
- `migrate/legacy-shape` — "‹table›" carries the retired (‹legacyPk›) primary
  key — the canonical key is (‹canonicalPk›). ‹degrade› Refusing to apply over
  the legacy shape: reset the dev database ('hazelnut migrate <app> reset') or
  re-key the table by hand, then re-apply.

## op

- `op/deadline-ms` — ‹at› deadlineMs must be 0 (off) or an integer number of
  milliseconds between 1 and 2147483647
- `op/decisions-written` — resource '‹name›' declares op(s) leaving a pipeline
  decision unmade — ‹join›. Refusing to boot: an op with no 'input' schema
  mounts its route and then fails inside validation on the first caller, an op
  with no 'policy' runs for ANY caller the route admits, including an anonymous
  one (null is how you say the door is deliberately public), an op with no 'tx'
  used to fall through to a write transaction, so a read-only handler held locks
  it never needed and no read replica could serve it, and a write with no
  'idempotent' verdict re-runs its handler on a retried Idempotency-Key instead
  of replaying the first result — a charge twice, a mail sent twice. Write all
  four on the declaration: input: z.object({ ... }), tx: "read" | "write",
  policy: requires("‹name›:<op>") | null, and idempotent: true | false on every
  op that is not tx:"read". Authoring the op through defineOp({ ... }) makes the
  same omission a compile error.
- `op/idempotency-lease-ms` — ‹at› idempotencyLeaseMs must be a finite number of
  milliseconds between 1 and 2147483647

## otlp

- `otlp/interval-ms` — intervalMs must be a finite number of milliseconds
  between 1 and 2147483647
- `otlp/max-queue` — maxQueue must be a positive integer

## outbox

- `outbox/gauge-ttl-ms` — outbox.gaugeTtlMs must be a non-negative integer
- `outbox/max-ready-backlog` — outbox.maxReadyBacklog must be a positive integer

## owns

- `owns/child-exists` — '‹name›.‹rel›' owns unknown resource '‹to›'
- `owns/name-ambiguous` — an `owns` relation names a resource that is declared
  in more than one module schema, and a bare name cannot pick between same-named
  resources in different schemas. Rename one of them.
- `owns/no-self` — '‹name›.‹rel›' cannot own itself
- `owns/same-module` — '‹name›.‹rel›' owns '‹to›' across modules — owned
  children are intra-module (cross-module is a by-id reference, not ownership)
- `owns/single-parent` — '‹to›' is owned by both '‹parent›' and '‹name›' — a
  child has at most one owning parent

## page

- `page/cursor-key-mismatch`
  - cursor has ‹length› column(s); orderBy has ‹length›
  - cursor column '‹value›' does not match orderBy '‹i›'
- `page/offset-with-keyset`
  - a read cannot paginate by both cursor and offset — `offset` was passed
    alongside `after`, and a keyset read is positioned by its cursor. Drop
    `offset`, or drop the cursor and page by offset alone.
  - a read cannot paginate by both cursor and offset — `offset` was passed
    alongside `orderBy`, and a keyset read is positioned by its cursor. Drop
    `offset`, or drop the cursor and page by offset alone.
  - a read cannot paginate by both cursor and offset. Drop `offset`, or drop
    `after`.

## password

- `password/field-exists` — ‹site› binds ‹role› field '‹name›', which is not a
  column on '‹userResource›'
- `password/field-is-password` — ‹site› binds passwordField '‹name›', which is
  not a password() field on '‹userResource›' — the hash column must be a
  declared password() field
- `password/login-scope-resolution` — identity '‹userResource›' is scope:true
  and login is public/pre-auth — lookups AND scope_key from the request's
  resolved scope (ctx.scope). An empty scope does not search every tenant.
  Declare scopeFrom: "request" on passwordLogin and resolve scope from the
  request (host / claim), never by scanning identifiers across scopes.
- `password/schema-matches` — ‹site› binds schema '‹boundSchema›' but resource
  '‹userResource›' lives in pg schema '‹pgSchema›' — the auth lookup would query
  the wrong table‹name›
- `password/throttle`
  - throttle.max must be a positive integer
  - throttle.windowSec must be a finite number of seconds between 1 and 2147483
- `password/ttl`
  - accessTtlSec ‹accessTtlSec› exceeds the 900s ceiling — a stateless access
    token cannot be revoked before it expires, so this bound is how long a
    revoked session may stay live. Ask for 900 or less; revocation rides the
    refresh layer.
  - accessTtlSec must be a positive integer
  - refreshTtlSec must be a positive integer
- `password/user-resource-exists` — ‹site› binds userResource '‹userResource›',
  which is not a declared resource

## policy

- `policy/effect-not-allowed` — ctx.‹door› is unavailable during authorization
  policy evaluation; policies may inspect reads only
- `policy/read-protected`
  - resource '‹name›' exposes ‹face› but ‹gap› — a "policy" read is served to
    any authenticated/remote caller with exactly the rowPolicy conjunct the
    declaration yields. Refusing to boot: narrow the read. If the rule is
    OWNERSHIP, name the column and stop — rowPolicy: "owner_id", one line and no
    import, and it denies the anonymous caller for you. Anything more than
    ownership takes owned/withinScope/relate, or an isAnonymous(actor) ? none()
    : … branch, with those fragments on "hazelnut/query". A null-check in front
    of { owner_id: actor.id } shares one bucket across every anonymous caller.
    If every caller who gets this far is MEANT to see the same rows (a
    catalogue, a directory, a tenant's shared table), say so: rowPolicy: () =>
    shared() from "hazelnut/query" instead of all(), or () =>
    shared(<condition>) for the same decision over a fixed subset — each lowers
    identically to the un-marked form and is the written decision. features:{
    scope:true } does NOT discharge this: scope partitions the tenant boundary,
    never two callers within it. An anonymous caller reaches the policy as a
    NON-NULL actor holding no claim, so a null-check guarding all() narrows
    nobody; test it with isAnonymous(actor) ("hazelnut/authz/auth.ts").
    Rewriting the read to '"public"' is not that fix: it declares the rows are
    meant for every caller, agent and crawler, and drops the narrowing this is
    asking for.
  - view '‹name›' is a run-form view ‹door› but ‹gap› — a run-form view's
    rowPolicy is not a row filter, it is the dispatch-time ALLOW/DENY gate, and
    it is the whole gate: the view's own 'run' body reaches its sources without
    re-applying their rowPolicies. Refusing to boot: make the gate SHUT for a
    caller holding nothing — rowPolicy: (actor) => can(actor, "<r>:<claim>") ?
    all() : none() (none/all on "hazelnut/query"). A top-level answer that is
    not none() admits everyone, anonymous callers included. Dropping the view's
    'mcp' card also closes it — a view with no mcp card is invisible to agents.
  - view '‹name›' (over '‹name›') is ‹door› but ‹gap› — a view is its OWN read
    door: the source resource's rowPolicy is NOT re-applied to it, so a narrowed
    resource read and a wide-open view over the same table are served side by
    side to the same agent. Refusing to boot: give the view a rowPolicy that
    yields no rows for an anonymous caller and an ownership / scope-value /
    grant fragment for the rest — rowPolicy: "owner_id" or owned(...), with
    none/owned/withinScope/relate on "hazelnut/query". If every caller who
    reaches this tool is MEANT to see the same rows, say so with rowPolicy: ()
    => shared() / () => shared(<condition>) from "hazelnut/query" — it lowers
    identically and is the written decision. features:{ scope:true } does NOT
    discharge this: scope partitions the tenant boundary, never two callers
    within it. An anonymous caller reaches the policy as a NON-NULL actor
    holding no claim, so a null-check guarding all() narrows nobody; test it
    with isAnonymous(actor) ("hazelnut/authz/auth.ts"). Dropping the view's
    'mcp' card also closes it — a view with no mcp card is invisible to agents.
- `policy/write-protected` — resource '‹name›' exposes ‹face› but ‹gap› — the
  write WHERE is 'id = $1 AND (<rowPolicy>)', so a vacuous policy makes the
  grant '‹grant›' authority over EVERY row, not the caller's. A row id is not an
  authorization: ids travel in URLs, webhook payloads, foreign keys and audit
  exports. Refusing to boot: give the resource a rowPolicy that yields no rows
  for an anonymous caller and an ownership / scope-value / grant fragment for
  the rest — rowPolicy: "owner_id" or owned(...), with
  none/owned/withinScope/relate on "hazelnut/query". If every caller who holds
  the grant is MEANT to write the same rows (a shared queue, a team wiki),
  rowPolicy: () => shared() from "hazelnut/query" instead of all(), or () =>
  shared(<condition>) for the same decision over a fixed subset — each lowers
  identically and is the written decision. features:{ scope:true } does NOT
  discharge this: scope partitions the tenant boundary, never two callers within
  it. An anonymous caller reaches the policy as a NON-NULL actor holding no
  claim, so a null-check guarding all() narrows nobody; test it with
  isAnonymous(actor) ("hazelnut/authz/auth.ts"). The same rowPolicy governs the
  read faces; there is no write-only slot. A hidden row matches 0 rows and
  returns the ordinary not-found, never a cross-owner mutation.

## push

- `push/observation-required`
  - push.topics must declare topic observation policies
  - '‹topic›' requires an observe function
- `push/route-collision` — /events belongs to the declared push surface; choose
  another resource path
- `push/rows-list` — '‹topic›' rows.resource '‹resource›' must expose http.list
  — the channel reuses that projection
- `push/rows-resource`
  - '‹topic›' rows.resource '‹resource›' is not a declared resource
  - '‹resource›' is not a composed resource
- `push/rows-shape` — '‹topic›' rows must be { resource } naming one resource
- `push/topic-resolves` — '‹topic›' must be a declared emits topic with a
  URL-safe name
- `push/unknown-key`
  - push accepts only topics
  - '‹topic›' accepts only observe, rows
  - '‹topic›' rows accepts only resource

## read

- `read/limit-valid` — ‹n› is not a non-negative finite integer — a malformed
  page is a validation error, never an unbounded query
- `read/page-limit` — a paged read needs a positive limit — a zero-row page
  cannot carry the continuation its hasMore promises

## readmodel

- `readmodel/duplicate-name` — two read-models are named '‹name›' — projection
  table names must be unique
- `readmodel/name-collision` — read-model '‹name›' collides with a resource of
  the same name — the projection table would alias the resource table
- `readmodel/name-shape` — read-model '‹name›' starts with a digit — the prod
  drizzle-generate emits the projection as a JS `const`, which cannot start with
  a digit
- `readmodel/placement` — read-model '‹name›' is declared at app level but its
  source '‹source›' belongs to module '‹owner›' — move it onto that module
  (`defineModule({ …, readModels: [‹name›] })`), so `Ctx<typeof ‹owner›>` types
  `ctx.readModels.‹name›` instead of leaving it an untyped Record
- `readmodel/reserved-name` — read-model '‹name›' is _-prefixed — that namespace
  is reserved for framework tables; a '_'-named projection aliases a framework
  _* table in dev and collides with its drizzle const in prod
- `readmodel/rowpolicy-required` — read-model '‹name›' ‹why›. Declare the
  projection's own actor gate — rowPolicy: (actor) => can(actor, "…") ? all() :
  none() (none/all on "hazelnut/query") — or drop the projection. The gate is
  all-or-nothing: a materialized row is actor-independent, so it must SHUT for
  an anonymous caller. There is no default: the framework cannot tell which of
  the source's callers the denormalized shape was built for.
- `readmodel/source-ambiguous` — read-model '‹name›' names source '‹source›',
  which is declared in ‹length› places (‹join›) — a projection must name one
  resource, and a bare name cannot pick between same-named resources in
  different schemas. Rename one of them, or drop the projection.
- `readmodel/source-exists` — read-model '‹name›' has source '‹source›', which
  is not a declared resource
- `readmodel/source-in-module`
  - read-model '‹name›' is declared on module '‹module›' but its source
    '‹source›' is declared at app level — a projection lives where its source
    lives, so leave it in the app-level `readModels:` slot, or move '‹source›'
    onto module '‹module›'
  - read-model '‹name›' is declared on module '‹module›' but its source
    '‹source›' belongs to module '‹owner›' — a projection lives with the
    resource it projects, or it reads across a boundary the module graph forbids

## references

- `references/field-exists` — '‹name›.‹field›' is not a schema column
- `references/name-ambiguous` — a `references` field names a resource that is
  declared in more than one module schema, and a bare name cannot pick between
  same-named resources in different schemas. Rename one of them.
- `references/same-module` — '‹name›.‹field›' references '‹to›' across modules —
  a typed ref() would emit a cross-schema FK. Use refById('‹home›.‹to›') to
  store the id without an FK.
- `references/target-exists` — '‹name›.‹field›' references unknown resource
  '‹to›'

## relates

- `relates/junction-collision` — junction '‹jname›' in schema '‹pgSchema›'
  collides with resource '‹name›' — the pair (‹left›, ‹right›) would mint a
  table that resource already owns. Rename the resource, or associate by-id.
- `relates/name-ambiguous` — a `manyToMany()` relation names a resource that is
  declared in more than one module schema, and a bare name cannot pick between
  same-named resources in different schemas. Rename one of them.
- `relates/no-self` — '‹name›' relates to itself — a manyToMany() junction
  cannot join a table to itself. Split the pair, or store the association as a
  by-id column.
- `relates/same-module` — '‹name›' relates to '‹target›' across modules — a
  manyToMany() junction would be a cross-schema FK, forbidden by the module
  boundary. Associate across modules BY-ID via an exposesRead read-view
  (ctx.reads.<dep>.<view>), not manyToMany()
- `relates/target-exists` — '‹name›' relates to unknown resource '‹target›'

## relay

- `relay/batch` — batch must be a positive integer
- `relay/decision-written` — async features declared (‹join›) but NO drain is
  wired on this boot — the outbox will fill and these will NEVER fire on a
  serve-only deploy. Declare it: relay: "in-process" (single-process — this boot
  drains its own outbox), or relay: "external" (you run a separate
  `hazelnut relay <app> --loop` process / cron drain).
- `relay/handler-timeout-ms` — handlerTimeoutMs must be a finite number of
  milliseconds between 1 and 2147483647
- `relay/health-port`
  - --health-port must be an integer port between 1 and 65535
  - healthPort must be an integer port between 1 and 65535
- `relay/interval-positive`
  - --interval must be a finite number of milliseconds between 1 and 2147483647
  - loop intervalMs must be a finite number of milliseconds between 1 and
    2147483647
  - boot.relay.intervalMs must be a finite number of milliseconds between 1 and
    2147483647
- `relay/max-attempts`
  - '‹name›' maxAttempts must be a positive integer
  - maxAttempts must be a positive integer
- `relay/max-cycles` — maxCycles must be a positive integer
- `relay/stall-budget`
  - stallBudget.maxCumulativeAttempts must be a positive integer
  - stallBudget.maxHeadAgeMs must be a positive integer

## rollups

- `rollups/child-exists` — '‹name›.‹column›' counts unknown resource '‹count›'
- `rollups/field-exists` — '‹name›.‹column›' (‹kind›) aggregates '‹field›', not
  a column of '‹count›'
- `rollups/needs-child` — '‹count›' must be owned by '‹name›' via owns
  (hasMany/hasOne) to be counted by '‹name›.‹column›'
- `rollups/needs-field` — '‹name›.‹column›' (‹kind›) needs a child column — e.g.
  ‹kind›(‹count›, "<field>")
- `rollups/no-sensitive` — '‹name›.‹column›' (‹kind›) exposes SENSITIVE child
  field '‹field›' of '‹count›' through the un-redacted parent rollup column —
  ‹kind› over a sensitive value leaks it (min/max directly, sum/avg via a
  create/update delta); drop the rollup or aggregate a non-sensitive field
- `rollups/numeric-field` — '‹name›.‹column›' (‹kind›) aggregates
  un-aggregatable child field '‹field›' of '‹count›' (pg type '‹pg›'‹bytea›) — a
  rollup aggregates PLAINTEXT NUMBERS only (an encrypted bytea envelope, a
  file() text key, or any text/date/bool corrupts sum→NaN or crashes
  avg/min/max); aggregate a plaintext numeric column or drop the rollup
- `rollups/scope-match` — '‹name›.‹column›' rolls up UNSCOPED child '‹count›'
  into a SCOPED parent — an unscoped child can point its parent FK at another
  scope's parent and skew that scope's aggregate; declare 'scope:true' on
  '‹count›' or drop 'scope' from '‹name›'

## safe-fetch

- `safe-fetch/https-required` — '‹origin›' is not https — an outbound call
  travels the open network; pass allowInsecureHttp: true only for a dev receiver
  you own.

## scaffold

- `scaffold/pin-required` — no framework pin — pass --local
  <framework-repo-path> (auto-derived when the CLI runs from a checkout),
  --vendor, or --pin <registry-specifier>

## scheduler

- `scheduler/decision-written` — this app depends on the feature scheduler
  (‹join›) but the boot declares no scheduler choice — these sweeps/purges NEVER
  run on this process and their tables grow without bound (the default
  throttle/idempotency floors alone make every served app scheduler-dependent).
  Declare it: scheduler: "in-process" (createApp wires
  startFeatureScheduler(app, db) onto Deno.cron — the serve command needs
  --unstable-cron), or scheduler: "external" (you run startFeatureScheduler(app,
  db) in a separate scheduler process).
- `scheduler/job-ctx-required` — job '‹name›' declares resources, so its handler
  needs the db-bound ctx — this scheduler was built without an app and has none
  to give it
- `scheduler/unstable-cron` — Deno.cron is unavailable (run with
  --unstable-cron) — feature TTL sweeps + expiry purge would silently no-op. Add
  --unstable-cron to the serve command (the scaffold does), or declare
  scheduler: "external" and drive the sweeps from a separate process.

## scheduling-cap

- `scheduling-cap/max`
  - schedulingCap.cap.max must be a positive integer
  - schedulingCap.emitCap.max must be a positive integer
- `scheduling-cap/window-sec`
  - schedulingCap.cap.windowSec must be a finite number of seconds between 1 and
    2147483
  - schedulingCap.emitCap.windowSec must be a finite number of seconds between 1
    and 2147483

## schema

- `schema/fk-cycle` — typed references cycle ‹cycle› — refuse at boot (a cycle
  FK cannot CREATE TABLE in order). Break an edge with refById, or drop one
  reference.
- `schema/unmappable` — '‹name›.‹name›' is a Zod ‹type› — that wrapper used to
  land as silent text. Pin dbType() or store jsonb.

## scope

- `scope/resolver-constant` — the app scope resolver answered two DIFFERENT
  synthetic requests (different actor, url, host and headers) with the SAME
  scope value, so every request resolves to that one value and the scope
  conjunct partitions nothing — the same silent no-op as wiring no resolver at
  all. Refusing to boot: derive the scope from the authenticated actor (e.g.
  resolve: ({ actor }) => actor?.orgId ?? ""), or from a server-trusted request
  axis such as Host — never a caller-controlled header (a header is spoofable).
  If this app genuinely has one partition, drop 'scope:true'; per-row visibility
  is the rowPolicy's job either way, since scope partitions the tenant boundary
  and never two callers within it.
- `scope/resolver-header-spoofable` — the app scope resolver answered two
  requests that differed ONLY in headers (same actor, same url/host) with
  DIFFERENT scope values — that means a caller-controlled header is choosing the
  tenant partition. Refusing to boot: derive the scope from the authenticated
  actor (claims / withTenant), or from a server-trusted request axis such as
  Host. An `x-org` (or any client-set) header lets a caller cross scopes by
  editing the request.
- `scope/resolver-required` — a resource declares 'scope:true' (opting into
  row-scoping) but no app scope resolver is wired (defineConfig({ scope: { key,
  resolve } })) — every row would share the empty scope and tenancy would NOT
  isolate. Refusing to boot the silent no-op: declare a config.scope resolver to
  supply the per-request scope value.
- `scope/resolver-url-spoofable` — the app scope resolver answered differently
  when only the request path or query changed — a caller can choose the tenant
  partition by editing the URL. Refusing to boot: derive scope from the
  authenticated actor (claims / withTenant), or from a server-trusted Host that
  the deployment ingress validates; do not use pathname or query parameters as
  the scope authority.

## sequence

- `sequence/pad` — sequence.pad must be a non-negative integer
- `sequence/start` — sequence.start must be a safe integer

## singleton

- `singleton/no-tree` — '‹name›' declares BOTH singleton and tree — a singleton
  is one row (per scope) and cannot form a hierarchy (a tree needs a parent_id
  self-reference over many rows); drop one feature

## tamper

- `tamper/key-source`
  - resource(s) ‹join› declare immutable:{ tamperEvident } but no HMAC-capable
    app key or KMS is configured — the chain is HMAC-SHA-256 under HKDF
    (chain-version v1). Supply defineConfig({ encryptionKey }) (base64, 32
    bytes, sourced at the config site from a project-named env / secret store),
    or inject an external boot.kms with equalityMacs. Refusing to boot: a KMS
    that only wraps envelopes cannot sign the chain, and an unkeyed chain cannot
    detect a rewrite by anyone who can recompute SHA-256. Existing unkeyed
    ledgers must re-baseline or re-anchor (tamper/chain-version).
  - KMS returned no MAC for purpose '‹purpose›'
  - resource '‹name›' is tamperEvident but no HMAC signer is bound — supply
    defineConfig({ encryptionKey }) or a KMS with equalityMacs

## task

- `task/storage-threshold` — taskResults.storageThreshold must be a non-negative
  integer

## temporal

- `temporal/overlap-cols-local`
  - resource '‹name›' temporal.noOverlap references '‹c›', not a declared LOCAL
    column of this resource — the exclusion key is over the resource's own
    fields
  - resource '‹name›' temporal.noOverlap references encrypted field '‹c›' — an
    encrypted envelope cannot equality-partition an exclusion constraint

## throttle

- `throttle/limit` — limit must be a non-negative integer
- `throttle/store-coordinated` — the bound db is not a Transactor, so the
  born-on rate limit cannot hold its counter in a shared row — every replica
  would keep its own budget and the effective limit becomes N times what you
  declared. Bind a Transactor db (pgliteDb / postgresDb), or say single-instance
  out loud: createApp(config, { db, rateLimitStore:
  defaultMemoryRateLimitStore() }).
- `throttle/window-sec` — windowSec must be a finite number of seconds between 1
  and 2147483

## transitions

- `transitions/tamper-immutable` — resource '‹name›' declares transitions AND
  immutable:{ tamperEvident } — ctx.transition writes status without re-stamping
  the hash chain, so the first transition silently breaks the chain (a real
  tamper then reads the same as a sanctioned status change); drop transitions,
  or drop tamperEvident (a mutable status FSM cannot ride an append-only
  tamper-evident ledger)

## tree

- `tree/no-cycle` — refuse a looping parent_id before any write

## tx

- `tx/read-op-no-write` — this op is declared tx:"read" but wrote — declare
  tx:"write", or the READ ONLY tx refuses

## unique

- `unique/duplicate-cols` — ‹length› unique constraints in pg schema
  '‹pgSchema›' collide on the derived index name '‹indexName›' (‹join›) — the
  derived unique-index name is minted per pg schema, so
  `CREATE UNIQUE INDEX IF NOT EXISTS` keeps the FIRST and silently drops the
  rest (a dropped unique never exists; a partial predicate on one would weaken a
  full unique to partial). Give the colliding constraints distinct derived names
  (rename a resource, or declare at most one unique per column tuple).

## vector

- `vector/dims-positive` — '‹name›.vector' declares dims=‹dims› — an embedding
  width must be a positive integer
- `vector/embed-required` — resource(s) ‹join› declare a vector field but no
  embedding provider is configured — pass createApp(config, { ..., embed }) with
  openaiEmbed({ ... }) (a real provider) or stubEmbed() from "hazelnut/test.ts"
  (tests). Refusing to boot: a vector field needs the embed seam to embed new
  rows on write AND to embed the query text for similarity search, so a vector
  app with no embed can neither populate nor query its vectors — there is NO
  default (the framework never invents an embedding).
- `vector/field-free` — '‹name›.vector' mints column '‹field›', but a schema
  field already claims that name
- `vector/source-exists` — '‹name›.vector' embeds '‹source›', which is not a
  schema column
- `vector/source-not-encrypted` — resource '‹name›' embeds encrypted field
  '‹source›' — the source is sent to an external embedding provider, so this
  egresses decrypted plaintext off-box (or embeds meaningless ciphertext); drop
  'encrypted' on '‹source›' or embed a non-encrypted field
- `vector/source-not-sensitive` — resource '‹name›' embeds sensitive field
  '‹source›' — the source is sent to an external embedding provider, egressing a
  surface-redacted value off-box; embed a non-sensitive field

## version

- `version/enum-mapped`
  - version '‹version›' declares enums.‹field›, but '‹field›' is not an enum
    field of resource '‹resource›'
  - version '‹version›' does not handle current '‹field›' value '‹val›' — add it
    to enums.‹field›.known, map it, or mark the field tolerant
- `version/example-required` — version '‹version›' declares up() with no example
  — the boot check cannot prove the up-cast satisfies current; supply example,
  or drop up() for a read-only pin
- `version/field-live` — version '‹version›' reads current field '‹k›' in
  expose() but omits it from fields — migrate could contract '‹k›' from under
  this live version; add '‹k›' to fields
- `version/lossless-round-trips` — version '‹version›' is declared lossless but
  up(expose(x)) != x on a generated row — it loses information (‹e›); drop the
  lossless flag or store the lossy field
- `version/pin-resolves`
  - a defineVersion projecting resource '‹resource›' has an empty version pin
  - version '‹version›' projects resource '‹resource›', which is not a declared
    resource
  - duplicate version '‹version›' for resource '‹resource›' — two projections
    for one pin are ambiguous
- `version/required-supplied`
  - version '‹version›' declares a default for '‹k›', which is not a field of
    resource '‹resource›'
  - version '‹version›' up-cast of its example does not satisfy '‹resource›'
    current schema (missing/invalid: ‹bad›) — supply it in up() or declare a
    default
  - version '‹version›' up-cast threw on its own example: ‹e›
  - version '‹version›' up-cast of a generated valid input does not satisfy
    '‹resource›' current schema — some inputs miss a required field (‹e›);
    supply it in up() or declare a default
- `version/resource-ambiguous` — a `defineVersion` names a resource that is
  declared in more than one module schema, and a bare name cannot pick between
  same-named resources in different schemas. Rename one of them.
- `version/token-invalid` — expected version ‹v› is not an integer between 0 and
  ‹VERSION_MAX›
- `version/unknown-key` — version '‹version›' declares unknown key '‹k›' — a
  typo'd or retired knob is silently inert, so it is refused instead

## versioning

- `versioning/decision-written` — resource(s) ‹join› carry a mutable write face
  but state no concurrency posture — with 'versioning' unwritten,
  ctx.data.<r>.update issues a blind UPDATE, so of two callers who read the same
  row and each write it back, the second silently erases the first (a
  decremented balance restored, a resolved ticket re-opened). Refusing to boot:
  declare features:{ versioning: true } — the row gets a 'version' column,
  update REQUIRES the expected version, and a stale write is rejected rather
  than applied (read the row with findForUpdate to hold it) — or features:{
  versioning: false } to state that last-write-wins is correct for this row.
  There is no default: the framework cannot tell a counter whose value is
  derived from what it just read from a row every writer overwrites whole.

## view

- `view/columns-not-redacted` — view '‹name›' projects '‹col›', which the output
  chokepoint drops (sensitive ∪ encrypted ∪ the minted <f>_bidx) — name a
  projection outside the redact set
- `view/http-json-only` — view '‹name›' declares http with output: binary() —
  HTTP opt-in is the JSON row set
- `view/http-policy` — view '‹name›' http.policy must be "public" | "policy"
- `view/over-ambiguous` — a `defineView`'s `over` names a resource that is
  declared in more than one module schema, and a bare name cannot pick between
  same-named resources in different schemas. Rename one of them.
- `view/over-exists` — view '‹name›' is over unknown resource '‹over›'

## webhook

- `webhook/https-required`
  - webhook '‹name›' has an unparseable url '‹url›'
  - webhook '‹name›' targets ‹url› — an outbound webhook carries a signed
    payload over the open network. Point it at an https url (terminate TLS at
    the receiver, or in front of it). A receiver on your own dev machine is the
    one exception, and allowInsecureHttp: true is how this declaration says so,
    loudly and per webhook.
- `webhook/secret-required`
  - webhook '‹name›' has no secret — deliveries would be unverifiable by the
    receiver. Source one (env → config, the encryptionKey precedent), or declare
    sign: false explicitly.
  - webhook '‹name›' has no secret and sign !== false
- `webhook/topic-resolves` — webhook '‹name›' externalizes topic '‹topic›', but
  no module or app-level emits declares that emit — it would never deliver.
  Declared emits: ‹none›.

## wire

- `wire/response-shape` — '‹column›' is projected by ‹resource› but absent from
  the row — the physical table no longer carries it (DB drift); fix the drift,
  never ship a response missing a promised field

## workflow

- `workflow/scope-required` — resource '‹name›' is scoped — a workflow write
  with an empty scope would land in the empty partition. Name the scope on the
  starting op's ctx.

## zod

- `zod/format-canonical` — resource '‹name›' field '‹field›' is declared
  `z.string().‹chained›()` — write `‹chained›` instead. Both spellings compile
  and declare the same type, which is exactly why the chained one must not
  exist: it is the form a generator has seen most, and it is the form that
  derived a `text` column where the canonical one derives its real pg type.

<!-- refusals:end -->
