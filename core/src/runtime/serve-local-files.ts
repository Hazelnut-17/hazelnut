/**
 * `localDriver` bytes door: GET `<serveBase>/*` with `Content-Disposition: attachment`.
 *
 * Off-box drivers mint the store's origin — this route exists only when the bound driver is
 * `localDriver`. Authorization is the same read WHERE-stack as `find` (or the task-poll scope for
 * `_tasks/<id>/result.json`). `exp=` is the mint's wall-clock bound on the URL as issued, not a
 * signature: an elapsed `exp` is the same silent `notFound` as an unreadable row.
 */
import { all } from "../core/where.ts";
import { list, type ReadCtx, type RowPolicy } from "../data/repo.ts";
import { isSafeStorageKey, localBound } from "../data/storage.ts";
import { taskOwnsOffloadedResult } from "./tasks.ts";
import {
  type AuthVars,
  byIdWithin,
  errorBody,
  type HonoCtx,
  type HttpRow,
  type ServeConfig,
} from "./serve-helpers.ts";
import type { Hono } from "hono";

function silent404(c: { json: (body: unknown, status: number) => Response }) {
  return c.json(errorBody("notFound"), 404);
}

/** Decode the path under `serveBase` into a storage key, or `null` when it is unsafe/malformed. */
export function keyFromServePath(
  pathname: string,
  serveBase: string,
): string | null {
  if (pathname !== serveBase && !pathname.startsWith(`${serveBase}/`)) {
    return null;
  }
  const rest = pathname.slice(serveBase.length).replace(/^\//, "");
  if (rest === "") return null;
  const segs: string[] = [];
  for (const raw of rest.split("/")) {
    try {
      segs.push(decodeURIComponent(raw));
    } catch {
      return null;
    }
  }
  const key = segs.join("/");
  return isSafeStorageKey(key) ? key : null;
}

function attachmentName(key: string): string {
  const raw = key.slice(key.lastIndexOf("/") + 1);
  const safe = raw.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "")
    .slice(0, 80);
  return safe === "" || safe === "." || safe === ".." ? "download" : safe;
}

function locateFileKey(
  models: ServeConfig["app"]["model"],
  key: string,
): { m: (typeof models)[number]; field: string; rowId: string } | undefined {
  for (const m of models) {
    for (const field of m.files) {
      const prefix = `${m.pgSchema}/${m.name}/${field}/`;
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const slash = rest.indexOf("/");
      const rowId = slash === -1 ? rest : rest.slice(0, slash);
      if (rowId.length === 0) continue;
      return { m, field, rowId };
    }
  }
  return undefined;
}

function expAlive(raw: string | null, nowSec: number): boolean {
  if (raw === null) return false;
  const exp = Number(raw);
  return Number.isFinite(exp) && nowSec < exp;
}

export function registerLocalFileRoutes(
  router: Hono<{ Variables: AuthVars }>,
  cfg: ServeConfig,
  ctxOf: (c: HonoCtx) => ReadCtx,
): void {
  const bound = localBound(cfg.storage);
  if (bound === undefined) return;
  const { serveBase, pathOf } = bound;
  router.get(`${serveBase}/*`, async (c) => {
    const url = new URL(c.req.url);
    const key = keyFromServePath(url.pathname, serveBase); // windows-portability:allow-http (HTTP request URL, not an fs path)
    if (key === null) return silent404(c);
    if (!expAlive(url.searchParams.get("exp"), Math.floor(Date.now() / 1000))) {
      return silent404(c);
    }
    const ctx = ctxOf(c);
    const located = locateFileKey(cfg.app.model, key);
    if (located !== undefined) {
      if (!located.m.http["find"]) return silent404(c);
      const rp: RowPolicy<HttpRow> =
        (located.m.rowPolicy as RowPolicy<HttpRow> | null) ??
          (() => all<HttpRow>());
      const rows = await list<HttpRow>(
        cfg.db,
        located.m,
        ctx,
        rp,
        byIdWithin(all<HttpRow>(), located.rowId),
        cfg.kms,
      );
      const row = rows[0];
      if (!row || row[located.field] !== key) return silent404(c);
    } else if (
      (cfg.app.tasks?.length ?? 0) > 0 &&
      await taskOwnsOffloadedResult(cfg.db, key, ctx.scope)
    ) {
      // task poll already scoped this result; the bytes door re-checks the same scope.
    } else {
      return silent404(c);
    }
    try {
      const bytes = await Deno.readFile(pathOf(key));
      return c.body(bytes, 200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${attachmentName(key)}"`,
      });
    } catch {
      return silent404(c);
    }
  });
}
