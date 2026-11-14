import express, { type NextFunction, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { hostname } from "node:os";
import { z } from "zod";
import { createCopilotExpressHandler } from "@copilotkit/runtime/v2/express";
import { ApprovalBroker, AuditLog, ConfirmationTokens, type OrgPolicy, resolveRole } from "@agent-os/governance";
import { CONFIRMABLE_ACTIONS, WORKER_MODELS, type ApprovalRecord, type AuditEntry, type WorkforceAgent } from "@agent-os/shared-types";
import { config, loadPolicy } from "./config.js";
import { EventHub } from "./events.js";
import { Paperclip } from "./paperclip.js";
import { ComposioBus } from "./composio-bus.js";
import { ApprovalMirror } from "./approval-mirror.js";
import { ContextStore } from "./context-store.js";
import { HeartbeatWorker } from "./worker.js";
import { createOperatorRuntime } from "./operator.js";
import { createStore } from "./store.js";
import { type RelayCommand, createRelay } from "./relay.js";
import { AgentSettingsService, SettingsPatch } from "./agent-settings.js";
import { Recovery, storeRunTracker } from "./recovery.js";

let policy: OrgPolicy = loadPolicy();
const getPolicy = () => policy;

const store = createStore(config.databaseUrl);
const relay = createRelay(config.redisUrl);
const hub = new EventHub();
hub.attachRelay(relay);
const audit = new AuditLog(config.auditFile);
const approvals = new ApprovalBroker(policy.approvalTimeoutSec);
const tokens = new ConfirmationTokens(config.confirmSecret);
const pc = new Paperclip(config.paperclipUrl, config.paperclipKey);
const contextStore = new ContextStore();
const settings = new AgentSettingsService(
  store,
  { model: config.workerModel, effort: config.workerEffort, maxTurns: config.workerMaxTurns },
  getPolicy,
  hub,
  audit,
);
const mirror = config.mirrorApprovals ? new ApprovalMirror(pc, approvals, audit) : undefined;
const bus = new ComposioBus(config.composioKey, approvals, audit, hub, mirror?.mirror);
/** Stable per container (its hostname), so after a restart this replica recognises work it left behind. */
const replicaId = process.env.REPLICA_ID || hostname();
const tracker = store.kind === "postgres" ? storeRunTracker(store, replicaId) : undefined;
const worker = new HeartbeatWorker({ pc, bus, hub, audit, contextStore, policy: getPolicy, settings, tracker });
const recovery = new Recovery({ store, replicaId, pc, hub, audit, mirror });

const persist = (a: ApprovalRecord) => store.saveApproval({ ...a, owner: replicaId }).catch((e) => console.error("[store] approval", String(e)));
approvals.on("requested", (a) => {
  audit.append("approval.requested", `agent:${a.agentId}`, { id: a.id, tool: a.tool, reasons: a.reasons });
  hub.publish({ type: "approval", data: a });
  void persist(a);
});
approvals.on("decided", (a) => {
  audit.append("approval.decided", a.decidedBy ?? "system", { id: a.id, tool: a.tool, status: a.status, note: a.note });
  hub.publish({ type: "approval", data: a });
  void persist(a);
});
approvals.on("mirrored", (a) => void persist(a));
audit.onAppend((e) => hub.publish({ type: "audit", data: e as AuditEntry }));

/** Commands from other replicas: only the replica holding the pending approval / run acts. */
function onCommand(c: RelayCommand) {
  if (c.kind === "decide") approvals.decide(c.approvalId, c.granted, c.by, c.note);
  else worker.cancel(c.runId);
}

const app = express();
app.disable("x-powered-by");

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Optional bearer auth for the operator surface (UI, REST, CopilotKit). */
const operatorToken = process.env.OPERATOR_TOKEN ?? "";
function requireOperator(req: Request, res: Response, next: NextFunction) {
  if (!operatorToken) return next();
  const got = req.get("authorization")?.replace(/^Bearer\s+/i, "") ?? (typeof req.query.token === "string" ? req.query.token : "");
  if (got && safeEqual(got, operatorToken)) return next();
  res.status(401).json({ error: "operator token required" });
}

// ── Paperclip HTTP adapter webhook ────────────────────────────────────────────────
const Heartbeat = z.object({
  runId: z.string(),
  agentId: z.string(),
  companyId: z.string(),
  context: z.object({ taskId: z.string().optional(), issueId: z.string().optional(), wakeReason: z.string().optional(), commentId: z.string().optional() }).passthrough().optional(),
});

app.post("/paperclip/heartbeat", express.json({ limit: "1mb" }), (req, res) => {
  if (config.webhookSecret && !safeEqual(req.get("x-agent-os-secret") ?? "", config.webhookSecret)) {
    res.status(401).json({ error: "bad webhook secret" });
    return;
  }
  const parsed = Heartbeat.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid heartbeat payload", issues: parsed.error.issues });
    return;
  }
  // Paperclip's http adapter is fire-and-forget: acknowledge now, report back over its REST API.
  res.status(202).json({ accepted: true, runId: parsed.data.runId });
  worker.run(parsed.data).catch((e) => audit.append("heartbeat.crash", "backend", { runId: parsed.data.runId, error: String(e) }));
});

// ── CopilotKit runtime (AG-UI) ────────────────────────────────────────────────────
app.use("/api/copilotkit", requireOperator);
app.use(
  createCopilotExpressHandler({
    runtime: createOperatorRuntime({ pc, bus, hub, approvals, audit, tokens, settings, policy: getPolicy, model: config.operatorModel }),
    basePath: "/api/copilotkit",
    cors: { origin: config.corsOrigin, credentials: true },
  }),
);

// ── Command-center REST + SSE ─────────────────────────────────────────────────────
const api = express.Router();
api.use(requireOperator, express.json({ limit: "256kb" }));

api.get("/events", hub.handler);

api.get("/approvals", async (req, res) => {
  const status = typeof req.query.status === "string" ? (req.query.status as ApprovalRecord["status"]) : undefined;
  // Live broker first (authoritative for this replica's pending items), then durable history.
  const byId = new Map<string, ApprovalRecord>();
  for (const a of await store.listApprovals(200).catch(() => [])) byId.set(a.id, a);
  for (const a of approvals.list()) byId.set(a.id, a);
  res.json([...byId.values()].filter((a) => !status || a.status === status).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});

api.post("/approvals/:id", (req, res) => {
  const body = z.object({ granted: z.boolean(), note: z.string().max(2000).optional(), by: z.string().max(120).default("operator") }).safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: body.error.message });
  const by = `user:${body.data.by}`;
  const a = approvals.decide(req.params.id, body.data.granted, by, body.data.note);
  if (a) return void res.json(a);
  if (relay.kind === "redis") {
    // Pending on another replica: forward the decision to whichever one holds it.
    relay.publishCommand({ kind: "decide", approvalId: req.params.id, granted: body.data.granted, by, note: body.data.note });
    return void res.status(202).json({ forwarded: true });
  }
  res.status(404).json({ error: "unknown approval" });
});

/** Called only by the frontend human-in-the-loop card after the human clicks Confirm. */
api.post("/confirm", (req, res) => {
  const body = z.object({ action: z.enum(CONFIRMABLE_ACTIONS), args: z.record(z.string(), z.unknown()) }).safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: body.error.message });
  audit.append("operator.confirmed", "user:operator", body.data);
  res.json({ token: tokens.mint(body.data.action, body.data.args) });
});

api.get("/companies", async (_req, res) => {
  try {
    res.json(await pc.companies());
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 401 || status === 403) {
      const hint = process.env.PAPERCLIP_API_KEY
        ? "Paperclip refused PAPERCLIP_API_KEY. Use a board token, or an agent API key (Agent → Configuration → API Keys), then restart the backend."
        : "PAPERCLIP_API_KEY is empty. Create an agent API key in Paperclip (Agent → Configuration → API Keys), put it in .env, then restart the backend.";
      return void res.status(502).json({ error: `${hint} (${String(e)})` });
    }
    res.status(502).json({ error: String(e) });
  }
});

api.get("/workforce", async (req, res) => {
  const companyId = String(req.query.companyId ?? "");
  if (!companyId) return void res.status(400).json({ error: "companyId required" });
  try {
    const [agents, overrides] = await Promise.all([pc.agents(companyId), settings.list()]);
    const byAgent = new Map(overrides.map((s) => [s.agentId, s]));
    const live = [...hub.workers.values()];
    const out: WorkforceAgent[] = agents.map((a) => {
      const role = resolveRole(policy, a);
      const s = byAgent.get(a.id) ?? null;
      return {
        ...a,
        policyRole: role?.role ?? null,
        live: live.filter((w) => w.agentId === a.id).sort((x, y) => y.updatedAt.localeCompare(x.updatedAt))[0] ?? null,
        settings: s,
        effective: settings.resolve(role, s),
        inherited: settings.resolve(role, null),
      };
    });
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

// ── Per-agent model settings ──────────────────────────────────────────────────────
api.get("/models", (_req, res) => res.json({ models: WORKER_MODELS, defaults: settings.workerDefaults }));

api.get("/agents/:id/settings", async (req, res) => {
  try {
    const agent = await pc.agent(req.params.id);
    const r = await settings.effectiveFor(agent);
    res.json({ agentId: agent.id, policyRole: r.role?.role ?? null, settings: r.settings, effective: r.effective });
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

api.put("/agents/:id/settings", async (req, res) => {
  const body = SettingsPatch.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  try {
    const agent = await pc.agent(req.params.id);
    await settings.update(agent.id, body.data, "user:operator");
    const r = await settings.effectiveFor(agent);
    res.json({ agentId: agent.id, policyRole: r.role?.role ?? null, settings: r.settings, effective: r.effective });
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

api.post("/context", (req, res) => {
  const body = z.object({ companyId: z.string(), focus: z.record(z.string(), z.unknown()) }).safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: body.error.message });
  const ctx = contextStore.set(body.data.companyId, body.data.focus);
  hub.publish({ type: "context", data: ctx });
  res.json(ctx);
});

api.get("/audit", (req, res) => res.json({ integrity: audit.verify(), entries: audit.tail(Math.min(500, Number(req.query.limit ?? 100))) }));

api.post("/runs/:runId/cancel", (req, res) => {
  const ok = worker.cancel(req.params.runId);
  if (!ok && relay.kind === "redis") relay.publishCommand({ kind: "cancel", runId: req.params.runId });
  audit.append("run.cancel", "user:operator", { runId: req.params.runId, ok, forwarded: !ok && relay.kind === "redis" });
  res.status(ok || relay.kind === "redis" ? 200 : 404).json({ cancelled: ok, forwarded: !ok && relay.kind === "redis" });
});

api.get("/policy", (_req, res) => res.json(policy));
api.post("/policy/reload", (_req, res) => {
  try {
    policy = loadPolicy();
    audit.append("policy.reloaded", "user:operator", { roles: policy.roles.map((r) => r.role) });
    res.json(policy);
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

app.use("/api", api);

app.get("/healthz", (_req, res) =>
  res.json({
    ok: true,
    store: store.kind,
    relay: relay.kind,
    composio: bus.enabled,
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
    paperclip: config.paperclipUrl,
    audit: audit.verify(),
  }),
);

async function main() {
  await store.init();
  await relay.start((e) => hub.deliver(e), onCommand);
  // Only Postgres outlives a restart; the memory store has nothing to recover.
  if (store.kind === "postgres") await recovery.start();
  const server = app.listen(config.port, () => {
    console.log(`agent-os backend on :${config.port}  (store: ${store.kind}, relay: ${relay.kind}, replica: ${replicaId})`);
    console.log(`  Paperclip webhook  POST /paperclip/heartbeat`);
    console.log(`  CopilotKit runtime      /api/copilotkit  (model ${config.operatorModel})`);
    console.log(`  Default worker model    ${config.workerModel} @ effort ${config.workerEffort} (per-role / per-agent overrides apply)`);
    if (!bus.enabled) console.log("  ! COMPOSIO_API_KEY not set: workers run without external tools");
  });
  const stop = () => {
    server.close();
    recovery.stop();
    void Promise.allSettled([relay.close(), store.close()]).then(() => process.exit(0));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

main().catch((e) => {
  console.error("startup failed:", e);
  process.exit(1);
});
