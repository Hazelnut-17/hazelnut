import { assembleProvenance, getLogSink } from "../core/ctx.ts";
import type { Hono } from "hono";
import { resolveActor } from "../authz/auth.ts";
import type { ReadCtx } from "../data/repo.ts";
import { type AuthVars, errorBody, type ServeConfig } from "./serve-helpers.ts";
import { listedVisibleRows } from "./read-wire.ts";

const POLL_MS = 1_000;
const LIFETIME_MS = 60_000;
const MAX_CONNECTIONS = 128;
const encoder = new TextEncoder();
const INVALIDATE = encoder.encode("event: invalidate\ndata: {}\n\n");
const HEARTBEAT = encoder.encode(": heartbeat\n\n");
const rowsFrame = (rows: unknown) =>
  encoder.encode(`event: rows\ndata: ${JSON.stringify(rows)}\n\n`);

/** Pull-driven, scope-bound notification door (05-runtime.md §push-invalidate / §push-rows). */
export function registerPushRoutes(
  router: Hono<{ Variables: AuthVars }>,
  cfg: ServeConfig,
): void {
  const topics = cfg.app.push?.topics;
  if (!topics || Object.keys(topics).length === 0) return;
  let connections = 0;
  router.get("/events/:topic", async (c) => {
    if (c.req.method === "HEAD") return c.body(null, 405, { Allow: "GET" });
    const topic = c.req.param("topic");
    const decl = Object.hasOwn(topics, topic) ? topics[topic] : undefined;
    if (!decl) return c.json(errorBody("notFound"), 404);
    if (connections >= MAX_CONNECTIONS) {
      return c.json(errorBody("rate_limited"), 429);
    }
    connections++;
    const request = c.req.raw;
    const fresh = async (): Promise<ReadCtx> => {
      if (!cfg.auth) return cfg.resolveCtx(request);
      const actor = await resolveActor(cfg.auth, request);
      return { ...cfg.resolveCtx(request, actor), actor };
    };
    let lastCtx: ReadCtx | undefined;
    const record = (outcome: "ok" | "err", kind?: "forbidden" | "internal") => {
      try {
        getLogSink().drain(assembleProvenance({
          actor: lastCtx?.actor ?? null,
          scope: lastCtx?.scope ?? "",
          attrs: {},
          op: {
            op: decl.rows ? "push.rows" : "push.invalidate",
            resource: topic,
          },
          origin: "http",
          outcome,
          kind,
          durationMs: 0,
          txOutcome: "none",
          traceId: c.get("hazelTraceId") ?? crypto.randomUUID(),
          spanId: crypto.randomUUID(),
        }));
      } catch { /* a sink failure cannot turn denial into delivery */ }
    };
    let initial: ReadCtx;
    try {
      initial = await fresh();
      lastCtx = initial;
      if (await decl.observe(initial, cfg.db) !== true) {
        connections--;
        record("err", "forbidden");
        return c.json(errorBody("forbidden"), 403);
      }
    } catch {
      connections--;
      record("err", "internal");
      return c.json(errorBody("auth_unavailable"), 503);
    }
    if (request.signal.aborted) {
      connections--;
      return c.body(null, 204);
    }
    const scope = initial.scope;
    let done = false;
    let first = true;
    let previous: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wake: (() => void) | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const finish = (cancelled = false) => {
      if (done) return;
      done = true;
      connections--;
      clearTimeout(expiry);
      if (timer !== undefined) clearTimeout(timer);
      wake?.();
      request.signal.removeEventListener("abort", onAbort);
      if (!cancelled) controller.close();
    };
    const onAbort = () => finish();
    const expiry = setTimeout(() => finish(), LIFETIME_MS);
    const allowed = async (): Promise<boolean> => {
      const ctx = await fresh();
      lastCtx = ctx;
      const ok = !done && ctx.scope === scope &&
        await decl.observe(ctx, cfg.db) === true;
      if (!ok && !done) record("err", "forbidden");
      return ok;
    };
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        request.signal.addEventListener("abort", onAbort, { once: true });
      },
      async pull(c) {
        try {
          if (!first) {
            await new Promise<void>((resolve) => {
              wake = resolve;
              timer = setTimeout(resolve, POLL_MS);
            });
            wake = undefined;
          }
          if (done) return;
          if (!await allowed()) return finish();
          const { rows } = await cfg.db.query<{ revision: string }>(
            `SELECT revision FROM "_push_revision" WHERE topic = $1 AND scope = $2`,
            [topic, scope],
          );
          const revision = rows[0]?.revision ?? null;
          // Query latency must never turn a prior authorization into a send decision.
          if (done) return;
          if (!await allowed()) return finish();
          if (done) return;
          const changed = first || revision !== previous;
          let frame = changed ? INVALIDATE : HEARTBEAT;
          if (changed && decl.rows) {
            const model = cfg.app.model.find((m) =>
              m.name === decl.rows!.resource
            );
            if (!model) {
              throw new Error(
                `push/rows-resource: '${decl.rows.resource}' is not a composed resource`,
              );
            }
            const payload = await listedVisibleRows(
              cfg.db,
              model,
              lastCtx!,
              cfg.kms,
              request,
              cfg.app.versions ?? [],
            );
            // List latency is the same class of gap as the revision read.
            if (done) return;
            if (!await allowed()) return finish();
            if (done) return;
            frame = rowsFrame(payload);
          }
          c.enqueue(frame.slice());
          if (changed) record("ok");
          first = false;
          previous = revision;
        } catch {
          if (!done) record("err", "internal");
          finish(); // no exception text, event metadata or policy diagnostics on the wire
        }
      },
      cancel() {
        finish(true);
      },
    }, { highWaterMark: 0 });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      },
    });
  });
}
