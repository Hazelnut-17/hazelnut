/** The `StorageDriver` Port-seam: file bytes live off-box; the framework owns only the opaque key, the
 *  grant, and the lifecycle GC. There is no default driver (unlike `kms`) — a `file()` field with none
 *  configured is a loud boot refuse, never a silent local-disk fallback. */

/** The bytes-transport seam. `put` is the proxy/server-side upload; `presignedGet`/`presignedPut` mint a
 *  TTL-bounded URL (`file/signed-url-ttl`); `delete` GCs the off-box bytes. Off-box drivers own both mint
 *  modes. `localDriver` serves authenticated GET and atomic if-absent PUT at `<serveBase>/*`.
 *  Upload signatures bind method and expiry; a download URL is never an upload capability. */
export interface StorageDriver {
  readonly put: (
    key: string,
    bytes: Uint8Array,
    opts?: { readonly contentType?: string },
  ) => Promise<void>;
  readonly presignedGet: (key: string, ttlSec: number) => Promise<string>;
  readonly presignedPut: (
    key: string,
    ttlSec: number,
    opts?: { readonly ifAbsent?: boolean },
  ) => Promise<string>;
  /** True only when presignedPut(...,{ifAbsent:true}) atomically refuses overwriting existing bytes. */
  readonly conditionalPut?: true;
  readonly delete: (key: string) => Promise<void>;
  /** Optional metadata capability. Null means that the object bytes do not exist. */
  readonly head?: (
    key: string,
  ) => Promise<{ readonly size: number; readonly contentType?: string } | null>;
  /** Optional streaming read. The consumer owns cancellation/closing of the returned stream. */
  readonly get?: (key: string) => Promise<
    {
      readonly body: ReadableStream<Uint8Array>;
      readonly size?: number;
      readonly contentType?: string;
    } | null
  >;
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
  const metadata = new Map<string, { readonly contentType?: string }>();
  return {
    store,
    conditionalPut: true,
    put: (key, bytes, opts) => {
      store.set(key, bytes.slice());
      metadata.set(key, { contentType: opts?.contentType });
      return Promise.resolve();
    },
    head: (key) =>
      Promise.resolve(
        store.has(key)
          ? { size: store.get(key)!.byteLength, ...metadata.get(key) }
          : null,
      ),
    get: (key) => {
      const bytes = store.get(key);
      return Promise.resolve(
        bytes
          ? {
            body: new Response(bytes.slice()).body!,
            size: bytes.byteLength,
            ...metadata.get(key),
          }
          : null,
      );
    },
    presignedGet: (key, ttlSec) =>
      Promise.resolve(`stub://get/${encodeURIComponent(key)}?ttl=${ttlSec}`),
    presignedPut: (key, ttlSec, opts) => {
      if (opts?.ifAbsent && store.has(key)) {
        return Promise.reject(
          Object.assign(
            new Error("file/upload-exists: object already exists"),
            { kind: "conflict" },
          ),
        );
      }
      return Promise.resolve(
        `stub://put/${encodeURIComponent(key)}?ttl=${ttlSec}${
          opts?.ifAbsent ? "&ifAbsent=1" : ""
        }`,
      );
    },
    delete: (key) => {
      store.delete(key);
      metadata.delete(key);
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
  /** True when `exp` and `sig` are the pair this driver minted for `key` — an extended `exp` fails. */
  readonly verifyGrant: (
    key: string,
    exp: string | null,
    sig: string | null,
    method?: "GET" | "PUT",
  ) => Promise<boolean>;
  readonly putNew: (
    key: string,
    body: ReadableStream<Uint8Array>,
    contentType?: string,
  ) => Promise<void>;
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
 * `exp=` + `sig=` pair the mint stamps (HMAC-SHA-256 over key and expiry) so a URL dies when the clamped
 * TTL elapses and cannot be extended. The read gate stays the authorization. `secret` keys the signature;
 * without it each process signs with its own random key, so several processes serving one directory pass
 * the same `secret`. Off-box drivers mint the store's origin instead — no app route, no `exp=` of ours.
 */
export function localDriver(
  opts: {
    readonly dir: string;
    readonly serveBase: string;
    readonly secret?: string;
  },
): LocalStorageDriver {
  const trimmed = typeof opts.serveBase === "string"
    ? opts.serveBase.trim()
    : "";
  const base = trimmed.replace(/\/+$/, "");
  if (base === "") {
    throw new Error(
      `localDriver: serveBase is required — name the route this process serves these bytes on (e.g. serveBase: "/files"). ` +
        `createRouter serves GET <serveBase>/* : Content-Disposition: attachment, the same read gate that guards the row, ` +
        `and a signed exp= query that bounds the URL as issued. Off-box drivers mint the store's origin and need no app route.`,
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
  // Metadata lives outside every resource/task key prefix, so an ordinary byte key cannot replace it.
  const metadataPath = async (key: string): Promise<string> => {
    guardKey(key);
    const hash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)),
    );
    return `${opts.dir}/.hazelnut-metadata/${
      [...hash].map((b) => b.toString(16).padStart(2, "0")).join("")
    }.json`;
  };
  const readMetadata = async (
    key: string,
  ): Promise<{ readonly contentType?: string }> => {
    try {
      const value: unknown = JSON.parse(
        await Deno.readTextFile(await metadataPath(key)),
      );
      return value && typeof value === "object" && "contentType" in value &&
          typeof value.contentType === "string"
        ? { contentType: value.contentType }
        : {};
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return {};
      throw error;
    }
  };
  const head: NonNullable<StorageDriver["head"]> = async (key) => {
    try {
      const stat = await Deno.stat(pathOf(key));
      if (!stat.isFile) return null;
      return { size: stat.size, ...await readMetadata(key) };
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      throw error;
    }
  };
  if (opts.secret !== undefined && opts.secret.length < 32) {
    throw new Error(
      "localDriver: secret must be at least 32 characters — it signs every download url this driver mints",
    );
  }
  const signingKey = crypto.subtle.importKey(
    "raw",
    opts.secret !== undefined
      ? new TextEncoder().encode(opts.secret)
      : crypto.getRandomValues(new Uint8Array(32)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = async (
    key: string,
    exp: string,
    method: "GET" | "PUT" = "GET",
  ): Promise<string> => {
    const mac = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        await signingKey,
        new TextEncoder().encode(
          method === "GET"
            ? `${key}\n${exp}`
            : `PUT\n${key}\n${exp}\nif-absent`,
        ),
      ),
    );
    return btoa(String.fromCharCode(...mac)).replace(/\+/g, "-")
      .replace(/\//g, "_").replace(/=+$/, "");
  };
  const presign = async (
    key: string,
    ttlSec: number,
    method: "GET" | "PUT" = "GET",
  ): Promise<string> => {
    guardKey(key); // never echo a `../` key into the served path
    const encoded = key.split("/").map(encodeURIComponent).join("/");
    const exp = String(
      Math.floor(Date.now() / 1000) + Math.max(1, Math.floor(ttlSec)),
    );
    return `${base}/${encoded}?exp=${exp}&sig=${await signature(
      key,
      exp,
      method,
    )}`;
  };
  const verifyGrant = async (
    key: string,
    exp: string | null,
    sig: string | null,
    method: "GET" | "PUT" = "GET",
  ): Promise<boolean> => {
    if (exp === null || sig === null || !/^\d+$/.test(exp)) return false;
    const expected = await signature(key, exp, method);
    if (expected.length !== sig.length) return false;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) {
      diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
    }
    return diff === 0;
  };
  return {
    conditionalPut: true,
    [LOCAL_DRIVER]: {
      dir: opts.dir,
      serveBase: base,
      pathOf,
      verifyGrant,
      putNew: async (key, body, contentType) => {
        const path = pathOf(key);
        await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), {
          recursive: true,
        });
        const file = await Deno.open(path, { write: true, createNew: true });
        try {
          await body.pipeTo(file.writable);
          await Deno.mkdir(`${opts.dir}/.hazelnut-metadata`, {
            recursive: true,
          });
          await Deno.writeTextFile(
            await metadataPath(key),
            JSON.stringify({ contentType }),
          );
        } catch (error) {
          try {
            file.close();
          } catch { /* the stream may already have closed its handle */ }
          try {
            await Deno.remove(path);
          } catch { /* preserve the original write failure */ }
          throw error;
        }
      },
    },
    head,
    get: async (key) => {
      let file: Deno.FsFile;
      try {
        file = await Deno.open(pathOf(key), { read: true });
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return null;
        throw error;
      }
      try {
        const stat = await file.stat();
        if (!stat.isFile) {
          file.close();
          return null;
        }
        return {
          body: file.readable,
          size: stat.size,
          ...await readMetadata(key),
        };
      } catch (error) {
        file.close();
        throw error;
      }
    },
    put: async (key, bytes, content) => {
      const p = pathOf(key); // guarded — an unsafe key throws before any fs touch
      const slash = p.lastIndexOf("/");
      if (slash > opts.dir.length - 1) {
        await Deno.mkdir(p.slice(0, slash), { recursive: true });
      }
      await Deno.writeFile(p, bytes);
      const metadata = await metadataPath(key);
      await Deno.mkdir(`${opts.dir}/.hazelnut-metadata`, { recursive: true });
      await Deno.writeTextFile(
        metadata,
        JSON.stringify({ contentType: content?.contentType }),
      );
    },
    // async so an unsafe key rejects (not a sync throw) — a Promise-returning sink signals failure uniformly.
    presignedGet: (key, ttlSec) => presign(key, ttlSec),
    presignedPut: (key, ttlSec) => presign(key, ttlSec, "PUT"),
    delete: async (key) => {
      guardKey(key); // refuse an arbitrary-delete key loudly, before the best-effort remove
      try {
        await Deno.remove(pathOf(key));
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      }
      try {
        await Deno.remove(await metadataPath(key));
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
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
