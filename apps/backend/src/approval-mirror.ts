import type { ApprovalBroker, AuditLog } from "@agent-os/governance";
import type { Paperclip } from "./paperclip.js";

/**
 * Dual-surface approvals. Every escalation is also filed in Paperclip's own approval
 * queue (type `request_board_approval`), so a board member can decide from the Paperclip
 * UI or phone while the operator can decide from the CopilotKit command center. Whichever
 * acts first wins; the other side is updated to match.
 */
export class ApprovalMirror {
  private readonly polls = new Map<string, NodeJS.Timeout>();
  private readonly fromPaperclip = new Set<string>();

  constructor(
    private readonly pc: Paperclip,
    private readonly broker: ApprovalBroker,
    private readonly audit: AuditLog,
    private readonly pollMs = 5000,
  ) {
    broker.on("decided", (a) => {
      this.stop(a.id);
      if (!a.paperclipApprovalId || this.fromPaperclip.delete(a.id)) return;
      const note = `${a.status} via agent-os by ${a.decidedBy ?? "system"}${a.note ? `: ${a.note}` : ""}`;
      const call = a.status === "approved" ? this.pc.approve(a.paperclipApprovalId, note) : this.pc.reject(a.paperclipApprovalId, note);
      call.catch((e) => this.audit.append("approval.mirror_sync_failed", "backend", { id: a.id, error: String(e) }));
    });
  }

  mirror = (approvalId: string) => {
    const a = this.broker.get(approvalId);
    if (!a) return;
    this.pc
      .createApproval(a.companyId, a.agentId, {
        source: "agent-os",
        agentOsApprovalId: a.id,
        summary: `${a.agentName} (${a.role}) wants to run ${a.tool}`,
        tool: a.tool,
        toolkit: a.toolkit,
        risk: a.risk,
        reasons: a.reasons,
        args: a.args,
        issueId: a.issueId,
        runId: a.runId,
        expiresAt: a.expiresAt,
      })
      .then((pcA) => {
        this.broker.attachMirror(a.id, pcA.id);
        const timer = setInterval(() => void this.poll(a.id, pcA.id), this.pollMs);
        timer.unref?.();
        this.polls.set(a.id, timer);
      })
      .catch((e) => this.audit.append("approval.mirror_failed", "backend", { id: a.id, error: String(e) }));
  };

  private async poll(id: string, pcId: string) {
    try {
      const pcA = await this.pc.approval(pcId);
      if (pcA.status === "approved" || pcA.status === "rejected") {
        this.fromPaperclip.add(id);
        this.broker.decide(id, pcA.status === "approved", "paperclip-board", pcA.decisionNote ?? undefined);
      }
    } catch {
      /* transient; keep polling until the local approval settles */
    }
  }

  private stop(id: string) {
    const t = this.polls.get(id);
    if (t) clearInterval(t);
    this.polls.delete(id);
  }
}
