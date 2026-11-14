import { describe, expect, it } from "vitest";
import { AuditLog, OrgPolicy } from "@agent-os/governance";
import { AgentSettingsService } from "../src/agent-settings.js";
import type { ComposioBus } from "../src/composio-bus.js";
import { ContextStore } from "../src/context-store.js";
import { EventHub } from "../src/events.js";
import type { Paperclip } from "../src/paperclip.js";
import { MemoryStore } from "../src/store.js";
import { HeartbeatWorker } from "../src/worker.js";

const policy = OrgPolicy.parse({ roles: [{ role: "*", toolkits: [] }] });

/** Paperclip fake whose issue lookup takes a while, recording how many runs overlap per agent. */
function setup() {
  const active = new Map<string, number>();
  const peak = new Map<string, number>();
  const order: string[] = [];
  const pc = {
    agent: async (id: string) => ({ id, companyId: "co", name: id, role: "general", spentMonthlyCents: 0, budgetMonthlyCents: 0 }),
    agentSpend: async () => ({ spentCents: 0, budgetCents: null }),
    issues: async (_c: string, q: string) => {
      const id = decodeURIComponent(q.split("=")[1]!);
      active.set(id, (active.get(id) ?? 0) + 1);
      peak.set(id, Math.max(peak.get(id) ?? 0, active.get(id)!));
      order.push(`start:${id}`);
      await new Promise((r) => setTimeout(r, 15));
      order.push(`end:${id}`);
      active.set(id, active.get(id)! - 1);
      return [];
    },
  } as unknown as Paperclip;
  const audit = new AuditLog();
  const hub = new EventHub();
  const settings = new AgentSettingsService(new MemoryStore(), { model: "claude-opus-5-5", effort: "high", maxTurns: 5 }, () => policy, hub, audit);
  const worker = new HeartbeatWorker({ pc, bus: {} as ComposioBus, hub, audit, contextStore: new ContextStore(), policy: () => policy, settings });
  return { worker, peak, order, audit, hub };
}

describe("HeartbeatWorker scheduling", () => {
  it("runs one heartbeat per agent at a time, and different agents in parallel", async () => {
    const { worker, peak, order } = setup();
    await Promise.all([
      worker.run({ runId: "r1", agentId: "a", companyId: "co" }),
      worker.run({ runId: "r2", agentId: "a", companyId: "co" }),
      worker.run({ runId: "r3", agentId: "b", companyId: "co" }),
    ]);
    expect(peak.get("a")).toBe(1);
    expect(peak.get("b")).toBe(1);
    // b started before a's first run ended: agents don't block each other.
    expect(order.indexOf("start:b")).toBeLessThan(order.indexOf("end:a"));
  });

  it("shows a queued run and lets the operator cancel it before it starts", async () => {
    const { worker, peak, audit, hub } = setup();
    const first = worker.run({ runId: "r1", agentId: "a", companyId: "co" });
    const second = worker.run({ runId: "r2", agentId: "a", companyId: "co" });
    expect(hub.workers.get("r2")?.status).toBe("queued");
    expect(worker.cancel("r2")).toBe(true);
    await Promise.all([first, second]);
    expect(peak.get("a")).toBe(1);
    expect(hub.workers.get("r2")?.status).toBe("error");
    expect(audit.tail().some((e) => e.type === "heartbeat.error" && JSON.stringify(e).includes("while queued"))).toBe(true);
  });
});
