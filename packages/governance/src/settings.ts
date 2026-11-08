import type { Effort, RolePolicy } from "./policy.js";

export type SettingSource = "agent" | "role" | "default";

export interface WorkerDefaults {
  model: string;
  effort: Effort;
  maxTurns: number;
}

export interface AgentOverride {
  model?: string | null;
  effort?: Effort | null;
  maxTurns?: number | null;
}

export interface ResolvedSettings extends WorkerDefaults {
  source: { model: SettingSource; effort: SettingSource; maxTurns: SettingSource };
}

/**
 * Per-agent model selection. Each field resolves independently, most specific first:
 * the agent's own override (set in the command center) → its role in org-policy.json → env defaults.
 * So "all support agents on Haiku, except this one on Sonnet" is one role line plus one override.
 */
export function resolveSettings(defaults: WorkerDefaults, role?: Pick<RolePolicy, "model" | "effort" | "maxTurns">, agent?: AgentOverride | null): ResolvedSettings {
  const pick = <K extends keyof WorkerDefaults>(k: K): [WorkerDefaults[K], SettingSource] => {
    const a = agent?.[k];
    if (a != null) return [a as WorkerDefaults[K], "agent"];
    const r = role?.[k];
    if (r != null) return [r as WorkerDefaults[K], "role"];
    return [defaults[k], "default"];
  };
  const [model, ms] = pick("model");
  const [effort, es] = pick("effort");
  const [maxTurns, ts] = pick("maxTurns");
  return { model, effort, maxTurns, source: { model: ms, effort: es, maxTurns: ts } };
}
