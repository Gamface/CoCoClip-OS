import { z } from "zod";

/**
 * Role-scoped tool governance.
 *
 * Paperclip owns the org chart (who an agent is, what role it holds, its budget).
 * Composio owns the tool catalogue. This module is the join: given a role and a
 * Composio tool slug it decides `allow | ask | deny`, so a worker only ever *sees*
 * tools it may use and every risky call is escalated to a human.
 */

export const PermissionMode = z.enum(["allow", "ask", "deny"]);
export type PermissionMode = z.infer<typeof PermissionMode>;

export const Risk = z.enum(["read", "write", "destructive"]);
export type Risk = z.infer<typeof Risk>;

export const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type Effort = z.infer<typeof Effort>;

export const ToolRule = z.object({
  /** Glob over the Composio tool slug, e.g. `GITHUB_MERGE_*` or `*_DELETE_*`. */
  match: z.string().min(1),
  mode: PermissionMode,
  note: z.string().optional(),
});
export type ToolRule = z.infer<typeof ToolRule>;

export const RolePolicy = z.object({
  /** Matched against the Paperclip agent's `role`, then its `name` (case-insensitive glob). */
  role: z.string().min(1),
  /** Composio toolkits this role may draw from. Nothing outside this list is ever fetched. */
  toolkits: z.array(z.string()).default([]),
  /** First matching rule wins. */
  rules: z.array(ToolRule).default([]),
  /** Mode per risk class when no rule matches. */
  defaults: z
    .object({ read: PermissionMode, write: PermissionMode, destructive: PermissionMode })
    .default({ read: "allow", write: "ask", destructive: "ask" }),
  /** How many tool schemas to inject per heartbeat (keeps context small). */
  maxTools: z.number().int().positive().default(20),
  /** Hard cap on tool executions in one heartbeat. */
  maxToolCallsPerRun: z.number().int().positive().default(25),
  /** Worker model for agents in this role (overridable per agent). Falls back to WORKER_MODEL. */
  model: z.string().regex(/^claude-[a-z0-9-]+$/).optional(),
  /** Effort for this role's workers. Falls back to WORKER_EFFORT. */
  effort: Effort.optional(),
  /** Model turns per heartbeat. Falls back to WORKER_MAX_TURNS. */
  maxTurns: z.number().int().min(1).max(100).optional(),
});
export type RolePolicy = z.infer<typeof RolePolicy>;

export const OrgPolicy = z.object({
  /** Fraction of budget at which writes start requiring approval. Paperclip's own soft alert is 0.8. */
  softBudgetRatio: z.number().min(0).max(1).default(0.8),
  /** Seconds a pending approval waits before it is auto-denied. */
  approvalTimeoutSec: z.number().int().positive().default(900),
  roles: z.array(RolePolicy).min(1),
});
export type OrgPolicy = z.infer<typeof OrgPolicy>;

const DESTRUCTIVE = /(^|_)(DELETE|REMOVE|DESTROY|PURGE|DROP|TERMINATE|REVOKE|ARCHIVE|FORCE|TRANSFER|PAY|REFUND)(_|$)/;
const WRITE =
  /(^|_)(CREATE|UPDATE|EDIT|PATCH|PUT|POST|SEND|REPLY|MERGE|PUSH|COMMIT|DEPLOY|INVITE|ADD|SET|ASSIGN|CLOSE|REOPEN|UPLOAD|PUBLISH|SCHEDULE|EXECUTE|RUN|TRIGGER|MOVE|RENAME|APPROVE|LOCK|STAR|FORK)(_|$)/;

/** Classify a Composio slug (e.g. `GITHUB_MERGE_A_PULL_REQUEST`) by its verbs. Unknown → write (fail closed). */
export function classifyRisk(slug: string): Risk {
  const s = slug.toUpperCase();
  if (DESTRUCTIVE.test(s)) return "destructive";
  if (WRITE.test(s)) return "write";
  if (/(^|_)(GET|LIST|SEARCH|FIND|FETCH|READ|RETRIEVE|DESCRIBE|COUNT|CHECK|QUERY|LOOKUP|VIEW)(_|$)/.test(s)) return "read";
  return "write";
}

export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

export function resolveRole(policy: OrgPolicy, agent: { role?: string | null; name?: string | null }): RolePolicy | undefined {
  const specific = policy.roles.filter((r) => r.role !== "*");
  for (const key of [agent.role, agent.name]) {
    if (!key) continue;
    const hit = specific.find((r) => globToRegExp(r.role).test(key));
    if (hit) return hit;
  }
  return policy.roles.find((r) => r.role === "*");
}

export interface BudgetSnapshot {
  spentCents: number;
  /** 0 or undefined = unlimited. */
  budgetCents?: number | null;
  /** Estimated cost of the next step, used to catch a call that would cross a threshold. */
  projectedCents?: number;
}

export interface Decision {
  mode: PermissionMode;
  risk: Risk;
  reasons: string[];
}

const rank: Record<PermissionMode, number> = { allow: 0, ask: 1, deny: 2 };
const stricter = (a: PermissionMode, b: PermissionMode) => (rank[a] >= rank[b] ? a : b);

/**
 * Decide whether a role may run a tool right now.
 * Static policy (rules/defaults) is combined with dynamic budget state; the stricter result wins.
 */
export function decide(
  role: RolePolicy,
  toolSlug: string,
  toolkitSlug: string | undefined,
  budget: BudgetSnapshot,
  softBudgetRatio = 0.8,
): Decision {
  const risk = classifyRisk(toolSlug);
  const reasons: string[] = [];

  if (toolkitSlug && role.toolkits.length > 0 && !role.toolkits.some((t) => t.toLowerCase() === toolkitSlug.toLowerCase())) {
    return { mode: "deny", risk, reasons: [`toolkit "${toolkitSlug}" is outside role "${role.role}"`] };
  }

  const rule = role.rules.find((r) => globToRegExp(r.match).test(toolSlug));
  let mode: PermissionMode;
  if (rule) {
    mode = rule.mode;
    reasons.push(`rule ${rule.match} → ${rule.mode}${rule.note ? ` (${rule.note})` : ""}`);
  } else {
    mode = role.defaults[risk];
    reasons.push(`default for ${risk} → ${mode}`);
  }

  const cap = budget.budgetCents ?? 0;
  if (cap > 0) {
    const after = budget.spentCents + (budget.projectedCents ?? 0);
    if (budget.spentCents >= cap) {
      mode = "deny";
      reasons.push(`budget exhausted (${budget.spentCents}/${cap}¢)`);
    } else if (after >= cap) {
      mode = stricter(mode, "ask");
      reasons.push(`projected spend ${after}¢ would exceed budget ${cap}¢`);
    } else if (risk !== "read" && after >= cap * softBudgetRatio) {
      mode = stricter(mode, "ask");
      reasons.push(`over ${Math.round(softBudgetRatio * 100)}% of budget; writes need approval`);
    }
  }

  return { mode, risk, reasons };
}
