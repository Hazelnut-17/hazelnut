/** The `StorageDriver` Port-seam: file bytes live off-box; the framework owns only the opaque key, the
 *  grant, and the lifecycle GC. There is no default driver (unlike `kms`) — a `file()` field with none
 *  configured is a loud boot refuse, never a silent local-disk fallback. */

/** The bytes-transport seam. `put` is the proxy/server-side upload; `presignedGet`/`presignedPut` mint a
 *  TTL-bounded URL (`file/signed-url-ttl`); `delete` GCs the off-box bytes. Off-box drivers honour both
 *  mint modes. `localDriver` serves GET `<serveBase>/*` only — `presignedPut` still stamps `&w=1`, but
 *  createRouter mounts no write door. */
export interface StorageDriver {
  readonly put: (
    key: string,
    bytes: Uint8Array,
    opts?: { readonly contentType?: string },
  ) => Promise<void>;
  readonly presignedGet: (key: string, ttlSec: number) => Promise<string>;
  readonly presignedPut: (key: string, ttlSec: number) => Promise<string>;
  readonly delete: (key: string) => Promise<void>;
}

/** Is `key` a safe, relative, no-traversal storage key? A client-controlled key that a driver resolves to
 *  a filesystem path/URL is a path-traversal vector if it carries `..`/an absolute prefix/NUL/backslash.
 *  Pure and driver-agnostic, so the `file()` schema refine and every driver boundary share one definition
 *  — traversal is closed at both the validation door and the sink (defense-in-depth). */
export function isSafeStorageKey(key: string): boolean {
  if (key.length === 0 || key.includes("\0") || key.includes("\\")) {
    return false;
  }
  if (key.startsWith("/") || /^[a-zA-Z]:/.test(key)) return false; // absolute (POSIX or Windows-drive)
  return key.split("/").every((seg) =>
    seg !== "" && seg !== "." && seg !== ".."
  );
}

/** A deterministic in-memory driver for tests (mirror `stubEmbed`): bytes in a Map, stable fake URLs. The
 *  `store` is exposed so teeth can assert `put`/`delete` reached the off-box bytes through the Port. */
export function stubStorage(): StorageDriver & {
  readonly store: Map<string, Uint8Array>;
} {
  const store = new Map<string, Uint8Array>();
  return {
    store,
    put: (key, bytes) => {
      store.set(key, bytes);
      return Promise.resolve();
    },
    presignedGet: (key, ttlSec) =>
      Promise.resolve(`stub://get/${encodeURIComponent(key)}?ttl=${ttlSec}`),
    presignedPut: (key, ttlSec) =>
      Promise.resolve(`stub://put/${encodeURIComponent(key)}?ttl=${ttlSec}`),
    delete: (key) => {
      store.delete(key);
      return Promise.resolve();
    },
  };
}

/** Brand on `localDriver`'s return. `createRouter` mounts GET `<serveBase>/*` when it sees this — off-box
 *  drivers mint the store's origin and must not grow an app route. Not on the public barrel. */
export const LOCAL_DRIVER = Symbol("hazelnut.localDriver");

export type LocalDriverBound = {
  readonly dir: string;
  readonly serveBase: string;
  readonly pathOf: (key: string) => string;
};

export type LocalStorageDriver = StorageDriver & {
  readonly [LOCAL_DRIVER]: LocalDriverBound;
};

export function localBound(
  storage: StorageDriver | undefined,
): LocalDriverBound | undefined {
  if (storage === undefined || !(LOCAL_DRIVER in storage)) return undefined;
  return (storage as LocalStorageDriver)[LOCAL_DRIVER];
}

/**
 * The local-disk driver (dev / single-box / self-host): bytes on disk under `dir`, served at `serveBase`.
 *
 * `serveBase` is REQUIRED. It defaulted to `/files` while nothing answered that path, so a grant minted
 * links to nothing. Naming the base is the author choosing the route; `createRouter` then serves GET
 * `<serveBase>/*` with `Content-Disposition: attachment`, the same read WHERE-stack as `find`, and an
 * `exp=` query the mint stamps so a leaked URL used as issued dies when the clamped TTL elapses. The
 * query is not a signature; the read gate is the authorization. Off-box drivers mint
 * the store's origin instead — no app route, no `exp=` of ours.
 */
export function localDriver(
  opts: { readonly dir: string; readonly serveBase: string },
): LocalStorageDriver {
  const trimmed = typeof opts.serveBase === "string"
    ? opts.serveBase.trim()
    : "";
  const base = trimmed.replace(/\/+$/, "");
  if (base === "") {
    throw new Error(
      `localDriver: serveBase is required — name the route this process serves these bytes on (e.g. serveBase: "/files"). ` +
        `createRouter serves GET <serveBase>/* : Content-Disposition: attachment, the same read gate that guards the row, ` +
        `and an exp= query that bounds the URL as issued (not a signature). Off-box drivers mint the store's origin and need no app route.`,
    );
  }
  // The last line of defense beneath the `file()` schema refine: even a key that reached the sink by
  // another path can never make `put`/`delete` touch an arbitrary file. Throws loud (fail-closed).
  const guardKey = (key: string) => {
    if (!isSafeStorageKey(key)) {
      throw new Error(
        `localDriver: refusing unsafe storage key ${
          JSON.stringify(key)
        } — a key must be relative with no '..'/'.' segments, no leading '/', no backslash, and no NUL (path-traversal guard, SEC-01)`,
      );
    }
  };
  const pathOf = (key: string) => {
    guardKey(key);
    return `${opts.dir}/${key}`;
  };
  const presign = (key: string, ttlSec: number, write: boolean): string => {
    guardKey(key); // never echo a `../` key into the served path
    const encoded = key.split("/").map(encodeURIComponent).join("/");
    const exp = Math.floor(Date.now() / 1000) + Math.max(1, Math.floor(ttlSec));
    return `${base}/${encoded}?exp=${exp}${write ? "&w=1" : ""}`;
  };
  return {
    [LOCAL_DRIVER]: { dir: opts.dir, serveBase: base, pathOf },
    put: async (key, bytes) => {
      const p = pathOf(key); // guarded — an unsafe key throws before any fs touch
      const slash = p.lastIndexOf("/");
      if (slash > opts.dir.length - 1) {
        await Deno.mkdir(p.slice(0, slash), { recursive: true });
      }
      await Deno.writeFile(p, bytes);
    },
    // async so an unsafe key rejects (not a sync throw) — a Promise-returning sink signals failure uniformly.
    presignedGet: async (key, ttlSec) => presign(key, ttlSec, false),
    presignedPut: async (key, ttlSec) => presign(key, ttlSec, true),
    delete: async (key) => {
      guardKey(key); // refuse an arbitrary-delete key loudly, before the best-effort remove
      try {
        await Deno.remove(pathOf(key));
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      }
    },
  };
}

// ── the minted object key (05-runtime.md §file) ──────────────────────────────────────────
//
// The client names the FILE; the framework names the OBJECT. A key the CLIENT chose could be shared by
// two rows — legitimately, since nothing constrains the column — and hard-deleting either enqueues that
// key for GC, destroying the survivor's bytes. Minting the key here makes the collision UNAUTHORABLE, so
// the GC's "does anything else point at this object" question has one answer by construction rather than
// a reference count that is always one race away from wrong.

/** The prefix every object of one row's `file()` field shares: `<pgSchema>/<table>/<field>/<rowId>/`.
 *  Row-scoped, which is what makes `keepsOrMintsFileKey` total — a value carrying this prefix can only
 *  have been minted for THIS row and field, so another row's key is never adopted. */
export function fileKeyPrefix(
  pgSchema: string,
  table: string,
  field: string,
  rowId: string,
): string {
  return `${pgSchema}/${table}/${field}/${rowId}/`;
}

/** The client's value reduced to one readable trailing segment, or `null` when nothing survives. Cosmetic
 *  — uniqueness lives in the uuid segment above it — so an unusable name is DROPPED, never rejected. */
function readableSegment(name: string): string | null {
  const base = name.slice(name.lastIndexOf("/") + 1)
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+/, "")
    .slice(0, 80);
  return base === "" || base === "." || base === ".." ? null : base;
}

/**
 * The key one write should store for a `file()` field, given what the caller sent and the row's prefix.
 *
 * A value already carrying this row+field's prefix is KEPT: read-modify-write is the ordinary way to
 * patch a row, and re-minting there would point the column at an object no upload ever filled. Every
 * other value is a NAME, and names a fresh object — including another row's key, which is exactly the
 * cross-reference this mint exists to make unauthorable.
 */
export function keepOrMintFileKey(
  sent: string,
  prefix: string,
  uuid: string,
): string {
  if (sent.startsWith(prefix)) return sent;
  const readable = readableSegment(sent);
  return `${prefix}${uuid}${readable === null ? "" : `/${readable}`}`;
}
