/**
 * Minimal typed client for the Paperclip control-plane REST API.
 * Endpoints follow docs/api/*.md in paperclipai/paperclip.
 */

export interface PcAgent {
  id: string;
  companyId: string;
  name: string;
  role?: string | null;
  title?: string | null;
  status?: string;
  reportsTo?: string | null;
  budgetMonthlyCents?: number | null;
  spentMonthlyCents?: number | null;
  [k: string]: unknown;
}

export interface PcIssue {
  id: string;
  identifier?: string;
  title: string;
  description?: string | null;
  status: string;
  priority?: string;
  assigneeAgentId?: string | null;
  [k: string]: unknown;
}

export interface PcComment {
  id: string;
  body: string;
  authorAgentId?: string | null;
  authorUserId?: string | null;
  createdAt?: string;
}

export class PaperclipError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export class Paperclip {
  constructor(private readonly baseUrl: string, private readonly apiKey?: string) {}

  private async call<T>(method: string, path: string, body?: unknown, runId?: string): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    if (runId) headers["X-Paperclip-Run-Id"] = runId;
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try {
        msg = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {}
      throw new PaperclipError(res.status, `${method} ${path} → ${res.status}: ${msg}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  agent = (id: string) => this.call<PcAgent>("GET", `/agents/${id}`);
  /**
   * Board tokens can list every company. An agent API key gets 403 "Board access required" there,
   * so fall back to the key's own company (GET /agents/me, then GET /companies/:id).
   */
  companies = async (): Promise<Array<{ id: string; name: string }>> => {
    try {
      return await this.call<Array<{ id: string; name: string }>>("GET", "/companies");
    } catch (e) {
      if (!(e instanceof PaperclipError) || e.status !== 403) throw e;
      const me = await this.call<{ companyId?: string }>("GET", "/agents/me");
      if (!me?.companyId) throw e;
      const c = await this.call<{ id: string; name: string }>("GET", `/companies/${me.companyId}`);
      return [{ id: c.id, name: c.name }];
    }
  };
  agents = (companyId: string) => this.call<PcAgent[]>("GET", `/companies/${companyId}/agents`);
  org = (companyId: string) => this.call<unknown>("GET", `/companies/${companyId}/org`);
  wake = (agentId: string) => this.call<unknown>("POST", `/agents/${agentId}/heartbeat/invoke`, {});

  issue = (id: string) => this.call<PcIssue>("GET", `/issues/${id}`);
  issues = (companyId: string, q = "") => this.call<PcIssue[]>("GET", `/companies/${companyId}/issues${q}`);
  comments = (id: string) => this.call<PcComment[]>("GET", `/issues/${id}/comments`);
  createIssue = (companyId: string, body: Record<string, unknown>) => this.call<PcIssue>("POST", `/companies/${companyId}/issues`, body);
  checkout = (issueId: string, agentId: string, runId: string) =>
    this.call<PcIssue>("POST", `/issues/${issueId}/checkout`, { agentId, expectedStatuses: ["todo", "backlog", "blocked", "in_review", "in_progress"] }, runId);
  updateIssue = (issueId: string, body: { status?: string; comment?: string }, runId?: string) =>
    this.call<unknown>("PATCH", `/issues/${issueId}`, body, runId);
  comment = (issueId: string, body: string, runId?: string) => this.call<unknown>("POST", `/issues/${issueId}/comments`, { body }, runId);

  costsByAgent = (companyId: string) => this.call<Array<{ agentId: string; costCents?: number; spentCents?: number; totalCents?: number }>>("GET", `/companies/${companyId}/costs/by-agent`);
  costSummary = (companyId: string) => this.call<unknown>("GET", `/companies/${companyId}/costs/summary`);
  reportCost = (
    companyId: string,
    e: { agentId: string; provider: string; model: string; inputTokens: number; outputTokens: number; costCents: number },
    runId?: string,
  ) => this.call<unknown>("POST", `/companies/${companyId}/cost-events`, e, runId);

  createApproval = (companyId: string, requestedByAgentId: string, payload: unknown) =>
    this.call<{ id: string; status: string }>("POST", `/companies/${companyId}/approvals`, { type: "request_board_approval", requestedByAgentId, payload });
  approval = (id: string) => this.call<{ id: string; status: string; decisionNote?: string | null }>("GET", `/approvals/${id}`);
  approve = (id: string, decisionNote?: string) => this.call<unknown>("POST", `/approvals/${id}/approve`, { decisionNote });
  reject = (id: string, decisionNote?: string) => this.call<unknown>("POST", `/approvals/${id}/reject`, { decisionNote });

  /** Month-to-date spend for one agent, tolerant of field-name differences across Paperclip versions. */
  async agentSpend(agent: PcAgent): Promise<{ spentCents: number; budgetCents: number | null }> {
    let spent = typeof agent.spentMonthlyCents === "number" ? agent.spentMonthlyCents : undefined;
    if (spent === undefined) {
      try {
        const rows = await this.costsByAgent(agent.companyId);
        const row = rows.find((r) => r.agentId === agent.id);
        spent = row?.costCents ?? row?.spentCents ?? row?.totalCents ?? 0;
      } catch {
        spent = 0;
      }
    }
    return { spentCents: spent, budgetCents: agent.budgetMonthlyCents ?? null };
  }
}
