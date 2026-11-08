# Enterprise Agent OS

One system built from three upstream projects, each doing the job it is best at:

| Layer | Upstream | What it owns here |
|---|---|---|
| **Control plane** | [Paperclip](https://github.com/paperclipai/paperclip) | Companies, org chart, roles, tasks (issues), heartbeats, monthly budgets, board approvals, activity log |
| **Tool bus** | [Composio](https://github.com/ComposioHQ/composio) | 1,000+ managed-auth toolkits, semantic tool search, execution |
| **Operator surface** | [CopilotKit](https://github.com/CopilotKit/CopilotKit) | AG-UI runtime, chat agent, human-in-the-loop cards, shared app context |
| **Glue + enhancements** | this repo | Role-scoped tool injection, per-agent models, policy and budget gate, firewall, dual-surface approvals, audit chain, Claude workers |
| **State** | Postgres + Redis | Per-agent model settings and approval history (Postgres); live events and approval decisions shared across backend replicas (Redis) |

```
                 ┌──────────────── Paperclip (:3100) ────────────────┐
                 │ org chart · issues · budgets · approvals · costs  │
                 └──────┬───────────────────────────────▲────────────┘
     heartbeat webhook  │ (http adapter)                │ REST: checkout, comment, status,
                        ▼                               │ cost-events, approvals (mirror)
┌───────────────────────────── backend (:8000, internal) ────────────────────────────┐
│  HeartbeatWorker (Claude tool loop; model per agent → role → default)              │
│     │ resolveTools(role, task) ── only the role's toolkits, semantic-ranked,       │
│     │                              denied tools never shown to the model           │
│     ▼                                                                              │
│  ComposioBus.execute ─► policy.decide(role, slug, budget) ─► allow | ask | deny    │
│                               │ ask                                                │
│                               ▼                                                    │
│                    ApprovalBroker ◄──► ApprovalMirror ◄──► Paperclip approvals     │
│                               │ granted                                            │
│                               ▼                                                    │
│                    Composio tools.execute ─► Firewall.sanitize ─► <untrusted…>     │
│                                                                                    │
│  AuditLog (sha256 chain) · EventHub (SSE) · ContextStore · ConfirmationTokens      │
│  AgentSettings ─► Postgres          EventHub/commands ◄─► Redis (other replicas)   │
│  CopilotRuntime { operator: BuiltInAgent }  at /api/copilotkit                     │
└───────────────────────────────▲────────────────────────────────────────────────────┘
                                │ /api/* proxied (AG-UI + SSE + REST)
          ┌─────────────────────┴── frontend (:3000, Next.js + CopilotKit v2) ──┐
          │ workforce + model picker · approval queue · firewall · audit · chat │
          └─────────────────────────────────────────────────────────────────────┘
```

## What was combined, and what was added

**Taken from each project, as-is**
- Paperclip's **HTTP adapter** is the integration point. Any Paperclip agent whose adapter is `http` pointing at the backend becomes a Composio-powered Claude worker. Paperclip still owns hiring, reporting lines, task assignment, budgets and its 80% / 100% budget enforcement.
- Composio's **raw tool catalogue + semantic search** (`tools.getRawComposioTools({ toolkits, search })`) and **execution** (`tools.execute`), scoped per company via `userId = companyId`.
- CopilotKit v2's **`CopilotRuntime` + `BuiltInAgent`** server side, and **`useHumanInTheLoop`**, **`useAgentContext`**, **`CopilotSidebar`** client side.

**Enhancements**
1. **Role-scoped JIT tool injection.** `config/org-policy.json` maps Paperclip roles (glob on `role`, then `name`) to the Composio toolkits they may use. Each heartbeat fetches only those toolkits, ranks them against the task text, and drops anything the policy would deny before the model sees it. This prevents privilege creep and keeps the context small.
2. **Budget-aware permission gate.** Each tool call gets `allow | ask | deny` from explicit rules, else from a risk class inferred from the slug (read / write / destructive; unknown slugs count as write). Paperclip spend is then layered on: writes need approval past the soft threshold, a call projected to cross the cap needs approval, and an exhausted budget means deny. The worker also stops before a model turn that would overrun the budget.
3. **Dual-surface approvals.** Escalations appear as cards in the command center *and* are filed in Paperclip's own queue (`request_board_approval`), so a board member can decide from Paperclip's UI or phone. The first decision wins and the other side is synced. Unanswered requests auto-deny after `approvalTimeoutSec`.
4. **Firewall on both directions of a handoff.** Composio outputs *and* inbound issue text and comments (which may come from other agents) go through the same steps: invisible-character and Unicode-tag smuggling is removed, hidden HTML is stripped, credentials are redacted, and injection lines are quarantined. Each result is then wrapped in an `<untrusted_tool_output>` envelope. Findings stream to the UI.
5. **Unskippable human confirmation for the chat operator.** The operator agent's `create_task` / `wake_agent` tools run only with an HMAC token, and only the frontend `confirm_action` card can mint one after a human click. Each token is bound to the exact arguments, expires after 5 minutes, and works once. A prompt-injected model cannot skip the card or swap arguments after approval.
6. **Bi-directional context.** What the operator is looking at (and their free-text notes) goes to the chat agent through `useAgentContext` and to background workers through `POST /api/context`. Workers receive it at their next heartbeat as operator context.
7. **Tamper-evident audit.** Every decision, approval, execution and operator action is appended to a SHA-256 hash chain (`data/audit.jsonl`). `GET /api/audit` reports whether the chain verifies.
8. **Per-agent models.** Each agent can run on its own Claude model, effort and turn limit. Set a default per role in `config/org-policy.json` (`"model"`, `"effort"`, `"maxTurns"`), then override single agents from the model picker on their Workforce card, or ask the operator chat ("put the support bot on Sonnet"), which asks you to confirm first. Each field resolves separately (agent → role → `WORKER_MODEL` / `WORKER_EFFORT` / `WORKER_MAX_TURNS`), and the card shows where each value came from. Overrides are stored in Postgres and audited. The request adapts to the model: Opus and Sonnet 5.5 use `fallbacks: "default"`, Fable 5.1 falls back to Opus 4.8, and Haiku 5.5 is sent without a fallback because it doesn't support one.
9. **Accurate cost reporting.** Per-response token usage (including cache reads and writes) is priced per model and posted to Paperclip's `cost-events`, so Paperclip's own budget enforcement sees real numbers. Workers use server-side refusal fallbacks (`fallbacks: "default"`) and stop cleanly on a refusal.

## Run it

### Docker (Paperclip + backend + frontend + Postgres + Redis)

The quickest route is the interactive setup script. It creates `.env` with generated secrets (owner-only permissions), asks for your API keys with hidden input, checks Docker and offers to start the stack. Re-running it keeps existing values.

```bash
./scripts/setup.sh
```

Or do it by hand:

```bash
cp .env.example .env
```

Fill in `.env`. Generate each secret with `openssl rand -hex 32`. You need at least `BETTER_AUTH_SECRET`, `AGENT_OS_WEBHOOK_SECRET`, `CONFIRM_SECRET`, `POSTGRES_PASSWORD`, `ANTHROPIC_API_KEY` and `COMPOSIO_API_KEY`.

```bash
docker compose up --build
```

Then, in Paperclip (http://localhost:3100):
1. Create a company and hire agents. Name or role them to match `config/org-policy.json` (e.g. "Release Engineer").
2. Set each agent's adapter to **HTTP** with URL `http://backend:8000/paperclip/heartbeat` and header `x-agent-os-secret: <AGENT_OS_WEBHOOK_SECRET>`.
3. Create an API key (`POST /api/agents/{id}/keys`, or a board token) and put it in `PAPERCLIP_API_KEY`.
4. In Composio, connect accounts (GitHub, Slack, …) for user id = the Paperclip **company id**.
5. Open the command center at http://localhost:3000. Pick a model for each agent on its Workforce card, or leave it on "Inherit".
6. Assign an issue to an agent, or trigger a heartbeat, and watch it run.

### Local dev

```bash
npm install
```

```bash
npm run dev
```

The backend runs on :8000 and the Next.js frontend on :3000, which proxies `/api` to it. Point `PAPERCLIP_API_URL` at a running Paperclip. Without `DATABASE_URL` the backend keeps settings in memory, and without `REDIS_URL` it runs as a single replica.

### Tests

```bash
npm test
```

The Postgres store is tested against an in-memory Postgres emulator (pg-mem).

## Layout

```
apps/frontend           Next.js + CopilotKit v2 command center (proxies /api to the backend)
apps/backend            Express: Paperclip webhook, Composio bus, Claude worker, approval mirror, CopilotRuntime, REST+SSE, Postgres/Redis
packages/shared-types   AG-UI / SSE payloads, approval and settings records, worker model catalogue
packages/ui-kit         Shared HITL components: ApprovalCard, ConfirmCard, ModelPicker, BudgetBar
packages/governance     policy engine, settings resolution, firewall, approval broker, audit chain, confirmation tokens, pricing
config/org-policy.json  roles → toolkits → rules → default model
```

## Backend API

| Method | Path | Purpose |
|---|---|---|
| POST | `/paperclip/heartbeat` | Paperclip HTTP-adapter webhook (needs `x-agent-os-secret`) |
| * | `/api/copilotkit/*` | CopilotKit AG-UI runtime (`operator` agent) |
| GET | `/api/events` | SSE: `worker`, `approval`, `firewall`, `audit`, `context` |
| GET/POST | `/api/approvals`, `/api/approvals/:id` | list / decide `{ granted, note }` |
| POST | `/api/confirm` | mint an operator confirmation token (UI only) |
| GET | `/api/workforce?companyId=` | agents + policy role + model settings + live run state |
| GET | `/api/models` | worker model catalogue and defaults |
| GET/PUT | `/api/agents/:id/settings` | an agent's model / effort / maxTurns (`null` clears back to role or default) |
| POST | `/api/context` | share operator focus with background workers |
| GET | `/api/audit` | audit tail + chain verification |
| POST | `/api/runs/:runId/cancel` | stop a running heartbeat |
| GET/POST | `/api/policy`, `/api/policy/reload` | view / hot-reload the org policy |

If `OPERATOR_TOKEN` is set, every `/api` route on the backend requires `Authorization: Bearer <token>`. EventSource connections can pass `?token=` instead.

## Notes and limits
- Per-agent settings and approval history persist in Postgres. In-flight runs, pending approvals and the operator context live on the replica running them, so a backend restart drops them (the tool call never executes). With Redis, a decision posted to any replica reaches the one waiting on it. The audit log is a per-replica file.
- Workers always run on Claude. `OPENAI_API_KEY` is only used if you point the operator chat at an `openai/*` model.
- Composio toolkit versions: each raw tool's `version` is pinned at execution. Tools without one run with `dangerouslySkipVersionCheck`.
- Risk classification by slug verb is a heuristic. Use explicit rules for anything that matters.
- The specification's layout, services and ports are followed, with these deliberate differences:
  - The spec's blueprint code used APIs that don't exist upstream (`@paperclipai/sdk` `PaperclipAdapter`, a `firewall` option on Composio `tools.get`, CopilotKit v1 `useCoAgent*`). This repo uses the real ones instead: Paperclip's HTTP adapter and REST API, Composio's `getRawComposioTools` and `execute`, and CopilotKit v2.
  - Images run production builds (`next start`, `node dist`) on Node 22, without source bind mounts.
  - The Postgres password comes from `.env`, and Postgres, Redis and the backend aren't published to the host.
  - The browser reaches the backend through the frontend's `/api` proxy, because `NEXT_PUBLIC_BACKEND_URL=http://backend:8000` only resolves inside Docker.
