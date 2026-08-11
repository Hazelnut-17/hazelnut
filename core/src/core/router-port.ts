// The router-factory PORT breaks a value-import cycle: createApp (core) builds app.fetch through
// createRouter, which lives in runtime/serve (which already imports core/app). Core owns the
// RouterFactory interface; runtime/serve installs its implementation at load via setRouterFactory.
import type { ServeConfig } from "../runtime/serve.ts";

/** A servable handler — the structural `{ fetch }` shape `Deno.serve` consumes (never the concrete
 *  Hono type). */
export interface ServableHandler {
  fetch(req: Request): Response | Promise<Response>;
}

/** The composed HTTP/MCP router factory for a served app — installed by runtime/serve, consumed by createApp. */
export type RouterFactory = (cfg: ServeConfig) => ServableHandler;

let factory: RouterFactory | null = null;

/** Runtime install point — `runtime/serve.ts` calls this at module load with its `createRouter`. */
export function setRouterFactory(f: RouterFactory): void {
  factory = f;
}

/** Core consume point — `createApp` builds `app.fetch` through this; throws (loud) if the runtime
 *  `serve` module was never loaded (a served app must import it, e.g. via the `hazelnut` barrel). */
export function getRouterFactory(): RouterFactory {
  if (factory === null) {
    throw new Error(
      "router-factory not installed — a served app must load the runtime `serve` module (import from the `hazelnut` barrel, or `serve.ts` directly) before `createApp(config, { db })` composes its `fetch`",
    );
  }
  return factory;
}
