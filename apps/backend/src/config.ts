import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { OrgPolicy } from "@agent-os/governance";

function env(k: string): string | undefined;
function env(k: string, d: string): string;
function env(k: string, d?: string) {
  return process.env[k] || d;
}

export const config = {
  port: Number(env("PORT", "8000")),
  /** Paperclip REST base, e.g. http://paperclip:3100/api */
  paperclipUrl: env("PAPERCLIP_API_URL", "http://localhost:3100/api")!.replace(/\/$/, ""),
  /** Bearer token for Paperclip (agent API key or board token). Empty in local_trusted mode. */
  paperclipKey: env("PAPERCLIP_API_KEY", ""),
  /** Shared secret Paperclip sends in its HTTP-adapter headers (`x-agent-os-secret`). */
  webhookSecret: env("AGENT_OS_WEBHOOK_SECRET", ""),
  composioKey: env("COMPOSIO_API_KEY", ""),
  /** Postgres for per-agent settings and approval history. Unset → in-memory (dev only). */
  databaseUrl: env("DATABASE_URL"),
  /** Redis pub/sub so several backend replicas share live events and approval decisions. Optional. */
  redisUrl: env("REDIS_URL"),
  /** Default worker model; override per role (org-policy.json) or per agent (command center). */
  workerModel: env("WORKER_MODEL", "claude-opus-5-5")!,
  workerEffort: env("WORKER_EFFORT", "high") as "low" | "medium" | "high" | "xhigh" | "max",
  workerMaxTurns: Number(env("WORKER_MAX_TURNS", "20")),
  /** CopilotKit operator agent model (AI SDK provider/model string). */
  operatorModel: env("OPERATOR_MODEL", "anthropic/claude-opus-5-5")!,
  confirmSecret: env("CONFIRM_SECRET") ?? randomBytes(32).toString("hex"),
  /** Mirror escalations into Paperclip's approval queue (type request_board_approval). */
  mirrorApprovals: env("MIRROR_APPROVALS", "true") === "true",
  auditFile: env("AUDIT_FILE", "./data/audit.jsonl")!,
  policyFile: env("POLICY_FILE", resolve(process.cwd(), "../../config/org-policy.json"))!,
  corsOrigin: env("CORS_ORIGIN", "http://localhost:3000")!,
};

export function loadPolicy(file = config.policyFile): OrgPolicy {
  return OrgPolicy.parse(JSON.parse(readFileSync(file, "utf8")));
}
