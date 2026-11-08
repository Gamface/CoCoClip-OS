import { z } from "zod";
import { Effort, type AuditLog, type OrgPolicy, type RolePolicy, type WorkerDefaults, resolveRole, resolveSettings } from "@agent-os/governance";
import type { AgentSettings, EffectiveSettings } from "@agent-os/shared-types";
import type { EventHub } from "./events.js";
import type { Store } from "./store.js";

/** A patch from the UI / operator. `null` clears a field back to the role or default value. */
export const SettingsPatch = z
  .object({
    model: z.string().regex(/^claude-[a-z0-9-]+$/, "must be a Claude model id, e.g. claude-sonnet-5-5").nullable().optional(),
    effort: Effort.nullable().optional(),
    maxTurns: z.number().int().min(1).max(100).nullable().optional(),
  })
  .strict();
export type SettingsPatch = z.infer<typeof SettingsPatch>;

/**
 * Per-agent worker settings: which Claude model, effort and turn limit each Paperclip agent runs with.
 * Overrides live in the store (Postgres in production) so every replica and restart agrees.
 */
export class AgentSettingsService {
  constructor(
    private readonly store: Store,
    private readonly defaults: WorkerDefaults,
    private readonly policy: () => OrgPolicy,
    private readonly hub: EventHub,
    private readonly audit: AuditLog,
  ) {}

  get workerDefaults(): WorkerDefaults {
    return this.defaults;
  }

  resolve(role: RolePolicy | undefined, override: AgentSettings | null): EffectiveSettings {
    return resolveSettings(this.defaults, role, override);
  }

  async effectiveFor(agent: { id: string; role?: string | null; name: string }, role = resolveRole(this.policy(), agent)) {
    const settings = await this.store.getSettings(agent.id);
    return { role, settings, effective: this.resolve(role, settings) };
  }

  async update(agentId: string, patch: SettingsPatch, by: string): Promise<AgentSettings | null> {
    const current = (await this.store.getSettings(agentId)) ?? { agentId };
    const next: AgentSettings = { ...current, ...patch, agentId, updatedBy: by };
    let saved: AgentSettings | null;
    if (next.model == null && next.effort == null && next.maxTurns == null) {
      await this.store.deleteSettings(agentId);
      saved = null;
    } else {
      saved = await this.store.putSettings(next);
    }
    this.audit.append("agent.settings", by, { agentId, patch, result: saved });
    this.hub.publish({ type: "settings", data: saved ?? { agentId } });
    return saved;
  }

  list() {
    return this.store.listSettings();
  }
}
