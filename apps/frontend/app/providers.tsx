"use client";

import { useEffect, useMemo } from "react";
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

  // Keyed by the token: saving a new one remounts the chat runtime and every panel, so they all
  // re-fetch with it (agent discovery, workforce, live events) without a page reload.
  return (
    <CopilotKitProvider key={token || "no-token"} runtimeUrl="/api/copilotkit" headers={headers}>
      {children}
    </CopilotKitProvider>
  );
}
