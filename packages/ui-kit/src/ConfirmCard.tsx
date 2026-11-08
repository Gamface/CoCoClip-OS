import { useState } from "react";

/** Human-in-the-loop card rendered inside the operator chat before a side-effecting action. */
export function ConfirmCard({
  action,
  summary,
  args,
  complete,
  approved,
  onConfirm,
  onCancel,
}: {
  action?: string;
  summary?: string;
  args?: unknown;
  complete: boolean;
  approved?: boolean;
  onConfirm?: () => Promise<void>;
  onCancel?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="card hitl">
      <p>
        <span className="pill risk-write">confirm</span> <b className="mono">{action ?? "…"}</b>
      </p>
      <p>{summary}</p>
      <pre>{JSON.stringify(args ?? {}, null, 2)}</pre>
      {complete ? (
        <p className="muted small">{approved ? "Confirmed" : "Declined"}</p>
      ) : (
        <div className="actions">
          <button
            className="approve"
            disabled={!onConfirm || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm?.();
              } finally {
                setBusy(false);
              }
            }}
          >
            Confirm
          </button>
          <button className="deny" disabled={!onCancel || busy} onClick={onCancel}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
