import type { App } from "./app.ts";

/** The declaration-owned context boundary. The flat app sentinel and a declared
 * module named app share a label, not a database home. Never drop this pair when
 * binding an operation's data, transitions or declared dependencies. */
export interface ContextHome {
  readonly module: string;
  readonly pgSchema: string;
}

export const FLAT_APP_HOME: ContextHome = {
  module: "app",
  pgSchema: "public",
};

/** Async declarations distinguish an absent module (flat) from module: "app".
 * Model-bound operations pass their actual model instead of reconstructing it. */
export function declaredContextHome(module?: string): ContextHome {
  return module === undefined ? FLAT_APP_HOME : { module, pgSchema: module };
}

/** Preserve string callers for ordinary modules and older flat-only callers.
 * Production model-bound callers pass the complete home; declarations use the
 * explicit resolver above so absence cannot become a declared app module. */
export function contextHome(
  app: App,
  identity: string | ContextHome,
): ContextHome {
  if (typeof identity !== "string") return identity;
  return identity === "app" &&
      !(app.moduleGraph ?? []).some((m) => m.name === "app")
    ? FLAT_APP_HOME
    : declaredContextHome(identity);
}

export function inContextHome(
  model: ContextHome,
  home: ContextHome,
): boolean {
  return model.module === home.module && model.pgSchema === home.pgSchema;
}
