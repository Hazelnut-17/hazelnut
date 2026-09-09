import type { ReadCtx } from "../data/repo.ts";
import type { Db } from "../data/db.ts";
import type { AnySubscriber } from "./events.ts";

/** Optional live-list payload on the same SSE door (05-runtime.md §push-rows). */
export interface PushRowsDecl {
  readonly resource: string;
}

/** Topic observation grants a change signal; `rows` opts the same door into the list projection. */
export interface PushTopicDecl {
  readonly observe: (ctx: ReadCtx, db: Db) => boolean | Promise<boolean>;
  readonly rows?: PushRowsDecl;
}

/** Topic observation grants only a change signal unless `rows` is declared (05-runtime.md §push-invalidate). */
export interface PushConfig {
  readonly topics: Readonly<Record<string, PushTopicDecl>>;
}

export const PUSH_REVISION_DDL = `CREATE TABLE IF NOT EXISTS "_push_revision" (
  topic text NOT NULL, scope text NOT NULL, revision text NOT NULL,
  PRIMARY KEY (topic, scope))`;

/** The revision write joins the relay's fenced transaction, never its socket. */
export function invalidationSubscribers(push?: PushConfig): AnySubscriber[] {
  return Object.keys(push?.topics ?? {}).map((topic) => ({
    name: `invalidation:${topic}`,
    topic,
    handler: async (event, ctx) => {
      await ctx.db.query(
        `INSERT INTO "_push_revision" (topic, scope, revision) VALUES ($1, $2, $3)
         ON CONFLICT (topic, scope) DO UPDATE SET revision = EXCLUDED.revision`,
        [topic, event.scope ?? "", event.id],
      );
    },
  }));
}

/** Declaration errors also reject JavaScript callers that bypass the type floor. */
export function pushErrors(
  push: PushConfig | undefined,
  emits: ReadonlySet<string>,
  /** resource name → whether that resource exposes `http.list`. */
  lists: Readonly<Record<string, boolean>> = {},
): string[] {
  if (push === undefined) return [];
  if (
    !push || !push.topics || typeof push.topics !== "object" ||
    Array.isArray(push.topics)
  ) {
    return [
      "push/observation-required: push.topics must declare topic observation policies",
    ];
  }
  const errors: string[] = [];
  if (Object.keys(push).some((key) => key !== "topics")) {
    errors.push("push/unknown-key: push accepts only topics");
  }
  for (const [topic, decl] of Object.entries(push.topics)) {
    if (
      !emits.has(topic) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(topic)
    ) {
      errors.push(
        `push/topic-resolves: '${topic}' must be a declared emits topic with a URL-safe name`,
      );
    }
    if (
      decl &&
      Object.keys(decl).some((key) => key !== "observe" && key !== "rows")
    ) {
      errors.push(`push/unknown-key: '${topic}' accepts only observe, rows`);
    }
    if (!decl || typeof decl.observe !== "function") {
      errors.push(
        `push/observation-required: '${topic}' requires an observe function`,
      );
    }
    if (decl && Object.hasOwn(decl, "rows")) {
      const rows = decl.rows as unknown;
      if (
        rows === null || typeof rows !== "object" || Array.isArray(rows) ||
        typeof (rows as { resource?: unknown }).resource !== "string" ||
        (rows as { resource: string }).resource.length === 0
      ) {
        errors.push(
          `push/rows-shape: '${topic}' rows must be { resource } naming one resource`,
        );
      } else {
        if (Object.keys(rows).some((key) => key !== "resource")) {
          errors.push(
            `push/unknown-key: '${topic}' rows accepts only resource`,
          );
        }
        const resource = (rows as { resource: string }).resource;
        if (!Object.hasOwn(lists, resource)) {
          errors.push(
            `push/rows-resource: '${topic}' rows.resource '${resource}' is not a declared resource`,
          );
        } else if (lists[resource] !== true) {
          errors.push(
            `push/rows-list: '${topic}' rows.resource '${resource}' must expose http.list — the channel reuses that projection`,
          );
        }
      }
    }
  }
  return errors;
}
