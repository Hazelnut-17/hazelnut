/** The `StorageDriver` Port-seam: file bytes live off-box; the framework owns only the opaque key, the
 *  grant, and the lifecycle GC. There is no default driver (unlike `kms`) — a `file()` field with none
 *  configured is a loud boot refuse, never a silent local-disk fallback. */

/** The bytes-transport seam. `put` is the proxy/server-side upload; `presignedGet`/`presignedPut` mint a
 *  TTL-bounded signed URL for a direct client↔store transfer (`file/signed-url-ttl`); `delete` GCs the
 *  off-box bytes. The Port expresses both modes so the driver — not app code — picks proxy-vs-presigned. */
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

/** A deterministic in-memory driver for tests (mirror `stubEmbed`): bytes in a Map, stable fake signed URLs. The
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

/** The local-disk driver (dev / single-box / self-host): bytes on disk under `dir`; the app serves them,
 *  so "presigned" URLs are app-relative paths the app's file route resolves. An explicit opt-in the app
 *  names — never an implicit default. */
export function localDriver(
  opts: { readonly dir: string; readonly serveBase?: string },
): StorageDriver {
  const base = (opts.serveBase ?? "/files").replace(/\/$/, "");
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
  return {
    put: async (key, bytes) => {
      const p = pathOf(key); // guarded — an unsafe key throws before any fs touch
      const slash = p.lastIndexOf("/");
      if (slash > opts.dir.length - 1) {
        await Deno.mkdir(p.slice(0, slash), { recursive: true });
      }
      await Deno.writeFile(p, bytes);
    },
    // async so an unsafe key rejects (not a sync throw) — a Promise-returning sink signals failure uniformly.
    presignedGet: async (key, ttlSec) => {
      guardKey(key); // never echo a `../` key into the served path
      const encoded = key.split("/").map(encodeURIComponent).join("/");
      return `${base}/${encoded}?ttl=${ttlSec}`;
    },
    presignedPut: async (key, ttlSec) => {
      guardKey(key);
      const encoded = key.split("/").map(encodeURIComponent).join("/");
      return `${base}/${encoded}?ttl=${ttlSec}&w=1`;
    },
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
