# Codes, hashes, and slugs

> **Reference** — for the handler author using `ctx.code` to generate codes,
> store a token hash, verify a secret, or turn a title into a URL slug.

Every operation context carries `ctx.code`. These helpers do not read or write
the database. Declare uniqueness, expiry, redemption state, and authorization on
the resource and operation that use their result.

| Method                                         | Result    | Use it for                                                         |
| ---------------------------------------------- | --------- | ------------------------------------------------------------------ |
| `await ctx.code.generate(config?)`             | `string`  | A cryptographically random code, formatted for a person or machine |
| `await ctx.code.hash(plaintext)`               | `string`  | A salted, slow hash of a password or confirmation token            |
| `await ctx.code.verifyHash(plaintext, stored)` | `boolean` | Checking a candidate against a stored hash                         |
| `ctx.code.slugify(text, options?)`             | `string`  | A deterministic URL slug; this call is synchronous                 |

## Generate a code

<!-- @conformance:ts imports=Ctx -->

```ts
import type { Ctx } from "hazelnut";
declare const ctx: Ctx<undefined>;

const invitation = await ctx.code.generate(); // 10 upper-case no-confusables glyphs
const printed = await ctx.code.generate({
  length: 12,
  alphabet: "crockford32",
  prefix: "M-",
  groups: { size: 4, sep: "-" },
}); // M-XXXX-XXXX-XXXX, where each X is random
const patterned = await ctx.code.generate({
  pattern: "INV-XXXX-XXXX",
  alphabet: "no-confusables",
});
```

| Option             | Default            | Behaviour                                                                                                |
| ------------------ | ------------------ | -------------------------------------------------------------------------------------------------------- |
| `length`           | `10`               | Number of random characters; a positive safe integer                                                     |
| `alphabet`         | `"no-confusables"` | `"alphanumeric"`, `"numeric"`, `"alpha"`, `"crockford32"`, `"no-confusables"`, or a custom character set |
| `case`             | `"upper"`          | `"upper"`, `"lower"`, or `"mixed"`; applies to the random alphabet and pattern literals                  |
| `prefix`, `suffix` | `""`               | Fixed text outside the body; kept as supplied                                                            |
| `groups`           | none               | `{ size, sep }` groups the random body; only positive `size` groups it                                   |
| `excludeVowels`    | `false`            | Removes vowels from the random alphabet                                                                  |
| `pattern`          | none               | Every upper-case `X` draws one glyph; other characters are literal. Overrides `length` and grouping      |

The alphabet is deduplicated after case folding and filtering. Fewer than two
usable glyphs is an error. Use simple ASCII characters in a custom alphabet. The
default removes `0`, `O`, `1`, `I`, and `L`; Crockford32 includes digits but
omits `I`, `L`, `O`, and `U`.

Only random positions contribute entropy: prefixes, separators, and literal
pattern characters add none. The default provides about 49.5 bits. Choose a
longer code when the live population or guessing exposure needs it. For a short
numeric code, use a short expiry, a narrow redemption policy, and an attempt
throttle; the helper itself imposes none of these.

`generate` does not reserve the result or retry an insert. Put `unique` on the
stored code or token identifier. A collision surfaces as `err("conflict")` from
`ctx.data.<resource>.create`; generate a new candidate in a bounded application
retry, using a fresh operation transaction or `ctx.savepoint` for the failed
insert. There are no `scope` or `maxRetries` helper options. Scope belongs to
the resource's uniqueness declaration. A code stays unchanged until your
application writes a replacement.

## Hash and verify a secret

<!-- @conformance:ts imports=Ctx -->

```ts
import type { Ctx } from "hazelnut";
declare const ctx: Ctx<undefined>;

const token = await ctx.code.generate({ length: 24, case: "mixed" });
const stored = await ctx.code.hash(token);
const accepted = await ctx.code.verifyHash(token, stored); // true
const rejected = await ctx.code.verifyHash("another-token", stored); // false
const slug = ctx.code.slugify("Crème Brûlée", { suffix: 2 }); // creme-brulee-2
```

`hash` writes a self-describing Argon2id record with a fresh 16-byte salt and a
32-byte derived key. Its profile is 19 MiB memory, two iterations, one lane.
Hashing the same plaintext twice produces different records; use `verifyHash` to
compare, never string equality between two calls to `hash`.

`verifyHash` also accepts legacy PBKDF2 records written by older releases. A
malformed or unknown record, or a stored cost above the current Argon2id profile
on any axis (or above 600000 PBKDF2 iterations), returns `false` without
deriving. Both calls share a process-wide bound of four active derivations;
waiting more than two seconds for capacity raises a retryable `timeout`. Keep a
login or redemption throttle as well.

Store a confirmation hash in a `sensitive` field. Give the row an expiry and a
pending-to-used transition, and use a version check or an explicit row lock to
make consumption atomic. `verifyHash` checks the secret; it does not expire or
consume the token. A declared `password()` field is hashed automatically by its
normal write path: pass that field plaintext instead of hashing it again. Hashes
cannot be decrypted; for retrievable secrets, use an encrypted field and
configure the app's KMS.

## Slug options

`slugify` lowercases, strips combining diacritics, replaces each run outside
`a-z`, `0-9` with one hyphen, and trims edge hyphens. Unsupported characters can
leave an empty string: validate that result if a slug is required.

`maxLength` truncates the normalized base and removes a trailing hyphen.
`suffix` appends `-<value>` afterwards, so it can make the final result longer
than `maxLength`. Supply a URL-safe suffix yourself; the suffix is appended
verbatim. The same input and options give the same slug. Declare a unique
constraint and handle collisions where the slug is stored.
