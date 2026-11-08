import { sanitize } from "@agent-os/governance";

export interface OperatorContext {
  companyId: string;
  /** What the operator is looking at: selected agent/issue, filters, free-form notes. */
  focus: Record<string, unknown>;
  updatedAt: string;
}

/**
 * Bi-directional context bridge. The command center pushes what the human is focused on
 * (the same data it hands CopilotKit via useAgentContext); background workers woken by
 * Paperclip read it at the start of each heartbeat. Entries go stale after `ttlMs`.
 */
export class ContextStore {
  private readonly byCompany = new Map<string, OperatorContext>();

  constructor(private readonly ttlMs = 30 * 60_000) {}

  set(companyId: string, focus: Record<string, unknown>): OperatorContext {
    // Operator input is trusted-ish, but it may contain pasted external text: sanitize anyway.
    const ctx = { companyId, focus: sanitize(focus).value, updatedAt: new Date().toISOString() };
    this.byCompany.set(companyId, ctx);
    return ctx;
  }

  get(companyId: string): OperatorContext | undefined {
    const c = this.byCompany.get(companyId);
    if (c && Date.now() - Date.parse(c.updatedAt) > this.ttlMs) {
      this.byCompany.delete(companyId);
      return undefined;
    }
    return c;
  }

  forCompany(companyId: string): string | undefined {
    const c = this.get(companyId);
    return c ? JSON.stringify(c.focus, null, 2).slice(0, 4000) : undefined;
  }
}
