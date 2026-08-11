/** password-auth recipe (13-authz.md §password-auth-recipe) — self-hosted email/password over the auth
 *  seam, the human-login sibling of the agent-credential recipe. Owns token mechanics: a short-TTL
 *  stateless access JWT (HMAC-SHA256) + a long-TTL revocable refresh token (`_password_refresh`,
 *  single-use rotation). `password()` + hash-on-write live in schema.ts/repo.ts. */
import { z } from "zod";
import type { Db } from "../data/db.ts";
import { hashCode, needsRehash, verifyCodeHash } from "../core/code-helpers.ts";
import { KdfOverloadedError } from "../core/kdf-gate.ts";
import { getLogSink } from "../core/ctx-provenance.ts";
import { type Actor, type AuthResolver, userActor } from "../authz/auth.ts";
import {
  defineOp,
  err,
  ok,
  type OpDecl,
  type Result,
} from "../core/pipeline.ts";

// ── access JWT (stateless, HMAC-SHA256, bounded TTL) ────────────────────────────────────────────────────────

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlBytes(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlJSON(o: unknown): string {
  return b64urlBytes(enc.encode(JSON.stringify(o)));
}
function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") +
    "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** The framework-owned min length for an auth signing secret. An HMAC key this short is brute-forceable,
 *  and a forged access token is a full auth bypass (a self-signed `roles` claim). 32 chars is the floor. */
export const MIN_SIGNING_SECRET_LEN = 32;

/** Fail-closed at the auth-wiring seam: refuses a signing secret shorter than `MIN_SIGNING_SECRET_LEN` at
 *  construction, thrown by every app-facing factory, so a misconfigured app fails to boot rather than
 *  silently serving forgeable tokens. Cannot catch a long-but-hardcoded literal — the
 *  `password/secret-not-literal` lint is the second layer, pushing the secret to an env/secret-store binding. */
function assertStrongSigningSecret(secret: string): void {
  if (secret.length < MIN_SIGNING_SECRET_LEN) {
    throw new Error(
      `password-auth: the JWT signing secret must be at least ${MIN_SIGNING_SECRET_LEN} characters (got ${secret.length}). A short secret is brute-forceable, and a forged token is a full auth bypass. Source a high-entropy secret from the environment (e.g. a 32+ char random string), never a short or hard-coded value.`,
    );
  }
}

/** The bounded access-token TTL ceiling (`password/token-bounded-ttl`): a stateless JWT cannot be revoked before
 *  it expires, so a SHORT ceiling bounds the revocation lag (revocation rides the refresh layer). 15 minutes. */
export const MAX_ACCESS_TTL_SEC = 900;

export interface AccessClaims {
  readonly sub: string; // the authenticated user id
  readonly iat: number;
  readonly exp: number;
  readonly [k: string]: unknown;
}

/** Mint a short-TTL stateless access JWT (HS256). TTL is clamped to `MAX_ACCESS_TTL_SEC` by construction
 *  (`password/token-bounded-ttl`) — a caller cannot mint a long-lived, unrevocable access token. `nowMs`
 *  is the injectable clock; wall-clock `Date.now()` is the default. */
export async function mintAccessToken(
  opts: {
    secret: string;
    subject: string;
    claims?: Record<string, unknown>;
    ttlSec?: number;
    nowMs?: number;
  },
): Promise<string> {
  const ttl = Math.min(
    Math.max(1, opts.ttlSec ?? MAX_ACCESS_TTL_SEC),
    MAX_ACCESS_TTL_SEC,
  );
  const iat = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = { ...opts.claims, sub: opts.subject, iat, exp: iat + ttl };
  const signingInput = `${b64urlJSON(header)}.${b64urlJSON(payload)}`;
  const sig = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(opts.secret),
    enc.encode(signingInput) as BufferSource,
  );
  return `${signingInput}.${b64urlBytes(new Uint8Array(sig))}`;
}

/** Verify an access JWT: HMAC signature (constant-time `subtle.verify`) + not expired. Returns the claims,
 *  or null on any failure (bad shape/signature/expiry/missing sub) — never throws, so the resolver falls
 *  cleanly to the next credential/anonymous. */
export async function verifyAccessToken(
  opts: { secret: string; token: string; nowMs?: number },
): Promise<AccessClaims | null> {
  const parts = opts.token.split(".");
  if (parts.length !== 3) return null;
  const signingInput = `${parts[0]}.${parts[1]}`;
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(opts.secret),
      b64urlToBytes(parts[2]!) as BufferSource,
      enc.encode(signingInput) as BufferSource,
    );
  } catch {
    return null;
  }
  if (!valid) return null;
  let claims: AccessClaims;
  try {
    claims = JSON.parse(dec.decode(b64urlToBytes(parts[1]!)));
  } catch {
    return null;
  }
  const now = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  if (typeof claims.exp !== "number" || claims.exp < now) return null;
  if (typeof claims.sub !== "string") return null;
  return claims;
}

// ── refresh token (server-side, REVOCABLE, single-use rotation) — the `_password_refresh` framework table ───────

/** The conditional framework table for revocable refresh tokens — minted ONLY when the app uses
 *  `password()` (migrate.ts gates on it, like `_workflow_journal`). Stores token id + hashed secret
 *  (never raw) + subject + expiry; `revoked`/`expires_at` are checked DB-side. */
export const PASSWORD_REFRESH_DDL =
  `CREATE TABLE IF NOT EXISTS "_password_refresh" (id text PRIMARY KEY, token_hash text NOT NULL, subject text NOT NULL, expires_at timestamptz NOT NULL, revoked boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now())`;

export const DEFAULT_REFRESH_TTL_SEC = 60 * 60 * 24 * 30; // 30 days

function randomSecret(): string {
  return b64urlBytes(crypto.getRandomValues(new Uint8Array(32)));
}

/** Issue a refresh token for `subject`: store `{id, hash(secret), subject, expires_at}`, return the raw
 *  `<id>.<secret>` — the ONLY time the secret exists in the clear (the client keeps it; the server keeps only the
 *  hash, so a `_password_refresh` table dump cannot mint tokens). */
export async function issueRefreshToken(
  db: Db,
  opts: { subject: string; ttlSec?: number },
): Promise<string> {
  const id = crypto.randomUUID();
  const secret = randomSecret();
  const ttl = opts.ttlSec ?? DEFAULT_REFRESH_TTL_SEC;
  await db.query(
    `INSERT INTO "_password_refresh" (id, token_hash, subject, expires_at) VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval)`,
    [id, await hashCode(secret), opts.subject, String(ttl)],
  );
  return `${id}.${secret}`;
}

/** Verify a raw refresh token (`<id>.<secret>`): look up by id, constant-time-verify the secret against the stored
 *  hash, require NOT revoked AND NOT expired (both DB-side). Returns the subject or null. Never throws. */
export async function verifyRefreshToken(
  db: Db,
  token: string,
): Promise<string | null> {
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const id = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  const row = (await db.query<{ token_hash: string; subject: string }>(
    `SELECT token_hash, subject FROM "_password_refresh" WHERE id = $1 AND NOT revoked AND expires_at > now()`,
    [id],
  )).rows[0];
  if (!row) return null;
  if (!(await verifyCodeHash(secret, row.token_hash))) return null;
  return row.subject;
}

/** Revoke a refresh token (logout / rotation): mark its row revoked. Idempotent; a non-existent id is a no-op. */
export async function revokeRefreshToken(db: Db, token: string): Promise<void> {
  const dot = token.indexOf(".");
  const id = dot < 0 ? token : token.slice(0, dot);
  await db.query(
    `UPDATE "_password_refresh" SET revoked = true WHERE id = $1`,
    [id],
  );
}

/** Rotate a refresh token: verify, atomically single-use-consume it, issue a fresh one — of two concurrent
 *  rotations of the same token exactly one wins, the loser gets null. Detects reuse (OWASP): a
 *  still-live-but-revoked row whose secret still matches is a theft signal (a stolen token replayed after
 *  the legit client already rotated), so it revokes the subject's whole token family; a legit
 *  near-simultaneous double-submit never trips this (both pass verify, the loser dies at the `won` gate
 * instead). Design: */
export async function rotateRefreshToken(
  db: Db,
  token: string,
  opts: { ttlSec?: number } = {},
): Promise<{ subject: string; refreshToken: string } | null> {
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const id = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  const subject = await verifyRefreshToken(db, token);
  if (subject === null) {
    // reuse probe: only a still-live but revoked row whose secret matches is a replay of a consumed
    // token → family revoke + theft signal. Everything else (expired/wrong secret/unknown id) returns null.
    const consumed = (await db.query<{ token_hash: string; subject: string }>(
      `SELECT token_hash, subject FROM "_password_refresh" WHERE id = $1 AND revoked AND expires_at > now()`,
      [id],
    )).rows[0];
    if (consumed && (await verifyCodeHash(secret, consumed.token_hash))) {
      // family revocation — kill every live token for the subject.
      await db.query(
        `UPDATE "_password_refresh" SET revoked = true WHERE subject = $1 AND NOT revoked`,
        [consumed.subject],
      );
      // the theft signal → the installed provenance sink (SIEM-catchable; §6 stderr-JSON floor by default).
      getLogSink().drain({
        envelope: {
          traceId: crypto.randomUUID(),
          spanId: crypto.randomUUID(),
          actor: { id: consumed.subject, type: "user" },
          scope: null,
        },
        op: { op: "auth/refresh-token-reuse" },
        origin: "http",
        outcome: "err",
        kind: "forbidden",
        durationMs: 0,
        message:
          "refresh-token reuse detected — a replayed consumed token revoked the subject's token family",
        attrs: { tokenId: id, action: "family-revoked" },
      });
    }
    return null;
  }
  const won = (await db.query<{ id: string }>(
    `UPDATE "_password_refresh" SET revoked = true WHERE id = $1 AND NOT revoked RETURNING id`,
    [id],
  )).rows.length > 0;
  if (!won) return null; // a concurrent rotation already consumed it (single-use) — not a reuse signal (legit race)
  return {
    subject,
    refreshToken: await issueRefreshToken(db, { subject, ttlSec: opts.ttlSec }),
  };
}

// ── per-identifier PRE-AUTH login throttle (the brute-force bound the per-actor rate-limit cannot give) ─────────

/** The conditional per-identifier login-throttle counter — minted with `_password_refresh` (both gate on
 *  `password()`). One row per identifier value, a windowed count advanced by a single no-TOCTOU upsert.
 *  Login is pre-auth (no actor yet), so the per-actor `RateLimitStore` floor cannot
 *  bite it — this is the recipe's own counter, keyed on the submitted identifier. */
export const PASSWORD_LOGIN_THROTTLE_DDL =
  // `window_sec` (this row's window width) lets the TTL sweep delete a row only after its own window
  // closes, never a fixed 24h horizon — a >24h lockout would otherwise be swept live and silently reset.
  `CREATE TABLE IF NOT EXISTS "_password_login_attempt" (identifier text PRIMARY KEY, count int NOT NULL, window_start double precision NOT NULL, window_sec double precision NOT NULL DEFAULT 0)`;

/** The throttle-store key for an identifier — HMAC-SHA256 under the signing secret (hex). Keeps the
 *  per-identifier window exact (same key ⇒ same row) while storing no recoverable identifier; keyed, not
 *  a bare SHA-256, so a rainbow table over common emails is useless without the secret. */
export async function loginThrottleKey(
  secret: string,
  identifier: string,
): Promise<string> {
  const te = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    te.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, te.encode(identifier));
  return Array.from(new Uint8Array(mac)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

export interface LoginThrottle {
  readonly max: number; // attempts allowed per identifier per window
  readonly windowSec: number; // rolling window width
}
export const DEFAULT_LOGIN_THROTTLE: LoginThrottle = {
  max: 10,
  windowSec: 300,
}; // 10 attempts / 5 min per identifier

/** Check+increment of the per-identifier login throttle, as ONE statement. Returns false when the identifier
 *  is over its window budget. Atomicity comes from the `ON CONFLICT DO UPDATE` row lock, NOT from a
 *  surrounding transaction — a concurrent attempt on the same identifier blocks on that lock and its SET
 *  re-reads the committed row, so the counter is no-TOCTOU even in autocommit. That is what lets
 *  `passwordLogin` bill an attempt from the pre-tx policy step, where no tx exists to hold a `FOR UPDATE`.
 *  The count advances past `max` on a refusal, so the verdict reads straight off `RETURNING`.
 *  `nowSec` is the injectable clock. */
export async function checkLoginThrottle(
  db: Db,
  identifier: string,
  t: LoginThrottle,
  nowSec?: number,
): Promise<boolean> {
  const now = nowSec ?? Date.now() / 1000;
  const cur = (await db.query<{ count: number }>(
    `INSERT INTO "_password_login_attempt" AS a (identifier, count, window_start, window_sec)
     VALUES ($1, 1, $2, $3)
     ON CONFLICT (identifier) DO UPDATE SET
       count = CASE WHEN excluded.window_start - a.window_start >= excluded.window_sec THEN 1 ELSE a.count + 1 END,
       window_start = CASE WHEN excluded.window_start - a.window_start >= excluded.window_sec THEN excluded.window_start ELSE a.window_start END,
       window_sec = excluded.window_sec
     RETURNING count`,
    [identifier, now, t.windowSec],
  )).rows[0]!;
  return Number(cur.count) <= t.max;
}

// ── login op factory + auth resolver (the HTTP-facing seam — email identifier) ──────────────────────────────

/** `passwordAuthResolver({secret})` — the auth-seam resolver: reads a `Bearer <jwt>` off the request,
 *  verifies it, and returns a `user` Actor. Returns null on a missing/other-scheme/invalid token, so the
 *  `defineAuth` chain falls to the next resolver/anonymous. */
export function passwordAuthResolver(
  opts: { secret: string },
): AuthResolver<Request> {
  assertStrongSigningSecret(opts.secret); // fail-closed at construction — never verify tokens with a weak secret
  return async (req: Request): Promise<Actor | null> => {
    const header = req.headers.get("authorization");
    if (!header || !/^bearer /i.test(header)) return null; // not my credential type → next resolver
    const claims = await verifyAccessToken({
      secret: opts.secret,
      token: header.replace(/^bearer /i, "").trim(),
    });
    if (!claims) return null;
    const roles = Array.isArray(claims.roles)
      ? claims.roles.filter((r): r is string => typeof r === "string")
      : [];
    return userActor(claims.sub, roles);
  };
}

/** The boot-checkable binding a password-recipe op carries: the factory opts are stringly (`userResource`/
 *  field names), so factories stamp this onto the returned op and `createApp` cross-checks every field
 *  against the declared model (resource exists, schema matches, columns exist, password field is a real
 *  `password()` field) and refuses at boot. Existence-against-the-declared-set also closes the
 *  hostile-interpolation surface — only a declared column name reaches the recipe's quoted SQL. */
export interface PasswordOpBinding {
  readonly kind: "login" | "refresh";
  readonly userResource: string;
  readonly schema?: string;
  readonly fields: ReadonlyArray<
    {
      readonly role: "identifier" | "password" | "roles";
      readonly name: string;
    }
  >;
}

/** Stamp the binding onto a recipe op (a plain data property — serialization-inert, read only by the boot check). */
function withBinding<T extends object>(op: T, binding: PasswordOpBinding): T {
  return Object.assign(op, { _passwordBinding: binding });
}

export interface PasswordLoginOpts {
  readonly userResource: string; // the user resource/table name (the login looks up its row by `identifierField`)
  readonly schema?: string; // the user table's pg schema — required for a schema-per-module user (the
  // module name); omit for a flat public-schema user. Qualifies `"<schema>"."<userResource>"` when set.
  readonly identifierField: string; // e.g. "email" — the login identifier column
  readonly passwordField: string; // the `password()` field on the user resource (the hash column)
  readonly secret: string; // the JWT signing secret — project-sourced from a conventional env (config-sourcing pin)
  readonly rolesField?: string; // optional string-array (jsonb) column minted into the access token's
  // `roles` claim (`passwordAuthResolver` reads it back into the Actor). Omit it and every
  // `requires(...)`-gated op denies (the resolver sees no claim).
  readonly accessTtlSec?: number;
  readonly refreshTtlSec?: number;
  readonly throttle?: LoginThrottle; // per-identifier pre-auth throttle (default DEFAULT_LOGIN_THROTTLE)
}

/** Normalize a jsonb string-array column across drivers (a raw read may hand it back parsed or as JSON
 *  text): array → its string members; JSON-text → parsed then filtered; anything else → []. Fails soft —
 *  a malformed roles cell yields no roles, never a throw that would turn a login into a 500. */
function stringRoles(v: unknown): string[] {
  let parsed: unknown = v;
  if (typeof v === "string") {
    try {
      parsed = JSON.parse(v);
    } catch {
      return [];
    }
  }
  return Array.isArray(parsed)
    ? parsed.filter((r): r is string => typeof r === "string")
    : [];
}

let dummyHash: string | undefined; // a fixed hash for the no-user path (constant-time — no user-enumeration oracle)

/** `passwordLogin({user, identifierField, passwordField, secret})` — a reusable login op for a
 *  `password()`-bearing user resource: verify identifier+password (constant-time) → mint an access JWT +
 *  issue a refresh token. Public/pre-auth. A wrong password and a non-existent identifier return the same
 *  `err("forbidden","invalid credentials")` — no user-enumeration. */
export function passwordLogin(
  opts: PasswordLoginOpts,
): OpDecl<
  Record<string, string>,
  { accessToken: string; refreshToken: string }
> {
  assertStrongSigningSecret(opts.secret); // fail-closed at construction — never mint tokens with a weak secret
  const schema = z.object({
    [opts.identifierField]: z.string(),
    [opts.passwordField]: z.string(),
  }) as unknown as z.ZodType<Record<string, string>>;
  const binding: PasswordOpBinding = {
    kind: "login",
    userResource: opts.userResource,
    ...(opts.schema !== undefined ? { schema: opts.schema } : {}),
    fields: [
      { role: "identifier", name: opts.identifierField },
      { role: "password", name: opts.passwordField },
      ...(opts.rolesField
        ? [{ role: "roles", name: opts.rolesField } as const]
        : []),
    ],
  };
  const throttle = opts.throttle ?? DEFAULT_LOGIN_THROTTLE;
  return withBinding(
    defineOp({
      input: schema,
      tx: "write",
      // no claim row: every login mints a fresh token pair, and a replayed key handing back a cached one
      // would keep a revoked session alive.
      idempotent: false,
      // Login is public/pre-auth — the password is the gate. The throttle bills from policy, the pipeline's
      // only PRE-TX step (05-runtime.md §op-pipeline): a wrong password returns `err`, the write tx rolls
      // back on `err`, so an attempt billed in-tx unbills itself and bounds successful logins only.
      // Denying here also keeps the gate fail-closed — a verdict handed on to the handler fails open.
      policy: async (_actor, input, ctx) => {
        const admitted = await checkLoginThrottle(
          ctx.db, // the pre-tx step's db is the base handle — this attempt commits on its own
          await loginThrottleKey(opts.secret, input[opts.identifierField]!),
          throttle,
        );
        // a lockout and a plain policy denial are both `forbidden` on the wire; the §6 record separates them.
        if (!admitted) ctx.log.set("loginThrottled", true);
        return admitted;
      },
      handler: async (
        input,
        ctx,
      ): Promise<Result<{ accessToken: string; refreshToken: string }>> => {
        const identifier = input[opts.identifierField]!;
        const presented = input[opts.passwordField]!;
        // read the auth hash directly: the typed repo (`ctx.data`) redacts the password column, so this
        // is a vetted, parameterized auth lookup, never a business read. Schema-qualified for a module user.
        const table = opts.schema
          ? `"${opts.schema}"."${opts.userResource}"`
          : `"${opts.userResource}"`;
        const rolesSel = opts.rolesField
          ? `, "${opts.rolesField}" AS roles`
          : "";
        const row =
          (await ctx.db.query<{ id: string; pw: string; roles?: unknown }>(
            `SELECT id, "${opts.passwordField}" AS pw${rolesSel} FROM ${table} WHERE "${opts.identifierField}" = $1 LIMIT 1`,
            [identifier],
          )).rows[0];
        // constant-time: always run a verify (dummy hash on no-user) so timing never reveals whether the
        // identifier exists — the rejection is byte-identical either way.
        const stored = row
          ? row.pw
          : (dummyHash ??= await hashCode(crypto.randomUUID()));
        // The derivation gate can refuse under load. That is NOT a credential verdict — surfacing it as
        // `forbidden` would tell a legitimate user their password is wrong and tell an attacker when the
        // box is saturated. `timeout` is retryable and says what actually happened.
        let okPw: boolean;
        try {
          okPw = await verifyCodeHash(presented, stored);
        } catch (e) {
          if (e instanceof KdfOverloadedError) {
            ctx.log.set("kdfOverloaded", true);
            return err("timeout", "password hashing is saturated — retry");
          }
          throw e;
        }
        if (!row || !okPw) return err("forbidden", "invalid credentials");
        // Login is the ONE moment the plaintext and the stored hash are both in hand, so it is the only
        // place a hash written under retired parameters can be upgraded. Without this, raising the KDF cost
        // protects new accounts and silently leaves every existing one behind. Rides this op's own write tx.
        if (needsRehash(stored)) {
          await ctx.db.query(
            `UPDATE ${table} SET "${opts.passwordField}" = $1 WHERE id = $2`,
            [await hashCode(presented), row.id],
          );
          ctx.log.set("passwordRehashed", true);
        }
        const claims = opts.rolesField
          ? { roles: stringRoles(row.roles) }
          : undefined;
        const accessToken = await mintAccessToken({
          secret: opts.secret,
          subject: row.id,
          ttlSec: opts.accessTtlSec,
          ...(claims ? { claims } : {}),
        });
        const refreshToken = await issueRefreshToken(ctx.db, {
          subject: row.id,
          ttlSec: opts.refreshTtlSec,
        });
        return ok({ accessToken, refreshToken });
      },
    }),
    binding,
  );
}

/** `passwordRefresh({secret})` — present a refresh token, rotate it (single-use), mint a fresh access JWT.
 *  Public — the refresh token is the credential. An invalid/expired/already-consumed token returns
 *  `err("forbidden")`. Returns the rotated `{accessToken, refreshToken}` pair.
 *
 *  `rolesFrom` pairs with login's `rolesField`: the refreshed token re-reads the user row's roles column
 *  (never copies the old token's claim), so a grant/revocation takes effect at the next refresh — without
 *  it, a refresh would silently drop the roles login minted and every perm-gated op would start denying. */
export function passwordRefresh(
  opts: {
    secret: string;
    accessTtlSec?: number;
    refreshTtlSec?: number;
    rolesFrom?: { userResource: string; schema?: string; field: string };
  },
): OpDecl<
  { refreshToken: string },
  { accessToken: string; refreshToken: string }
> {
  assertStrongSigningSecret(opts.secret); // fail-closed at construction — never mint tokens with a weak secret
  const binding: PasswordOpBinding | null = opts.rolesFrom
    ? {
      kind: "refresh",
      userResource: opts.rolesFrom.userResource,
      ...(opts.rolesFrom.schema !== undefined
        ? { schema: opts.rolesFrom.schema }
        : {}),
      fields: [{ role: "roles", name: opts.rolesFrom.field }],
    }
    : null; // no rolesFrom ⇒ the op touches no user table — nothing to bind-check
  const op = defineOp({
    input: z.object({ refreshToken: z.string() }),
    tx: "write",
    // no claim row: rotation consumes the presented token, so a resend fails on the token itself.
    idempotent: false,
    policy: () => true,
    handler: async (
      input,
      ctx,
    ): Promise<Result<{ accessToken: string; refreshToken: string }>> => {
      const rot = await rotateRefreshToken(ctx.db, input.refreshToken, {
        ttlSec: opts.refreshTtlSec,
      });
      if (!rot) return err("forbidden", "invalid refresh token");
      let claims: Record<string, unknown> | undefined;
      if (opts.rolesFrom) {
        const t = opts.rolesFrom.schema
          ? `"${opts.rolesFrom.schema}"."${opts.rolesFrom.userResource}"`
          : `"${opts.rolesFrom.userResource}"`;
        const r = (await ctx.db.query<{ roles: unknown }>(
          `SELECT "${opts.rolesFrom.field}" AS roles FROM ${t} WHERE id = $1 LIMIT 1`,
          [rot.subject],
        )).rows[0];
        claims = { roles: stringRoles(r?.roles) };
      }
      const accessToken = await mintAccessToken({
        secret: opts.secret,
        subject: rot.subject,
        ttlSec: opts.accessTtlSec,
        ...(claims ? { claims } : {}),
      });
      return ok({ accessToken, refreshToken: rot.refreshToken });
    },
  });
  return binding ? withBinding(op, binding) : op;
}

/** `passwordLogout()` — revoke the presented refresh token (the access JWT expires on its own short TTL).
 *  Public and idempotent — revoking an unknown/already-revoked token is a clean no-op. */
export function passwordLogout(): OpDecl<
  { refreshToken: string },
  Record<string, never>
> {
  return defineOp({
    input: z.object({ refreshToken: z.string() }),
    tx: "write",
    // no claim row: revoking an already-revoked token is a clean no-op, so a resend converges.
    idempotent: false,
    policy: () => true,
    handler: async (input, ctx): Promise<Result<Record<string, never>>> => {
      await revokeRefreshToken(ctx.db, input.refreshToken);
      return ok({});
    },
  });
}
