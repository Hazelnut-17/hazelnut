# Choose the right door

> **Reference** — for application authors choosing a supported ctx, HTTP, MCP or
> typed-client capability.

Hazelnut derives several faces from a declaration. Each face has a concrete
contract; a ctx method does not automatically create an HTTP route or MCP tool.
Use this reference with the [Rundown](./rundown.md) and the
[agent walkthrough](./agent-door.md). Unknown wire fields are refused rather
than interpreted as extra query capabilities.

## Reads, filters and pagination

| Concern          | ctx                                                                                  | HTTP and typed client                                                                                                           | MCP                                                                               |
| ---------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| List             | `data.<resource>.list(query)`                                                        | GET; client `list({where,limit,offset,after,sort,asOf?})`                                                                       | Curated `list` with `filter`, `sort`, `limit`, `offset`, `after`, temporal `asOf` |
| Rich read/search | `search(text,{asOf?})` uses the declared row policy; it has no caller-Where argument | QUERY body `{filter,search,sort,limit,offset,after,asOf?}`; client `query(...)` and searchable-resource `search(...)`           | Curated list admits `search` on a searchable resource                             |
| Count            | `count({where?,search?,asOf?})` returns a number                                     | Explicit `http.count`: GET `/<plural>/count?where=&search=&asOf=`; client `count(...)` returns the number                       | Explicit `mcp.count`: `{filter?,search?,asOf?}` returns `{count}`                 |
| Cursor envelope  | `listPage(page,where?)` returns `{items,hasMore,nextCursor?}`                        | Array plus `Hazelnut-Has-More`; safe cursor and/or offset headers. Client `{withCursor:true}` attaches those hints to the array | List returns `items`, `page`, `hasMore`, and continuation fields                  |
| Relations/graph  | `children`, `related`, `link`, `unlink`, `with`, `columns`, tree methods             | No automatic relation/graph routes or nested-create body                                                                        | No automatic relation/graph tools                                                 |

GET `where`, QUERY/MCP `filter`, and ctx `Where` are different grammars. Wire
filters are a flat column-to-scalar equality object. Do not send `q`, nested
`{eq:...}`, `include`, `expand`, or graph `with` to those endpoints. Range,
OR/NOT, grants and encrypted-equality queries belong to the typed ctx/Where
surface; encrypted fields remain absent from public filter vocabularies. Native
fields without value equality are absent too: `point`, `polygon`, `xml`, `box`,
`circle`, `path`, and arrays of these or `line`/`lseg`. Equality filters on
these fields return validation; geometric size equality is not a location match.
Scalar `line`/`lseg`, native case-insensitive `citext`, `interval`, and
supported arrays keep their PostgreSQL equality semantics. In typed ctx reads,
use `isNull` or null shorthand for a missing native value; these need no
equality operator. Framework-minted `deleted_at` is also absent from wire filter
and sort inputs: these reads return only live rows, so a selected marker is
always null. A same-named ordinary business field keeps its declared filtering
behavior. String-backed native fields take their declared PostgreSQL text input.
A bytea `Uint8Array` or native array read back from a row cannot be rebound as
that string input; convert intentionally or retain the original input text.
Bytea accepts PostgreSQL hex and historical escape/plain text; base64-looking
text stores its literal bytes. Bytea and inet[] text inputs use a batched native
validity SELECT before writes/caller-filter casts, so malformed input returns
validation without aborting the transaction. This needs PostgreSQL 16+ soft
input support; it is not a general parser for every native type. Nullable fields
still accept null and inet[] accepts its native empty-array text `{}`.

Keyset sorts admit delivered, non-null scalar columns. Binary, arrays, JSON/XML,
vectors, text-search and geometric/opaque native values are excluded from sort
advertisements and refused if forced through ctx `orderBy`.
`sort: {field,direction:"asc"|"desc"}` works on HTTP, MCP and ctx paging; ctx
also accepts ascending `orderBy`. Do not mix the two forms or mix `after` with
`offset`. `id` is the stable tie-breaker. Timestamp keys order and compare at
the millisecond precision their Date read face carries, with id ordering all
stored microseconds inside one visible millisecond. Continuation tokens are
bounded to 8192 encoded characters.

HTTP/MCP pages cap at 100. `listPage` defaults to 50 and caps at 100; a plain
unpaged ctx list, children read, or tree walk can be unbounded. Use explicit
bounds for large graphs. Every wire list fetches one extra row: even a full
final page reports no continuation. A cursor is available only when all key
values survive the final projection unchanged. HTTP always sends
`Hazelnut-Has-More`; offset requests with more rows also receive
`Hazelnut-Next-Offset`. Keyset requests cannot invent an offset when their
cursor is withheld. `hasMore` does not disclose a total. Count requires its own
explicit HTTP/MCP declaration; list exposure never grants it and there is no
`Prefer:count` contract. Count search is conditional on `searchable` and retains
the same row policy and scope without decrypting payload rows.

Empty full-text search does not mean an unfiltered list. Stored search vectors
are not an authorization bypass: search still applies the ordinary scope,
lifecycle and row-policy predicates. `z.bigint()` reads as bigint inside ctx and
as a decimal JSON string on the wire; use that declared wire form, never a
rounded JSON number.

## Historical reads and present grants

Temporal resources accept an ISO `asOf` instant on GET list/find, HTTP QUERY,
curated MCP list/find/count tools, and those typed-client methods. Count is a
separate explicit door. Invalid instants and `asOf` on a non-temporal wire
resource are validation failures. The MCP `resources/read` URI, views and their
client methods remain live-now. Selected ctx reads accept `{asOf}`:
list/count/find/byIds/children/related/search and graph reads. `listPage` and
tree ancestors/descendants/depth retain their own signatures and have no
historical instant argument.

Successful `ctx.data` creates return the row they wrote even for a future or
past temporal window. An update of a currently live row also returns its settled
image when it closes its own window before now. This acknowledgement does not
make that slice visible to an ordinary current read or authorize updating an
already future/closed row. To supersede a current row, close it and create its
successor in one custom-op transaction, supplying the same explicit instant to
old `valid_to` and new `valid_from`. An application-clock close and a database
`now()` default are different instants.

Soft deletion always hides a tombstone, even during an as-of read. Temporal and
expiry predicates can use the requested instant, but a `relate().via` grant is
checked for current membership/liveness. A grant made today can authorize access
to a row's historical state. Association junctions also store current
membership, not a time series: `related(...,{asOf})` dates its endpoint rows,
not the link/unlink history. Build an explicit historical grant/link resource if
that distinction matters to your application.

## Views, read models and graph reads

Declarative views apply their own row rule over source rows; they do not inherit
the producer's actor policy. A denied declarative read narrows to no rows. A
cross-source run-form view has an actor-admission gate and can answer
`forbidden`; a returned object is not subsequently filtered as a source row. MCP
`shape` narrows only the MCP projection, not `ctx.reads` or HTTP.

Query-form views also have an actor-admission gate, in addition to their
sources' row rules and scope/lifecycle filters. A denial is HTTP 403 or MCP
`forbidden`, even for a public HTTP route; MCP omits that tool from the caller's
catalogue. OpenAPI still describes the declared path and its possible 403.

HTTP-visible JSON views are at their declared `/views/...` path and have
`api.views.<name>.read(input?)` typed-client members. They are live-now.
Query-form view pages and MCP view envelopes are bounded; run-form output is
owned by its declared runtime output schema. A binary view is a ctx seam and
does not gain an HTTP/MCP JSON projection merely by adding an HTTP card.

Read models are maintained projections read through
`ctx.readModels.<declared_name>.read(query?)`. Keep the exact declared spelling,
including underscores. They have no automatic HTTP, OpenAPI, MCP or client
endpoint. Their maintenance is eventually consistent with the source outbox;
deletion/cascade/TTL recovery belongs to the declared maintenance jobs, not an
invented synchronous join. Bound a large read explicitly.

Graph `with`, selections, ordering and nested bounds are ctx-only. Parent
references are deliberate graph paths as well as owned-child paths; ordinary
CRUD response columns do not request joins. A per-edge cap is a local bound, not
a count of the entire graph. Empty selections and invalid/zero bounds are
subject to their graph validator, not wire list defaults. Selecting an encrypted
field requires its KMS; selecting ordinary columns does not grant access to
ciphertext or blind-index storage columns.

## Modules and transaction boundaries

An HTTP resource path is flat: `/<path-or-name-plus-s>/...`. Modules do not add
a `/modules/<name>` URL prefix. MCP names encode the module as
`<module>__<resource>__<operation>`. Use the live catalogue and OpenAPI paths,
rather than constructing a second naming convention.

`exposes:["create","find","list","count","update","delete","restore"]` makes the
corresponding supported data verbs callable through a resource carrier. For
example, `ctx.modules.billing.create({resource:"invoice",data})`,
`find({resource:"invoice",id,asOf?})`,
`list/count({resource:"invoice",query?})`,
`update({resource:"invoice",id,patch,expectedVersion})`,
`delete({resource:"invoice",id,expectedVersion})`, and
`restore({resource:"invoice",id,options?})`. Only the dependency's own resources
are valid. Versioned update/delete require the expected version; non-versioned
resources have no such option. Writes use the existing create/update/delete
permissions; restore uses update. Current row policy, scope and feature guards
remain. Results omit privacy fields recursively and framework storage columns;
outer id, version and enabled update stamps remain available for the next write.
Native Date/bigint/binary leaves keep their in-process types. Existing custom
operations named count or restore keep their authored signature and dispatch.

`ctx.modules.<dependency>.<operation>(...)` dispatches the dependency's own
operation transaction on the root database. It is not enlisted in the caller's
transaction. If the caller later rolls back, a dependency operation that already
committed keeps its writes and outbox effects. Use a transaction-local
`ctx.data`/event boundary when that atomicity is required; do not treat a
cross-module call as a distributed transaction.

## Operations and declared output

`defineOp.output` is a runtime return contract as well as a type. Its defaults
and transforms apply to the successful value; a mismatch is an internal failure,
not a partial success. A read operation still validates its output. Named
collection operations return HTTP 200 unless their actual route contract
specifies otherwise; creating a row inside one does not turn it into CRUD
POST 201.

HTTP custom-op success wraps the answer under `result`. MCP keeps its protocol
content and compatibility projection; use the current advertised output schema
and returned `result` field when present. `mcp.<op>.shape` is MCP-only: HTTP
uses the operation output after HTTP egress, and OpenAPI describes that HTTP
shape. It does not borrow a narrower MCP field pick. `rowPolicy` governs
repository reads/writes; it cannot infer which arbitrary objects a handler chose
to return.

A declared custom-op output also appears as MCP `outputSchema`. Read its
`structuredContent.result`: the schema describes the encoded, masked and
MCP-shaped value, with an object wrapper even for arrays/scalars. An undefined
answer leaves that property absent. Legacy content and payload fields remain;
business keys colliding with protocol content fields remain under `value`.
Without a declared output there is no structured-output schema promise. An
opaque transform has an unknown value schema; pipe it to an explicit output
schema when the catalogue should advertise those constraints. Complex object
intersections that cannot be folded also use unknown for that portion; an
explicit representable output pipe restores concrete metadata. Building metadata
does not execute default, catch or transform callbacks. Array/tuple slots that
contain undefined become JSON null; object properties with undefined stay
absent. Field picks preserve scalar/native scalar values, including inside
arrays.

For a pooled model-call operation, choose
`tx: "read", readConsistency:
"statement"`. Every owned DB call uses a short
real `READ ONLY` transaction, then releases its connection before external work.
Composed data, dependency and projection reads use that constrained base too;
transaction/savepoint/pool escape handles are absent. This gives up a
multi-query snapshot. SQL statement, provider-call and request deadlines are
separate, while explicitly wired external datasources retain their own
credentials and transaction contract. Policies, writes and workflows retain
their model-call refusal.

## CAS and write acknowledgements

The precondition belongs to the read version: numeric `expectedVersion` in ctx,
`If-Match` on HTTP, and `version` on MCP. A missing/invalid HTTP precondition
returns 428 with `error.kind:"validation"` and `version/precondition-required`;
it is not a ninth error kind. A version miss is `stale` only while the row
remains visible. Missing, hidden, deleted or expired targets are `notFound`/404.
Re-read before retrying a genuine stale write; the old token cannot become
current again.

Successful HTTP updates return the committed ETag; MCP update returns the
committed version and enabled acknowledgement stamps. A same-value patch is a
no-op; an empty patch does not manufacture an audit change. For `dbType()`
fields, same-value means matching PostgreSQL text output after the declared
input type and the actual stored type/modifiers coerce the input. Equivalent
input for stored `numeric(19,4)` (including bare `numeric`) or explicit numeric
typmods keeps the existing version. A different native position, interval
components, casing or unbounded decimal scale is a stored update even when
native SQL equality treats it as equal. Soft deletion also advances version:
HTTP DELETE remains 204 without a body and supplies its new ETag; MCP includes
`version`; the typed client can return delete metadata with its response-options
mode. Hard deletion has no surviving-row version. Normal wire error text can be
silent even when ctx/MCP retain rule detail: classify by status/kind/code rather
than matching a database message.

Restore is independently curated: `http.restore` mounts POST
`/<plural>/:id/restore` with a JSON options object (`{}` when absent), and
`mcp.restore` takes `{id,options?}`. The typed client offers
`restore(id,options?)` only for that HTTP declaration. It uses the update
permission, accepts no caller CAS token, and acknowledges
`{restored:true,version?}` plus the HTTP ETag. A unique key reused by a live row
returns a generic conflict; the failed restore leaves the tombstone/version
unchanged. Hidden, superseded or parent-blocked tombstones remain unavailable.
An expired tombstone needs a caller-writable expiry renewal with `expires_at`
(future ISO instant or null); fixed-after expiry cannot be overridden. Temporal
create may set `valid_from`/`valid_to`; PATCH may close `valid_to` but cannot
rewrite `valid_from`, so noOverlap keys can progress to a new non-overlapping
window. Ordinary HTTP/MCP create and PATCH schemas omit `expires_at`; per-row
expiry assignment on those writes is a `ctx.data` capability. The explicit
restore options above have their own wire renewal contract.

## Typed-client reflection and retry hints

`hazelnutClient` makes network calls only through declared callable members.
Promise/reflection probes such as `then`, `toJSON`, symbols and undeclared
property names have no network effect. A declaration conflicting with those
reserved reflection names refuses at construction rather than allowing an
implicit request. Config namespaces and operation names also retain their
explicit collision checks.

Put authentication/default headers in the constructor options. Per-call response
options request metadata such as ETag/cursor; they are not arbitrary RequestInit
or a second header override channel. Errors preserve safe domain `code`,
`retryAfter` and credential throttle metadata, with Retry-After as a transport
fallback. Unknown/proxy transport statuses normalize to a Result error while
retaining their safe retry signal. A response without a JSON body does not
become a thrown parse error. Use those hints for backoff; do not convert an
unrecognized HTTP status into permission to repeat a mutation with a new replay
key.

Constructor `If-Match`, `If-None-Match` and `Idempotency-Key` headers are
stripped case-insensitively; only their corresponding call options supply those
tokens. Safe error metadata also includes observed `httpStatus`, `traceId` and
numeric `rateLimit` values (`limit`, `remaining`, `resetAfter` seconds).
Transport `rate_limited`, `auth_unavailable` and `payload_too_large` keep their
identity as `code` while mapping to the closed Result kinds.

## Bulk writes and savepoint effects

HTTP collection POST accepts create arrays and PATCH accepts by-id update
arrays. There is no collection DELETE route. `deleteMany`, `updateWhere` and
`deleteWhere` are ctx capabilities; MCP advertises curated single-row CRUD and
custom operations, not automatic bulk tools. The typed fetch client has no bulk
convenience member. Use a deliberately authorized custom operation when a domain
action should accept a batch.

Default atomic mode rolls the batch back on a row failure. HTTP `?mode=continue`
commits each surviving row in its own transaction; a later failure does not undo
earlier rows. Inside an existing operation, `ctx.data` continue mode uses
per-row savepoints in the caller's transaction: its survivors still roll back
with that caller. Inspect `BulkOutcome.failed` even on HTTP 200, including the
case where every row failed. Versioned update items need their own
`expectedVersion`; delete tokens belong to the ctx bulk delete contract, not an
invented HTTP delete body.

Unique constraints alone do not prohibit set-based writes. An applicable unique
or foreign-key failure is a failed Result, with the failed statement rolled
back. A conflict can identify an authored unique clause when the framework can
attribute it safely; raw constraint names and database error text are not a
discovery API. Atomic and continue batches keep their respective rollback
boundaries.

Within `ctx.savepoint(fn)`, use the callback's `data`, `query`, `emit` and
`queue`. They share that savepoint. A call through an outer context keeps its
outer transaction boundary; catching an inner clash cannot undo an earlier outer
emit. Await the savepoint before reusing that outer handle. Parent or sibling
effects during an active child refuse before SQL as `transaction/scope-overlap`
(`validation`); use the callback handle for nested work and await its effects
before returning. Concurrent queries on a leaf handle remain allowed. Tasks,
transitions, schedule and cross-module calls are not silently rebound by closing
over the callback. Continue bulk creation can leave vector re-embedding for the
standing relay rather than an inline drain.

`AlarmSink` delivery is process-local and non-transactional. A raised alarm can
survive database rollback; it is not another outbox fact. A sink throw is
contained, and the default no-op sink supplies no external evidence.

## Password sessions and rate budgets

The [password recipe](./rundown.md) in “Email and password login” returns
`{accessToken,refreshToken,expiresIn,tokenType:"Bearer"}`. Credential schema
fields are password-formatted, and operation responses are `no-store`. Both
tokens belong to the issuing scope. Use the same stable signing material across
replicas, and validate the origin/host authority at ingress.

Refresh slides its default 30-day lifetime within the original device session's
default 90-day absolute cap. A matching replay within the default 30-second
grace receives the same surviving successor. Matching reuse outside grace
revokes that scoped family. Store the returned pair together. Logout closes only
the authenticated credential's device session in its issuing scope, including
its rotation lineage. An authentic, unexpired old rotation credential can close
that device even outside retry grace. Refresh and logout share a family lock;
another device or scope is unaffected. `passwordRevokeOtherSessions()` revokes
other device refresh authority; issued access bearers remain usable until their
short expiry, capped at 900 seconds from issuance. Revoke-others is not a
session-inventory API. An older unscoped token or refresh verifier requires
login after the credential-format upgrade.

There are two fixed-window budgets: the inbound actor/source floor and the
durable credential × scope × trusted-source counter (default 10/300 seconds).
Known aliases follow identifier-column equality. Wrong/unknown credentials
remain ordinary forbidden; credential lockout is HTTP 429 with Retry-After and
RateLimit metadata. Login costs four inbound units; HMAC refresh costs one.
Password/code KDF saturation is 504 `kdf/overloaded` with Retry-After:1;
ordinary request-deadline 504 remains a separate silent timeout. Four real KDF
workers admit four derivations with a 2000 ms queue bound.

Anonymous source separation requires a trustworthy `clientIp` hook; it never
trusts a caller's forwarded header automatically. The MCP gateway forwards
credentials, not original client-address authority, so anonymous callers behind
it can share one upstream bucket. A store outage can affect admission metadata;
headers do not prove the durable store committed. Successful idempotent replay
is still an inbound request and spends that request budget.

## Scope, actors and caches

`withTenant(actor,scope)` binds the generic actor scope; it deliberately leaves
an anonymous actor unbound. It does not invent a tenant model or authorize
another partition. Use `isAnonymous` for the anonymous actor shape. Ordinary
resource reads narrow through their row rule and hide foreign rows as absent; do
not expect HTTP list/find to return a permission 403 for each excluded row.
Run-form views have the separate actor gate described above. `unsafeRowPolicy`
is the explicit escape from structural policy analysis, not permission to omit
the runtime scope/lifecycle stack.

The request supplied to a scope resolver contains only normalized origin and the
resolved actor. Path, query, method, body and headers are stripped on the
runtime call, not only during a boot probe. Origin/Host authority still belongs
to trusted ingress. Password login needs the issuing partition before an actor
exists; use the same trusted-origin mapping for login, refresh and bearer
verification. Keep `passwordAuthResolver` directly in the resolver chain and use
its `mapActor` option for post-verification application bindings or grant
expansion. An actor-only scope cannot bootstrap this flow. A framework service
actor has privileged maintenance meaning; a caller-provided object or payload
flag is not that authority.

Policy-sensitive GET list/find/view/file-grant answers use private, no-store
cache posture and vary on Authorization. Cookie auth does not become an
Authorization cache-key axis; preserve no-store or add the relevant cookie axis
in any application-owned caching layer. SSE has its own no-store policy. Custom
operations use no-store independently. Query method and custom route headers
follow their actual declared transport contract, not a blanket claim that all
responses have identical cache headers.

## MCP catalogue, prompts and resources

`tools/list` is identity-specific. Identity-only permission rules omit denied
tools; an ad-hoc operation policy remains listed and is evaluated when called. A
denied direct call returns forbidden; never-curated names return notFound. HTTP
`external: true` never bypasses a direct MCP write's permission. Auto-CRUD HTTP
`"public"` deliberately opts out of permission checks on both curated doors;
custom operations keep their MCP policy unless the operation declares
`policy: null`. The four standard effect/retry hints are booleans. A soft-delete
tool is recoverable; optional `_idempotencyKey` does not make a keyless custom
write idempotent. Confirmation lives at `_meta["hazelnut/confirmHint"]`, field
advertisements at `_meta["hazelnut/shape"]`. A host may ignore that metadata: it
is not a server approval receipt and does not govern HTTP bulk writes.

`definePrompt`, prompt listing/getting and `as:"resource"` URI reads are MCP
capabilities. They create neither OpenAPI routes nor typed fetch members.
Resource reads return MCP `contents` with protocol `text`/`blob` and MIME
metadata, using the same current row visibility and declared field projection.
JSON resource templates advertise `mimeType:"application/json"`; their field
pick is vendor metadata at `_meta["hazelnut/shape"]`, not a protocol-level
`shape` property. The initialized `resources` capability includes templates;
`resources/list` lists static runtime resources, not application rows. Discover
declared row URI patterns with `resources/templates/list`. Prompt argument
advertisements are descriptor arrays; arguments arrive as strings, explicit
coercion produces typed renderer values, and only user/assistant roles are
served. Bad arguments are invalid params; renderer/output faults are redacted
internal errors. A deleted or superseded row is not a historical URI archive.
Prompt arguments have their own declared parser; they are not arbitrary
operation bodies.

## Encryption, redaction and native wire values

Passwords, sensitive and encrypted inputs are write-only in derived write
schemas. Passwords alone gain password format. HTTP drops protected fields. MCP
CRUD projections omit sensitive fields, passwords and blind-index storage. An
encrypted field already selected by its positive logical projection is a fixed
`[redacted]` placeholder, with the same advertised field name; its ciphertext is
never selected or decrypted for that placeholder. Custom-op output uses its
fixed masks. Null follows the same secrecy path as a non-null value: it is not a
public presence oracle. Trusted domain hooks can read declared sensitive
business fields and decrypted encrypted fields; password hashes and framework
columns are excluded from the typed transition image. Log/audit masks and wire
masks have different purposes; an application span is its own disclosure
boundary.

Omitting a nullable sealed field from PATCH preserves its ciphertext and blind
index. Sending null explicitly clears both. A wire read that does not deliver an
encrypted field does not fetch/decrypt it. Plaintext ctx reads still need the
KMS. One fresh DEK is shared by touched encrypted cells of a row write; each
cell keeps independent IV and position AAD. Rotation rewraps keys without
changing payload ciphertext, and equality canonical-key custody is a separate
cutover from the wrapping current key. Keep old keys until their retained
envelopes/markers no longer need them.

Bytea crosses JSON as PostgreSQL `\\x` hex; bigint crosses as decimal text.
Neither representation authorizes a raw storage read or arbitrary native filter
cast. KMS unavailable errors carry safe retry metadata and HTTP 503; provider
denial remains internal, not a user permission refusal. No provider body is part
of the public error contract.

## Audit, provenance and immutable history

Audit logs record meaningful audited changes, not every framework stamp. An
empty restricted update diff is skipped unless snapshots are enabled;
`snapshot:true` intentionally keeps its masked before/after business image. An
audited transition records its status diff and, with `snapshot:true`, its masked
business row before and after the guarded status change. Authored audit field
restrictions still apply, and password hashes stay absent. Encrypted
diff/snapshot values use a fixed marker, including null endpoints. Soft
delete/restore record tombstone/deletion-actor changes rather than inventing
business destruction/recreation. No automatic audit-history HTTP, MCP or client
endpoint is created.

`onRow` supplies created/updated attribution and deletion attribution where the
lifecycle mints it. Live reads hide a soft-deleted/superseded row, and restore
clears deletion markers; projecting the actor column does not create a
tombstone-history query. Use an intentionally authorized audit capability for
who-deleted history. Scope and origin stamps are framework authority, not
client-settable business fields.

Whole-resource immutability has a distinct `rectify` capability on ctx. It
creates a replacement head and one linked rectification audit event; it is not
ordinary PATCH and creates no generic wire tool. Status and structural parent
keys cannot be corrected. Mutable owned children move through guarded writes;
whole-immutable children or an immutable tree with live children refuse the
correction atomically. The old head advances its enabled lifecycle/version
stamps and stays hidden even without a softDelete feature.

Tamper-chain v2 authenticates a column/type manifest and correction lifecycle
authority. A missing digest is an integrity fault, not permission to re-anchor.
Keep `chainCheckpoint` outside the ledger's trust domain and pass that trusted
prefix to `verifyHashChain`; link-only verification cannot prove that a valid
tail was retained. Every pre-0.70.0 ledger is an older format, including
0.69.0's `v2:<64hex>`; the current four-part shape carries a base64url manifest
and two MACs. Pause writers before the
[reviewed format cutover](./rundown.md#tamper-format-cutover): retain the
original namespace/tool/KMS context and anchor evidence, then establish a
separate fresh genesis and new external anchor. Boot/migration do not scan this
boundary, and an accepted append can extend an unsupported tail without
validating history. No automatic repair command is implied. Database WORM
triggers reject ordinary mutation but cannot prevent an owner/superuser
disabling triggers or changing DDL. Verification is privileged global-chain
forensics, not a tenant-scoped row-read API.

## FSM, ownership, uniqueness and restore

State changes go through a named domain operation calling `ctx.transition`;
there is no generic transition HTTP/MCP tool. Guards see the current status;
onExit/onEnter receive the post-CAS candidate status inside its transaction.
Typed success preserves the literal target and committed version when enabled.
Declare the generated transitioned topic on the owner: boot refuses a missing
declaration, and failed transitions do not leave a partial row/event mutation.
Deletion, restore and expiry are lifecycle actions outside the FSM graph.

Owned children, ordinary references and association links are separate
contracts. Soft deletion can leave owned children physically present, while hard
FK CASCADE physically removes mutable dependents. Database WORM on a whole
immutable child refuses a physical cascade into its history and rolls back the
parent delete too. Restoring a parent does not silently restore/rebuild its
children or historical links. Tree parent writes and restore validate the parent
through their declared liveness, scope, visibility and cycle checks;
bulk/set-based shortcuts do not bypass them.

Unique indexes exclude soft-deleted/superseded rows through
`deleted_at IS
NULL`; expiry and temporal invisibility do not release a key. An
expired row can still conflict until its physical purge. Reusing a tombstone's
key can make later restore conflict. Create remains insert-only: there is no
general upsert or implicit renew-on-conflict. Use the returned unique conflict
to reconcile the existing row; do not assume it became readable to that caller.
Set-based writes retain feature-specific refusals; use guarded by-id writes for
audited, versioned, encrypted, structural or otherwise woven effects.

Per-row expiry and computed after-mode expiry have different write authority.
Ordinary wire create/PATCH omit the per-row expiry field; use `ctx.data` for
that assignment. Extending an already-invisible live row is not a generic
revival path. A caller-writable restore deadline can extend an expired tombstone
in the same guarded restore. Purge uses the database clock and rechecks liveness
inside its mutation transaction.
[Expiry posture](./rundown.md#expiry-storage-posture) explains physical deletion
and recovery costs.

## Translations

Translation resolve/set are ctx capabilities with no automatic locale route, MCP
helper or fetch-client member. Locale syntax and declared fallback are
validated; fallback is per field and a present empty string wins. Omission does
not mean delete. A successful setter returns the visible row with its validated,
transformed locale overlay, using the declared fallback order; it does not
return the untranslated base row. A later resolve rereads the current row and
sidecar. Sidecars follow physical parent deletion; soft deletion does not create
a historical locale API. Translation resolution and association membership have
no implied as-of history. A rectification path is an explicit ctx capability,
not a generated HTTP action.

## Workflows, tasks and deadlines

Workflows have ctx start/inspect/cancel. HTTP GET/DELETE
`/workflows/{name}/{id}`, explicitly curated MCP
`workflow_inspect`/`workflow_cancel`, and client
`api.workflows.<name>.inspect/cancel` inspect or cooperatively cancel a run
owned by that declaration, scope and submitter. Inspection exposes step states
and safe error kinds, not recorded step values/raw error text. There is no
automatic HTTP workflow-start route. Inspection and cancellation hide legacy
ownerless identities until their original authority is reviewed. Follow the
[legacy binding procedure](./cli/run-workflow.md) to set the reviewed owner's
exact `submitter` key. Its compatibility value `''` allows any submitter in the
same declaration/scope to resume; it does not bind an owner for these app doors.

Standalone `runWorkflow` commits steps independently. Operation-nested start
requires a concurrent pool (`Db.concurrent`); single-connection PGlite refuses
it with `validation` before the body because there is no independent recording
connection to preserve a failure after caller rollback. Use standalone
`runWorkflow` on a transaction-capable root or `hazelnut run-workflow` instead.
A workflow started inside an operation keeps the operation transaction, so later
rollback removes its earlier done marks and a retry can repeat external effects.
Its identity may be committed through an independent recording connection even
when the caller's step journal rolls back; that rollback does not free the id
for another workflow or scope. The identity also binds the submitter's actor
type and id; another submitter, including a CLI system actor, cannot resume a
user's bound run. Use the stable step idempotency key at external effect owners.
Duplicate/empty/colon-containing step ids refuse. Input is supplied again, not
durably compared with identity; keep it unchanged for a resume.

The journal does not persist the submitter's original claims. Resolve current
authority on each invocation: unfinished steps use that same submitter's current
actor and claims, so revoked access can now refuse or hide a row. Completed
steps replay their recorded results rather than re-running under new claims.

`run-workflow` plans durable identities; execution requires explicit
`--workflow-id` and JSON `--input`, with optional `--scope`. The app's
`workflowSeams()` or `relaySeams()` supplies built KMS/storage/datasources.
Unstick resolves identity to the declaration and checks a fresh claim
generation; an unknown UUID is not evidence that its lease expired.

Job handlers and workflow steps default to a 600000 ms deadline with a real
AbortSignal and SQL timeout. `handlerTimeoutMs`/`stepTimeoutMs` can choose a
finite value or explicit false; false removes this bound and requires the
application to own its external waits. A lease is crash reclamation, not that
deadline. The bundled Postgres adapter heartbeats through an independent short
connection even with an occupied one-slot pool; a custom adapter without that
port cannot claim the same live-owner guarantee. Cancellation is cooperative:
JavaScript or an external service ignoring abort can still complete an effect.

Tasks submit/poll/cancel on ctx and client. MCP task `poll`/`cancel` and
workflow `inspect`/`cancel` each opt in through an authored `mcp` method
`{describe}` card; omitted methods create no tool or MCP posture obligation.
Their FQNs end in `task_poll`/`task_cancel` and
`workflow_inspect`/`workflow_cancel`. Tasks default to one attempt; opt into
retry with `maxAttempts`. Their worker uses the relay's default 600000 ms
handler bound. A timeout cannot prove that an external service cancelled its
work; use the delivery idempotency key. HTTP GET/DELETE `/tasks/{id}` accepts
the declared `name` guard used by the typed client. Ownership binds task name,
scope and submitter. Poll may return inline `result` or a short-lived
`resultUrl`; the result is a data disclosure boundary, not automatically
encrypted storage. PGlite progress writes the current worker transaction and
becomes visible after commit; native adapters can publish progress
independently. Failure is derived from the exact durable task dead letter, not a
guessed stale row. There is no task-poll CLI verb.

## Scheduled work and consumer authority

`defineJob` is recurring cron; `ctx.queue.schedule`/`ctx.schedule` schedule one
future queue row consumed by a declared worker. They are not job-administration
HTTP or MCP tools. `ctx.queue.scheduleWithId(at,job,payload)` returns a Result
of `{scheduled:true,id}` only when this caller won the new slot; a duplicate
returns `{scheduled:false,id:null}` without revealing another owner's handle.
`ctx.queue.cancelScheduled(id)` returns a Result of `{cancelled}` for the same
owner and scope. Anonymous callers cannot cancel. A branded service actor can
perform declared maintenance within scope; caller-supplied actor/payload flags
cannot grant it.

Cancellation applies to unclaimed pending/failed scheduled rows. Any processed
fence or active delivery lease refuses cancellation; it does not abort a running
worker or undo an external effect. The shared source mutex coordinates framework
consumers; older replicas or independent drainers that bypass that claim
protocol cannot promise the same cancellation race guarantee.

Workers/subscribers default to the frozen event originator. Explicit authored
`runAs:"system"` elevates that one consumer to a branded service actor; payload
`runAs` has no effect. A chained message preserves the true original identity,
so an ordinary successor does not accidentally retain the previous consumer's
elevation. Consumer-chained emit/enqueue is exempt from the initiating agent's
producer cap, while the whole-system due-backlog valve remains active. SQL
liveness/scheduling use the database clock; injected `ctx.now` controls logic
reads of the clock, not database time.

## Relay, leases and external side effects

Per-consumer retries keep succeeded siblings fenced while failed siblings honor
their own attempts/backoff. Ordered-head stall breaking waits for in-flight
ownership: an age threshold does not authorize terminating a live handler. Queue
rows are outside that ordered-event breaker. A low-level custom adapter without
savepoints uses a bounded lease fallback, so its timeout and adapter
capabilities matter to crash/retry behavior.

Events carry frozen originator provenance into background work; they do not
continuously re-authenticate the initiating credential. A later logout/role
change does not retroactively erase a committed message. Authorize the
background operation deliberately and make external side effects idempotent.
Soft-deleting a source row before its event drains can make a handler's ordinary
find return notFound; an event is not a retained row snapshot unless its
declared payload carries the required data.

An external-relay web replica cannot infer the other process's last drain from
its local `lastDrainAt`. In that placement its `/ready` checks the database;
monitor the worker's `/healthz` and shared lag evidence separately. An absent
local timestamp is not a healthy recent drain. Alarms, process logs and external
calls are not rolled back with outbox SQL.

## Idempotency and retry recovery

Only a custom operation declaring idempotency owns the framework replay key.
HTTP uses `Idempotency-Key`; MCP uses `_idempotencyKey`. Automatic CRUD and bulk
do not gain a replay claim by sending that header. Unique/version checks are
constraints, not stored-answer replay or upsert.

Reuse the same key for the same logical request. A live claim may return
conflict; after retention expiry the same text can execute again. The default
retention is seven days, not an eternal promise. Retained answers re-egress
through the current door's secrecy rules, including in-process masking; they are
not a durable plaintext response archive. A trusted in-process first execution
can return plaintext while its replay returns masked fields. Old raw replay rows
need their documented upgrade purge, not silent trust. Module-qualified
operation identity separates otherwise equal names. A request deadline and claim
lease are separate bounds. An idempotent write requires a finite SQL statement
deadline and a strictly longer lease (defaults 30 seconds and five minutes). An
opaque input decoder plus any `before` hook requires a validation-only
`beforeOutput`, including observers: each success revalidates the decoded
replacement or mutated input before executing the body. Retry after a transient
failure with the same key and follow the declared owner/lease outcome, never a
second independent payment. SQL deadlines do not bound JavaScript or external
effects; use provider idempotency as well.

## Files, streaming and upload handover

A `file()` column stores a framework-minted object key. Read grants are HTTP GET
`/<plural>/:id/:field/url`, MCP `file_grant`, and client `fileGrant`. They
require source read visibility and the projected file field; MCP also intersects
its find shape. TTL defaults to 300 seconds and clamps to 1..3600. A `file()`
resource without a storage driver refuses at boot (`file/storage-required`); the
served grant is never reached. `storageUnconfigured` remains on the offloaded
task-result path. Possessing a column name does not authorize a storage lookup.
A driver with `head` can add `exists` and `{size,contentType?}` metadata; an
authorized missing object is `exists:false`, not evidence about someone else's
row.

After `rectify()`, an unchanged file keeps its original object key and bytes.
The local bytes door follows that key's same-field, same-scope supersession
chain, then rechecks the current head's full find visibility and projected file
field. It does not expose the superseded rows. Replacing or clearing the file
breaks that lineage. Copying a key onto another row does not confer read
authority over the canonical head. Read URL minting keeps its existing
stored-key behavior after the requested row's find gate; local download
authorization is checked separately.

Upload grants use POST `/<plural>/:id/:field/upload-url`, MCP
`file_upload_grant`, and client `fileUploadGrant`. They require trusted update
permission plus the full source read stack and projected file field. Only the
currently stored minted key can be granted. A conditional-upload-capable driver
must honor atomic no-overwrite; otherwise the grant refuses. Local PUT URLs are
method-bound and recheck policy, and exclusive creation refuses an existing
object. A read URL is not an upload credential. Optional driver `get` streams
local downloads with preserved content type; task JSON remains JSON, and local
responses carry attachment/nosniff boundaries. If the carried key was never
uploaded, an authorized current head can still request its first conditional
PUT. The upload grant must use that head's id; a copied/nonlineage key remains a
conflict. The bytes route rechecks the head before and after writing. Existing
bytes are never overwritten or moved, and supersession alone does not schedule
GC. The lineage lookup adds database work as the correction history grows; no
schema migration or re-upload of existing bytes is required.

PATCH commits a file pointer before the caller uploads its bytes. There is no
staged atomic handover: upload failure can leave a missing current object, and
non-soft-delete old bytes may already be eligible for GC. Soft-delete resources
retain replaced/detached keys until physical purge; current and retired keys,
including cascaded children, enter durable GC with that deletion. Post-commit
drains are best effort; failure leaves retry work and does not undo a successful
row write. Restore can preserve bytes but cannot reconstruct an upload that
never succeeded.

## Push, webhooks and operational trust

SSE at `/events/<topic>` is a separate HTTP streaming door with no MCP or
typed-fetch subscription helper. Observation policy controls whether a caller
can learn that a topic changed. An invalidate frame means refetch; rows frames
are full unpaged current snapshots, not a paginated durable log. Heartbeats are
comments, not business events. Disconnects/reconnects do not provide replay or
exactly-once delivery. Browser EventSource needs a cookie resolver; a
Bearer-only password resolver needs an authenticated fetch stream. A stream that
cannot preserve a version pin should refetch through that pinned read instead of
treating current rows as a historical version response.

The stream's own lifetime is 60000 ms; a larger request-timeout setting does not
extend it. Admission is bounded to 128 active streams per process. A full stream
capacity returns transport 429 `rate_limited`, separately from the actor's
request budget. Unknown query keys return 400, unknown topics 404, HEAD 405,
denied observation 403, unavailable authentication 503, and a pre-admission
aborted request can finish 204. Request setup can still meet its ordinary 504
deadline. Logs identify `push.rows`/`push.invalidate`; a heartbeat is not an
extra business operation.

Outbound webhooks send JSON `{id,topic,payload}` under HTTPS/DNS/private-address
and redirect checks. HMAC covers the original timestamp and raw body. Public
`signWebhook` and `verifyWebhook(secret,signature,rawBody,{maxSkewSec?,now?})`
live on `hazelnut/async`; read `request.text()` and verify before JSON parsing.
Verification defaults to 300 seconds of allowed past/future skew. Malformed,
tampered or out-of-window signatures return false; invalid configuration refuses
validation. A skew window is not replay deduplication: persist the message id at
the receiver. Delivery forces `application/json` regardless of authored header
casing and owns its signing header when signing is enabled. Delivery is
at-least-once and receiver waits have their own timeout. DNS validates both
families; only no-data/NotFound is an absent family, while
permission/timeout/resolver failures refuse before send. Launch grants the
actual numeric resolver sockets through a trusted no-app discovery helper,
keeping system-information permission out of app planning and serving. Empty or
unavailable DNS configuration refuses launch. A timed-out preflight may finish
its native lookup later but cannot then send. DNS preflight does not pin the
later network connection; deployment egress policy remains part of the SSRF
boundary.

Migrations are operator actions, never agent CRUD tools. The safe-DDL gate
classifies actual statements, refuses unclassifiable procedural/function bodies,
and requires the explicit destructive/field-live markers at the protected
mutation. Unknown history or unresolved remote protection is a refusal, not
permission to dissolve migrations. See the [migration guide](./cli/migrate.md)
before changing live columns or clocks.

Vector semantic search/re-embedding remains a repo/background capability, not an
automatic wire tool. Declare 1–4000 dimensions; widths 2001–4000 use half
precision and larger widths refuse at composition. Internal semantic hits
include `_distance` and `_stale`; retained vectors may lag current text, while
null vectors or sources are excluded. A single HTTP/MCP create may attempt an
exact-row inline refresh for up to five seconds; timeout, bulk creation or an
unavailable provider leaves durable work, so a successful response need not
contain a refreshed embedding. The re-embed crash lease is eleven minutes to
cover its ten-minute external wait plus recovery margin. Remote provider work
remains at least once. Raw SQL outside the framework protocol can bypass
rollup/projection hooks, and the hourly source healer cannot reconstruct IDs of
physically deleted raw-SQL rows. A lease and an external embedding timeout are
different bounds. Raw code, callback defaults, external providers and privileged
operators retain their stated trust boundaries. No generated endpoint can make
an off-process side effect transactional.
