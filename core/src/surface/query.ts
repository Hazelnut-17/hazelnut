// `hazelnut/query` — ask a question of a row — the Where algebra, the rowPolicy fragments, and the column/relation vocabulary a question is asked over.
//
// A CONCERN BARREL, and its membership is not written here: `scripts/surface-groups.ts` declares which
// symbols belong to this group as an equality, so a symbol
// cannot be reachable from two paths or from none. Re-exports point at the CONCRETE home, never at the
// root barrel — that is what keeps the group importable without pulling the whole surface in.

export {
  avg,
  count,
  hasMany,
  hasOne,
  manyToMany,
  max,
  min,
  ref,
  refById,
  sum,
} from "../core/app-refs.ts";
export {
  all,
  and,
  andPolicy,
  eq,
  fields,
  gt,
  gte,
  inArray,
  isNull,
  like,
  lt,
  lte,
  ne,
  none,
  not,
  or,
  orPolicy,
  owned,
  ramp,
  relate,
  shared,
  sharedVia,
  withinScope,
} from "../core/where.ts";
export type {
  Condition,
  Field,
  Fields,
  Fragment,
  Where,
} from "../core/where.ts";
export { dbType, file, money, password, translatable } from "../data/schema.ts";
