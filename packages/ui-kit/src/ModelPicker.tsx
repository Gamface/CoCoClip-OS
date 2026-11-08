import { useState } from "react";
import { EFFORTS, type AgentSettings, type EffectiveSettings, type ModelInfo } from "@agent-os/shared-types";

export type SettingsPatch = Partial<Pick<AgentSettings, "model" | "effort" | "maxTurns">>;

const SOURCE_LABEL = { agent: "this agent", role: "role", default: "default" } as const;

/**
 * Assigns one agent its own worker model, effort and turn limit. "Inherit" clears the override so
 * the agent follows its role in org-policy.json, then the backend default.
 */
export function ModelPicker({
  models,
  settings,
  effective,
  inherited,
  onChange,
}: {
  models: readonly ModelInfo[];
  settings: AgentSettings | null;
  effective: EffectiveSettings;
  /** What the agent would run with if its override were cleared. */
  inherited: { model: string; effort: string; maxTurns: number };
  onChange: (patch: SettingsPatch) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const label = (id: string) => models.find((m) => m.id === id)?.label ?? id;

  const apply = async (patch: SettingsPatch) => {
    setBusy(true);
    setErr("");
    try {
      await onChange(patch);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const known = models.some((m) => m.id === settings?.model);
  return (
    <div className="model-picker" onClick={(e) => e.stopPropagation()}>
      <label>
        <span className="muted small">Model</span>
        <select aria-label="Worker model" disabled={busy} value={settings?.model ?? ""} onChange={(e) => apply({ model: e.target.value || null })}>
          <option value="">Inherit · {label(inherited.model)}</option>
          {models.map((m) => (
            <option key={m.id} value={m.id} title={m.note}>
              {m.label} · ${m.price.input}/${m.price.output}
            </option>
          ))}
          {settings?.model && !known ? <option value={settings.model}>{settings.model}</option> : null}
        </select>
      </label>
      <label>
        <span className="muted small">Effort</span>
        <select aria-label="Effort" disabled={busy} value={settings?.effort ?? ""} onChange={(e) => apply({ effort: (e.target.value || null) as SettingsPatch["effort"] })}>
          <option value="">Inherit · {inherited.effort}</option>
          {EFFORTS.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="muted small">Turns</span>
        <input
          aria-label="Max turns per heartbeat"
          type="number"
          min={1}
          max={100}
          disabled={busy}
          placeholder={String(inherited.maxTurns)}
          defaultValue={settings?.maxTurns ?? ""}
          key={settings?.maxTurns ?? "inherit"}
          onBlur={(e) => {
            const v = e.target.value.trim();
            const n = v ? Number(v) : null;
            if (n === (settings?.maxTurns ?? null)) return;
            if (n !== null && (!Number.isInteger(n) || n < 1 || n > 100)) return setErr("Turns must be 1–100");
            void apply({ maxTurns: n });
          }}
        />
      </label>
      <p className="small muted model-source">
        Runs <b>{label(effective.model)}</b> @ {effective.effort}, {effective.maxTurns} turns · model from {SOURCE_LABEL[effective.source.model]}
      </p>
      {err && <p className="error small">{err}</p>}
    </div>
  );
}
