/**
 * Types shared by the backend (Express + CopilotRuntime) and the frontend (Next.js + CopilotKit):
 * AG-UI / SSE event payloads, governance records, and the worker model catalogue.
 */

// ── Worker models ──────────────────────────────────────────────────────────────

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * How a model handles a safety refusal. `default` = the scalar `fallbacks: "default"` form
 * (beta server-side-fallback-2026-07-01); `array` = an explicit fallback model (beta
 * server-side-fallback-2026-06-01); `none` = the model has no server-side fallback.
 */
export type FallbackMode = { kind: "default" } | { kind: "array"; model: string } | { kind: "none" };

export interface ModelInfo {
  id: string;
  label: string;
  tier: "frontier" | "balanced" | "fast";
  /** USD per million tokens. */
  price: { input: number; output: number };
  fallback: FallbackMode;
  note: string;
}

export const WORKER_MODELS: readonly ModelInfo[] = [
  { id: "claude-fable-5-1", label: "Claude Fable 5.1", tier: "frontier", price: { input: 10, output: 50 }, fallback: { kind: "array", model: "claude-opus-4-8" }, note: "Most capable; long-horizon, research-heavy roles" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", tier: "frontier", price: { input: 4, output: 20 }, fallback: { kind: "default" }, note: "Default; strong agentic coding and knowledge work" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", tier: "balanced", price: { input: 2, output: 10 }, fallback: { kind: "default" }, note: "Near-Opus quality at half the price" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", tier: "fast", price: { input: 0.1, output: 0.5 }, fallback: { kind: "none" }, note: "Fast and cheap; triage, routing, support" },
];

export const modelInfo = (id: string): ModelInfo | undefined => WORKER_MODELS.find((m) => m.id === id);

/** Per-agent overrides set from the command center (persisted by the backend). */
export interface AgentSettings {
  agentId: string;
  model?: string | null;
  effort?: Effort | null;
  maxTurns?: number | null;
  updatedAt?: string;
  updatedBy?: string;
}

/** What a heartbeat will actually run with, and where each value came from. */
export interface EffectiveSettings {
  model: string;
  effort: Effort;
  maxTurns: number;
  source: { model: SettingSource; effort: SettingSource; maxTurns: SettingSource };
}
export type SettingSource = "agent" | "role" | "default";

// ── Live state (SSE) ───────────────────────────────────────────────────────────

export type WorkerStatus = "starting" | "thinking" | "calling_tool" | "awaiting_approval" | "done" | "blocked" | "error";

export interface WorkerState {
  agentId: string;
  agentName: string;
  role: string;
  runId: string;
  model?: string;
  issueId?: string;
  issueTitle?: string;
  status: WorkerStatus;
  detail?: string;
  turn: number;
  toolCalls: number;
  spentCents: number;
  budgetCents?: number | null;
  runCostCents: number;
  updatedAt: string;
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface ApprovalRecord {
  id: string;
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
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  decidedBy?: string;
  note?: string;
  paperclipApprovalId?: string;
}

export interface AuditEntry {
  seq: number;
  ts: string;
  type: string;
  actor: string;
  data: Record<string, unknown>;
  hash: string;
}

export interface FirewallFinding {
  kind: string;
  path: string;
  detail: string;
}

export interface FirewallEvent {
  agentId: string;
  tool: string;
  score: number;
  findings: FirewallFinding[];
}

export type HubEvent =
  | { type: "worker"; data: WorkerState }
  | { type: "approval"; data: ApprovalRecord }
  | { type: "firewall"; data: FirewallEvent }
  | { type: "audit"; data: AuditEntry }
  | { type: "context"; data: unknown }
  | { type: "settings"; data: AgentSettings };

// ── REST payloads ──────────────────────────────────────────────────────────────

export interface WorkforceAgent {
  id: string;
  name: string;
  role?: string | null;
  title?: string | null;
  status?: string;
  budgetMonthlyCents?: number | null;
  spentMonthlyCents?: number | null;
  policyRole: string | null;
  live: WorkerState | null;
  settings: AgentSettings | null;
  effective: EffectiveSettings;
  /** What the agent runs with if its own override is cleared (role → default). */
  inherited: EffectiveSettings;
}

export interface Company {
  id: string;
  name: string;
}

/** Operator actions that need a human-minted confirmation token. */
export const CONFIRMABLE_ACTIONS = ["create_task", "wake_agent", "set_agent_model"] as const;
export type ConfirmableAction = (typeof CONFIRMABLE_ACTIONS)[number];
