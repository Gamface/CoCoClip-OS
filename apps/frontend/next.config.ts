import type { NextConfig } from "next";

/**
 * The browser only ever talks to this Next.js origin. /api/* (REST, SSE, and the CopilotKit AG-UI
 * runtime) is proxied to the backend over the internal network, so BACKEND_URL can be a container
 * hostname like http://backend:8000 and no CORS or public backend port is needed.
 */
const backend = (process.env.BACKEND_URL ?? "http://localhost:8000").replace(/\/$/, "");

const config: NextConfig = {
  transpilePackages: ["@agent-os/ui-kit", "@agent-os/shared-types"],
  // Keep SSE and AG-UI streams unbuffered through the proxy.
  compress: false,
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${backend}/api/:path*` }];
  },
};

export default config;
