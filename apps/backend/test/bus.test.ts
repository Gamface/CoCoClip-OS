import { describe, expect, it } from "vitest";
import { ApprovalBroker, AuditLog, OrgPolicy } from "@agent-os/governance";
import { ComposioBus, type CallContext } from "../src/composio-bus.js";
import { EventHub } from "../src/events.js";
import { ApprovalMirror } from "../src/approval-mirror.js";
import type { Paperclip } from "../src/paperclip.js";

const role = OrgPolicy.parse({
  roles: [{ role: "release", toolkits: ["github"], rules: [{ match: "GITHUB_MERGE_*", mode: "ask" }, { match: "GITHUB_DELETE_*", mode: "deny" }] }],
}).roles[0]!;

function setup() {
  const audit = new AuditLog();
  const broker = new ApprovalBroker(60);
  const hub = new EventHub();
  const bus = new ComposioBus("", broker, audit, hub);
  const ctx: CallContext = {
    companyId: "co1",
    agentId: "ag1",
    agentName: "Rel",
    role,
    runId: "run1",
    budget: () => ({ spentCents: 0, budgetCents: 1000 }),
    softBudgetRatio: 0.8,
  };
  return { audit, broker, bus, ctx };
}

const tool = (slug: string) => ({ slug, toolkit: "github", description: "", inputSchema: {}, risk: "write" });

describe("ComposioBus governance gate", () => {
  it("denies without ever reaching Composio", async () => {
    const { bus, ctx, audit } = setup();
    const out = await bus.execute(tool("GITHUB_DELETE_A_REPOSITORY"), {}, ctx);
    expect(out.ok).toBe(false);
    expect(out.content).toMatch(/Denied by governance policy/);
    expect(audit.tail().map((e) => e.type)).toEqual(["tool.decision"]);
  });

  it("pauses on ask, and a rejection is returned to the model", async () => {
    const { bus, ctx, broker } = setup();
    const p = bus.execute(tool("GITHUB_MERGE_A_PULL_REQUEST"), { pull_number: 7 }, ctx);
    await Promise.resolve();
    const [pending] = broker.list("pending");
    expect(pending?.args).toEqual({ pull_number: 7 });
    broker.decide(pending!.id, false, "user:alice", "freeze until Monday");
    const out = await p;
    expect(out.ok).toBe(false);
    expect(out.content).toContain("freeze until Monday");
  });

  it("proceeds past approval to execution", async () => {
    const { bus, ctx, broker } = setup();
    const p = bus.execute(tool("GITHUB_MERGE_A_PULL_REQUEST"), {}, ctx);
    await Promise.resolve();
    broker.decide(broker.list("pending")[0]!.id, true, "user:alice");
    // No Composio key in tests: reaching this message proves the gate let it through.
    expect((await p).content).toBe("Composio is not configured on this backend.");
  });

  it("escalates a normally-allowed write when over the soft budget", async () => {
    const { bus, ctx, broker } = setup();
    ctx.budget = () => ({ spentCents: 850, budgetCents: 1000 });
    const p = bus.execute(tool("GITHUB_CREATE_AN_ISSUE_COMMENT"), {}, ctx);
    await Promise.resolve();
    const [pending] = broker.list("pending");
    expect(pending?.reasons.join(" ")).toMatch(/80% of budget/);
    broker.decide(pending!.id, false, "user:alice");
    await p;
  });
});

describe("ApprovalMirror", () => {
  it("files the escalation in Paperclip and applies a board decision made there", async () => {
    const calls: string[] = [];
    let pcStatus = "pending";
    const pc = {
      createApproval: async (_c: string, _a: string, payload: { tool: string }) => {
        calls.push(`create:${payload.tool}`);
        return { id: "pc-1", status: "pending" };
      },
      approval: async () => ({ id: "pc-1", status: pcStatus, decisionNote: "ok from board" }),
      approve: async () => calls.push("approve"),
      reject: async () => calls.push("reject"),
    } as unknown as Paperclip;

    const broker = new ApprovalBroker(60);
    const mirror = new ApprovalMirror(pc, broker, new AuditLog(), 10);
    const { approval, outcome } = broker.request({ companyId: "c", agentId: "a", agentName: "Rel", role: "release", tool: "GITHUB_MERGE_X", risk: "write", args: {}, reasons: [] });
    mirror.mirror(approval.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual(["create:GITHUB_MERGE_X"]);
    expect(broker.get(approval.id)?.paperclipApprovalId).toBe("pc-1");

    pcStatus = "approved";
    const o = await outcome;
    expect(o.granted).toBe(true);
    expect(o.approval.decidedBy).toBe("paperclip-board");
    // Decision came from Paperclip, so it must not be echoed back.
    expect(calls).not.toContain("approve");
  });

  it("syncs a command-center decision back to Paperclip", async () => {
    const calls: string[] = [];
    const pc = {
      createApproval: async () => ({ id: "pc-2", status: "pending" }),
      approval: async () => ({ id: "pc-2", status: "pending" }),
      approve: async () => calls.push("approve"),
      reject: async (_id: string, note: string) => calls.push(`reject:${note}`),
    } as unknown as Paperclip;
    const broker = new ApprovalBroker(60);
    const mirror = new ApprovalMirror(pc, broker, new AuditLog(), 1000);
    const { approval } = broker.request({ companyId: "c", agentId: "a", agentName: "Rel", role: "r", tool: "T", risk: "write", args: {}, reasons: [] });
    mirror.mirror(approval.id);
    await new Promise((r) => setTimeout(r, 10));
    broker.decide(approval.id, false, "user:alice", "no");
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toEqual(["reject:rejected via agent-os by user:alice: no"]);
  });
});

describe("ApprovalMirror retries", () => {
  const req = { companyId: "c", agentId: "a", agentName: "Rel", role: "r", tool: "T", risk: "write", args: {}, reasons: [] };
  const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

  it("retries a failed sync until Paperclip accepts it", async () => {
    let failures = 2;
    const calls: string[] = [];
    const pc = {
      createApproval: async () => ({ id: "pc-3", status: "pending" }),
      approval: async () => ({ id: "pc-3", status: "pending" }),
      approve: async () => {
        if (failures-- > 0) throw new Error("ECONNREFUSED");
        calls.push("approve");
      },
      reject: async () => calls.push("reject"),
    } as unknown as Paperclip;
    const audit = new AuditLog();
    const broker = new ApprovalBroker(60);
    const mirror = new ApprovalMirror(pc, broker, audit, 1000, [1, 1, 1]);
    const { approval } = broker.request(req);
    mirror.mirror(approval.id);
    await tick();
    broker.decide(approval.id, true, "user:alice");
    await tick();
    expect(calls).toEqual(["approve"]);
    expect(audit.tail().map((e) => e.type)).toContain("approval.mirror_recovered");
  });

  it("gives up on a refusal from Paperclip and audits it", async () => {
    const { PaperclipError } = await import("../src/paperclip.js");
    let attempts = 0;
    const pc = {
      createApproval: async () => ({ id: "pc-4", status: "pending" }),
      approval: async () => ({ id: "pc-4", status: "pending" }),
      approve: async () => {},
      reject: async () => {
        attempts++;
        throw new PaperclipError(409, "already decided");
      },
    } as unknown as Paperclip;
    const audit = new AuditLog();
    const broker = new ApprovalBroker(60);
    const mirror = new ApprovalMirror(pc, broker, audit, 1000, [1, 1, 1]);
    const { approval } = broker.request(req);
    mirror.mirror(approval.id);
    await tick();
    broker.decide(approval.id, false, "user:alice");
    await tick();
    expect(attempts).toBe(1);
    expect(audit.tail().map((e) => e.type)).toContain("approval.mirror_sync_failed");
  });

  it("syncs a decision made before Paperclip's copy existed", async () => {
    const calls: string[] = [];
    let release!: () => void;
    const filed = new Promise<void>((r) => (release = r));
    const pc = {
      createApproval: async () => {
        await filed;
        return { id: "pc-5", status: "pending" };
      },
      approval: async () => ({ id: "pc-5", status: "pending" }),
      approve: async () => calls.push("approve"),
      reject: async (id: string) => calls.push(`reject:${id}`),
    } as unknown as Paperclip;
    const broker = new ApprovalBroker(60);
    const mirror = new ApprovalMirror(pc, broker, new AuditLog(), 1000, [1]);
    const { approval } = broker.request(req);
    mirror.mirror(approval.id);
    broker.decide(approval.id, false, "user:alice");
    release();
    await tick();
    expect(calls).toEqual(["reject:pc-5"]);
  });
});
