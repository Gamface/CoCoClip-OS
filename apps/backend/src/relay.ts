import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import type { HubEvent } from "@agent-os/shared-types";

/** Commands that must run on the replica that owns a resource (e.g. the run waiting on an approval). */
export type RelayCommand =
  | { kind: "decide"; approvalId: string; granted: boolean; by: string; note?: string }
  | { kind: "cancel"; runId: string };

export interface Relay {
  readonly kind: "redis" | "local";
  start(onEvent: (e: HubEvent) => void, onCommand: (c: RelayCommand) => void): Promise<void>;
  publishEvent(e: HubEvent): void;
  publishCommand(c: RelayCommand): void;
  close(): Promise<void>;
}

/** Single replica: nothing to relay. */
export class LocalRelay implements Relay {
  readonly kind = "local" as const;
  async start() {}
  publishEvent() {}
  publishCommand() {}
  async close() {}
}

type Envelope = { from: string } & ({ t: "event"; e: HubEvent } | { t: "command"; c: RelayCommand });

/**
 * Redis pub/sub so several backend replicas behave as one: every SSE client sees every
 * worker/approval event, and a decision posted to any replica reaches the one whose
 * heartbeat is waiting on it.
 */
export class RedisRelay implements Relay {
  readonly kind = "redis" as const;
  private readonly id = randomUUID();
  private readonly pub;
  private readonly sub;
  static readonly CHANNEL = "agent-os:bus";

  constructor(url: string) {
    this.pub = createClient({ url });
    this.sub = this.pub.duplicate();
    for (const c of [this.pub, this.sub]) c.on("error", (e) => console.error("[redis]", e.message));
  }

  async start(onEvent: (e: HubEvent) => void, onCommand: (c: RelayCommand) => void) {
    await Promise.all([this.pub.connect(), this.sub.connect()]);
    await this.sub.subscribe(RedisRelay.CHANNEL, (raw) => {
      let m: Envelope;
      try {
        m = JSON.parse(raw) as Envelope;
      } catch {
        return;
      }
      if (m.from === this.id) return;
      if (m.t === "event") onEvent(m.e);
      else onCommand(m.c);
    });
  }

  private send(m: Omit<Envelope, "from"> & Partial<Envelope>) {
    if (!this.pub.isReady) return;
    void this.pub.publish(RedisRelay.CHANNEL, JSON.stringify({ ...m, from: this.id })).catch(() => {});
  }
  publishEvent(e: HubEvent) {
    this.send({ t: "event", e } as Envelope);
  }
  publishCommand(c: RelayCommand) {
    this.send({ t: "command", c } as Envelope);
  }
  async close() {
    await Promise.allSettled([this.sub.quit(), this.pub.quit()]);
  }
}

export function createRelay(redisUrl: string | undefined): Relay {
  return redisUrl ? new RedisRelay(redisUrl) : new LocalRelay();
}
