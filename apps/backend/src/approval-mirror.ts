import type { Approval, ApprovalBroker, AuditLog } from "@agent-os/governance";
import { type Paperclip, PaperclipError } from "./paperclip.js";

/** Default waits between attempts when a Paperclip call fails: 2 s, 10 s, 30 s, 2 min, 5 min. */
const RETRY_DELAYS_MS = [2_000, 10_000, 30_000, 120_000, 300_000];

/** 4xx means Paperclip understood and refused (e.g. already decided); retrying won't help. 408/429 are transient. */
const retryable = (e: unknown) => !(e instanceof PaperclipError) || e.status >= 500 || e.status === 408 || e.status === 429;

/**
 * Dual-surface approvals. Every escalation is also filed in Paperclip's own approval
 * queue (type `request_board_approval`), so a board member can decide from the Paperclip
 * UI or phone while the operator can decide from the CopilotKit command center. Whichever
 * acts first wins; the other side is updated to match, retrying while Paperclip is unreachable.
 */
export class ApprovalMirror {
  private readonly polls = new Map<string, NodeJS.Timeout>();
  private readonly fromPaperclip = new Set<string>();

  constructor(
    private readonly pc: Paperclip,
    private readonly broker: ApprovalBroker,
    private readonly audit: AuditLog,
    private readonly pollMs = 5000,
    private readonly retryDelaysMs: readonly number[] = RETRY_DELAYS_MS,
  ) {
    broker.on("decided", (a) => {
      this.stop(a.id);
      if (this.fromPaperclip.delete(a.id)) return;
      // Not mirrored yet: mirror()'s callback syncs the decision once the Paperclip copy exists.
      if (a.paperclipApprovalId) void this.sync(a);
    });
  }

  mirror = (approvalId: string) => {
    const a = this.broker.get(approvalId);
    if (!a) return;
    void this.withRetry("approval.mirror_failed", a.id, () =>
      this.pc.createApproval(a.companyId, a.agentId, {
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
      }),
    ).then((pcA) => {
      if (!pcA) return;
      this.broker.attachMirror(a.id, pcA.id);
      const current = this.broker.get(a.id);
      // Decided on this side while Paperclip's copy was being filed: push that decision now.
      if (current && current.status !== "pending") return void this.sync(current);
      const timer = setInterval(() => void this.poll(a.id, pcA.id), this.pollMs);
      timer.unref?.();
      this.polls.set(a.id, timer);
    });
  };

  /**
   * Bring Paperclip's copy in line with a settled approval: approve it, or reject it for
   * rejected / expired. Retries transient failures; the last failure is audited.
   */
  sync = async (a: Pick<Approval, "id" | "status" | "decidedBy" | "note" | "paperclipApprovalId">): Promise<boolean> => {
    const pcId = a.paperclipApprovalId;
    if (!pcId || a.status === "pending") return false;
    const note = `${a.status} via agent-os by ${a.decidedBy ?? "system"}${a.note ? `: ${a.note}` : ""}`;
    const ok = await this.withRetry("approval.mirror_sync_failed", a.id, () => (a.status === "approved" ? this.pc.approve(pcId, note) : this.pc.reject(pcId, note)));
    return ok !== undefined;
  };

  private async poll(id: string, pcId: string) {
    try {
      const pcA = await this.pc.approval(pcId);
      if ((pcA.status === "approved" || pcA.status === "rejected") && this.broker.get(id)?.status === "pending") {
        this.fromPaperclip.add(id);
        this.broker.decide(id, pcA.status === "approved", "paperclip-board", pcA.decisionNote ?? undefined);
        this.fromPaperclip.delete(id);
      }
    } catch {
      /* transient; keep polling until the local approval settles */
    }
  }

  /** Run `fn`, retrying transient failures. Resolves undefined (after auditing) when it gives up. */
  private async withRetry<T>(failEvent: string, id: string, fn: () => Promise<T>): Promise<T | undefined> {
    for (let attempt = 0; ; attempt++) {
      try {
        const v = await fn();
        if (attempt > 0) this.audit.append("approval.mirror_recovered", "backend", { id, attempts: attempt + 1 });
        return (v ?? true) as T;
      } catch (e) {
        const delay = this.retryDelaysMs[attempt];
        if (delay === undefined || !retryable(e)) {
          this.audit.append(failEvent, "backend", { id, attempts: attempt + 1, error: String(e) });
          return undefined;
        }
        await new Promise((r) => setTimeout(r, delay).unref?.());
      }
    }
  }

  private stop(id: string) {
    const t = this.polls.get(id);
    if (t) clearInterval(t);
    this.polls.delete(id);
  }
}
