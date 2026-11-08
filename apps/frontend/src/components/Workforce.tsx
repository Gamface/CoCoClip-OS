"use client";

import type { ModelInfo } from "@agent-os/shared-types";
import { BudgetBar, ModelPicker, type SettingsPatch, cents } from "@agent-os/ui-kit";
import { type Agent, type WorkerState, api } from "@/api";

const LIVE = new Set(["starting", "thinking", "calling_tool", "awaiting_approval"]);

export function Workforce({
  agents,
  workers,
  models,
  selected,
  onSelect,
  onSettingsSaved,
}: {
  agents: Agent[];
  workers: Record<string, WorkerState>;
  models: readonly ModelInfo[];
  selected?: string;
  onSelect: (id: string) => void;
  onSettingsSaved: () => void;
}) {
  const latest = (agentId: string) =>
    Object.values(workers)
      .filter((w) => w.agentId === agentId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];

  if (!agents.length) return <p className="muted">No agents yet. Hire some in Paperclip and set their adapter to HTTP → this backend.</p>;

  const save = async (agentId: string, patch: SettingsPatch) => {
    await api(`/agents/${agentId}/settings`, { method: "PUT", body: JSON.stringify(patch) });
    onSettingsSaved();
  };

  return (
    <div className="workforce">
      {agents.map((a) => {
        const w = latest(a.id) ?? a.live ?? undefined;
        const spent = (w ? w.spentCents + w.runCostCents : a.spentMonthlyCents) ?? 0;
        const budget = a.budgetMonthlyCents ?? w?.budgetCents ?? null;
        const live = w && LIVE.has(w.status);
        return (
          <article key={a.id} className={`card agent ${selected === a.id ? "focused" : ""}`} onClick={() => onSelect(a.id)}>
            <header>
              <span className={`dot ${live ? "live" : w?.status ?? "idle"}`} />
              <strong>{a.name}</strong>
              <span className="muted small">{a.title ?? a.role}</span>
            </header>
            <p className="small">
              policy: <span className={`mono ${a.policyRole ? "" : "error"}`}>{a.policyRole ?? "unmapped"}</span>
              {a.status ? <> · paperclip: {a.status}</> : null}
            </p>
            <ModelPicker models={models} settings={a.settings} effective={a.effective} inherited={a.inherited} onChange={(p) => save(a.id, p)} />
            {w && (
              <p className="small">
                <b>{w.status.replace("_", " ")}</b>
                {w.model ? <span className="pill model">{w.model}</span> : null}
                {w.issueTitle ? <> · {w.issueTitle}</> : null}
                {w.detail ? <span className="muted"> · {w.detail}</span> : null}
                <br />
                <span className="muted">
                  turn {w.turn} · {w.toolCalls} tool calls · run {cents(w.runCostCents)}
                </span>
              </p>
            )}
            <BudgetBar spentCents={spent} budgetCents={budget} />
            {live && (
              <button
                className="ghost small"
                onClick={(e) => {
                  e.stopPropagation();
                  void api(`/runs/${w!.runId}/cancel`, { method: "POST" });
                }}
              >
                Stop run
              </button>
            )}
          </article>
        );
      })}
    </div>
  );
}
