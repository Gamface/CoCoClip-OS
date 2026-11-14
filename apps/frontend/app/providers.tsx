"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { useAuth } from "@/useAuth";

export function Providers({ children }: { children: React.ReactNode }) {
  // CopilotKit's styles key off a `.dark` ancestor; follow the OS color scheme like the rest of the UI.
  useEffect(() => {
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.classList.toggle("dark", scheme.matches);
    apply();
    scheme.addEventListener("change", apply);
    return () => scheme.removeEventListener("change", apply);
  }, []);

  const { token } = useAuth();
  const headers = useMemo((): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {}), [token]);

  // The chat panel shows nothing when a run fails (bad API key, no credit, unknown model...),
  // so surface CopilotKit's errors here with a hint at the usual fix.
  const [chatError, setChatError] = useState("");
  const onError = useCallback(({ error }: { error: Error }) => {
    console.error("[CopilotKit]", error);
    setChatError(error.message || String(error));
  }, []);

  // Keyed by the token: saving a new one remounts the chat runtime and every panel, so they all
  // re-fetch with it (agent discovery, workforce, live events) without a page reload.
  return (
    <CopilotKitProvider key={token || "no-token"} runtimeUrl="/api/copilotkit" headers={headers} onError={onError}>
      {children}
      {chatError && (
        <p className="error banner chat-error" role="alert" onClick={() => setChatError("")} title="Click to dismiss">
          <strong>Operator chat failed:</strong> {chatError}
          {chatHint(chatError) && <span className="muted small"> {chatHint(chatError)}</span>}
        </p>
      )}
    </CopilotKitProvider>
  );
}

/** The usual fix for the errors operators actually hit. */
export function chatHint(message: string): string {
  if (/operator token|\b401\b.*copilotkit/i.test(message)) return "Paste OPERATOR_TOKEN from .env using the Token button.";
  if (/x-api-key|authentication_error|invalid api key|\b401\b/i.test(message)) return "Check ANTHROPIC_API_KEY in .env, then restart the backend.";
  if (/credit balance/i.test(message)) return "The Anthropic account behind ANTHROPIC_API_KEY is out of credit.";
  if (/not_found_error|model.*not found|unknown model/i.test(message)) return "That key can't use OPERATOR_MODEL; try anthropic/claude-sonnet-5-5 in .env.";
  if (/rate.?limit|\b429\b|overloaded|\b529\b/i.test(message)) return "Anthropic is rate-limiting or busy; try again in a minute.";
  if (/fetch failed|ECONNREFUSED|network/i.test(message)) return "The backend isn't reachable; check docker compose ps.";
  return "Details are in the backend log: docker compose logs --tail=100 backend";
}
