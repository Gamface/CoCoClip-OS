import pg from "pg";
import type { AgentSettings, ApprovalRecord } from "@agent-os/shared-types";

/**
 * Durable state that must survive a backend restart and be shared by every replica:
 * per-agent model settings and approval history. Live run state stays in memory / Redis.
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
    this.approvals.set(a.id, structuredClone(a));
  }
  async listApprovals(limit = 100) {
    return [...this.approvals.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
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
`;

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
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, record = EXCLUDED.record`,
      [a.id, a.companyId, a.agentId, a.status, a.createdAt, JSON.stringify(a)],
    );
  }
  async listApprovals(limit = 100) {
    const r = await this.pool.query<{ record: ApprovalRecord | string }>("SELECT record FROM approvals ORDER BY created_at DESC LIMIT $1", [limit]);
    return r.rows.map((x) => (typeof x.record === "string" ? JSON.parse(x.record) : x.record));
  }
  async close() {
    await this.pool.end();
  }
}

export function createStore(databaseUrl: string | undefined): Store {
  return databaseUrl ? PostgresStore.fromUrl(databaseUrl) : new MemoryStore();
}
