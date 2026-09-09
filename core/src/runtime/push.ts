import type { ReadCtx } from "../data/repo.ts";
import type { Db } from "../data/db.ts";
import type { AnySubscriber } from "./events.ts";

/** Topic observation grants only a change signal (05-runtime.md §push-invalidate). */
export interface PushConfig {
  readonly topics: Readonly<
    Record<string, {
      readonly observe: (ctx: ReadCtx, db: Db) => boolean | Promise<boolean>;
    }>
  >;
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
    if (decl && Object.keys(decl).some((key) => key !== "observe")) {
      errors.push(`push/unknown-key: '${topic}' accepts only observe`);
    }
    if (!decl || typeof decl.observe !== "function") {
      errors.push(
        `push/observation-required: '${topic}' requires an observe function`,
      );
    }
  }
  return errors;
}
