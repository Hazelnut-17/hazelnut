// Refresh credentials contain 256 random bits. A keyed authenticator verifies possession without a
// password KDF; password entropy and refresh-token entropy have different offline guessing costs.
import type { Db, Transactor } from "../data/db.ts";
import { getLogSink } from "../core/ctx-provenance.ts";

export const PASSWORD_REFRESH_DDL =
  `CREATE TABLE IF NOT EXISTS "_password_refresh" (
  id text PRIMARY KEY, token_hash text NOT NULL, subject text NOT NULL,
  scope_key text NOT NULL DEFAULT '', session_id text NOT NULL DEFAULT '',
  family_started_at timestamptz NOT NULL DEFAULT now(), absolute_expires_at timestamptz,
  expires_at timestamptz NOT NULL, revoked boolean NOT NULL DEFAULT false, revoked_reason text,
  revoked_at timestamptz, successor_id text, created_at timestamptz NOT NULL DEFAULT now())`;
export const DEFAULT_REFRESH_TTL_SEC = 60 * 60 * 24 * 30;
export const DEFAULT_REFRESH_ABSOLUTE_TTL_SEC = 60 * 60 * 24 * 90;
export const DEFAULT_REFRESH_REPLAY_GRACE_SEC = 30;
const enc = new TextEncoder();

function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll(
    "/",
    "_",
  ).replace(/=+$/, "");
}
function bytes(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(
    atob(
      text.replaceAll("-", "+").replaceAll("_", "/") +
        "===".slice((text.length + 3) % 4),
    ),
    (c) => c.charCodeAt(0),
  );
}
function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
function parsed(token: string): { id: string; secret: string } | null {
  const match = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/i.exec(token);
  return match ? { id: match[1]!, secret: match[2]! } : null;
}
interface RefreshRecord {
  id: string;
  token_hash: string;
  subject: string;
  scope_key: string;
  session_id: string;
  family_started_at: string | Date;
  absolute_expires_at: string | Date;
  revoked: boolean;
  revoked_reason: string | null;
  successor_id: string | null;
  within_grace: boolean;
}
function material(
  row: Pick<RefreshRecord, "id" | "subject" | "scope_key">,
): Uint8Array<ArrayBuffer> {
  return enc.encode(
    JSON.stringify(["hazelnut:refresh:v2", row.id, row.subject, row.scope_key]),
  );
}
async function authenticator(
  secret: string,
  row: Pick<RefreshRecord, "id" | "subject" | "scope_key">,
): Promise<string> {
  return "hmac-sha256$" +
    b64(
      new Uint8Array(
        await crypto.subtle.sign("HMAC", await key(secret), material(row)),
      ),
    );
}
async function matches(secret: string, row: RefreshRecord): Promise<boolean> {
  if (!row.token_hash.startsWith("hmac-sha256$")) return false; // old sessions re-authenticate
  try {
    return await crypto.subtle.verify(
      "HMAC",
      await key(secret),
      bytes(row.token_hash.slice(12)),
      material(row),
    );
  } catch {
    return false;
  }
}
async function successorSecret(secret: string, id: string): Promise<string> {
  return b64(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        await key(secret),
        enc.encode(JSON.stringify(["hazelnut:refresh-successor:v2", id])),
      ),
    ),
  );
}

async function familyLock<T>(
  db: Db,
  subject: string,
  fn: (tx: Db) => Promise<T>,
): Promise<T> {
  const run = async (tx: Db) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `password-refresh-family:${subject}`,
    ]);
    return await fn(tx);
  };
  if (db.transactionScoped) return await run(db);
  if (typeof (db as Partial<Transactor>).transaction !== "function") {
    throw new Error(
      "password/refresh-family-transaction: refresh writes require a transaction-capable Db",
    );
  }
  return await (db as Db & Transactor).transaction(run);
}

interface RefreshIssueOpts {
  subject: string;
  scope?: string;
  ttlSec?: number;
  absoluteTtlSec?: number;
}
async function insert(
  db: Db,
  opts: RefreshIssueOpts & {
    id?: string;
    secret?: string;
    sessionId?: string;
    started?: string | Date;
    absolute?: string | Date;
  },
): Promise<string> {
  const id = opts.id ?? crypto.randomUUID();
  const secret = opts.secret ?? b64(crypto.getRandomValues(new Uint8Array(32)));
  const scope = opts.scope ?? "";
  await db.query(
    `INSERT INTO "_password_refresh"
    (id, token_hash, subject, scope_key, session_id, family_started_at, absolute_expires_at, expires_at)
    VALUES ($1, $2, $3, $4, $5, COALESCE($6::text::timestamptz, clock_timestamp()),
      COALESCE($7::text::timestamptz, clock_timestamp() + ($8 || ' seconds')::interval),
      LEAST(clock_timestamp() + ($9 || ' seconds')::interval,
        COALESCE($7::text::timestamptz, clock_timestamp() + ($8 || ' seconds')::interval)))`,
    [
      id,
      await authenticator(secret, {
        id,
        subject: opts.subject,
        scope_key: scope,
      }),
      opts.subject,
      scope,
      opts.sessionId ?? id,
      opts.started instanceof Date
        ? opts.started.toISOString()
        : opts.started ?? null,
      opts.absolute instanceof Date
        ? opts.absolute.toISOString()
        : opts.absolute ?? null,
      String(opts.absoluteTtlSec ?? DEFAULT_REFRESH_ABSOLUTE_TTL_SEC),
      String(opts.ttlSec ?? DEFAULT_REFRESH_TTL_SEC),
    ],
  );
  return `${id}.${secret}`;
}

/** Issue an independently revocable device session, bound to scope and an absolute lifetime. */
export function issueRefreshToken(
  db: Db,
  opts: RefreshIssueOpts,
): Promise<string> {
  return familyLock(db, opts.subject, (tx) => insert(tx, opts));
}

async function read(
  db: Db,
  token: string,
  scope: string,
  graceSec: number,
): Promise<RefreshRecord | null> {
  const credential = parsed(token);
  if (!credential) return null;
  // Keep these immutable timestamps as database text. A driver's JS Date would discard microseconds
  // each time the chain rotates, changing the original cap/start despite carrying the same values.
  const row = (await db.query<RefreshRecord>(
    `SELECT id, token_hash, subject, scope_key, session_id,
    family_started_at::text AS family_started_at, absolute_expires_at::text AS absolute_expires_at,
    revoked, revoked_reason, successor_id,
    (revoked_at IS NOT NULL AND revoked_at >= clock_timestamp() - ($3 || ' seconds')::interval) AS within_grace
    FROM "_password_refresh" WHERE id = $1 AND scope_key = $2
      AND expires_at > clock_timestamp() AND absolute_expires_at > clock_timestamp()`,
    [credential.id, scope, String(graceSec)],
  )).rows[0];
  return row && await matches(credential.secret, row) ? row : null;
}

/** The same scope is required on every refresh use. Grace is opt-in for the rotation recipe only. */
export async function verifyRefreshToken(db: Db, token: string, opts: {
  scope?: string;
  allowGrace?: boolean;
  replayGraceSec?: number;
} = {}): Promise<string | null> {
  const row = await read(
    db,
    token,
    opts.scope ?? "",
    opts.replayGraceSec ?? DEFAULT_REFRESH_REPLAY_GRACE_SEC,
  );
  return row &&
      (!row.revoked ||
        (opts.allowGrace && row.revoked_reason === "rotation" &&
          row.within_grace))
    ? row.subject
    : null;
}

/** Logout closes only the authenticated credential's active device session, including rotation retries.
 * An already-issued bearer retains its short remaining lifetime. */
export async function revokeRefreshToken(
  db: Db,
  token: string,
  opts: { scope?: string } = {},
): Promise<void> {
  const scope = opts.scope ?? "";
  const record = await read(db, token, scope, 0);
  if (
    !record || !record.session_id ||
    (record.revoked && record.revoked_reason !== "rotation")
  ) return;
  await familyLock(db, record.subject, async (tx) => {
    // Rotation, logout and family revocation share this lock. Authenticate and
    // re-check the credential inside it so a concurrent rotation cannot escape logout.
    const row = await read(tx, token, scope, 0);
    if (
      !row || row.subject !== record.subject ||
      row.session_id !== record.session_id ||
      (row.revoked && row.revoked_reason !== "rotation")
    ) return;
    await tx.query(
      `UPDATE "_password_refresh" AS target
       SET revoked = true, revoked_reason = 'logout', revoked_at = clock_timestamp()
       WHERE target.subject = $1 AND target.scope_key = $2 AND target.session_id = $3
         AND (NOT target.revoked OR target.revoked_reason = 'rotation')
         AND EXISTS (
           SELECT 1 FROM "_password_refresh" AS live
           WHERE live.subject = $1 AND live.scope_key = $2 AND live.session_id = $3
             AND NOT live.revoked AND live.expires_at > clock_timestamp()
             AND live.absolute_expires_at > clock_timestamp()
         )`,
      [row.subject, row.scope_key, row.session_id],
    );
  });
}

/** Password changes/removals omit scope to revoke the subject everywhere; scoped auth uses its own scope. */
export function revokeRefreshFamily(
  db: Db,
  subject: string,
  scope?: string,
): Promise<void> {
  return familyLock(db, subject, (tx) =>
    tx.query(
      `UPDATE "_password_refresh"
    SET revoked = true, revoked_reason = 'family', revoked_at = clock_timestamp()
    WHERE subject = $1 AND NOT revoked${
        scope === undefined ? "" : " AND scope_key = $2"
      }`,
      scope === undefined ? [subject] : [subject, scope],
    ).then(() => undefined));
}

/** Past-grace matching reuse is a theft signal. Within-grace retries never revoke another session. */
export async function revokeRefreshFamilyOnReplay(db: Db, token: string, opts: {
  scope?: string;
  replayGraceSec?: number;
} = {}): Promise<boolean> {
  const row = await read(
    db,
    token,
    opts.scope ?? "",
    opts.replayGraceSec ?? DEFAULT_REFRESH_REPLAY_GRACE_SEC,
  );
  if (!row?.revoked || row.revoked_reason !== "rotation" || row.within_grace) {
    return false;
  }
  await revokeRefreshFamily(db, row.subject, row.scope_key);
  getLogSink().drain({
    envelope: {
      traceId: crypto.randomUUID(),
      spanId: crypto.randomUUID(),
      actor: { id: row.subject, type: "user" },
      scope: row.scope_key,
    },
    op: { op: "auth/refresh-token-reuse" },
    origin: "http",
    outcome: "err",
    kind: "forbidden",
    durationMs: 0,
    message:
      "refresh-token reuse outside the retry grace revoked the scoped token family",
    attrs: { tokenId: row.id, action: "family-revoked" },
  });
  return true;
}

/** Rotations are single-use except a bounded retry grace, which returns the same surviving successor. */
export async function rotateRefreshToken(db: Db, token: string, opts: {
  ttlSec?: number;
  scope?: string;
  detectReuse?: boolean;
  replayGraceSec?: number;
} = {}): Promise<{ subject: string; refreshToken: string } | null> {
  const scope = opts.scope ?? "";
  const grace = opts.replayGraceSec ?? DEFAULT_REFRESH_REPLAY_GRACE_SEC;
  const record = await read(db, token, scope, grace);
  if (!record) return null;
  if (
    record.revoked &&
    (!record.within_grace || record.revoked_reason !== "rotation")
  ) {
    if (opts.detectReuse !== false) {
      await revokeRefreshFamilyOnReplay(db, token, opts);
    }
    return null;
  }
  return await familyLock(db, record.subject, async (tx) => {
    const row = await read(tx, token, scope, grace);
    if (!row) return null;
    const credential = parsed(token)!;
    if (row.revoked) {
      if (
        !row.within_grace || row.revoked_reason !== "rotation" ||
        !row.successor_id
      ) return null;
      const next = `${row.successor_id}.${await successorSecret(
        credential.secret,
        row.successor_id,
      )}`;
      return await verifyRefreshToken(tx, next, { scope }) === row.subject
        ? { subject: row.subject, refreshToken: next }
        : null;
    }
    const id = crypto.randomUUID();
    const secret = await successorSecret(credential.secret, id);
    const won = (await tx.query<{ id: string }>(
      `UPDATE "_password_refresh"
      SET revoked = true, revoked_reason = 'rotation', revoked_at = clock_timestamp(), successor_id = $2
      WHERE id = $1 AND NOT revoked AND expires_at > clock_timestamp()
        AND absolute_expires_at > clock_timestamp() RETURNING id`,
      [row.id, id],
    )).rows[0];
    if (!won) return null;
    return {
      subject: row.subject,
      refreshToken: await insert(tx, {
        id,
        secret,
        subject: row.subject,
        scope,
        ttlSec: opts.ttlSec,
        sessionId: row.session_id,
        started: row.family_started_at,
        absolute: row.absolute_expires_at,
      }),
    };
  });
}

/** Keep the proven current device session and revoke only the subject's other scoped refresh sessions. */
export async function revokeOtherRefreshSessions(
  db: Db,
  token: string,
  scope: string,
): Promise<number | null> {
  const current = await read(db, token, scope, 0);
  if (!current || current.revoked) return null;
  return await familyLock(db, current.subject, async (tx) => {
    if (await verifyRefreshToken(tx, token, { scope }) !== current.subject) {
      return null;
    }
    return (await tx.query(
      `UPDATE "_password_refresh"
      SET revoked = true, revoked_reason = 'other-session', revoked_at = clock_timestamp()
      WHERE subject = $1 AND scope_key = $2 AND session_id <> $3 AND NOT revoked RETURNING id`,
      [current.subject, scope, current.session_id],
    )).rows.length;
  });
}
