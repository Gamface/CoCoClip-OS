import pg from "pg";
import type { AgentSettings, ApprovalRecord } from "@agent-os/shared-types";

/** A heartbeat in progress, recorded so another replica (or this one after a restart) can recover it. */
export interface RunRecord {
  runId: string;
  agentId: string;
  companyId: string;
  issueId?: string;
  owner: string;
  startedAt: string;
}

/**
 * Durable state that must survive a backend restart and be shared by every replica:
 * per-agent model settings, approval history, in-flight runs and replica liveness.
 */
export interface Store {
  readonly kind: "postgres" | "memory";
  init(): Promise<void>;
  getSettings(agentId: string): Promise<AgentSettings | null>;
  listSettings(): Promise<AgentSettings[]>;
  putSettings(s: AgentSettings): Promise<AgentSettings>;
  deleteSettings(agentId: string): Promise<void>;
  saveApproval(a: ApprovalRecord): Promise<void>;
  listApprovals(limit?: number): Promise<ApprovalRecord[]>;
  /** Pending approvals across all replicas. */
  listPendingApprovals(): Promise<ApprovalRecord[]>;
  /**
   * Settle a pending approval if it is still pending; returns the stored record, or null when it
   * was already settled (another replica got there first).
   */
  settleApproval(a: ApprovalRecord): Promise<ApprovalRecord | null>;
  saveRun(r: RunRecord): Promise<void>;
  deleteRun(runId: string): Promise<void>;
  listRuns(): Promise<RunRecord[]>;
  /** Remove a run record and return it, or null when another replica already claimed it. */
  claimRun(runId: string): Promise<RunRecord | null>;
  /** Record that a replica is alive. */
  touchReplica(id: string): Promise<void>;
  /** Last-seen time (ms since epoch) of every replica that has checked in. */
  replicaSeen(): Promise<Map<string, number>>;
  close(): Promise<void>;
}

export class MemoryStore implements Store {
  readonly kind = "memory" as const;
  private settings = new Map<string, AgentSettings>();
  private approvals = new Map<string, ApprovalRecord>();
  async init() {}
  async getSettings(id: string) {
    return this.settings.get(id) ?? null;
  }
  async listSettings() {
    return [...this.settings.values()];
  }
  async putSettings(s: AgentSettings) {
    const v = { ...s, updatedAt: new Date().toISOString() };
    this.settings.set(s.agentId, v);
    return v;
  }
  async deleteSettings(id: string) {
    this.settings.delete(id);
  }
  async saveApproval(a: ApprovalRecord) {
    // Writes can land out of order; a settled approval is never turned back into a pending one.
    if (this.approvals.get(a.id)?.status !== undefined && this.approvals.get(a.id)?.status !== "pending") return;
    this.approvals.set(a.id, structuredClone(a));
  }
  async listApprovals(limit = 100) {
    return [...this.approvals.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }
  async listPendingApprovals() {
    return [...this.approvals.values()].filter((a) => a.status === "pending").map((a) => structuredClone(a));
  }
  async settleApproval(a: ApprovalRecord) {
    const cur = this.approvals.get(a.id);
    if (!cur || cur.status !== "pending") return null;
    this.approvals.set(a.id, structuredClone(a));
    return structuredClone(a);
  }
  private runs = new Map<string, RunRecord>();
  private replicas = new Map<string, number>();
  async saveRun(r: RunRecord) {
    this.runs.set(r.runId, { ...r });
  }
  async deleteRun(runId: string) {
    this.runs.delete(runId);
  }
  async listRuns() {
    return [...this.runs.values()].map((r) => ({ ...r }));
  }
  async claimRun(runId: string) {
    const r = this.runs.get(runId);
    this.runs.delete(runId);
    return r ? { ...r } : null;
  }
  async touchReplica(id: string) {
    this.replicas.set(id, Date.now());
  }
  async replicaSeen() {
    return new Map(this.replicas);
  }
  async close() {}
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_settings (
  agent_id   TEXT PRIMARY KEY,
  model      TEXT,
  effort     TEXT,
  max_turns  INTEGER,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS approvals (
  id         TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  status     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  record     JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS approvals_created_idx ON approvals (created_at DESC);
CREATE TABLE IF NOT EXISTS runs (
  run_id     TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  company_id TEXT NOT NULL,
  issue_id   TEXT,
  owner      TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS replicas (
  id      TEXT PRIMARY KEY,
  seen_at TIMESTAMPTZ NOT NULL
);
`;

type RunRow = { run_id: string; agent_id: string; company_id: string; issue_id: string | null; owner: string; started_at: Date | string };
const toRun = (r: RunRow): RunRecord => ({
  runId: r.run_id,
  agentId: r.agent_id,
  companyId: r.company_id,
  issueId: r.issue_id ?? undefined,
  owner: r.owner,
  startedAt: new Date(r.started_at).toISOString(),
});
const parseRecord = (x: { record: ApprovalRecord | string }): ApprovalRecord => (typeof x.record === "string" ? JSON.parse(x.record) : x.record);

type SettingsRow = { agent_id: string; model: string | null; effort: string | null; max_turns: number | null; updated_by: string | null; updated_at: Date | string };

const toSettings = (r: SettingsRow): AgentSettings => ({
  agentId: r.agent_id,
  model: r.model,
  effort: r.effort as AgentSettings["effort"],
  maxTurns: r.max_turns,
  updatedBy: r.updated_by ?? undefined,
  updatedAt: new Date(r.updated_at).toISOString(),
});

export class PostgresStore implements Store {
  readonly kind = "postgres" as const;
  constructor(private readonly pool: pg.Pool) {}

  static fromUrl(url: string) {
    return new PostgresStore(new pg.Pool({ connectionString: url, max: 5 }));
  }

  async init() {
    await this.pool.query(SCHEMA);
  }
  async getSettings(id: string) {
    const r = await this.pool.query<SettingsRow>("SELECT * FROM agent_settings WHERE agent_id = $1", [id]);
    return r.rows[0] ? toSettings(r.rows[0]) : null;
  }
  async listSettings() {
    return (await this.pool.query<SettingsRow>("SELECT * FROM agent_settings")).rows.map(toSettings);
  }
  async putSettings(s: AgentSettings) {
    const r = await this.pool.query<SettingsRow>(
      `INSERT INTO agent_settings (agent_id, model, effort, max_turns, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (agent_id) DO UPDATE SET model = EXCLUDED.model, effort = EXCLUDED.effort,
         max_turns = EXCLUDED.max_turns, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING *`,
      [s.agentId, s.model ?? null, s.effort ?? null, s.maxTurns ?? null, s.updatedBy ?? null],
    );
    return toSettings(r.rows[0]!);
  }
  async deleteSettings(id: string) {
    await this.pool.query("DELETE FROM agent_settings WHERE agent_id = $1", [id]);
  }
  async saveApproval(a: ApprovalRecord) {
    await this.pool.query(
      `INSERT INTO approvals (id, company_id, agent_id, status, created_at, record) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, record = EXCLUDED.record
       WHERE approvals.status = 'pending'`,
      [a.id, a.companyId, a.agentId, a.status, a.createdAt, JSON.stringify(a)],
    );
  }
  async listApprovals(limit = 100) {
    const r = await this.pool.query<{ record: ApprovalRecord | string }>("SELECT record FROM approvals ORDER BY created_at DESC LIMIT $1", [limit]);
    return r.rows.map(parseRecord);
  }
  async listPendingApprovals() {
    const r = await this.pool.query<{ record: ApprovalRecord | string }>("SELECT record FROM approvals WHERE status = 'pending'");
    return r.rows.map(parseRecord);
  }
  async settleApproval(a: ApprovalRecord) {
    const r = await this.pool.query<{ record: ApprovalRecord | string }>(
      "UPDATE approvals SET status = $2, record = $3 WHERE id = $1 AND status = 'pending' RETURNING record",
      [a.id, a.status, JSON.stringify(a)],
    );
    return r.rows[0] ? parseRecord(r.rows[0]) : null;
  }
  async saveRun(r: RunRecord) {
    await this.pool.query(
      `INSERT INTO runs (run_id, agent_id, company_id, issue_id, owner, started_at) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (run_id) DO UPDATE SET issue_id = EXCLUDED.issue_id, owner = EXCLUDED.owner`,
      [r.runId, r.agentId, r.companyId, r.issueId ?? null, r.owner, r.startedAt],
    );
  }
  async deleteRun(runId: string) {
    await this.pool.query("DELETE FROM runs WHERE run_id = $1", [runId]);
  }
  async listRuns() {
    return (await this.pool.query<RunRow>("SELECT * FROM runs")).rows.map(toRun);
  }
  async claimRun(runId: string) {
    const r = await this.pool.query<RunRow>("DELETE FROM runs WHERE run_id = $1 RETURNING *", [runId]);
    return r.rows[0] ? toRun(r.rows[0]) : null;
  }
  async touchReplica(id: string) {
    await this.pool.query(
      "INSERT INTO replicas (id, seen_at) VALUES ($1, now()) ON CONFLICT (id) DO UPDATE SET seen_at = now()",
      [id],
    );
  }
  async replicaSeen() {
    const r = await this.pool.query<{ id: string; seen_at: Date | string }>("SELECT id, seen_at FROM replicas");
    return new Map(r.rows.map((x) => [x.id, new Date(x.seen_at).getTime()]));
  }
  async close() {
    await this.pool.end();
  }
}

export function createStore(databaseUrl: string | undefined): Store {
  return databaseUrl ? PostgresStore.fromUrl(databaseUrl) : new MemoryStore();
}
