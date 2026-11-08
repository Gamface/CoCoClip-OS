"use client";

import { useEffect, useReducer } from "react";
import { type Approval, type AuditEntry, type FirewallEvent, type WorkerState, api, getToken } from "@/api";

interface LiveState {
  connected: boolean;
  workers: Record<string, WorkerState>;
  approvals: Record<string, Approval>;
  audit: AuditEntry[];
  firewall: Array<FirewallEvent & { at: string }>;
  integrity?: { ok: boolean; length?: number; brokenAt?: number };
  /** Bumps whenever any replica changes an agent's model settings, so the workforce reloads. */
  settingsRev: number;
}

type Action =
  | { t: "connected"; v: boolean }
  | { t: "worker"; v: WorkerState }
  | { t: "approval"; v: Approval }
  | { t: "approvals"; v: Approval[] }
  | { t: "audit"; v: AuditEntry }
  | { t: "auditInit"; v: { integrity: LiveState["integrity"]; entries: AuditEntry[] } }
  | { t: "firewall"; v: FirewallEvent }
  | { t: "settings" };

function reduce(s: LiveState, a: Action): LiveState {
  switch (a.t) {
    case "connected":
      return { ...s, connected: a.v };
    case "worker":
      return { ...s, workers: { ...s.workers, [a.v.runId]: a.v } };
    case "approval":
      return { ...s, approvals: { ...s.approvals, [a.v.id]: a.v } };
    case "approvals":
      return { ...s, approvals: Object.fromEntries(a.v.map((x) => [x.id, x])) };
    case "audit":
      return { ...s, audit: [...s.audit.slice(-199), a.v] };
    case "auditInit":
      return { ...s, audit: a.v.entries, integrity: a.v.integrity };
    case "settings":
      return { ...s, settingsRev: s.settingsRev + 1 };
    case "firewall":
      return { ...s, firewall: [{ ...a.v, at: new Date().toISOString() }, ...s.firewall].slice(0, 50) };
  }
}

/** One SSE connection feeds every panel: workers, approvals, firewall hits, audit entries. */
export function useLiveEvents() {
  const [state, dispatch] = useReducer(reduce, { connected: false, workers: {}, approvals: {}, audit: [], firewall: [], settingsRev: 0 });

  useEffect(() => {
    api<Approval[]>("/approvals").then((v) => dispatch({ t: "approvals", v })).catch(() => {});
    api<{ integrity: LiveState["integrity"]; entries: AuditEntry[] }>("/audit?limit=200").then((v) => dispatch({ t: "auditInit", v })).catch(() => {});

    const token = getToken();
    const es = new EventSource(`/api/events${token ? `?token=${encodeURIComponent(token)}` : ""}`);
    es.onopen = () => dispatch({ t: "connected", v: true });
    es.onerror = () => dispatch({ t: "connected", v: false });
    es.addEventListener("worker", (e) => dispatch({ t: "worker", v: JSON.parse((e as MessageEvent).data) }));
    es.addEventListener("approval", (e) => dispatch({ t: "approval", v: JSON.parse((e as MessageEvent).data) }));
    es.addEventListener("audit", (e) => dispatch({ t: "audit", v: JSON.parse((e as MessageEvent).data) }));
    es.addEventListener("firewall", (e) => dispatch({ t: "firewall", v: JSON.parse((e as MessageEvent).data) }));
    es.addEventListener("settings", () => dispatch({ t: "settings" }));
    return () => es.close();
  }, []);

  return state;
}
