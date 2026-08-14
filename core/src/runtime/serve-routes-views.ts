// Opt-in `defineView` HTTP — GET /views/<name>, extracted so the resource CRUD loop never grows a third face.
import type { Hono } from "hono";
import { z } from "zod";
import { isAnonymous } from "../authz/auth.ts";
import {
  httpVisibleViews,
  runView,
  ViewForbiddenError,
  viewHttpPath,
} from "../features/view.ts";
import type { AuthVars } from "./serve-helpers.ts";
import type { RouteCtx } from "./serve-routes.ts";

export function registerViewRoutes(
  router: Hono<{ Variables: AuthVars }>,
  rctx: RouteCtx,
): void {
  const { cfg, ctxOf } = rctx;
  for (const view of httpVisibleViews(cfg.app.views ?? [])) {
    const path = viewHttpPath(view);
    if (view.http.policy === "public") rctx.deferAuthn("GET", path);
    router.get(path, async (c) => {
      const ctx = ctxOf(c);
      if (view.http.policy === "policy" && isAnonymous(ctx.actor)) {
        return c.json({ error: "forbidden" }, 403);
      }
      let input: unknown = undefined;
      const raw = c.req.query("input");
      if (raw !== undefined && raw !== "") {
        try {
          input = JSON.parse(raw);
        } catch {
          return c.json({ error: "validation" }, 400);
        }
      }
      try {
        const rows = await runView(cfg.db, cfg.app, view, ctx, input);
        return c.json(rows);
      } catch (e) {
        if (e instanceof ViewForbiddenError) {
          return c.json({ error: "forbidden" }, 403);
        }
        if (e instanceof z.ZodError) {
          return c.json({ error: "validation" }, 400);
        }
        throw e;
      }
    });
  }
}
