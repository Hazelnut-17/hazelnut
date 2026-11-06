import type { Db } from "../data/db.ts";

// Only registered internal rollup-resync handlers receive an owned cron
// boundary. A user job may catch its own failures and cannot inherit it.
const runners = new WeakMap<object, (db: Db) => Promise<void>>();

export function registerOwnedFeatureHandler(
  handler: object,
  run: (db: Db) => Promise<void>,
): void {
  runners.set(handler, run);
}

export function ownedFeatureHandler(
  handler: object,
): ((db: Db) => Promise<void>) | undefined {
  return runners.get(handler);
}
