// `hazelnut/schema` — column vocabulary a declaration writes — explicit database defaults, native-type pins, file handles, money, password hashes, translatable marks.
//
// A CONCERN BARREL, and its membership is not written here: `scripts/surface-groups.ts` declares which
// symbols belong to this group as an equality. Not the Where algebra (`hazelnut/query`).

export {
  dbDefault,
  dbType,
  file,
  money,
  password,
  translatable,
} from "../data/schema.ts";

export type {
  DbDefaultKeys,
  DbDefaultMark,
  KnownSqlDefault,
  ResourceCreateInput,
} from "../data/db-default.ts";

export type {
  BrandedSchemaKeys,
  FileSchema,
  HasSchemaBrand,
  PasswordSchema,
} from "../data/schema-types.ts";
