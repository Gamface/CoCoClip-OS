"use client";

import { useEffect, useRef } from "react";
import { z } from "zod";
import { useAgentContext, useHumanInTheLoop } from "@copilotkit/react-core/v2";
import { CONFIRMABLE_ACTIONS } from "@agent-os/shared-types";
import { ConfirmCard } from "@agent-os/ui-kit";
import { api } from "@/api";

const ConfirmArgs = z.object({
  action: z.enum(CONFIRMABLE_ACTIONS).describe("The exact server tool you intend to call next."),
  args: z.record(z.string(), z.unknown()).describe("The exact arguments for that tool, excluding confirmationToken."),
  summary: z.string().describe("One sentence for the human describing the effect."),
});
type ConfirmArgs = z.infer<typeof ConfirmArgs>;

/**
 * Registers the operator's frontend capabilities with CopilotKit:
 *  - `confirm_action` human-in-the-loop card (gates create_task / wake_agent / set_agent_model)
 *  - shared context: what the human is looking at, both to the chat agent (useAgentContext)
 *    and to background Paperclip workers (POST /api/context → injected at next heartbeat)
 */
export function OperatorTools({ focus }: { focus: Record<string, string> & { companyId?: string } }) {
  useHumanInTheLoop<ConfirmArgs>({
    name: "confirm_action",
    description: "Ask the human to confirm a side-effecting operator action. Returns { approved, confirmationToken }.",
    parameters: ConfirmArgs,
    render: ({ args, status, respond, result }) => {
      const reply = respond as ((r: unknown) => Promise<void>) | undefined;
      return (
        <ConfirmCard
          action={args.action}
          summary={args.summary}
          args={args.args}
          complete={String(status) === "complete"}
          approved={(result as { approved?: boolean } | undefined)?.approved}
          onConfirm={
            reply && args.action && args.args
              ? async () => {
                  try {
                    // The token is minted server-side and bound to this exact action + args.
                    const { token } = await api<{ token: string }>("/confirm", { method: "POST", body: JSON.stringify({ action: args.action, args: args.args }) });
                    await reply({ approved: true, confirmationToken: token });
                  } catch (e) {
                    await reply({ approved: false, error: String(e) });
                  }
                }
              : undefined
          }
          onCancel={reply ? () => void reply({ approved: false }) : undefined}
        />
      );
    },
  });

  useAgentContext({ description: "The operator's current view in the Agent OS command center", value: focus });

  const last = useRef("");
  useEffect(() => {
    if (!focus.companyId) return;
    const body = JSON.stringify({ companyId: focus.companyId, focus });
    if (body === last.current) return;
    const t = setTimeout(() => {
      last.current = body;
      void api("/context", { method: "POST", body }).catch(() => {});
    }, 800);
    return () => clearTimeout(t);
  }, [focus]);

  return null;
}
