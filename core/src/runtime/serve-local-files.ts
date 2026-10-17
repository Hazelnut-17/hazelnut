/**
 * `localDriver` bytes door: GET `<serveBase>/*` with `Content-Disposition: attachment`.
 *
 * Off-box drivers mint the store's origin — this route exists only when the bound driver is
 * `localDriver`. Authorization is the same read WHERE-stack as `find` (or the task-poll scope for
 * `_tasks/<id>/result.json`). Signed `exp=` authenticates the URL's wall-clock bound.
 * New task results include a stable hex-encoded outbox-delivery segment before `result.json`; the legacy
 * one-segment task key remains accepted. Upload signatures also bind PUT and if-absent mode.
 * An elapsed `exp` is the same silent `notFound` as an unreadable row.
 */
import { all } from "../core/where.ts";
import { list, type ReadCtx, type RowPolicy } from "../data/repo.ts";
import { isSafeStorageKey, localBound } from "../data/storage.ts";
import { taskOwnsOffloadedResult, taskSubmitter } from "./tasks.ts";
import { grantedFileFields } from "../features/redact.ts";
import { crudWriteDenied } from "../authz/auth.ts";
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
  const { serveBase, verifyGrant } = bound;
  router.use(`${serveBase}/*`, async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    const vary = c.res.headers.get("Vary");
    if (
      !vary?.split(",").some((value) =>
        value.trim().toLowerCase() === "authorization"
      )
    ) c.header("Vary", vary ? `${vary}, Authorization` : "Authorization");
    await next();
  });
  router.get(`${serveBase}/*`, async (c) => {
    const url = new URL(c.req.url);
    const key = keyFromServePath(url.pathname, serveBase); // windows-portability:allow-http (HTTP request URL, not an fs path)
    if (key === null) return silent404(c);
    const exp = url.searchParams.get("exp");
    if (
      !expAlive(exp, Math.floor(Date.now() / 1000)) ||
      !await verifyGrant(key, exp, url.searchParams.get("sig"))
    ) return silent404(c);
    const ctx = ctxOf(c);
    const located = locateFileKey(cfg.app.model, key);
    if (located !== undefined) {
      if (!grantedFileFields(located.m).includes(located.field)) {
        return silent404(c);
      }
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
      await taskOwnsOffloadedResult(
        cfg.db,
        key,
        ctx.scope,
        taskSubmitter(ctx.actor),
      )
    ) {
      // task poll already scoped this result; the bytes door re-checks the same scope.
    } else {
      return silent404(c);
    }
    try {
      const object = await cfg.storage!.get?.(key);
      if (!object) return silent404(c);
      return c.body(object.body, 200, {
        "Content-Type": object.contentType ?? "application/octet-stream",
        "Content-Disposition": `attachment; filename="${attachmentName(key)}"`,
        "X-Content-Type-Options": "nosniff",
        ...(object.size === undefined
          ? {}
          : { "Content-Length": String(object.size) }),
      });
    } catch {
      return silent404(c);
    }
  });
  router.put(`${serveBase}/*`, async (c) => {
    const url = new URL(c.req.url);
    const key = keyFromServePath(url.pathname, serveBase); // windows-portability:allow-http (HTTP request URL, not an fs path)
    const exp = url.searchParams.get("exp");
    if (
      !key || !expAlive(exp, Math.floor(Date.now() / 1000)) ||
      !await verifyGrant(key, exp, url.searchParams.get("sig"), "PUT")
    ) return silent404(c);
    const located = locateFileKey(cfg.app.model, key), ctx = ctxOf(c);
    if (!located || !grantedFileFields(located.m).includes(located.field)) {
      return silent404(c);
    }
    if (crudWriteDenied(ctx.actor, located.m.name, "update", true)) {
      return c.json(errorBody("forbidden"), 403);
    }
    const policy = (located.m.rowPolicy as RowPolicy<HttpRow> | null) ??
      (() => all<HttpRow>());
    const current = async () =>
      (await list<HttpRow>(cfg.db, located.m, ctx, policy, {
        id: located.rowId,
      }, cfg.kms))[0];
    if ((await current())?.[located.field] !== key) return silent404(c);
    try {
      await bound.putNew(
        key,
        c.req.raw.body ?? new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        c.req.header("content-type"),
      );
      if ((await current())?.[located.field] !== key) {
        await cfg.storage!.delete(key);
        return silent404(c);
      }
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof Deno.errors.AlreadyExists) {
        return c.json(
          errorBody(
            "conflict",
            "file already uploaded; replace the file field to mint a new key",
          ),
          409,
        );
      }
      return c.json(errorBody("internal"), 500);
    }
  });
}
