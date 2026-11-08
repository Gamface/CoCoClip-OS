import { describe, expect, it } from "vitest";
import { newDb } from "pg-mem";
import type pg from "pg";
import { AuditLog, OrgPolicy } from "@agent-os/governance";
import { AgentSettingsService, SettingsPatch } from "../src/agent-settings.js";
import { EventHub } from "../src/events.js";
import { MemoryStore, PostgresStore, type Store } from "../src/store.js";
import { fallbackParams } from "../src/worker.js";

const policy = OrgPolicy.parse({
  roles: [
    { role: "*support*", toolkits: ["slack"], model: "claude-haiku-5-5", effort: "low" },
    { role: "*", toolkits: [] },
  ],
});
const defaults = { model: "claude-opus-5-5", effort: "high" as const, maxTurns: 20 };

function pgStore(): Store {
  const { Pool } = newDb().adapters.createPg() as { Pool: new () => pg.Pool };
  return new PostgresStore(new Pool());
}

for (const [name, make] of [
  ["memory", () => new MemoryStore()],
  ["postgres", pgStore],
] as const) {
  describe(`per-agent model settings (${name} store)`, () => {
    it("resolves agent → role → default and persists overrides", async () => {
      const store = make();
      await store.init();
      const hub = new EventHub();
      const events: unknown[] = [];
      hub.attachRelay({ kind: "local", start: async () => {}, publishEvent: (e) => events.push(e), publishCommand: () => {}, close: async () => {} });
      const svc = new AgentSettingsService(store, defaults, () => policy, hub, new AuditLog());

      const support = { id: "a1", name: "Support Bot", role: "support" };
      const eng = { id: "a2", name: "Eng", role: "engineer" };

      expect((await svc.effectiveFor(support)).effective).toMatchObject({ model: "claude-haiku-5-5", effort: "low", maxTurns: 20 });
      expect((await svc.effectiveFor(eng)).effective.source.model).toBe("default");

      await svc.update("a1", { model: "claude-sonnet-5-5", maxTurns: 8 }, "user:alice");
      const r = await svc.effectiveFor(support);
      expect(r.effective).toMatchObject({ model: "claude-sonnet-5-5", effort: "low", maxTurns: 8, source: { model: "agent", effort: "role", maxTurns: "agent" } });
      expect(r.settings?.updatedBy).toBe("user:alice");
      expect(events).toContainEqual(expect.objectContaining({ type: "settings" }));

      // Other agents are untouched.
      expect((await svc.effectiveFor(eng)).effective.model).toBe("claude-opus-5-5");

      // Clearing every field removes the override entirely.
      expect(await svc.update("a1", { model: null, maxTurns: null }, "user:alice")).toBeNull();
      expect(await store.getSettings("a1")).toBeNull();
      expect((await svc.effectiveFor(support)).effective.model).toBe("claude-haiku-5-5");
    });

    it("stores approval history", async () => {
      const store = make();
      await store.init();
      const a = { id: "x", companyId: "c", agentId: "a", agentName: "A", role: "r", tool: "T", risk: "write", args: { n: 1 }, reasons: [], status: "pending" as const, createdAt: new Date().toISOString(), expiresAt: new Date().toISOString() };
      await store.saveApproval(a);
      await store.saveApproval({ ...a, status: "approved", decidedBy: "user:alice" });
      const [got] = await store.listApprovals();
      expect(got).toMatchObject({ id: "x", status: "approved", decidedBy: "user:alice", args: { n: 1 } });
    });
  });
}

describe("settings validation and model-specific request params", () => {
  it("rejects non-Claude models and unknown fields", () => {
    expect(SettingsPatch.safeParse({ model: "gpt-5" }).success).toBe(false);
    expect(SettingsPatch.safeParse({ temperature: 1 }).success).toBe(false);
    expect(SettingsPatch.safeParse({ model: null, effort: "max" }).success).toBe(true);
  });

  it("only sends server-side fallbacks in the form each model supports", () => {
    expect(fallbackParams("claude-opus-5-5")).toEqual({ betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
    expect(fallbackParams("claude-fable-5-1")).toEqual({ betas: ["server-side-fallback-2026-06-01"], fallbacks: [{ model: "claude-opus-4-8" }] });
    expect(fallbackParams("claude-haiku-5-5")).toEqual({});
    expect(fallbackParams("claude-unknown-9")).toEqual({});
  });
});
