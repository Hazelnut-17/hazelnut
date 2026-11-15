import type { Db } from "../data/db.ts";

type Waiter = {
  resolve: (cancelled: boolean) => void;
  reject: (error: unknown) => void;
};
type Batch = {
  readonly pending: Map<string, Waiter[]>;
  running: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

// One independent query at a time per native root, even if every pool slot is
// occupied by a workflow step. The weak key does not extend the pool lifetime.
const roots = new WeakMap<object, Batch>();
const MAX_IDS = 512;

export function pollStandaloneCancellation(
  root: object,
  query: Db["query"],
  workflowId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  let batch = roots.get(root);
  if (!batch) {
    batch = { pending: new Map(), running: false };
    roots.set(root, batch);
  }
  const state = batch;
  const answer = new Promise<boolean>((resolve, reject) => {
    const waiters = state.pending.get(workflowId) ?? [];
    const abort = () => {
      const pending = state.pending.get(workflowId);
      if (pending) {
        const index = pending.indexOf(waiter);
        if (index >= 0) pending.splice(index, 1);
        if (pending.length === 0) state.pending.delete(workflowId);
      }
      if (state.pending.size === 0 && state.timer !== undefined) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
      resolve(false);
    };
    const waiter: Waiter = {
      resolve: (value) => {
        signal?.removeEventListener("abort", abort);
        resolve(value);
      },
      reject: (error) => {
        signal?.removeEventListener("abort", abort);
        reject(error);
      },
    };
    signal?.addEventListener("abort", abort, { once: true });
    waiters.push(waiter);
    state.pending.set(workflowId, waiters);
  });
  const schedule = () => {
    if (
      state.running || state.timer !== undefined || state.pending.size === 0
    ) return;
    // Coalesce the 100 ms timers of concurrently started steps.
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void flush();
    }, 5);
  };
  const flush = async () => {
    state.running = true;
    const picked = [...state.pending.entries()].slice(0, MAX_IDS);
    for (const [id] of picked) state.pending.delete(id);
    try {
      const rows = await query<
        { workflow_id: string; cancel_requested: boolean }
      >(
        'SELECT workflow_id, cancel_requested FROM "_workflow_identity" WHERE workflow_id = ANY($1::text[])',
        [picked.map(([id]) => id)],
      );
      const cancelled = new Set(
        rows.rows.filter((r) => r.cancel_requested).map((r) => r.workflow_id),
      );
      for (const [id, waiters] of picked) {
        for (const waiter of waiters) waiter.resolve(cancelled.has(id));
      }
    } catch (error) {
      for (const [, waiters] of picked) {
        for (const waiter of waiters) waiter.reject(error);
      }
    } finally {
      state.running = false;
      schedule();
    }
  };
  schedule();
  return answer;
}
