import type { Db } from "../data/db.ts";

type Renewal = { workflow_id: string; step_id: string; fence: string };
type Waiter = { resolve: () => void; reject: (error: unknown) => void };
type Pending = { renewal: Renewal; waiters: Waiter[] };
type State = {
  pending: Map<string, Pending>;
  running: boolean;
  timer?: ReturnType<typeof setTimeout>;
};
const roots = new WeakMap<object, State>();

/** Coalesce native standalone heartbeats while retaining the durable-claim generation fence. */
export function renewStandaloneClaim(
  root: object,
  query: Db["query"],
  renewal: Renewal,
): Promise<void> {
  let state = roots.get(root);
  if (!state) {
    state = { pending: new Map(), running: false };
    roots.set(root, state);
  }
  const batch = state;
  const key = JSON.stringify([
    renewal.workflow_id,
    renewal.step_id,
    renewal.fence,
  ]);
  const answer = new Promise<void>((resolve, reject) => {
    const pending = batch.pending.get(key) ?? { renewal, waiters: [] };
    pending.waiters.push({ resolve, reject });
    batch.pending.set(key, pending);
  });
  const schedule = () => {
    if (
      batch.running || batch.timer !== undefined || batch.pending.size === 0
    ) return;
    batch.timer = setTimeout(() => {
      batch.timer = undefined;
      void flush();
    }, 5);
  };
  const flush = async () => {
    batch.running = true;
    const picked = [...batch.pending.entries()].slice(0, 512);
    for (const [id] of picked) batch.pending.delete(id);
    try {
      await query(
        `WITH renewal_candidates AS (
          SELECT j.ctid FROM "_workflow_journal" AS j
          JOIN jsonb_to_recordset($1::text::jsonb) AS b(workflow_id text, step_id text, fence text)
            ON j.workflow_id = b.workflow_id AND j.step_id = b.step_id
          WHERE j.status <> 'done'
            AND to_char(j.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') = b.fence
          FOR UPDATE OF j SKIP LOCKED
        )
        UPDATE "_workflow_journal" AS j SET locked_at = now()
        FROM renewal_candidates AS c WHERE j.ctid = c.ctid`,
        [JSON.stringify(picked.map(([, item]) => item.renewal))],
      );
      for (const [, item] of picked) {
        for (const waiter of item.waiters) waiter.resolve();
      }
    } catch (error) {
      for (const [, item] of picked) {
        for (const waiter of item.waiters) waiter.reject(error);
      }
    } finally {
      batch.running = false;
      schedule();
    }
  };
  schedule();
  return answer;
}
