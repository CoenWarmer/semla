import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  serverExternalPackages: [
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    // Native binding plus a helper binary it exec's by path. Bundling it would
    // both fail to resolve the .node and move the helper out from under it.
    "node-pty",
  ],
};

export default nextConfig;
