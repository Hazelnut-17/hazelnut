// `hazelnut/async` — work that outlives the request — queues, events, cron, sagas, webhooks and the projections they feed.
//
// A CONCERN BARREL, and its membership is not written here: `scripts/surface-groups.ts` declares which
// symbols belong to this group and holds the two as an equality, so a symbol
// cannot be reachable from two paths or from none. Re-exports point at the CONCRETE home, never at the
// root barrel — that is what keeps the group importable without pulling the whole surface in.

export { defineReadModel } from "../features/readmodel.ts";
export { defineUpcaster } from "../features/versioning.ts";
export { defineSubscriber, defineWorker } from "../runtime/events.ts";
export type { ConsumerCtx } from "../runtime/events.ts";
export { drainOutbox } from "../runtime/outbox-drain.ts";
export { runLiveRelay } from "../runtime/relay.ts";
export { safeFetch } from "../runtime/safe-fetch.ts";
export { defineJob, startFeatureScheduler } from "../runtime/scheduler.ts";
export { defineTask } from "../runtime/tasks.ts";
export { defineWebhook } from "../runtime/webhook.ts";
export type { WebhookDecl } from "../runtime/webhook.ts";
export {
  defineWorkflow,
  runWorkflow,
  WorkflowConflictError,
} from "../runtime/workflow.ts";
export type {
  StepCtx,
  WorkflowCtx,
  WorkflowDecl,
} from "../runtime/workflow.ts";
