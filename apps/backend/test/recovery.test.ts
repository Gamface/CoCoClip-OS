import { describe, expect, it } from "vitest";
import { newDb } from "pg-mem";
import type pg from "pg";
import { AuditLog } from "@agent-os/governance";
import type { ApprovalRecord } from "@agent-os/shared-types";
import { EventHub } from "../src/events.js";
import type { Paperclip } from "../src/paperclip.js";
import { Recovery, storeRunTracker } from "../src/recovery.js";
import { MemoryStore, PostgresStore, type Store } from "../src/store.js";

function pgStore(): Store {
  const { Pool } = newDb().adapters.createPg() as { Pool: new () => pg.Pool };
  return new PostgresStore(new Pool());
}

const approval = (id: string, owner: string, status: ApprovalRecord["status"] = "pending"): ApprovalRecord => ({
  id,
  companyId: "co",
  agentId: "a1",
  agentName: "Lucky",
  role: "general",
  tool: "GITHUB_MERGE_X",
  risk: "write",
  args: {},
  reasons: [],
  status,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  paperclipApprovalId: `pc-${id}`,
  owner,
});

function fakePc() {
  const calls: string[] = [];
  const pc = {
    comment: async (issueId: string) => void calls.push(`comment:${issueId}`),
    wake: async (agentId: string) => void calls.push(`wake:${agentId}`),
    reject: async (id: string) => void calls.push(`reject:${id}`),
    approve: async (id: string) => void calls.push(`approve:${id}`),
  } as unknown as Paperclip;
  return { pc, calls };
}

for (const [name, make] of [
  ["memory", () => new MemoryStore()],
  ["postgres", pgStore],
] as const) {
  describe(`restart recovery (${name} store)`, () => {
    it("never turns a settled approval back into a pending one", async () => {
      const store = make();
      await store.init();
      await store.saveApproval(approval("x", "r1", "approved"));
      await store.saveApproval(approval("x", "r1", "pending"));
      expect((await store.listApprovals())[0]?.status).toBe("approved");
    });

    it("on boot, expires this replica's leftover approvals and restarts its leftover runs", async () => {
      const store = make();
      await store.init();
      await store.saveApproval(approval("ap1", "replica-a"));
      storeRunTracker(store, "replica-a").started({ runId: "run1", agentId: "a1", companyId: "co", issueId: "iss1" });
      await new Promise((r) => setTimeout(r, 10));

      const { pc, calls } = fakePc();
      const { ApprovalMirror } = await import("../src/approval-mirror.js");
      const { ApprovalBroker } = await import("@agent-os/governance");
      const mirror = new ApprovalMirror(pc, new ApprovalBroker(60), new AuditLog(), 1000, []);
      const audit = new AuditLog();
      const rec = new Recovery({ store, replicaId: "replica-a", pc, hub: new EventHub(), audit, mirror });
      expect(await rec.sweep(true)).toEqual({ approvals: 1, runs: 1 });
      await new Promise((r) => setTimeout(r, 10));

      expect((await store.listApprovals())[0]?.status).toBe("expired");
      expect(await store.listRuns()).toEqual([]);
      expect(calls).toEqual(expect.arrayContaining(["reject:pc-ap1", "comment:iss1", "wake:a1"]));
      expect(audit.tail().map((e) => e.type)).toEqual(expect.arrayContaining(["approval.recovered", "run.recovered"]));
      // Nothing left to do on the next pass.
      expect(await rec.sweep(false)).toEqual({ approvals: 0, runs: 0 });
    });

    it("leaves a live replica's work alone and takes over a stopped one's", async () => {
      const store = make();
      await store.init();
      await store.touchReplica("live");
      await store.saveApproval(approval("mine", "live"));
      await store.saveApproval(approval("theirs", "gone"));
      await store.saveRun({ runId: "r-live", agentId: "a1", companyId: "co", owner: "live", startedAt: new Date().toISOString() });
      await store.saveRun({ runId: "r-gone", agentId: "a2", companyId: "co", owner: "gone", startedAt: new Date().toISOString() });

      const { pc, calls } = fakePc();
      const rec = new Recovery({ store, replicaId: "other", pc, hub: new EventHub(), audit: new AuditLog(), staleMs: 60_000 });
      expect(await rec.sweep(false)).toEqual({ approvals: 1, runs: 1 });
      expect((await store.listPendingApprovals()).map((a) => a.id)).toEqual(["mine"]);
      expect((await store.listRuns()).map((r) => r.runId)).toEqual(["r-live"]);
      expect(calls).toContain("wake:a2");
      expect(calls).not.toContain("wake:a1");
    });

    it("a run record is cleared when the run finishes", async () => {
      const store = make();
      await store.init();
      const t = storeRunTracker(store, "r1");
      t.started({ runId: "run9", agentId: "a", companyId: "co" });
      await new Promise((r) => setTimeout(r, 5));
      t.finished("run9");
      await new Promise((r) => setTimeout(r, 5));
      expect(await store.listRuns()).toEqual([]);
    });
  });
}
