import type { AuditLog } from "@agent-os/governance";
import type { ApprovalRecord } from "@agent-os/shared-types";
import type { ApprovalMirror } from "./approval-mirror.js";
import type { EventHub } from "./events.js";
import type { Paperclip } from "./paperclip.js";
import type { RunRecord, Store } from "./store.js";

/** What the worker reports so its runs can be recovered if this replica stops mid-run. */
export interface RunTracker {
  started(r: Omit<RunRecord, "owner" | "startedAt">): void;
  finished(runId: string): void;
}

export function storeRunTracker(store: Store, owner: string): RunTracker {
  const startedAt = new Map<string, string>();
  const log = (e: unknown) => console.error("[store] run", String(e));
  return {
    started(r) {
      const at = startedAt.get(r.runId) ?? new Date().toISOString();
      startedAt.set(r.runId, at);
      store.saveRun({ ...r, owner, startedAt: at }).catch(log);
    },
    finished(runId) {
      startedAt.delete(runId);
      store.deleteRun(runId).catch(log);
    },
  };
}

export interface RecoveryDeps {
  store: Store;
  /** Stable id for this replica (the container hostname by default), so a restart recognises its own leftovers. */
  replicaId: string;
  pc: Paperclip;
  hub: EventHub;
  audit: AuditLog;
  mirror?: ApprovalMirror;
  /** A replica not seen for this long is treated as stopped. */
  staleMs?: number;
  heartbeatMs?: number;
  sweepMs?: number;
}

const RESTART_NOTE = "Agent OS restarted before a decision; the agent's run was stopped and has been restarted.";

/**
 * Picks up work a stopped replica left behind. Each replica checks in every `heartbeatMs`.
 * Every `sweepMs` it looks for pending approvals and in-flight runs owned by a replica that
 * stopped checking in (or by itself, on startup), and:
 * - expires each such approval (it can never be answered: the run waiting on it is gone)
 *   and rejects its Paperclip copy;
 * - wakes the agent of each such run in Paperclip, which starts a fresh heartbeat for it.
 * Claims are atomic in the store, so two replicas never recover the same item twice.
 */
export class Recovery {
  private timers: NodeJS.Timeout[] = [];
  private readonly staleMs: number;

  constructor(private readonly d: RecoveryDeps) {
    this.staleMs = d.staleMs ?? 90_000;
  }

  async start() {
    await this.d.store.touchReplica(this.d.replicaId);
    await this.sweep(true);
    const every = (ms: number, fn: () => Promise<unknown>) => {
      const t = setInterval(() => void fn().catch((e) => console.error("[recovery]", String(e))), ms);
      t.unref?.();
      this.timers.push(t);
    };
    every(this.d.heartbeatMs ?? 20_000, () => this.d.store.touchReplica(this.d.replicaId));
    every(this.d.sweepMs ?? 30_000, () => this.sweep(false));
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  /** One pass. `boot` = this replica just started, so anything it owned before is orphaned. */
  async sweep(boot: boolean): Promise<{ approvals: number; runs: number }> {
    const { store, replicaId } = this.d;
    const seen = await store.replicaSeen();
    const now = Date.now();
    const orphaned = (owner: string | undefined) => {
      if (!owner) return false; // written before owners were recorded; leave it to the timeout
      if (owner === replicaId) return boot;
      return now - (seen.get(owner) ?? 0) > this.staleMs;
    };

    let approvals = 0;
    for (const a of await store.listPendingApprovals()) {
      if (!orphaned(a.owner)) continue;
      const settled: ApprovalRecord = { ...a, status: "expired", decidedAt: new Date().toISOString(), decidedBy: "system", note: RESTART_NOTE };
      const rec = await store.settleApproval(settled);
      if (!rec) continue;
      approvals++;
      this.d.audit.append("approval.recovered", "system", { id: rec.id, tool: rec.tool, owner: a.owner });
      this.d.hub.publish({ type: "approval", data: rec });
      if (this.d.mirror) void this.d.mirror.sync(rec);
    }

    let runs = 0;
    for (const r of await store.listRuns()) {
      if (!orphaned(r.owner)) continue;
      const claimed = await store.claimRun(r.runId);
      if (!claimed) continue;
      runs++;
      this.d.audit.append("run.recovered", "system", { runId: r.runId, agentId: r.agentId, issueId: r.issueId, owner: r.owner });
      const stale = this.d.hub.workers.get(r.runId);
      if (stale) this.d.hub.publish({ type: "worker", data: { ...stale, status: "error", detail: "Agent OS restarted during this run; restarting it", updatedAt: new Date().toISOString() } });
      if (r.issueId) {
        await this.d.pc
          .comment(r.issueId, `⚠️ Agent OS restarted during run ${r.runId}. Starting the agent again.`)
          .catch(() => {});
      }
      await this.d.pc.wake(r.agentId).catch((e) => this.d.audit.append("run.recover_failed", "system", { runId: r.runId, agentId: r.agentId, error: String(e) }));
    }
    return { approvals, runs };
  }
}
