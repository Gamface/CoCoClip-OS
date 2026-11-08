"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CopilotSidebar } from "@copilotkit/react-core/v2";
import { WORKER_MODELS, type ModelInfo } from "@agent-os/shared-types";
import { ApprovalCard } from "@agent-os/ui-kit";
import { type Agent, type Company, api, getToken, setToken } from "@/api";
import { useLiveEvents } from "@/useLiveEvents";
import { Workforce } from "./Workforce";
import { AuditFeed, FirewallFeed } from "./Feeds";
import { OperatorTools } from "./OperatorTools";

const decide = (id: string) => (granted: boolean, note?: string) => api(`/approvals/${id}`, { method: "POST", body: JSON.stringify({ granted, note }) });

export function Dashboard() {
  const live = useLiveEvents();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState<string>("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string>();
  const [selectedApproval, setSelectedApproval] = useState<string>();
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [models, setModels] = useState<readonly ModelInfo[]>(WORKER_MODELS);

  useEffect(() => {
    api<{ models: ModelInfo[] }>("/models").then((r) => setModels(r.models)).catch(() => {});
  }, []);

  useEffect(() => {
    api<Company[]>("/companies")
      .then((cs) => {
        setCompanies(Array.isArray(cs) ? cs : []);
        if (Array.isArray(cs) && cs[0]) setCompanyId((c) => c || cs[0]!.id);
      })
      .catch((e) => setError(`Paperclip: ${e.message}`));
  }, []);

  const loadAgents = useCallback(() => {
    if (!companyId) return;
    api<Agent[]>(`/workforce?companyId=${companyId}`).then(setAgents).catch((e) => setError(e.message));
  }, [companyId]);

  useEffect(() => {
    loadAgents();
    const t = setInterval(loadAgents, 15_000);
    return () => clearInterval(t);
  }, [loadAgents, live.settingsRev]);

  const approvals = useMemo(() => Object.values(live.approvals).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [live.approvals]);
  const pending = approvals.filter((a) => a.status === "pending");
  const recent = approvals.filter((a) => a.status !== "pending").slice(0, 6);

  const focus = useMemo(() => {
    const agent = agents.find((a) => a.id === selectedAgent);
    const appr = approvals.find((a) => a.id === selectedApproval);
    return {
      companyId,
      company: companies.find((c) => c.id === companyId)?.name ?? "",
      selectedAgent: agent
        ? JSON.stringify({ id: agent.id, name: agent.name, role: agent.role, policyRole: agent.policyRole, model: agent.effective.model, effort: agent.effective.effort })
        : "",
      selectedApproval: appr ? JSON.stringify({ id: appr.id, tool: appr.tool, agent: appr.agentName, status: appr.status }) : "",
      pendingApprovals: String(pending.length),
      operatorNotes: notes,
    };
  }, [companyId, companies, agents, selectedAgent, approvals, selectedApproval, pending.length, notes]);

  return (
    <div className="shell">
      <OperatorTools focus={focus} />
      <header className="top">
        <h1>Agent OS</h1>
        <span className="muted small">Paperclip org · Composio tools · CopilotKit operator</span>
        <span className={`dot ${live.connected ? "live" : "error"}`} title={live.connected ? "live" : "disconnected"} />
        <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} aria-label="Company">
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button
          className="ghost small"
          onClick={() => {
            const t = prompt("Operator token (blank to clear)", getToken());
            if (t !== null) {
              setToken(t);
              location.reload();
            }
          }}
        >
          Token
        </button>
      </header>
      {error && <p className="error banner" onClick={() => setError("")}>{error}</p>}

      <main className="grid">
        <section className="panel">
          <h2>Workforce</h2>
          <Workforce agents={agents} workers={live.workers} models={models} selected={selectedAgent} onSelect={setSelectedAgent} onSettingsSaved={loadAgents} />
        </section>

        <section className="panel">
          <h2>
            Approvals <span className="pill status-pending">{pending.length}</span>
          </h2>
          {pending.length === 0 && <p className="muted small">Nothing waiting. Risky or over-budget tool calls show up here.</p>}
          {pending.map((a) => (
            <ApprovalCard key={a.id} approval={a} focused={a.id === selectedApproval} onFocus={() => setSelectedApproval(a.id)} onDecide={decide(a.id)} />
          ))}
          {recent.length > 0 && <h3>Recent</h3>}
          {recent.map((a) => (
            <ApprovalCard key={a.id} approval={a} focused={a.id === selectedApproval} onFocus={() => setSelectedApproval(a.id)} onDecide={decide(a.id)} />
          ))}
        </section>

        <section className="panel">
          <h2>Shared context</h2>
          <textarea
            placeholder="Notes for the workforce: priorities, freezes, who's on call… Background agents read this at their next heartbeat."
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          <h2>Firewall</h2>
          <FirewallFeed items={live.firewall} />
          <h2>Audit</h2>
          <AuditFeed items={live.audit} integrity={live.integrity} />
        </section>
      </main>

      <CopilotSidebar agentId="operator" defaultOpen width={420} labels={{ modalHeaderTitle: "Operator", chatInputPlaceholder: "Ask about agents, models, budgets, approvals…" }} />
    </div>
  );
}
