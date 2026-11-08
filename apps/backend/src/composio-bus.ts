import { Composio } from "@composio/core";
import {
  type ApprovalBroker,
  type AuditLog,
  type BudgetSnapshot,
  type RolePolicy,
  decide,
  envelope,
  sanitize,
} from "@agent-os/governance";
import type { EventHub } from "./events.js";

export interface ScopedTool {
  slug: string;
  toolkit?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  version?: string;
  risk: string;
}

export interface CallContext {
  companyId: string;
  agentId: string;
  agentName: string;
  role: RolePolicy;
  runId: string;
  issueId?: string;
  budget: () => BudgetSnapshot;
  softBudgetRatio: number;
  signal?: AbortSignal;
  onAwaitingApproval?: (tool: string) => void;
}

export interface ToolOutcome {
  ok: boolean;
  /** Text handed back to the model as the tool_result. */
  content: string;
}

/**
 * The execution bus between Paperclip workers and Composio.
 *
 *  resolveTools(): JIT, role-scoped schema injection. Only toolkits the Paperclip role
 *                  owns are queried, ranked by Composio's semantic search against the task,
 *                  and tools the policy would deny are dropped before the model sees them.
 *  execute():      policy gate → (human approval) → Composio execute → firewall → audit.
 */
export class ComposioBus {
  private readonly composio?: Composio;

  constructor(
    apiKey: string,
    private readonly approvals: ApprovalBroker,
    private readonly audit: AuditLog,
    private readonly hub: EventHub,
    private readonly mirror?: (approvalId: string) => void,
  ) {
    if (apiKey) this.composio = new Composio({ apiKey });
  }

  get enabled() {
    return Boolean(this.composio);
  }

  async resolveTools(role: RolePolicy, taskText: string, budget: BudgetSnapshot, softRatio: number): Promise<ScopedTool[]> {
    if (!this.composio || role.toolkits.length === 0) return [];
    const perToolkit = Math.max(3, Math.ceil(role.maxTools / role.toolkits.length));
    const search = taskText.slice(0, 300);

    const batches = await Promise.all(
      role.toolkits.map(async (toolkit) => {
        try {
          return await this.composio!.tools.getRawComposioTools({ toolkits: [toolkit], search, limit: perToolkit });
        } catch (err) {
          // Semantic search can come back empty for a narrow query: fall back to the toolkit's important tools.
          try {
            return await this.composio!.tools.getRawComposioTools({ toolkits: [toolkit], important: true, limit: perToolkit });
          } catch {
            this.audit.append("composio.resolve_failed", "backend", { toolkit, error: String(err) });
            return [];
          }
        }
      }),
    );

    const seen = new Set<string>();
    const tools: ScopedTool[] = [];
    for (const t of batches.flat()) {
      if (seen.has(t.slug)) continue;
      seen.add(t.slug);
      const toolkit = t.toolkit?.slug;
      const d = decide(role, t.slug, toolkit, budget, softRatio);
      if (d.mode === "deny") continue;
      tools.push({
        slug: t.slug,
        toolkit,
        description: `${t.description ?? t.name ?? t.slug}${d.mode === "ask" ? " [requires human approval]" : ""}`.slice(0, 1024),
        inputSchema: (t.inputParameters as Record<string, unknown> | undefined) ?? { type: "object", properties: {} },
        version: t.version,
        risk: d.risk,
      });
      if (tools.length >= role.maxTools) break;
    }
    return tools;
  }

  async execute(tool: ScopedTool, args: Record<string, unknown>, ctx: CallContext): Promise<ToolOutcome> {
    const actor = `agent:${ctx.agentId}`;
    const budget = ctx.budget();
    const decision = decide(ctx.role, tool.slug, tool.toolkit, budget, ctx.softBudgetRatio);
    this.audit.append("tool.decision", actor, { runId: ctx.runId, tool: tool.slug, args, ...decision });

    if (decision.mode === "deny") {
      return { ok: false, content: `Denied by governance policy: ${decision.reasons.join("; ")}. Do not retry this tool.` };
    }

    if (decision.mode === "ask") {
      ctx.onAwaitingApproval?.(tool.slug);
      const { approval, outcome } = this.approvals.request(
        {
          companyId: ctx.companyId,
          agentId: ctx.agentId,
          agentName: ctx.agentName,
          role: ctx.role.role,
          runId: ctx.runId,
          issueId: ctx.issueId,
          tool: tool.slug,
          toolkit: tool.toolkit,
          risk: decision.risk,
          args,
          reasons: decision.reasons,
          estimatedCostCents: budget.projectedCents,
          budget: { spentCents: budget.spentCents, budgetCents: budget.budgetCents },
        },
        { signal: ctx.signal },
      );
      this.mirror?.(approval.id);
      const { granted, approval: settled } = await outcome;
      if (!granted) {
        return {
          ok: false,
          content: `A human supervisor ${settled.status === "expired" ? "did not respond in time to" : "rejected"} ${tool.slug}${settled.note ? `: "${settled.note}"` : ""}. Choose another approach or report that you are blocked.`,
        };
      }
    }

    if (!this.composio) return { ok: false, content: "Composio is not configured on this backend." };

    try {
      const result = await this.composio.tools.execute(
        tool.slug,
        { userId: ctx.companyId, arguments: args, ...(tool.version ? { version: tool.version } : { dangerouslySkipVersionCheck: true }) },
        { signal: ctx.signal },
      );
      const fw = sanitize(result.successful ? result.data : { error: result.error });
      if (fw.findings.length) {
        this.hub.publish({ type: "firewall", data: { agentId: ctx.agentId, tool: tool.slug, score: fw.score, findings: fw.findings } });
      }
      this.audit.append("tool.executed", actor, {
        runId: ctx.runId,
        tool: tool.slug,
        successful: result.successful,
        firewall: { score: fw.score, quarantined: fw.quarantined, findings: fw.findings.length },
      });
      return { ok: result.successful, content: envelope(tool.slug, fw) };
    } catch (err) {
      this.audit.append("tool.failed", actor, { runId: ctx.runId, tool: tool.slug, error: String(err) });
      return { ok: false, content: `Tool ${tool.slug} failed: ${String(err).slice(0, 500)}` };
    }
  }

  /** Read-only catalogue search used by the operator chat ("what could the DevOps agent do?"). */
  async search(query: string, toolkits: string[], limit = 10) {
    if (!this.composio || toolkits.length === 0) return [];
    const tools = await this.composio.tools.getRawComposioTools({ toolkits, search: query, limit });
    return tools.map((t) => ({ slug: t.slug, toolkit: t.toolkit?.slug, description: t.description }));
  }
}
