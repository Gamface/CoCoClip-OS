import type { AuditEntry, FirewallEvent } from "@/api";

export function FirewallFeed({ items }: { items: Array<FirewallEvent & { at: string }> }) {
  if (!items.length) return <p className="muted small">No suspicious tool output yet.</p>;
  return (
    <ul className="feed">
      {items.map((f, i) => (
        <li key={`${f.at}-${i}`}>
          <span className={`pill ${f.score >= 50 ? "risk-destructive" : "risk-write"}`}>{f.score}</span>
          <span className="mono">{f.tool}</span>
          <ul>
            {f.findings.slice(0, 4).map((x, j) => (
              <li key={j} className="small muted">
                {x.kind}: {x.detail}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

export function AuditFeed({ items, integrity }: { items: AuditEntry[]; integrity?: { ok: boolean; length?: number; brokenAt?: number } }) {
  return (
    <>
      <p className="small">
        Chain:{" "}
        {integrity ? (
          integrity.ok ? <span className="ok">verified ({integrity.length} entries)</span> : <span className="error">broken at #{integrity.brokenAt}</span>
        ) : (
          "…"
        )}
      </p>
      <ul className="feed audit">
        {[...items].reverse().slice(0, 60).map((e) => (
          <li key={e.seq} title={e.hash}>
            <span className="muted small mono">#{e.seq}</span> <b className="small">{e.type}</b> <span className="muted small">{e.actor}</span>
            {typeof e.data?.tool === "string" && <span className="mono small"> {e.data.tool}</span>}
          </li>
        ))}
      </ul>
    </>
  );
}
