# Protected relational reads

**How-to ·** for an operation that needs related rows or a declared report.

Keep `defineResource` as the only schema. Hazelnut derives an in-memory Drizzle
RQB v2 graph from `owns`, `references` and `relates`; there is no ORM client,
second schema file or generated runtime table module to maintain. Existing
`ctx.data` reads and `ctx.query(sql, params)` remain available.

## Nested resource reads

`list`, `find` and `findOrFail` accept an explicit positive `columns` projection
and finite `with` tree. The operation's resource witness supplies the types:

<!-- @conformance:ts imports= -->

```ts
import { defineModule, defineOp, defineResource } from "hazelnut";
import { hasMany } from "hazelnut/query";
import { z } from "zod";

const message = defineResource({
  name: "message",
  schema: z.object({ body: z.string(), owner_id: z.string() }),
  rowPolicy: "owner_id",
  features: { versioning: false },
});
const conversation = defineResource({
  name: "conversation",
  schema: z.object({ title: z.string(), owner_id: z.string() }),
  rowPolicy: "owner_id",
  features: { versioning: false },
  owns: { messages: hasMany(message) },
});
const conversations = defineModule({
  name: "conversations",
  resources: [conversation, message],
});
const inbox = defineOp({
  resources: conversations,
  input: z.object({}),
  policy: null,
  tx: "read",
  handler: async (_input, ctx) =>
    await ctx.data.conversation.list({
      columns: ["id", "title"],
      with: {
        messages: {
          columns: ["id", "body"],
          limit: 10,
          orderBy: ["id"],
          dir: "desc",
        },
      },
    }),
});
void inbox;
```

Each node applies its target's scope, soft deletion, expiry, temporal slice and
row policy before contributing any result. A hidden/missing `hasOne` or `ref`
target is `null`; a collection with no visible rows is `[]`. A nested `where`
filters that collection, not the root. Independent sibling collections do not
multiply one another. Self/repeated targets are legal when the selected tree is
finite.

`with` keys normally name declared relation keys. To rename a result, retain a
scalar FK alongside its referenced object, or distinguish identical keys in
different edge kinds, use an output alias with
`relation: { kind: "owns" | "ref" | "manyToMany", name: "<declared-key>" }`. An
ambiguous shorthand refuses that read; it does not invalidate the resource.
Explicitly selecting a scalar and relation under the same output key refuses.

New selected reads default to 100 rows per node and order by `id` when no order
is supplied. A `limit` you pass on the root node is honoured as given; a nested
relation node caps a requested limit at 100. Authored order fields get an `id`
tie-breaker. Offset belongs to each node independently. The selected tree is
limited to eight edges deep and 64 nodes; no cycle is auto-expanded. A root
`asOf` is inherited by temporal descendants unless a descendant overrides it.
Old reads with no new selection/order options retain their existing paging and
result behavior. `byIds`, `children`, `listPage` and locking reads retain their
own signatures; graph options are not silently accepted there.

Encrypted fields cannot be graph order keys, at the root or any nested relation.
Equality-search opt-in does not make a blind index sortable. Sensitive-only
fields remain sortable inside a trusted handler; serving that handler still
needs an explicit output contract. Cursor and declared-report selectors have
separate, stricter exclusions.

Graph reads use one SQL statement on the exact operation-bound handle, not a
second connection or Drizzle transaction. Equality-encrypted predicate
preparation can perform its existing prerequisite work. The one-statement
snapshot is a new read contract, not a change to the isolation of old reads.
Encrypted selected fields are decrypted only after visibility; internal rows are
not a wire projection. Curate a custom operation and its output before serving
it. Graph selection does **not** add automatic HTTP/MCP routes or let remote
callers choose private filters/columns.

## Declared joins and reports

`readQuery` accepts declaration values and a closed expression vocabulary.
Attach the plan to `defineView({ query })`; HTTP/MCP exposure remains explicit.
Every source retains its own full resource visibility, unlike the existing
cross-source `run` escape whose producer-row-policy exception is separately
documented.

<!-- @conformance:ts imports= -->

```ts
import { defineModule, defineResource, defineView } from "hazelnut";
import { all, none, readQuery, unsafeRowPolicy } from "hazelnut/query";
import { z } from "zod";

const customer = defineResource({
  name: "customer",
  schema: z.object({ phone: z.string(), owner_id: z.string() }),
  rowPolicy: "owner_id",
  features: { versioning: false },
});
const membership = defineResource({
  name: "membership",
  schema: z.object({ customer_id: z.string(), owner_id: z.string() }),
  rowPolicy: "owner_id",
  features: { versioning: false, softDelete: true },
});
const sales = defineModule({
  name: "sales",
  resources: [customer, membership],
});
const query = readQuery({
  sources: { c: customer, m: membership },
  input: z.object({ minimum: z.string().default("1") }),
}, (s, q) => ({
  from: "c",
  joins: [{ source: "m", kind: "left", on: q.eq(s.m.customer_id, s.c.id) }],
  select: { id: s.c.id, phone: s.c.phone, memberships: q.count(s.m.id) },
  groupBy: [s.c.id, s.c.phone],
  having: q.gte(q.count(s.m.id), q.input("minimum")),
  orderBy: [{ by: s.c.id }],
}));
const report = defineView({
  name: "membership_totals",
  query,
  rowPolicy: unsafeRowPolicy((actor) =>
    actor?.claims.has("report:read") ? all() : none()
  ),
  http: { policy: "policy" },
  mcp: {
    describe: "Count the caller-visible memberships per visible customer.",
  },
});
void [sales, report];
```

Sources must resolve to registered resource values or registered over-form views
with positive columns, in one module. Use the actual declaration object, not a
spread copy. Distinct same-named resources can share a schema in different
modules; each witness still selects its own composed model. Registering the same
object in multiple homes is ambiguous and refuses. Later edits to the authored
object do not change the composed source policy or schema. An over-form view's
existing `over` name must still identify one resource. A shared database is not
permission to join across modules. Sensitive/encrypted/blind-index columns
cannot be used in **any** selector, predicate, join, grouping, HAVING, sort or
subquery of this served report form. Source visibility is inside each authorized
subquery, so a left join keeps a visible parent even when all its children are
hidden.

The vocabulary includes comparisons, `and/or/not/isNull`,
`count/sum/avg/min/max`, and correlated `exists` or `scalar` subqueries. Declare
a separate source alias for each repeated/self/correlated occurrence; an inner
scope cannot shadow an outer alias. A scalar subquery must produce at most one
row (for example by aggregation); PostgreSQL refuses multiple rows. Left-joined
fields and scalar results are nullable in the inferred result. `count`, `sum`
and `avg` are exact text outputs, with nullable sum/average on an empty group.
Numeric comparisons and ordering happen in PostgreSQL before that result
conversion. Comparisons and `and/or/not` preserve nullable values and
left-joined aliases in result inference; SQL may return `null`, not `false`.
`isNull` and `exists` return non-null booleans.

`q.value` and referenced `q.input` fields are SQL scalars: string, finite
number, boolean or null. They are not an arbitrary JavaScript-to-database codec.
Numeric/boolean parameters retain their SQL semantics even when selected alone;
text parameters use the opposing column or aggregate's PostgreSQL type. A
referenced optional input must be supplied or have a schema default. Grouping
rules and native operator/aggregate compatibility are still checked by
PostgreSQL; a typed expression is not proof that every SQL grouping is valid.

Query input is validated once per call. A missing referenced value is a
validation failure. When PostgreSQL identifies a conversion failure at a bound
caller-input parameter, HTTP returns 400 and MCP reports `validation`, without
the submitted value or database diagnostic. Authored constants/defaults,
policies and source-data failures are not caller validation errors. Omitted or
explicit `undefined` values that use a schema default/prefault remain authored
values, not caller bindings. SQLSTATE alone does not establish that distinction.
Missing, translated or unrecognized database error context, or multiple
ambiguous Bind frames, retains the native failure rather than guessing. A
recognized Bind frame may follow native type context or carry a
multiline/omitted value; values are never used to identify the caller parameter.
Narrow your input schema to the SQL use, especially with custom adapters or
localized servers. No extra validation query, connection or PostgreSQL codec is
added.

The plan owns input validation and `select`; do not also supply the old
`over/run/sources/input/where/columns` form. Use `q.input` for schema-declared
values, never interpolate caller data into SQL. Query views default/cap at 100
rows; they do not expose caller-controlled SQL or arbitrary paging controls.

For MCP query views, `hasMore` reports truncation at the framework's 100-row
cap. One internal result-row lookahead determines the flag; it is never
returned. A smaller authored plan limit remains the result's semantic bound, not
a page that the framework expands. `hasMore` does not supply a continuation for
an arbitrary report: use an author-defined bounded report or an over-form view
when you need paging. HTTP query views return a bare array capped at 100 rows,
with no continuation signal; do not use its length as proof of a complete
export.

## Database adapters and upgrade cost

The root library resolves both native driver dependencies before lazy imports.
Loading them does not initialize an engine or open a connection; your bound `Db`
continues to own execution and transactions.

Ordinary/compiler reads still use `Db.query(sql, params)` and unchanged native
values. New graph reads additionally require `queryArrays` on the **bound**
root, transaction, reserved and savepoint handles. Built-in PGlite/postgres.js
adapters supply it. A custom/decorated adapter must forward native ordered rows,
ordered column labels and public native text decoders; never reconstruct
positional rows with `Object.values` or substitute a root connection.

RQB's JSON envelope carries each nested value's native PostgreSQL type output,
not a SQL cast to text. SQL NULL remains null, boolean values keep their truth
value, inet host addresses retain the driver's representation, and fixed-width
character values retain their native padding. A type witness inside the same
statement selects the native parser (including array/domain metadata); the
adapter preserves bigint, exact numeric, bytea, dates, JSON, multidimensional
arrays and custom types instead of forcing them through a generic JSON decoder.
This uses the pinned public custom-type hooks, not a Drizzle fork or private
mapper import. Dependency upgrades must re-prove that adapter contract. Missing
metadata/capability fails loudly; old plain-Db reads remain usable.

For a `graph/*` failure, use its message to distinguish a rejected selection
from an adapter or compiler failure. Check relation/column names and selection
bounds for the former. For the latter, forward the bound handle's native
positional rows, labels and decoders without reshaping them; preserve the native
error rather than logging an ORM wrapper with SQL or parameters. An unsupported
compiler execution mode needs a framework report, not wider database
permissions. The [refusal catalog](refusals.md) lists the messages and next
steps.

No data migration, relation rewrite, pin change to the application's own raw
SQL, or automatic CustomerOS conversion is required by these additive APIs. Raw
queries remain the author's explicit authorization escape. They do not gain
policy, scope or lifecycle predicates merely because the internal compiler now
uses Drizzle.
