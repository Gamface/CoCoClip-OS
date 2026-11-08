import type { Request, Response } from "express";
import type { HubEvent, WorkerState } from "@agent-os/shared-types";
import type { Relay } from "./relay.js";

export type { HubEvent, WorkerState };

/** Server-sent events fan-out. The UI subscribes once and renders everything live. */
export class EventHub {
  private clients = new Set<Response>();
  readonly workers = new Map<string, WorkerState>();
  private relay?: Relay;

  /** Mirror local events to other replicas (Redis). */
  attachRelay(r: Relay) {
    this.relay = r;
  }

  publish(e: HubEvent) {
    this.deliver(e);
    this.relay?.publishEvent(e);
  }

  /** Deliver to this replica's SSE clients only (used for events arriving from other replicas). */
  deliver(e: HubEvent) {
    if (e.type === "worker") this.workers.set(e.data.runId, e.data);
    const frame = `event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`;
    for (const c of this.clients) c.write(frame);
  }

  handler = (req: Request, res: Response) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    res.write(": connected\n\n");
    for (const w of this.workers.values()) res.write(`event: worker\ndata: ${JSON.stringify(w)}\n\n`);
    this.clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
      clearInterval(ping);
      this.clients.delete(res);
    });
  };
}
