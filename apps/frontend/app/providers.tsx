"use client";

import { useEffect, useState } from "react";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { authHeaders } from "@/api";

export function Providers({ children }: { children: React.ReactNode }) {
  // CopilotKit's styles key off a `.dark` ancestor; follow the OS color scheme like the rest of the UI.
  useEffect(() => {
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.classList.toggle("dark", scheme.matches);
    apply();
    scheme.addEventListener("change", apply);
    return () => scheme.removeEventListener("change", apply);
  }, []);

  // The operator token lives in localStorage, which only exists in the browser.
  const [headers, setHeaders] = useState<Record<string, string>>({});
  useEffect(() => setHeaders(authHeaders()), []);

  return (
    <CopilotKitProvider runtimeUrl="/api/copilotkit" headers={headers}>
      {children}
    </CopilotKitProvider>
  );
}
