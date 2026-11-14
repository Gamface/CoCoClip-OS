import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface ApprovalRequest {
  companyId: string;
  agentId: string;
  agentName: string;
  role: string;
  runId?: string;
  issueId?: string;
  tool: string;
  toolkit?: string;
  risk: string;
  args: unknown;
  reasons: string[];
  estimatedCostCents?: number;
  budget?: { spentCents: number; budgetCents?: number | null };
}

export interface Approval extends ApprovalRequest {
  id: string;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  decidedBy?: string;
  note?: string;
  /** Id of the mirrored Paperclip approval, when mirroring succeeded. */
  paperclipApprovalId?: string;
}

export interface ApprovalOutcome {
  granted: boolean;
  approval: Approval;
}

/**
 * Pending human decisions. A worker awaits `request()`; any surface (CopilotKit UI,
 * Paperclip board UI via the mirror, REST) settles it with `decide()`. First decision wins.
 */
export class ApprovalBroker extends EventEmitter<{ requested: [Approval]; decided: [Approval]; mirrored: [Approval] }> {
  private readonly items = new Map<string, Approval>();
  private readonly waiters = new Map<string, { resolve: (o: ApprovalOutcome) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly timeoutSec = 900) {
    super();
  }

  request(req: ApprovalRequest, opts: { signal?: AbortSignal } = {}): { approval: Approval; outcome: Promise<ApprovalOutcome> } {
    const now = Date.now();
    const approval: Approval = {
      ...req,
      id: randomUUID(),
      status: "pending",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.timeoutSec * 1000).toISOString(),
    };
    this.items.set(approval.id, approval);

    const outcome = new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => this.settle(approval.id, "expired", "system", "timed out"), this.timeoutSec * 1000);
      timer.unref?.();
      this.waiters.set(approval.id, { resolve, timer });
      opts.signal?.addEventListener("abort", () => this.settle(approval.id, "rejected", "system", "run aborted"), { once: true });
    });

    this.emit("requested", approval);
    return { approval, outcome };
  }

  decide(id: string, granted: boolean, by: string, note?: string): Approval | undefined {
    return this.settle(id, granted ? "approved" : "rejected", by, note);
  }

  attachMirror(id: string, paperclipApprovalId: string) {
    const a = this.items.get(id);
    if (!a) return;
    a.paperclipApprovalId = paperclipApprovalId;
    this.emit("mirrored", a);
  }

  get(id: string) {
    return this.items.get(id);
  }

  list(status?: ApprovalStatus): Approval[] {
    return [...this.items.values()].filter((a) => !status || a.status === status).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private settle(id: string, status: Exclude<ApprovalStatus, "pending">, by: string, note?: string): Approval | undefined {
    const a = this.items.get(id);
    if (!a || a.status !== "pending") return a;
    a.status = status;
    a.decidedAt = new Date().toISOString();
    a.decidedBy = by;
    a.note = note;
    const w = this.waiters.get(id);
    if (w) {
      clearTimeout(w.timer);
      this.waiters.delete(id);
      w.resolve({ granted: status === "approved", approval: a });
    }
    this.emit("decided", a);
    return a;
  }
}
