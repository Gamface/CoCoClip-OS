import { useEffect, useState } from "react";
import type { ApprovalRecord } from "@agent-os/shared-types";
import { BudgetBar } from "./BudgetBar";
import { cents } from "./format";

function useCountdown(until: string) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.round((Date.parse(until) - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Budget-gated escalation raised by a Paperclip worker before a Composio call. */
export function ApprovalCard({
  approval: a,
  focused,
  onFocus,
  onDecide,
}: {
  approval: ApprovalRecord;
  focused?: boolean;
  onFocus?: () => void;
  onDecide: (granted: boolean, note?: string) => Promise<unknown>;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const left = useCountdown(a.expiresAt);
  const pending = a.status === "pending";

  const decide = async (granted: boolean) => {
    setBusy(true);
    setErr("");
    try {
      await onDecide(granted, note || undefined);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className={`card approval risk-${a.risk} ${focused ? "focused" : ""}`} onClick={onFocus}>
      <header>
        <span className={`pill risk-${a.risk}`}>{a.risk}</span>
        <strong className="mono">{a.tool}</strong>
        <span className={`pill status-${a.status}`}>{pending ? `pending · ${left}` : a.status}</span>
      </header>
      <p className="muted">
        <b>{a.agentName}</b> ({a.role}) {a.issueId ? <>on issue <span className="mono">{a.issueId.slice(0, 8)}</span></> : null}
        {a.paperclipApprovalId ? <> · mirrored to Paperclip</> : null}
      </p>
      <ul className="reasons">
        {a.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      {a.budget && (
        <BudgetBar spentCents={a.budget.spentCents} budgetCents={a.budget.budgetCents} suffix={a.estimatedCostCents ? ` · next step ≈ ${cents(a.estimatedCostCents)}` : undefined} />
      )}
      <details open={pending}>
        <summary>Arguments</summary>
        <pre>{JSON.stringify(a.args, null, 2)}</pre>
      </details>
      {pending ? (
        <div className="actions" onClick={(e) => e.stopPropagation()}>
          <input placeholder="Note to the agent (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="approve" disabled={busy} onClick={() => decide(true)}>
            Approve
          </button>
          <button className="deny" disabled={busy} onClick={() => decide(false)}>
            Deny
          </button>
        </div>
      ) : (
        <p className="muted small">
          {a.status} by {a.decidedBy ?? "system"}
          {a.note ? ` — “${a.note}”` : ""}
        </p>
      )}
      {err && <p className="error">{err}</p>}
    </article>
  );
}
