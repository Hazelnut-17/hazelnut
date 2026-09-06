/**
 * The `ctx.data` / `ctx.config` VERB NAMES, as plain strings and nothing else.
 *
 * A leaf on purpose: the lint floor derives its read set from `DATA_ROW_READ_VERBS`, and the floor plugin must
 * load inside a consumer's bare workspace — importing the runtime facade to reach a string array would pull
 * zod in behind it and every `deno lint` would fail to load the plugin. One roster, both rungs, no runtime.
 */
/**
 * The `ctx.data` verbs that hand a handler ANOTHER row's stored contents — the read-door set the row-visibility
 * boot guard covers (`core/model-guards.ts §policyReadLeak`). `count`/`exists`/`depth` return an aggregate and
 * `related` returns ids, so neither carries a row; every write verb reads back only the row it addressed. The
 * complement is PARTITIONED against the live `ctx.data` facade keys, so a new verb is classified or RED.
 */
export const DATA_ROW_READ_VERBS = [
  "ancestors",
  "byIds",
  "children",
  "descendants",
  "find",
  "findForUpdate",
  "findOrFail",
  "list",
  "listPage",
  "search",
] as const;

/**
 * The `ctx.data` verbs that mutate a PRE-EXISTING row — the write-door set `policy/write-protected` covers
 * (`core/model-guards.ts §policyWriteLeak`), the twin of `DATA_ROW_READ_VERBS`. Membership is an EFFECT, not a
 * category: each one narrows by the resource's rowPolicy (`link`/`unlink` gate BOTH endpoints' visibility
 * first), so demanding a policy of a resource an exposed op writes really does block the cross-owner patch.
 * `create`/`createMany` mint a row — there is no pre-existing row for a WHERE to narrow, so a demand there
 * would read as satisfied and enforce nothing. Aggregates and the reads are the rest of the partition.
 */
export const DATA_ROW_WRITE_VERBS = [
  "delete",
  "deleteMany",
  "deleteWhere",
  "link",
  "move",
  "rectify",
  "restore",
  "unlink",
  "update",
  "updateMany",
  "updateWhere",
] as const;

/** The `ctx.config` verbs onto a `singleton` resource's row — the same two doors under a second facade name.
 *  `getOrSeedConfig` returns the stored row and `replace` rewrites it, and BOTH run the rowPolicy conjunct
 *  (`repo-config.ts §readSingletonRow`, and `replace` writes through `update`), so a singleton's op door
 *  obliges exactly as `http.find`/`http.update` on the same resource already does. */
export const CONFIG_ROW_READ_VERBS = ["getOrSeedConfig"] as const;
export const CONFIG_ROW_WRITE_VERBS = ["replace"] as const;
