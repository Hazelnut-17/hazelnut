/** The producer routes work by topic. The relay records each worker's outcome by name. */
export function taskTopic(name: string): string {
  return "_task:" + name;
}

export function taskWorkerName(name: string): string {
  return "task:" + name;
}

/** SQL aliases bind tasks as t, dead deliveries as d, and live outbox rows as o. */
export const DEAD_TASK_DELIVERY_SQL = `d.aggregate_type = '_task'
  AND d.aggregate_id = t.id::text AND d.topic = '_task:' || t.name
  AND d.scope = t.scope_key
  AND (strpos(d.id, ':') = 0 OR substr(d.id, strpos(d.id, ':') + 1) = 'task:' || t.name)`;

export const LIVE_TASK_DELIVERY_SQL = `o.aggregate_type = '_task'
  AND o.aggregate_id = t.id::text AND o.topic = '_task:' || t.name
  AND o.scope = t.scope_key AND o.processed_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM "_processed" p
    WHERE p.msg_id = o.id AND p.consumer = 'task:' || t.name)`;
